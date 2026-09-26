// Manifest discovery (PLAN.md §6.1 steps 3-5, §6.3 step 4). Pure filesystem reads,
// no DB. Walks one repo for package.json / pubspec.yaml and returns package
// descriptors with visibility, manifest deps, and resolved entry points.
//
// All returned paths are POSIX. `path` is the package dir relative to the repo
// root ('.' for the root); `entryPoints` are relative to the REPO root.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { matchGlob } from './glob.ts';
import { TEST_GLOBS } from './globs.ts';

export type Manager = 'npm' | 'pub';
export type Visibility = 'private' | 'published-private' | 'published-public';

export interface ManifestDep {
  name: string;
  manager: Manager;
  /** Version string as written (npm), or pub constraint; `path:<rel>` for pub path deps. */
  constraint: string | null;
  /**
   * Present (true) only when the name appears ONLY in the dev block (npm
   * `devDependencies`, pub `dev_dependencies`): a test-time dependency, whose uses
   * from the consumer's test files count (analyze.sql `external_refs`).
   */
  dev?: true;
}

export interface ManifestPackage {
  manager: Manager;
  name: string;
  version: string | null;
  visibility: Visibility;
  /**
   * Manifest shape of a library (imported by other code) rather than an app (run by a
   * runtime): npm `exports`/`types`/`typings`/`module`; pub any `lib/*.dart`.
   */
  isLibrary: boolean;
  /** Package dir relative to the repo root, POSIX; '.' for the root. */
  path: string;
  /** Manifest file relative to the repo root, POSIX (for error messages). */
  manifest: string;
  /** Entry files relative to the repo root, POSIX, sorted, deduplicated. */
  entryPoints: string[];
  /**
   * npm `main` / `module` / `types` / `typings` / `exports` leaves that look like code
   * (CODE_EXT, incl. `.d.ts`) but resolve to no file, even through the dist→src rules,
   * as written in the manifest, sorted, deduplicated. The package's surface is then
   * partly unknown: discover flags it `opaque_consumer` (fail closed). [] for pub.
   */
  unresolvedEntryPoints: string[];
  /**
   * Files the RUNTIME or a bundler loads, not importers: npm `imports` map targets
   * (every condition arm), Vite / HTML client entries (clientEntryPoints), files loaded
   * by path by convention (conventionEntryPoints: wrangler `main`, Pages `functions/`,
   * HonoX / Next / SvelteKit / Nuxt routes…), all also in entryPoints; and `bin`
   * targets, which are NOT in entryPoints (run, never imported: no export surface, and a
   * bin outside the TS program must not make the package `partial`). Ingest makes these
   * documents seeds (documents.is_entry) and the exported declarations of the
   * entryPoints among them entry_symbols (never a verdict): an `imports` arm's `digest`
   * is wired by Node's condition, not consumed through the export surface. Sorted; []
   * for pub.
   */
  runtimeEntryPoints: string[];
  /**
   * Names of exported classes the RUNTIME instantiates by name (wrangler config
   * `durable_objects.bindings[].class_name`, `migrations[].new_classes` /
   * `new_sqlite_classes`, `workflows[].class_name`). Ingest makes every exported symbol
   * with such a name declared in one of the package's entry / runtime entry files an
   * entry_symbol (never a verdict). Sorted, deduplicated; omitted when none.
   */
  runtimeEntrySymbols?: string[];
  /** Sorted by name; one entry per name. */
  deps: ManifestDep[];
}

export type Warn = (message: string) => void;

/**
 * Directory names never descended into, at any depth, in a git checkout or not:
 * installed dependencies and VCS / tool metadata.
 */
export const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.dart_tool']);

/**
 * Directory names also skipped when the repo is NOT a git checkout (fixtures, plain
 * directories), where .gitignore is not available to tell build output from source.
 * `build` and `dist` are kept when the directory itself holds a manifest
 * (package.json / pubspec.yaml): that is a real package named like a build dir (e.g.
 * honojs `packages/build`), not build output.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ...ALWAYS_SKIP_DIRS, 'build', 'dist', 'vendor', 'third_party',
]);
const OUTPUT_DIRS: ReadonlySet<string> = new Set(['build', 'dist']);
const MANIFEST_NAMES = ['package.json', 'pubspec.yaml'];

export const DEFAULT_IGNORE_MANIFEST_DIRS: readonly string[] = Object.freeze([
  'fixtures', '__fixtures__', 'fixture', 'templates', 'template', 'examples', 'example',
  'benchmarks', 'bench', 'playground', 'playgrounds', 'sandbox', '__mocks__', 'test', 'tests', '__tests__',
  'test_fixtures', 'test_fixture', 'testdata', 'test_data', 'golden', 'goldens',
]);

/** True if any directory segment of repo-relative `file` is in `dirs` (the basename is not checked). */
export function inIgnoredDir(file: string, dirs: ReadonlySet<string>): boolean {
  const segs = file.split('/');
  for (let i = 0; i < segs.length - 1; i++) if (dirs.has(segs[i]!)) return true;
  return false;
}

export interface ManifestOptions {
  /** Dir names whose manifests are not org packages; default DEFAULT_IGNORE_MANIFEST_DIRS. */
  ignoreDirs?: readonly string[];
  /** Extra per-manifest exclusion (repo-relative manifest path), e.g. org `ignoreManifests` globs. */
  ignoreManifest?: (manifest: string) => boolean;
  /** Informational log (one line per repo listing skipped manifests). */
  log?: (message: string) => void;
}

/**
 * Every file under `root`, as sorted POSIX paths relative to `root` (sorted per
 * directory level: 'a/b' before 'a-c').
 *
 * - Git checkout (`root/.git` exists): `git ls-files -z --cached --others
 *   --exclude-standard`, i.e. tracked files plus untracked files that are not
 *   ignored, so .gitignore decides what is build output. Only ALWAYS_SKIP_DIRS are
 *   skipped by name; symlinks, submodules and tracked-but-deleted files are dropped.
 *   If git fails, falls back to the walk below.
 * - Otherwise: a filesystem walk skipping SKIP_DIRS by name at any depth, except a
 *   `build` / `dist` dir that contains a manifest. Symlinks are not followed (a
 *   symlinked dir could loop or escape the repo).
 */
export function listFiles(root: string): string[] {
  if (existsSync(join(root, '.git'))) {
    const files = gitListFiles(root);
    if (files) return files;
  }
  return walkFiles(root);
}

function gitListFiles(root: string): string[] | null {
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] });
  let out: string;
  try {
    // `root` must be the work tree's top level: a broken or bare `.git` inside some
    // other checkout would otherwise make git answer for the enclosing repository.
    if (git(['rev-parse', '--show-cdup']).trim() !== '') return null;
    out = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  } catch {
    return null;
  }
  const seen = new Set<string>();
  for (const f of out.split('\0')) {
    if (f === '' || seen.has(f)) continue; // --cached lists each stage of a conflicted file
    const segs = f.split('/');
    if (segs.some((seg) => ALWAYS_SKIP_DIRS.has(seg))) continue;
    try {
      if (!lstatSync(join(root, f)).isFile()) continue;
    } catch {
      continue; // tracked but deleted from the working tree
    }
    seen.add(f);
  }
  return [...seen].sort(comparePaths);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const entries = readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child);
        else if (OUTPUT_DIRS.has(e.name) && MANIFEST_NAMES.some((m) => existsSync(join(root, child, m)))) walk(child);
      } else if (e.isFile()) {
        out.push(child);
      }
    }
  };
  walk('');
  return out;
}

