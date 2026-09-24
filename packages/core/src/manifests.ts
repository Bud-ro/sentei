// Manifest discovery (PLAN.md §6.1 steps 3-5, §6.3 step 4). Pure filesystem reads,
// no DB. Walks one repo for package.json / pubspec.yaml and returns package
// descriptors with visibility, manifest deps, and resolved entry points.
//
// All returned paths are POSIX. `path` is the package dir relative to the repo
// root ('.' for the root); `entryPoints` are relative to the REPO root.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export type Manager = 'npm' | 'pub';
export type Visibility = 'private' | 'published-private' | 'published-public';

export interface ManifestDep {
  name: string;
  manager: Manager;
  /** Version string as written (npm), or pub constraint; `path:<rel>` for pub path deps. */
  constraint: string | null;
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
      ? readNpmPackage(repoRoot, dir, files, warn)
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
  repoRoot: string, dir: string, repoFiles: readonly string[] | null, warn: Warn = () => {},
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
  const entryPoints = npmEntryPoints(dir, json, files, warn);
  return {
    manager: 'npm',
    name,
    version,
    visibility: npmVisibility(json, manifest, warn),
    isLibrary: ['exports', 'types', 'typings', 'module'].some((k) => json[k] !== undefined),
    path: dir,
    manifest,
    entryPoints,
    deps: npmDeps(json, manifest, warn),
  };
}

/** npm deps: first non-dev field wins; devDependencies only if the name is nowhere else. Sorted by name. */
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
      deps.set(dep, { name: dep, manager: 'npm', constraint: typeof spec === 'string' ? spec : null });
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
 *   3. dist→src mapping for unbuilt TS repos: if `<p>` starts with `dist/`, `lib/`,
 *      `build/` or `out/`, replace that first segment with `src/` and the
 *      extension (`.js .mjs .cjs .jsx .d.ts .d.mts .d.cts`) with `.ts`, then `.tsx`.
 * Paths that resolve to nothing are dropped silently (npm manifests routinely
 * point at build output). Only code-looking files are kept (see CODE_EXT) plus
 * extension-less files (shebang bin scripts), so `"./package.json"` exports are ignored.
 * If nothing resolves, fall back to the first existing of index.{ts,tsx,js,mjs,cjs},
 * src/index.{ts,tsx}.
 */
export function npmEntryPoints(
  dir: string, json: Record<string, unknown>, repoFiles: readonly string[], warn: Warn = () => {},
): string[] {
  const declared: string[] = [];
  const patterns: string[] = [];
  for (const key of ['main', 'module', 'types', 'typings'] as const) {
    const v = json[key];
    if (typeof v === 'string') declared.push(v);
  }
  const bin = json['bin'];
  if (typeof bin === 'string') declared.push(bin);
  else if (isObject(bin)) for (const v of Object.values(bin)) if (typeof v === 'string') declared.push(v);
  if (typeof json['browser'] === 'string') declared.push(json['browser']);
  collectExportLeaves(json['exports'], (leaf) => (leaf.includes('*') ? patterns : declared).push(leaf));

  const pkgFiles = packageFiles(dir, repoFiles);
  const pkgFileSet = new Set(pkgFiles);
  const found = new Set<string>();
  const add = (rel: string | null): void => {
    if (rel === null) return;
    if (!CODE_EXT.test(rel) && posix.extname(rel) !== '') return;
    found.add(joinRel(dir, rel));
  };
  for (const p of declared) {
    const n = normalizeRel(p);
    if (n === null) {
      warn(`${joinRel(dir, 'package.json')}: entry ${JSON.stringify(p)} escapes the package, ignored`);
      continue;
    }
    add(resolveEntry(n, pkgFileSet));
  }
  for (const p of patterns) {
    const n = normalizeRel(p);
    if (n === null) continue;
    // The pattern as written; only if it matches nothing, its dist→src variants (.ts and .tsx together).
    for (const variants of [[n], distToSrc(n)]) {
      const res = variants.map(exportPatternRegExp);
      const hits = pkgFiles.filter((f) => res.some((re) => re.test(f)));
      hits.forEach(add);
      if (hits.length > 0) break;
    }
  }
  if (found.size === 0) {
    for (const f of ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs', 'src/index.ts', 'src/index.tsx']) {
      if (pkgFileSet.has(f)) {
        found.add(joinRel(dir, f));
        break;
      }
    }
  }
  if (found.size === 0) warn(`${joinRel(dir, 'package.json')}: no entry points resolved`);
  return [...found].sort(cmp);
}

function collectExportLeaves(v: unknown, out: (leaf: string) => void): void {
  if (typeof v === 'string') out(v);
  else if (Array.isArray(v)) v.forEach((x) => collectExportLeaves(x, out));
  else if (isObject(v)) Object.values(v).forEach((x) => collectExportLeaves(x, out));
}

/** Resolve one declared entry (package-relative, normalized) against the package's files. */
function resolveEntry(p: string, files: ReadonlySet<string>): string | null {
  if (files.has(p)) return p;
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']) if (files.has(p + ext)) return p + ext;
  for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']) {
    const idx = p === '' ? `index${ext}` : `${p}/index${ext}`;
    if (files.has(idx)) return idx;
  }
  for (const alt of distToSrc(p)) if (files.has(alt)) return alt;
  return null;
}

const BUILD_DIR = /^(?:dist|lib|build|out)\//;
const BUILT_EXT = /(?:\.d\.[cm]?ts|\.[cm]?js|\.jsx)$/;

/** dist/foo.js → [src/foo.ts, src/foo.tsx]; [] if the path is not build-output-shaped. */
function distToSrc(p: string): string[] {
  if (!BUILD_DIR.test(p) || !BUILT_EXT.test(p)) return [];
  const stem = p.replace(BUILD_DIR, 'src/').replace(BUILT_EXT, '');
  return [`${stem}.ts`, `${stem}.tsx`];
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
    deps: pubDeps(doc, manifest, warn),
  };
}

/** pub deps (dependencies, then dev_dependencies for names not already seen). Sorted by name. */
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
      deps.set(dep, { name: dep, manager: 'pub', constraint: pubConstraint(spec) });
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