/** Path order of the walk: segment by segment, each by code unit. */
function comparePaths(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * A manifest skipped as "not an org package" (ignored dir or `ignoreManifest`),
 * parsed only for its deps. Its code is not indexed and it never becomes a
 * package; the text witness scans it as an extra consumer (PLAN §12: unindexed
 * code may block or downgrade, never add edges).
 */
export interface IgnoredManifest {
  /** Manifest dir relative to the repo root, POSIX; '.' for the root. */
  path: string;
  /** Manifest file relative to the repo root, POSIX. */
  manifest: string;
  manager: Manager;
  /** Declared name, or null when absent. */
  name: string | null;
  /** Sorted by name; one entry per name. [] when the manifest could not be parsed. */
  deps: ManifestDep[];
  /**
   * True when the manifest could not be parsed (warned): its deps are unknown, so
   * the witness treats it as a consumer of every package (fail closed).
   */
  depsUnknown: boolean;
}

export interface RepoManifests {
  packages: ManifestPackage[];
  /** Sorted by (path, manager). */
  ignored: IgnoredManifest[];
}

/**
 * Find and parse every manifest in a repo. Packages without a name are skipped with
 * a warning. Manifests under an ignored dir (`opts.ignoreDirs`) or rejected by
 * `opts.ignoreManifest` are skipped as packages, reported in one `opts.log` line.
 */
export function readRepoManifests(
  repoRoot: string, warn: Warn = () => {}, files: readonly string[] = listFiles(repoRoot), opts: ManifestOptions = {},
): ManifestPackage[] {
  return readRepoManifestsWithIgnored(repoRoot, warn, files, opts).packages;
}

/**
 * readRepoManifests plus the skipped manifests, parsed just enough to know their
 * deps (IgnoredManifest). A malformed ignored manifest is a warning, not an error;
 * it is recorded with `depsUnknown: true`.
 */
export function readRepoManifestsWithIgnored(
  repoRoot: string, warn: Warn = () => {}, files: readonly string[] = listFiles(repoRoot), opts: ManifestOptions = {},
): RepoManifests {
  const ignoreDirs = new Set(opts.ignoreDirs ?? DEFAULT_IGNORE_MANIFEST_DIRS);
  const pkgs: ManifestPackage[] = [];
  const ignored: IgnoredManifest[] = [];
  const skipped: string[] = [];
  const vscode: string[] = [];
  for (const file of files) {
    const base = posix.basename(file);
    if (base !== 'package.json' && base !== 'pubspec.yaml') continue;
    const dir = posix.dirname(file); // '.' for the root
    if (inIgnoredDir(file, ignoreDirs) || opts.ignoreManifest?.(file)) {
      skipped.push(file);
      ignored.push(readIgnoredManifest(repoRoot, dir, base === 'package.json' ? 'npm' : 'pub', warn));
      continue;
    }
    if (base === 'package.json' && isVscodeExtension(repoRoot, file)) {
      vscode.push(file);
      ignored.push(readIgnoredManifest(repoRoot, dir, 'npm', warn));
      continue;
    }
    const pkg = base === 'package.json'
      ? readNpmPackage(repoRoot, dir, files, warn, opts.log)
      : readPubPackage(repoRoot, dir, files, warn);
    if (pkg) pkgs.push(pkg);
  }
  if (skipped.length > 0) {
    opts.log?.(`skipped ${skipped.length} manifest(s) as not org packages (ignoreManifestDirs/ignoreManifests): ${
      skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ', ...' : ''}`);
  }
  if (vscode.length > 0) {
    opts.log?.(`skipped ${vscode.length} VS Code extension manifest(s) (engines.vscode) as not org packages: ${
      vscode.slice(0, 3).join(', ')}${vscode.length > 3 ? ', ...' : ''}`);
  }
  pkgs.sort((a, b) => cmp(a.path, b.path) || cmp(a.manager, b.manager));
  ignored.sort((a, b) => cmp(a.path, b.path) || cmp(a.manager, b.manager));
  return { packages: pkgs, ignored };
}

/**
 * A package.json with `engines.vscode` is a VS Code extension: installed into the
 * editor, never imported, so not an org package (its code is scanned by the witness
 * like any ignored manifest). A manifest that does not parse is not one here;
 * readNpmPackage reports the parse error.
 */
function isVscodeExtension(repoRoot: string, manifest: string): boolean {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'));
  } catch {
    return false;
  }
  if (!isObject(json)) return false;
  const engines = json['engines'];
  return isObject(engines) && engines['vscode'] !== undefined;
}

/** Parse an ignored manifest for its name and deps only; parse errors are warnings. */
function readIgnoredManifest(repoRoot: string, dir: string, manager: Manager, warn: Warn): IgnoredManifest {
  const manifest = joinRel(dir, manager === 'npm' ? 'package.json' : 'pubspec.yaml');
  const out: IgnoredManifest = { path: dir, manifest, manager, name: null, deps: [], depsUnknown: false };
  let doc: Record<string, unknown>;
  try {
    const text = readFileSync(join(repoRoot, manifest), 'utf8');
    const parsed: unknown = manager === 'npm' ? JSON.parse(text) : parsePubspecYaml(text);
    if (!isObject(parsed)) throw new Error('not an object');
    doc = parsed;
  } catch (err) {
    warn(`${manifest} (ignored manifest): cannot parse: ${(err as Error).message}; its deps are unknown`);
    out.depsUnknown = true;
    return out;
  }
  const name = doc['name'];
  out.name = typeof name === 'string' && name !== '' ? name : null;
  out.deps = manager === 'npm' ? npmDeps(doc, manifest, warn) : pubDeps(doc as YamlMap, manifest, warn);
  return out;
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

const NPM_DEP_FIELDS_NON_DEV = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Extensions an entry file may have. Extension-less files (bin scripts) are kept too. */
const CODE_EXT = /\.[cm]?[jt]sx?$/;

/** Parse one package.json. `dir` is the package dir relative to the repo root. */
export function readNpmPackage(
  repoRoot: string, dir: string, repoFiles: readonly string[] | null, warn: Warn = () => {}, log: Warn = () => {},
): ManifestPackage | null {
  const manifest = joinRel(dir, 'package.json');
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(repoRoot, manifest), 'utf8'));
  } catch (err) {
    // Fail closed: silently dropping a manifest could hide a consumer.
    throw new Error(`sentei: cannot parse ${manifest}: ${(err as Error).message}`);
  }
  if (!isObject(json)) throw new Error(`sentei: ${manifest} is not a JSON object`);
  const name = json['name'];
  if (typeof name !== 'string' || name === '') {
    warn(`${manifest}: no "name", skipped`);
    return null;
  }
  const version = typeof json['version'] === 'string' ? json['version'] : null;

  const files = repoFiles ?? listFiles(repoRoot);
  const resolved = resolveNpmEntryPoints(dir, json, files, warn, tsconfigOutDirs(repoRoot, dir, packageFiles(dir, files)));
  const { unresolved } = resolved;
  const clientAll = clientEntryPoints(repoRoot, dir, files);
  const client = clientAll.filter((f) => !resolved.entryPoints.includes(f));
  if (client.length > 0) log(`${manifest}: client entry points from index.html / vite.config: ${client.join(', ')}`);
  const deps = npmDeps(json, manifest, warn);
  const scripts = isObject(json['scripts'])
    ? Object.values(json['scripts']).filter((v): v is string => typeof v === 'string') : [];
  const conventionAll = conventionEntryPoints(repoRoot, dir, files, new Set(deps.map((d) => d.name)), scripts);
  const runtimeEntrySymbols = wranglerRuntimeClasses(repoRoot, dir, files);
  const convention = conventionAll.filter((f) => !resolved.entryPoints.includes(f) && !clientAll.includes(f));
  if (convention.length > 0) {
    log(`${manifest}: ${convention.length} runtime entry point(s) by convention (wrangler main, functions/, routes/, node|tsx <file> scripts, Dockerfile CMD…): ${
      convention.slice(0, 5).join(', ')}${convention.length > 5 ? ', ...' : ''}`);
  }
  const entryPoints = [...new Set([...resolved.entryPoints, ...client, ...convention])].sort(cmp);
  if (resolved.noneResolved && entryPoints.length === 0) warn(`${manifest}: no entry points resolved`);
  // Runtime-loaded files that are not also declared surface (main/exports/…). The index
  // fallback is a guess, not a declaration: a convention naming it (a wrangler main at
  // src/index.ts, with no package.json entry) makes it a runtime entry.
  const runtimeEntryPoints = [...new Set([...resolved.runtime, ...clientAll, ...conventionAll])]
    .filter((f) => f === resolved.fallback || !resolved.surface.includes(f)).sort(cmp);
  return {
    manager: 'npm',
    name,
    version,
    visibility: npmVisibility(json, manifest, warn),
    isLibrary: ['exports', 'types', 'typings', 'module'].some((k) => json[k] !== undefined),
    path: dir,
    manifest,
    entryPoints,
    unresolvedEntryPoints: unresolved,
    runtimeEntryPoints,
    ...(runtimeEntrySymbols.length > 0 ? { runtimeEntrySymbols } : {}),
    deps,
  };
}

/**
 * npm deps: first non-dev field wins; devDependencies only if the name is nowhere else
 * (then `dev: true`). Sorted by name.
 */
function npmDeps(json: Record<string, unknown>, manifest: string, warn: Warn): ManifestDep[] {
  const deps = new Map<string, ManifestDep>();
  for (const field of [...NPM_DEP_FIELDS_NON_DEV, 'devDependencies'] as const) {
    const block = json[field];
    if (block === undefined) continue;
    if (!isObject(block)) {
      warn(`${manifest}: "${field}" is not an object, ignored`);
      continue;
    }
    for (const [dep, spec] of Object.entries(block)) {
      if (deps.has(dep)) continue;
      const d: ManifestDep = { name: dep, manager: 'npm', constraint: typeof spec === 'string' ? spec : null };
      if (field === 'devDependencies') d.dev = true;
      deps.set(dep, d);
    }
  }
  return [...deps.values()].sort((a, b) => cmp(a.name, b.name));
}

/** PLAN §6.1 step 5 (npm). */
export function npmVisibility(json: Record<string, unknown>, manifest = 'package.json', warn: Warn = () => {}): Visibility {
  if (json['private'] === true) return 'private';
  const pc = json['publishConfig'];
  if (isObject(pc) && typeof pc['registry'] === 'string' && pc['registry'] !== '') {
    let host: string;
    try {
      host = new URL(pc['registry']).hostname;
    } catch {
      // Unparseable registry: assume public (the fail-closed choice; public is never closed-world).
      warn(`${manifest}: publishConfig.registry ${JSON.stringify(pc['registry'])} is not a URL; treated as public`);
      return 'published-public';
    }
    // registry.yarnpkg.com is a mirror of the public npm registry.
    return host === 'registry.npmjs.org' || host === 'registry.yarnpkg.com' ? 'published-public' : 'published-private';
  }
  return 'published-public';
}

/**
 * Entry points (PLAN §6.3 step 4): `main`, `module`, `types`/`typings`, `bin`
 * (string or object), `browser` if a string, and every string leaf of `exports`
 * (all conditions, nested objects, arrays; `null` exclusions ignored). A `*` in
 * an `exports` target is resolved against the filesystem.
 *
 * Each declared path is resolved relative to the package dir by, in order:
 *   1. the file itself;
 *   2. Node's extension/directory probing: `<p>.{ts,tsx,js,mjs,cjs,jsx}`, `<p>/index.*`;
 *      and the TypeScript source beside built output: `<p>` with its extension
 *      (`.js .mjs .cjs .jsx .d.ts .d.mts .d.cts`) replaced by `.ts .tsx .mts .cts`;
 *   3. dist→src mapping for unbuilt TS repos, in priority order:
 *      a. the package's own tsconfigs (TsOutDir, from tsconfigOutDirs): `<p>` under an
 *         `outDir` maps to the same path under that config's `rootDir`, so a package
 *         built twice (`tsconfig.json` → `dist/main`, `tsconfig.module.json` →
 *         `dist/module`, both rootDir `src`) maps `dist/module/index.d.ts` → `src/index.ts`;
 *      b. the convention below;
 *      c. one leading output segment stripped (`dist/<seg>/rest` → `src/rest`), only
 *         when nothing under `src/<seg>` exists (then `<seg>` is a subpath, not a format),
 *         and never for a `*` pattern;
 *      the convention: if `<p>` starts with `dist/`, `lib/`,
 *      `build/` or `out/`, replace that first segment with `src/` and the
 *      extension (`.js .mjs .cjs .jsx .d.ts .d.mts .d.cts`) with `.ts`, then `.tsx`
 *      (then `.d.ts` for a declaration leaf: `dist/types.d.mts` → `src/types.d.ts`),
 *      then `/index.ts`, `/index.tsx` (`dist/vue.mjs` → `src/vue/index.ts`); a stem
 *      ending in `/index` also tries the parent (`dist/x/index.js` → `src/x.ts`).
 * Paths that resolve to nothing are dropped from the entry points (npm manifests
 * routinely point at build output that the mapping cannot always find). Only
 * code-looking files are kept (see CODE_EXT) plus extension-less files (shebang bin
 * scripts), so `"./package.json"` exports are ignored.
 * If nothing resolves, fall back to the first existing of index.{ts,tsx,js,mjs,cjs},
 * src/index.{ts,tsx}.
 */
export function npmEntryPoints(
  dir: string, json: Record<string, unknown>, repoFiles: readonly string[], warn: Warn = () => {},
): string[] {
  const r = resolveNpmEntryPoints(dir, json, repoFiles, warn);
  if (r.noneResolved) warn(`${joinRel(dir, 'package.json')}: no entry points resolved`);
  return r.entryPoints;
}

/**
 * npmEntryPoints plus `unresolved`: every code-looking (CODE_EXT) `main` / `module` /
 * `types` / `typings` leaf that resolved to no file, and the code-looking leaves (a `*`
 * pattern included) of every `exports` ENTRY (subpath key) none of whose conditions
 * resolved (one resolving condition makes the entry fine), as written, sorted,
 * deduplicated. `bin` and `browser` are not checked (bins
 * are scripts run by name, not import surface). The index fallback does not clear them.
 */
export function resolveNpmEntryPoints(
  dir: string, json: Record<string, unknown>, repoFiles: readonly string[], warn: Warn = () => {},
  outDirs: readonly TsOutDir[] = [],
):{ entryPoints: string[]; unresolved: string[]; runtime: string[]; surface: string[]; fallback: string | null; noneResolved: boolean } {
  // `entry`: the exports entry (subpath key) a leaf belongs to; undefined outside exports.
  const declared: Array<{ path: string; surface: boolean; entry?: string }> = [];
  const patterns: Array<{ path: string; entry: string }> = [];
  for (const key of ['main', 'module', 'types', 'typings'] as const) {
    const v = json[key];
    if (typeof v === 'string') declared.push({ path: v, surface: true });
  }
  // `bin` targets are run, never imported: runtime entry points only (never in
  // entryPoints, so a bin outside the TS program cannot make the adapter report a missing
  // entry and the package `partial`); ingest seeds their documents.
  const bins: string[] = [];
  const bin = json['bin'];
  if (typeof bin === 'string') bins.push(bin);
  else if (isObject(bin)) for (const v of Object.values(bin)) if (typeof v === 'string') bins.push(v);
  if (typeof json['browser'] === 'string') declared.push({ path: json['browser'], surface: false });
  for (const [entry, value] of exportEntries(json['exports'])) {
    collectExportLeaves(value, (leaf) => {
      if (leaf.includes('*')) patterns.push({ path: leaf, entry });
      else declared.push({ path: leaf, surface: true, entry });
    });
  }
  const unresolved = new Set<string>();
  // Per exports entry: its code-looking leaves that resolved to nothing, and whether any
  // leaf resolved. An entry is unresolved only when NONE of its conditions resolves
  // (hono: `require` → ./dist/cjs/… is unbuilt, `import` → src/… resolves: fine).
  const entryMisses = new Map<string, string[]>();
  const entryOk = new Set<string>();
  const noteEntry = (entry: string | undefined, leaf: string, ok: boolean, code: boolean): boolean => {
    if (entry === undefined) return false;
    if (ok) entryOk.add(entry);
    else if (code) entryMisses.set(entry, [...(entryMisses.get(entry) ?? []), leaf]);
    return true;
  };

  const pkgFiles = packageFiles(dir, repoFiles);
  const pkgFileSet = new Set(pkgFiles);
  const layout: SourceLayout = { files: pkgFileSet, outDirs };
  const found = new Set<string>();
  const add = (rel: string | null): void => {
    if (rel === null) return;
    if (!CODE_EXT.test(rel) && posix.extname(rel) !== '') return;
    found.add(joinRel(dir, rel));
  };
  for (const { path: p, surface, entry } of declared) {
    const n = normalizeRel(p);
    if (n === null) {
      warn(`${joinRel(dir, 'package.json')}: entry ${JSON.stringify(p)} escapes the package, ignored`);
      continue;
    }
    const r = resolveEntry(n, layout);
    if (!noteEntry(entry, p, r !== null, CODE_EXT.test(n)) && r === null && surface && CODE_EXT.test(n)) unresolved.add(p);
    add(r);
  }
  // `files` (what npm publishes) bounds what an exports `*` pattern can match: with
  // `files: ["dist"]`, `"./*": "./*"` does not publish `eslint.config.mjs` or tests.
  const published = publishedFilter(json['files']);
  for (const { path: p, entry } of patterns) {
    const n = normalizeRel(p);
    if (n === null) continue;
    // The pattern as written; only if it matches nothing, its dist→src variants, one group
    // at a time (.ts and .tsx together; the index variants only if those match nothing: a
    // `*` spans `/`, so `src/x/*.ts` for `dist/x/*/index.mjs` would also catch helpers).
    // A dist→src variant stands for the written (built) path, so `files` is checked on that.
    let matched = false;
    for (const [i, variants] of [[n], ...distToSrcGroups(n, layout)].entries()) {
      const res = variants.map(exportPatternRegExp);
      const ok = (f: string): boolean => (i === 0 ? published(f) : published(n.replaceAll('*', 'x')));
      const hits = pkgFiles.filter((f) => patternFileOk(f, variants) && ok(f) && res.some((re) => re.test(f)));
      hits.forEach(add);
      if (hits.length > 0) {
        matched = true;
        break;
      }
    }
    noteEntry(entry, p, matched, CODE_EXT.test(n));
  }
  for (const [entry, misses] of entryMisses) if (!entryOk.has(entry)) misses.forEach((m) => unresolved.add(m));
  const binFiles: string[] = [];
  for (const b of bins) {
    const n = normalizeRel(b);
    if (n === null) {
      warn(`${joinRel(dir, 'package.json')}: bin ${JSON.stringify(b)} escapes the package, ignored`);
      continue;
    }
    const r = resolveEntry(n, layout);
    if (r !== null && (CODE_EXT.test(r) || posix.extname(r) === '')) binFiles.push(joinRel(dir, r));
  }
  let fallback: string | null = null;
  if (found.size === 0 && binFiles.length === 0) {
    for (const f of ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs', 'src/index.ts', 'src/index.tsx']) {
      if (pkgFileSet.has(f)) {
        fallback = joinRel(dir, f);
        found.add(fallback);
        break;
      }
    }
  }
  // (The "no entry points resolved" warning is the caller's: a runtime convention may
  // still supply entries, e.g. a wrangler `main`.)
  const noneResolved = found.size === 0 && binFiles.length === 0;
  // Subpath imports (`imports: { "#crypto": { node: "./lib/digest.node.mjs", default:
  // "./lib/digest.mjs" } }`): every condition target is a file the package may load at
  // runtime, and TypeScript follows only one of them, so each one that resolves to a
  // local code file is an entry point (ocache: the arm tsc did not pick was
  // private_dead). Internal wiring, not surface: never `unresolved`; after the index
  // fallback, which is about the package's declared surface.
  const surface = [...found];
  const before = new Set(found);
  for (const leaf of importsLeaves(json['imports'])) {
    const n = normalizeRel(leaf);
    if (n === null || !CODE_EXT.test(n)) continue;
    if (n.includes('*')) {
      const re = exportPatternRegExp(n);
      pkgFiles.filter((f) => patternFileOk(f, [n]) && re.test(f)).forEach(add);
    } else {
      add(resolveEntry(n, layout));
    }
  }
  const runtime = [...new Set([...[...found].filter((f) => !before.has(f)), ...binFiles.filter((f) => !found.has(f))])];
  return {
    entryPoints: [...found].sort(cmp), unresolved: [...unresolved].sort(cmp), runtime: runtime.sort(cmp), surface: surface.sort(cmp), fallback, noneResolved,
  };
}

/**
 * Browser entry points a bundler (Vite) loads with no import from code: every
 * `<script … src="…">` of an HTML file at the package root (`index.html`, other
 * `*.html`), and every string value after `input:` in a package-root `vite.config.*`
 * (`input: 'x'`, `input: { a: 'x', b: 'y' }`, `input: ['x']`, also inside
 * `resolve(__dirname, 'x')`); an `input` that is itself an HTML file of the package
 * contributes its scripts (resolved relative to that file; a leading `/` means the
 * package root, as in Vite). Only targets that resolve to a local code file are kept
 * (repo-relative, sorted). Dumb text scanning on purpose: it only ever adds entries.
 */
export function clientEntryPoints(repoRoot: string, dir: string, repoFiles: readonly string[]): string[] {
  const pkgFiles = packageFiles(dir, repoFiles);
  const fileSet = new Set(pkgFiles);
  const out = new Set<string>();
  const read = (rel: string): string => {
    try {
      return readFileSync(join(repoRoot, joinRel(dir, rel)), 'utf8');
    } catch {
      return '';
    }
  };
  /** Resolve `target` (from a file in package dir `base`) to a package file; null if not local code. */
  const resolveLocal = (target: string, base: string): string | null => {
    if (/^[a-z][\w+.-]*:|^\/\//i.test(target)) return null; // URL
    const clean = target.split(/[?#]/)[0]!;
    const n = normalizeRel(clean.startsWith('/') ? clean.slice(1) : base === '' ? clean : `${base}/${clean}`);
    if (n === null || n === '') return null;
    return fileSet.has(n) ? n : resolveEntry(n, { files: fileSet, outDirs: [] });
  };
  const scripts = (html: string): void => {
    const base = posix.dirname(html) === '.' ? '' : posix.dirname(html);
    const re = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
    const text = read(html);
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const r = resolveLocal(m[1]!, base);
      if (r !== null && CODE_EXT.test(r)) out.add(r);
    }
  };
  for (const f of pkgFiles) if (!f.includes('/') && f.endsWith('.html')) scripts(f);
  for (const cfg of pkgFiles.filter((f) => /^vite\.config\.[cm]?[jt]s$/.test(f))) {
    const text = read(cfg);
    const inputRe = /\binput\s*:\s*/g;
    for (let m = inputRe.exec(text); m; m = inputRe.exec(text)) {
      const at = m.index + m[0].length;
      let end = at;
      const open = text[at];
      if (open === '{' || open === '[') {
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        for (end = at; end < text.length; end += 1) {
          if (text[end] === open) depth += 1;
          else if (text[end] === close && --depth === 0) break;
        }
      } else {
        end = text.slice(at).search(/[,\n}]/);
        end = end === -1 ? text.length : at + end;
      }
      for (const lit of text.slice(at, end + 1).matchAll(/(['"`])([^'"`\n]+)\1/g)) {
        const target = lit[2]!;
        const r = resolveLocal(target, '');
        if (r === null) continue;
        if (r.endsWith('.html')) scripts(r);
        else if (CODE_EXT.test(r)) out.add(r);
      }
    }
  }
  return [...out].map((f) => joinRel(dir, f)).sort(cmp);
}

/**
 * Runtime entry conventions: files a platform or framework loads BY PATH, with no import
 * from code and no manifest field naming them. One row per convention: `files` = the
 * condition "one of these package-relative files exists" (omitted: unconditional),
 * `deps` = "one of these is a declared dependency" (any block, dev included),
 * `scripts` = "some package.json `scripts` value matches", all required when several are
 * given, unless `any` (then one suffices); `globs` = the package-relative files it loads
 * (glob.ts syntax). Only code files (CODE_EXT), never a `.d.ts` (ambient declarations
 * are not loaded: they are the adapter's `entrySymbols` kind 'ambient'), never a test
 * file (TEST_GLOBS), a dot dir, `node_modules`, or a file inside a nested package.
 * Dumb on purpose: it only ever adds runtime entries. The wrangler `main` field is read
 * separately (wranglerMain).
 */
const RUNTIME_ENTRY_CONVENTIONS: ReadonlyArray<{
  what: string; files?: string[]; deps?: string[]; scripts?: RegExp; any?: true; globs: string[];
}> = [
  // Cloudflare Pages Functions: file-based routes under functions/. A Pages project may
  // have no wrangler config at all (honojs examples/pages-stack): a wrangler dependency
  // or a `wrangler pages …` script is enough.
  {
    what: 'Cloudflare Pages Functions', any: true,
    files: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', '_routes.json', 'public/_routes.json'],
    deps: ['wrangler'], scripts: /\bwrangler\s+pages\b/, globs: ['functions/**'],
  },
  // HonoX: app/server.ts and app/client.ts are the server / client entries; routes and
  // islands are loaded by the file router (app/global.d.ts is ambient, not an entry).
  { what: 'HonoX', deps: ['honox'], globs: ['app/server.*', 'app/client.*', 'app/routes/**', 'app/islands/**'] },
  // Netlify Functions (the directory name is the convention; no config needed).
  { what: 'Netlify Functions', globs: ['netlify/functions/**', 'netlify/edge-functions/**'] },
  // Vercel Functions: api/ at the project root.
  { what: 'Vercel Functions', files: ['vercel.json'], globs: ['api/**'] },
  // Next.js: pages router and app router, at the root or under src/.
  { what: 'Next.js', deps: ['next'], globs: ['pages/**', 'app/**', 'src/pages/**', 'src/app/**'] },
  // SvelteKit / SolidStart file routers.
  { what: 'SvelteKit / SolidStart', deps: ['@sveltejs/kit', '@solidjs/start'], globs: ['src/routes/**'] },
  // Nuxt: pages/ (file router) and server/ (Nitro api/routes/middleware/plugins).
  { what: 'Nuxt', deps: ['nuxt'], globs: ['pages/**', 'server/**'] },
];

/** Wrangler config files whose `main` is the Worker's entry module. */
const WRANGLER_CONFIGS = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];

/**
 * The `main` of a package-root wrangler config (package-relative, as written): in TOML
 * only top-level keys (before the first `[table]`); in JSON/JSONC any `"main": "…"`
 * (an `env` override adds another). Text scanning, no parser.
 */
function wranglerMain(read: (rel: string) => string, cfg: string): string[] {
  const text = read(cfg);
  if (cfg.endsWith('.toml')) {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*main\s*=\s*["']([^"']+)["']/.exec(line);
      if (m) out.push(m[1]!);
    }
    return out;
  }
  return [...text.matchAll(/"main"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
}

/**
 * The entry module passed on a `wrangler dev <file>` / `wrangler deploy <file>` (or the
 * legacy `publish`) command line in a package.json script, package-relative as written:
 * the first non-flag argument that looks like code. `wrangler pages …` is not a Worker.
 */
function wranglerScriptMains(scripts: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of scripts) {
    for (const m of s.matchAll(/\bwrangler\s+(?:dev|deploy|publish)\b([^&|;]*)/g)) {
      const arg = m[1]!.trim().split(/\s+/).find((t) => t !== '' && !t.startsWith('-'));
      const unq = arg?.replace(/^["']|["']$/g, '');
      if (unq !== undefined && CODE_EXT.test(unq)) out.push(unq);
    }
  }
  return out;
}

/**
 * Class names a package-root wrangler config makes the runtime instantiate by name:
 * `class_name` (Durable Object and Workflow bindings, TOML `[[durable_objects.bindings]]`
 * blocks, inline tables or JSON objects, `env` overrides included) and the
 * `new_classes` / `new_sqlite_classes` arrays of `migrations`. Text scanning, no parser;
 * it only ever adds seeds (a `script_name` binding naming another Worker's class matches
 * nothing here). Sorted, deduplicated.
 */
export function wranglerRuntimeClasses(repoRoot: string, dir: string, repoFiles: readonly string[]): string[] {
  const fileSet = new Set(packageFiles(dir, repoFiles));
  const out = new Set<string>();
  for (const cfg of WRANGLER_CONFIGS.filter((f) => fileSet.has(f))) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, joinRel(dir, cfg)), 'utf8');
    } catch {
      continue;
    }
    const toml = cfg.endsWith('.toml');
    const name = toml ? /\bclass_name\s*=\s*["']([^"']+)["']/g : /"class_name"\s*:\s*"([^"]+)"/g;
    for (const m of text.matchAll(name)) out.add(m[1]!);
    const arr = toml ? /\bnew_(?:sqlite_)?classes\s*=\s*\[([^\]]*)\]/g : /"new_(?:sqlite_)?classes"\s*:\s*\[([^\]]*)\]/g;
    for (const m of text.matchAll(arr)) {
      for (const lit of m[1]!.matchAll(/["']([^"']+)["']/g)) out.add(lit[1]!);
    }
  }
  return [...out].filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)).sort(cmp);
}

/**
 * Runtime entry points by convention (RUNTIME_ENTRY_CONVENTIONS, wrangler `main`, else a
 * `wrangler dev|deploy <file>` script; the file of a `node|tsx|bun|… <file>` script
 * (runnerTargets) or Dockerfile CMD/ENTRYPOINT (dockerfileTargets), build output mapped
 * to source; Next.js files loaded by name (nextConventionFiles)) of the npm package at
 * `dir`, repo-relative, sorted.
 * `scripts` = the package.json `scripts` values.
 */
export function conventionEntryPoints(
  repoRoot: string, dir: string, repoFiles: readonly string[], deps: ReadonlySet<string>, scripts: readonly string[] = [],
): string[] {
  const pkgFiles = packageFiles(dir, repoFiles);
  const fileSet = new Set(pkgFiles);
  const nested = pkgFiles
    .filter((f) => f.includes('/') && MANIFEST_NAMES.includes(posix.basename(f)))
    .map((f) => `${posix.dirname(f)}/`);
  const ok = (f: string): boolean => CODE_EXT.test(f) && !/\.d\.[cm]?ts$/.test(f)
    && !f.split('/').some((s) => s.startsWith('.') || s === 'node_modules')
    && !TEST_GLOBS.some((g) => matchGlob(g, f))
    && !nested.some((n) => f.startsWith(n));
  const out = new Set<string>();
  for (const c of RUNTIME_ENTRY_CONVENTIONS) {
    const conds: boolean[] = [];
    if (c.files) conds.push(c.files.some((f) => fileSet.has(f)));
    if (c.deps) conds.push(c.deps.some((d) => deps.has(d)));
    if (c.scripts) conds.push(scripts.some((s) => c.scripts!.test(s)));
    if (c.any ? conds.length > 0 && !conds.includes(true) : conds.includes(false)) continue;
    for (const f of pkgFiles) if (ok(f) && c.globs.some((g) => matchGlob(g, f))) out.add(f);
  }
  const read = (rel: string): string => {
    try {
      return readFileSync(join(repoRoot, joinRel(dir, rel)), 'utf8');
    } catch {
      return '';
    }
  };
  const mains = WRANGLER_CONFIGS.filter((f) => fileSet.has(f)).flatMap((cfg) => wranglerMain(read, cfg));
  // No `main` in any config: the entry may be passed on the command line.
  // Files a runtime is started on: `node dist/server.js` / `tsx src/x.ts` in any
  // package.json script, a package-root Dockerfile's CMD / ENTRYPOINT. Build output is
  // mapped to its source like a declared entry (tsconfig outDirs first).
  const layout: SourceLayout = { files: fileSet, outDirs: tsconfigOutDirs(repoRoot, dir, pkgFiles) };
  const launched = [
    ...(mains.length > 0 ? mains : wranglerScriptMains(scripts)),
    ...scripts.flatMap(runnerTargets),
    ...pkgFiles.filter(isDockerfile).flatMap((f) => dockerfileTargets(read(f))),
  ];
  for (const main of launched) {
    const n = normalizeRel(main);
    const r = n === null || n === '' ? null : resolveEntry(n, layout);
    if (r !== null && ok(r)) out.add(r);
  }
  if (deps.has('next')) for (const f of nextConventionFiles(fileSet)) if (ok(f)) out.add(f);
  return [...out].map((f) => joinRel(dir, f)).sort(cmp);
}

/** Commands that run the file named by their first positional argument. */
const SCRIPT_RUNNERS = new Set([
  'node', 'nodejs', 'tsx', 'ts-node', 'ts-node-esm', 'ts-node-script', 'bun', 'deno', 'nodemon', 'vite-node',
  'esno', 'esr', 'esrun', 'jiti', 'babel-node', 'node-dev', 'ts-node-dev', 'tsnd',
]);
/** Runner flags whose value is the next token (`node -r dotenv/config x.js`). */
const RUNNER_VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '-C', '--conditions',
  '--watch-path', '--tsconfig', '-P', '--project', '--config', '--ext', '--ignore', '--signal', '--delay',
]);
/** nodemon's own value flags (`nodemon -w src -e ts x.ts`; `-e` is not eval there). */
const NODEMON_VALUE_FLAGS = new Set(['-w', '--watch', '-e', '--ext', '-i', '--ignore', '-d', '--delay', '-s', '--signal', '--config']);
/** Flags meaning the code is inline, not a file (`node -e "…"`). */
const RUNNER_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);

/** Shell-ish tokens of one command line (quotes stripped; no expansion). */
function shellTokens(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/**
 * The code files a script command line starts a runtime on: after every runner token
 * (SCRIPT_RUNNERS, also as a path `./node_modules/.bin/tsx`) in each `&&` / `||` / `;` /
 * `|` segment, the first code-looking (CODE_EXT) positional argument, skipping flags
 * (with their value for RUNNER_VALUE_FLAGS / NODEMON_VALUE_FLAGS) and other positionals
 * (`tsx watch x.ts`, `bun run x.ts`, `nodemon -w src x.ts`); nothing after `-e` / `-p`
 * of a non-nodemon runner (inline code). `nodemon --exec node x.ts` works because the
 * inner `node` stops the scan and is scanned again as a runner. Package-relative as
 * written. Text scanning: it only ever adds entries (a target must also exist).
 */
export function runnerTargets(script: string): string[] {
  const out: string[] = [];
  for (const segment of script.split(/&&|\|\||;|\|/)) {
    const tokens = shellTokens(segment);
    for (let i = 0; i < tokens.length; i++) {
      const runner = posix.basename(tokens[i]!);
      if (!SCRIPT_RUNNERS.has(runner)) continue;
      const nodemon = runner === 'nodemon';
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j]!;
        if (SCRIPT_RUNNERS.has(posix.basename(t))) break; // `nodemon --exec node …`: the outer loop takes it
        if (t.startsWith('-')) {
          if (nodemon ? NODEMON_VALUE_FLAGS.has(t) : RUNNER_VALUE_FLAGS.has(t)) j++;
          else if (!nodemon && RUNNER_EVAL_FLAGS.has(t)) break;
          continue;
        }
        if (CODE_EXT.test(t) && !/^[a-z][\w+.-]*:/i.test(t)) {
          out.push(t);
          break;
        }
      }
    }
  }
  return out;
}

/** `Dockerfile`, `Dockerfile.prod`, `api.Dockerfile` at the package root. */
function isDockerfile(f: string): boolean {
  return !f.includes('/') && /^(?:Dockerfile(?:\.[\w.-]+)?|[\w.-]+\.[Dd]ockerfile)$/.test(f);
}

/**
 * Code files a Dockerfile's `CMD` / `ENTRYPOINT` starts (exec form `["node", "dist/x.js"]`
 * or shell form), as runnerTargets of: the last ENTRYPOINT followed by the last CMD (its
 * arguments), each alone, and every earlier one. An absolute path under the last
 * `WORKDIR` is made relative to it (the build context is assumed to be the package
 * dir); other absolute paths are dropped. `HEALTHCHECK … CMD` lines are not commands.
 */
export function dockerfileTargets(text: string): string[] {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  let workdir: string | null = null;
  const cmds: string[] = [];
  const entries: string[] = [];
  for (const line of lines) {
    const m = /^\s*(CMD|ENTRYPOINT|WORKDIR)\s+(.*)$/i.exec(line);
    if (!m) continue;
    const kind = m[1]!.toUpperCase();
    const arg = m[2]!.trim();
    if (kind === 'WORKDIR') {
      workdir = arg.replace(/\/+$/, '');
      continue;
    }
    let cmd = arg;
    if (arg.startsWith('[')) {
      try {
        const arr = JSON.parse(arg) as unknown;
        if (Array.isArray(arr)) cmd = arr.filter((x): x is string => typeof x === 'string').map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
      } catch {
        // Not valid exec form: scan the text as is.
      }
    }
    (kind === 'CMD' ? cmds : entries).push(cmd);
  }
  const lines2 = [...entries, ...cmds];
  if (entries.length > 0 && cmds.length > 0) lines2.push(`${entries.at(-1)} ${cmds.at(-1)}`);
  const out = new Set<string>();
  for (const t of lines2.flatMap(runnerTargets)) {
    if (!t.startsWith('/')) out.add(t);
    else if (workdir !== null && t.startsWith(`${workdir}/`)) out.add(t.slice(workdir.length + 1));
  }
  return [...out];
}

/**
 * Next.js files the framework loads by name (beyond the pages/app routers):
 * `next.config.*` at the project root, and `middleware`, `proxy` (Next 16's name for
 * middleware), `instrumentation`, `instrumentation-client` and `mdx-components`, which
 * Next reads from the dir holding the router: `src/` when the project uses `src/app` or
 * `src/pages` (and has no root `app/` or `pages/`, which would win), else the root. A
 * root `middleware.ts` in a `src/app` project is ignored by Next, so it is not an entry.
 */
function nextConventionFiles(fileSet: ReadonlySet<string>): string[] {
  const has = (d: string): boolean => {
    for (const f of fileSet) if (f.startsWith(`${d}/`)) return true;
    return false;
  };
  const base = !has('app') && !has('pages') && (has('src/app') || has('src/pages')) ? 'src/' : '';
  const names = ['middleware', 'proxy', 'instrumentation', 'instrumentation-client', 'mdx-components'];
  return [...fileSet].filter((f) => {
    if (/^next\.config\.[cm]?[jt]s$/.test(f)) return true;
    if (!f.startsWith(base) || f.slice(base.length).includes('/')) return false;
    const stem = f.slice(base.length).replace(/\.[cm]?[jt]sx?$/, '');
    return names.includes(stem) && CODE_EXT.test(f);
  });
}

/**
 * The package.json `files` field as a filter on package-relative paths: a listed dir
 * covers everything under it, a listed file itself, a glob (glob.ts syntax, plus a
 * bare `*.ext` for any depth) its matches; `!` negations are ignored. Absent or not
 * an array of strings: everything is published.
 */
function publishedFilter(files: unknown): (f: string) => boolean {
  if (!Array.isArray(files) || files.length === 0) return () => true;
  const entries = files.filter((e): e is string => typeof e === 'string' && !e.startsWith('!'))
    .map((e) => normalizeRel(e)).filter((e): e is string => e !== null && e !== '');
  if (entries.length === 0) return () => true;
  return (f) => entries.some((e) => (e.includes('*')
    ? matchGlob(e, f) || (!e.includes('/') && matchGlob(`**/${e}`, f))
    : f === e || f.startsWith(`${e}/`)));
}

/** Local string targets of a package.json `imports` map (`#x` keys; bare package targets skipped). */
function importsLeaves(v: unknown): string[] {
  const out: string[] = [];
  if (!isObject(v)) return out;
  for (const [k, target] of Object.entries(v)) {
    if (!k.startsWith('#')) continue;
    collectExportLeaves(target, (leaf) => {
      if (leaf.startsWith('./')) out.push(leaf);
    });
  }
  return out;
}

/**
 * The entries of an `exports` value: [subpath key, value] for a subpath map (keys
 * starting with `.`), else one entry `.` for the whole value (a string, an array, or a
 * conditions object).
 */
function exportEntries(v: unknown): Array<[string, unknown]> {
  if (v === undefined || v === null) return [];
  if (isObject(v) && Object.keys(v).some((k) => k.startsWith('.'))) {
    return Object.entries(v).filter(([k]) => k.startsWith('.'));
  }
  return [['.', v]];
}

function collectExportLeaves(v: unknown, out: (leaf: string) => void): void {
  if (typeof v === 'string') out(v);
  else if (Array.isArray(v)) v.forEach((x) => collectExportLeaves(x, out));
  else if (isObject(v)) Object.values(v).forEach((x) => collectExportLeaves(x, out));
}

/**
 * What entry resolution looks at: the package's files (package-relative) and its
 * tsconfig outDir→rootDir pairs (tsconfigOutDirs; longest outDir first).
 */
export interface SourceLayout {
  files: ReadonlySet<string>;
  outDirs: readonly TsOutDir[];
}

/** Resolve one declared entry (package-relative, normalized) against the package's files. */
function resolveEntry(p: string, layout: SourceLayout): string | null {
  const { files } = layout;
  if (files.has(p)) return p;
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']) if (files.has(p + ext)) return p + ext;
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']) {
    const idx = p === '' ? `index${ext}` : `${p}/index${ext}`;
    if (files.has(idx)) return idx;
  }
  // TypeScript source next to the declared output (`main.js` / `main.d.ts` → `main.ts`).
  if (BUILT_EXT.test(p)) {
    const stem = p.replace(BUILT_EXT, '');
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (files.has(stem + ext)) return stem + ext;
  }
  for (const alt of distToSrcGroups(p, layout).flat()) if (files.has(alt)) return alt;
  return null;
}

const BUILD_DIR = /^(?:dist|lib|build|out)\//;
const BUILT_EXT = /(?:\.d\.[cm]?ts|\.[cm]?js|\.jsx)$/;
/** Source extensions a tsconfig `rootDir` file may have (allowJs included). */
const ROOTDIR_SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * dist→src candidates in priority groups (see npmEntryPoints step 3):
 * a. per tsconfig outDir containing `p`: `<outDir>/x/y.js` → `<rootDir>/x/y.{ts,tsx,mts,cts,js…}`,
 *    then the index variants;
 * b. dist/foo.js → [[src/foo.ts, src/foo.tsx], [src/foo/index.ts, src/foo/index.tsx]];
 *    dist/x/index.js → [[src/x/index.ts, src/x/index.tsx], [src/x.ts, src/x.tsx]];
 * c. dist/<seg>/foo.js → src/foo.* (one leading output segment stripped), only when no
 *    package file sits at `src/<seg>.*` or under `src/<seg>/` (else `<seg>` is a subpath);
 *    never for a `*` pattern (`dist/gone/*.js` → `src/*.ts` would match every source).
 * [] if the path is not build-output-shaped.
 */
function distToSrcGroups(p: string, layout: SourceLayout): string[][] {
  if (!BUILT_EXT.test(p)) return [];
  const decl = /\.d\.[cm]?ts$/.test(p);
  const out: string[][] = [];
  for (const { outDir, rootDir } of layout.outDirs) {
    if (!p.startsWith(`${outDir}/`)) continue;
    const stem = joinRel(rootDir === '' ? '.' : rootDir, p.slice(outDir.length + 1)).replace(BUILT_EXT, '');
    out.push(...stemGroups(stem, rootDir, decl, ROOTDIR_SOURCE_EXT));
  }
  if (!BUILD_DIR.test(p)) return out;
  out.push(...stemGroups(p.replace(BUILD_DIR, 'src/').replace(BUILT_EXT, ''), 'src', decl, ['.ts', '.tsx']));
  const segs = p.split('/');
  if (segs.length >= 3 && !p.includes('*')) {
    const seg = segs[1]!;
    let taken = false;
    for (const f of layout.files) {
      if (f.startsWith(`src/${seg}/`) || f.startsWith(`src/${seg}.`)) {
        taken = true;
        break;
      }
    }
    if (!taken) {
      const stem = `src/${segs.slice(2).join('/')}`.replace(BUILT_EXT, '');
      out.push(...stemGroups(stem, 'src', decl, ['.ts', '.tsx', '.mts', '.cts']));
    }
  }
  return out;
}

/**
 * Candidate groups for one source stem under `root`: [stem.{exts}] (plus `stem.d.ts` for
 * a declaration leaf: `dist/types.d.mts` may come from a hand-written `src/types.d.ts`),
 * then `stem/index.{ts,tsx}`, or for a `…/index` stem its parent `.{ts,tsx}` (never
 * `root` itself: `dist/index.js` must not become `src.ts`).
 */
function stemGroups(stem: string, root: string, decl: boolean, exts: readonly string[]): string[][] {
  const out = [[...exts.map((e) => stem + e), ...(decl ? [`${stem}.d.ts`] : [])]];
  if (stem === 'index' || stem.endsWith('/index')) {
    const parent = stem === 'index' ? '' : stem.slice(0, -'/index'.length);
    if (parent !== root && parent !== '') out.push([`${parent}.ts`, `${parent}.tsx`]);
  } else {
    out.push([`${stem}/index.ts`, `${stem}/index.tsx`]);
  }
  return out;
}

/** One tsconfig's build mapping, package-relative ('' = the package dir). */
export interface TsOutDir {
  outDir: string;
  rootDir: string;
  /** The package-root tsconfig it came from (package-relative), for diagnostics. */
  config: string;
}

/**
 * outDir→rootDir pairs of every `tsconfig*.json` at the root of the npm package at `dir`
 * (`pkgFiles` package-relative), following relative `extends` (a string or an array;
 * `./x`, `./x.json`, `./dir` → `./dir/tsconfig.json`; up to 10 levels; paths set in a
 * base resolve against the base's dir, as tsc does). A base outside the repo or a
 * package-name `extends` (`@tsconfig/node20`) is ignored; unreadable or unparsable
 * configs are skipped (fewer mappings only means fewer entry points resolve, which
 * leaves the package flagged opaque: fail closed). No `rootDir`: the single non-glob
 * `include` entry if there is exactly one, else `src` when the package has files there,
 * else the package dir (tsc's own default, the common dir of the inputs, needs the
 * program). Pairs whose outDir or rootDir leaves the package, or whose rootDir is the
 * outDir or inside it, are dropped. Sorted longest outDir first.
 */
export function tsconfigOutDirs(repoRoot: string, dir: string, pkgFiles: readonly string[]): TsOutDir[] {
  const configs = pkgFiles.filter((f) => /^tsconfig[^/]*\.json$/.test(f)).sort(cmp);
  if (configs.length === 0) return [];
  const hasSrc = pkgFiles.some((f) => f.startsWith('src/'));
  const toPkg = (repoRel: string): string | null => {
    if (dir === '.') return repoRel === '.' ? '' : repoRel;
    if (repoRel === dir) return '';
    return repoRel.startsWith(`${dir}/`) ? repoRel.slice(dir.length + 1) : null;
  };
  const out = new Map<string, TsOutDir>();
  for (const cfg of configs) {
    const opts = readTsconfigChain(repoRoot, joinRel(dir, cfg), 0, new Set());
    if (opts === null || opts.outDir === undefined) continue;
    const outDir = toPkg(opts.outDir);
    if (outDir === null || outDir === '') continue;
    let rootDir: string | null;
    if (opts.rootDir !== undefined) rootDir = toPkg(opts.rootDir);
    else if (opts.include?.length === 1 && !/[*?]/.test(opts.include[0]!)) rootDir = toPkg(opts.include[0]!);
    else rootDir = hasSrc ? 'src' : '';
    if (rootDir === null || rootDir === outDir || rootDir.startsWith(`${outDir}/`)) continue;
    const key = `${outDir}\0${rootDir}`;
    if (!out.has(key)) out.set(key, { outDir, rootDir, config: cfg });
  }
  return [...out.values()].sort((a, b) => b.outDir.length - a.outDir.length || cmp(a.outDir, b.outDir) || cmp(a.rootDir, b.rootDir));
}

/** outDir / rootDir / include of a tsconfig after its relative `extends` chain, repo-relative POSIX. */
interface TsPaths {
  outDir?: string;
  rootDir?: string;
  include?: string[];
}

function readTsconfigChain(repoRoot: string, file: string, depth: number, seen: Set<string>): TsPaths | null {
  if (depth > 10 || seen.has(file)) return null;
  seen.add(file);
  let json: unknown;
  try {
    json = JSON.parse(stripJsonc(readFileSync(join(repoRoot, file), 'utf8')));
  } catch {
    return null;
  }
  if (!isObject(json)) return null;
  const base = posix.dirname(file);
  const rel = (p: string): string | null => {
    const n = posix.normalize(posix.join(base, p.replace(/\\/g, '/'))).replace(/\/$/, '');
    return n === '..' || n.startsWith('../') || posix.isAbsolute(n) ? null : n;
  };
  let merged: TsPaths = {};
  const ext = json['extends'];
  for (const e of typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext : []) {
    if (typeof e !== 'string' || !e.startsWith('.')) continue;
    const target = rel(e);
    if (target === null) continue;
    const candidates = target.endsWith('.json') ? [target] : [target, `${target}.json`, `${target}/tsconfig.json`];
    const found = candidates.find((c) => {
      try {
        return lstatSync(join(repoRoot, c)).isFile();
      } catch {
        return false;
      }
    });
    if (found === undefined) continue;
    const parent = readTsconfigChain(repoRoot, found, depth + 1, seen);
    if (parent !== null) merged = { ...merged, ...parent };
  }
  const co = json['compilerOptions'];
  if (isObject(co)) {
    for (const k of ['outDir', 'rootDir'] as const) {
      const v = co[k];
      if (typeof v !== 'string') continue;
      const r = rel(v);
      if (r !== null) merged[k] = r;
      else delete merged[k];
    }
  }
  const inc = json['include'];
  if (Array.isArray(inc)) {
    const r = inc.filter((x): x is string => typeof x === 'string').map(rel);
    if (r.every((x): x is string => x !== null)) merged.include = r;
    else delete merged.include;
  }
  return merged;
}

/** JSON with comments and trailing commas (tsconfig) → JSON; string contents are kept verbatim. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  // Trailing commas; a `,` inside a string followed by `}` is rare enough in a tsconfig.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Whether a package file may be matched by an `exports` / `imports` `*` pattern: a code
 * file (CODE_EXT; `"./*": "./*"` must not make `LICENSE` or `.eslintrc` entry points),
 * no dotfile / dot-dir segment, never under `node_modules`, and under a build output dir
 * (`dist`/`build`/`out`/`lib` output of a build) only when the pattern itself starts
 * there (`./dist/*.js` against a committed dist).
 */
function patternFileOk(f: string, patterns: readonly string[]): boolean {
  if (!CODE_EXT.test(f)) return false;
  const segs = f.split('/');
  if (segs.some((s) => s.startsWith('.') || s === 'node_modules')) return false;
  const top = segs[0]!;
  if (segs.length > 1 && (top === 'dist' || top === 'build' || top === 'out')) {
    return patterns.some((p) => p.startsWith(`${top}/`));
  }
  return true;
}

/** Node `exports` target pattern: every `*` stands for the same (possibly slash-containing) string. */
function exportPatternRegExp(p: string): RegExp {
  const parts = p.split('*').map((s) => s.replace(/[\\^$.+?()|{}[\]]/g, '\\$&'));
  return new RegExp(`^${parts[0]}(.+)${parts.slice(1).join('\\1')}$`);
}

// ---------------------------------------------------------------------------
// pub
// ---------------------------------------------------------------------------

/** Parse one pubspec.yaml. `dir` is the package dir relative to the repo root. */
export function readPubPackage(
  repoRoot: string, dir: string, repoFiles: readonly string[] | null, warn: Warn = () => {},
): ManifestPackage | null {
  const manifest = joinRel(dir, 'pubspec.yaml');
  let doc: YamlMap;
  try {
    doc = parsePubspecYaml(readFileSync(join(repoRoot, manifest), 'utf8'));
  } catch (err) {
    throw new Error(`sentei: cannot parse ${manifest}: ${(err as Error).message}`);
  }
  const name = doc['name'];
  if (typeof name !== 'string' || name === '') {
    warn(`${manifest}: no "name", skipped`);
    return null;
  }
  const version = typeof doc['version'] === 'string' ? doc['version'] : null;

  const files = packageFiles(dir, repoFiles ?? listFiles(repoRoot));
  const entryPoints = files
    .filter((f) => f.endsWith('.dart') && ((f.startsWith('lib/') && !f.slice(4).includes('/')) || f.startsWith('bin/')))
    .map((f) => joinRel(dir, f))
    .sort(cmp);
  if (entryPoints.length === 0) warn(`${manifest}: no entry points (no lib/*.dart or bin/**/*.dart)`);

  return {
    manager: 'pub',
    name,
    version,
    visibility: pubVisibility(doc['publish_to']),
    isLibrary: files.some((f) => f.startsWith('lib/') && f.endsWith('.dart') && !f.slice(4).includes('/')),
    path: dir,
    manifest,
    entryPoints,
    unresolvedEntryPoints: [],
    runtimeEntryPoints: [],
    deps: pubDeps(doc, manifest, warn),
  };
}

/** pub deps (dependencies, then dev_dependencies for names not already seen, with `dev: true`). Sorted by name. */
function pubDeps(doc: YamlMap, manifest: string, warn: Warn): ManifestDep[] {
  const deps = new Map<string, ManifestDep>();
  for (const field of ['dependencies', 'dev_dependencies'] as const) {
    const block = doc[field];
    if (block === undefined || block === null) continue;
    if (typeof block === 'string') {
      warn(`${manifest}: "${field}" is not a map, ignored`);
      continue;
    }
    for (const [dep, spec] of Object.entries(block)) {
      if (deps.has(dep)) continue;
      const d: ManifestDep = { name: dep, manager: 'pub', constraint: pubConstraint(spec) };
      if (field === 'dev_dependencies') d.dev = true;
      deps.set(dep, d);
    }
  }
  return [...deps.values()].sort((a, b) => cmp(a.name, b.name));
}

/** PLAN §6.1 step 5 (pub). An explicit pub.dev URL counts as the public registry. */
export function pubVisibility(publishTo: YamlValue | undefined): Visibility {
  if (publishTo === undefined || publishTo === null) return 'published-public';
  if (publishTo === 'none') return 'private';
  if (typeof publishTo === 'string') {
    try {
      const host = new URL(publishTo).hostname;
      if (host === 'pub.dev' || host === 'pub.dartlang.org') return 'published-public';
    } catch {
      /* custom non-URL value: treat as a private registry */
    }
  }
  return 'published-private';
}

function pubConstraint(spec: YamlValue): string | null {
  if (spec === null) return 'any';
  if (typeof spec === 'string') return spec;
  const path = spec['path'];
  if (typeof path === 'string') return `path:${path}`;
  const sdk = spec['sdk'];
  if (typeof sdk === 'string') return `sdk:${sdk}`;
  const git = spec['git'];
  if (typeof git === 'string') return `git:${git}`;
  if (git !== undefined && git !== null && typeof git === 'object' && typeof git['url'] === 'string') return `git:${git['url']}`;
  const version = spec['version'];
  if (typeof version === 'string') return version;
  if ('hosted' in spec) return 'any';
  return null;
}

// Minimal YAML reader, sufficient for pubspec.yaml: block maps (nesting by
// indentation), scalar values (plain, 'single', "double" quoted), `# comments`,
// and one-line flow maps (`{path: ../x}`). Block scalars (`|`, `>`) and block
// sequences (`- item`) are skipped together with everything nested under them;
// flow sequences are kept as their raw string. A key with no value and no
// children reads as null. Anything else is out of scope.
export type YamlValue = string | null | YamlMap;
export interface YamlMap { [key: string]: YamlValue }

export function parsePubspecYaml(text: string): YamlMap {
  const root: YamlMap = {};
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }];
  const pending = new Set<YamlMap>(); // maps created for `key:` with no inline value
  let skipDeeperThan: number | null = null;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    const line = stripComment(raw);
    if (line.trim() === '' || line.trim() === '---' || line.trim() === '...') continue;
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes('\t')) throw new Error(`line ${n + 1}: tab indentation`);
    if (skipDeeperThan !== null) {
      if (indent > skipDeeperThan) continue;
      skipDeeperThan = null;
    }
    const body = line.trim();
    if (body === '-' || body.startsWith('- ')) {
      // Block sequence item: not needed for pubspec deps; skip it and its children.
      // (A following `- item` at the same indent re-enters this branch.)
      skipDeeperThan = indent;
      continue;
    }
    const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(body);
    if (!m) continue; // continuation of a multi-line plain scalar, etc.
    const key = unquote(m[1]!);
    const rest = (m[2] ?? '').trim();
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.map;
    if (rest === '') {
      const child: YamlMap = {};
      parent[key] = child;
      pending.add(child);
      stack.push({ indent, map: child });
    } else if (/^[|>][-+0-9]*$/.test(rest)) {
      parent[key] = null; // block scalar content is not needed
      skipDeeperThan = indent;
    } else if (rest.startsWith('{') && rest.endsWith('}')) {
      parent[key] = parseFlowMap(rest);
    } else {
      parent[key] = scalar(rest);
    }
  }
  // `key:` with no children means null (e.g. `  foo:` in dependencies = any version).
  const fix = (map: YamlMap): void => {
    for (const [k, v] of Object.entries(map)) {
      if (v !== null && typeof v === 'object') {
        if (pending.has(v) && Object.keys(v).length === 0) map[k] = null;
        else fix(v);
      }
    }
  };
  fix(root);
  return root;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(.)/g, '$1');
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function scalar(s: string): string | null {
  if (s === '~' || s === 'null') return null;
  return unquote(s);
}

function parseFlowMap(s: string): YamlMap {
  const out: YamlMap = {};
  for (const part of s.slice(1, -1).split(',')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const k = unquote(part.slice(0, idx).trim());
    if (k !== '') out[k] = scalar(part.slice(idx + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `dir` ('.' or 'a/b') joined with a package-relative path. */
function joinRel(dir: string, rel: string): string {
  return dir === '.' ? rel : `${dir}/${rel}`;
}

/** Repo files under package `dir`, as package-relative paths. */
function packageFiles(dir: string, repoFiles: readonly string[]): string[] {
  if (dir === '.') return [...repoFiles];
  const prefix = `${dir}/`;
  return repoFiles.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
}

/** Normalize a manifest-declared path to package-relative POSIX; null if it leaves the package. */
function normalizeRel(p: string): string | null {
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (posix.isAbsolute(n) || n === '..' || n.startsWith('../')) return null;
  return n === '.' ? '' : n.replace(/\/$/, '');
}
