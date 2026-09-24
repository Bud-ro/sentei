// scip-typescript adapter (PLAN.md §6.2, §6.6). The indexer runs as a
// subprocess; the pinned copy is a dependency of @sentei/cli, never a global.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { computeExportSurface } from './export-surface.ts';
import type { DiscoveredPackage, DiscoveredRepo, Indexer, IndexerInput, IndexerResult, IndexStatus } from './types.ts';
import { worstStatus } from './types.ts';

const require = createRequire(import.meta.url);

/** Absolute path of the pinned scip-typescript entry script. */
function scipTypescriptBin(): string {
  const pkgJson = require.resolve('@sourcegraph/scip-typescript/package.json');
  const { bin } = require(pkgJson) as { bin: Record<string, string> };
  return path.join(path.dirname(pkgJson), bin['scip-typescript'] ?? 'dist/src/main.js');
}

/** Filesystem-safe name for a package's output files: `@acme/core` → `acme__core`. */
export function packageSlug(pkg: DiscoveredPackage): string {
  const base = pkg.name ?? (pkg.path === '.' ? 'root' : pkg.path);
  return base.replace(/^@/, '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
}

export function packageDir(repo: DiscoveredRepo, pkg: DiscoveredPackage): string {
  return path.resolve(repo.localPath, ...pkg.path.split('/'));
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Lockfile → package manager and its install arguments (first match wins, per directory). */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager, string[]]> = [
  ['package-lock.json', 'npm', ['ci', '--ignore-scripts']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['bun.lock', 'bun', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['bun.lockb', 'bun', ['install', '--frozen-lockfile', '--ignore-scripts']],
];

/** Directories never searched for sources when deciding `--infer-tsconfig`. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage']);

function hasJsOrTsSources(dir: string, budget = { n: 2000 }): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (--budget.n < 0) return false;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && hasJsOrTsSources(path.join(dir, e.name), budget)) {
        return true;
      }
    } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      return true;
    }
  }
  return false;
}

export const scipTypescript: Indexer = {
  name: 'scip-typescript',
  version: '0.4.0',

  detect({ repo, pkg }) {
    if (pkg.manager !== 'npm') return false;
    const dir = packageDir(repo, pkg);
    return existsSync(path.join(dir, 'tsconfig.json')) || hasJsOrTsSources(dir);
  },

  async prepare(input) {
    const { repo, pkg, options } = input;
    const diagnostics: string[] = [];
    const log: string[] = [];
    let status: IndexStatus = 'ok';
    const dir = realpathSync(packageDir(repo, pkg));
    // 1. Install third-party deps (before source-linking: links create node_modules).
    if (options.install) {
      const installed = await install(realpathSync(repo.localPath), dir, diagnostics, log);
      if (!installed) status = 'partial';
    } else {
      diagnostics.push('info: install skipped (--no-install)');
    }
    // 2. Source-link org dependencies so references resolve to the org checkout's symbols.
    linkOrgDeps(input, dir, diagnostics);
    return { status, diagnostics, log };
  },

  async run(input, outDir) {
    const { repo, pkg, options } = input;
    const prepared = input.prepared ?? (await this.prepare!(input));
    const diagnostics: string[] = [...prepared.diagnostics];
    let status: IndexStatus = prepared.status;
    const slug = packageSlug(pkg);
    const scipFile = path.join(outDir, `${slug}.scip`);
    const exportsFile = path.join(outDir, `${slug}.exports.json`);
    const logFile = path.join(outDir, `${slug}.log`);
    const result = (): IndexerResult => ({ status, diagnostics, scipFile, exportsFile });

    const repoRoot = realpathSync(repo.localPath);
    const dir = realpathSync(packageDir(repo, pkg));
    const tsconfig = path.join(dir, 'tsconfig.json');
    const inferTsconfig = !existsSync(tsconfig);
    const log: string[] = [...prepared.log];

    // 3. Index (1–2 are `prepare`).
    const args = [scipTypescriptBin(), 'index', '--output', scipFile, '--no-progress-bar'];
    if (inferTsconfig) {
      args.push('--infer-tsconfig');
      diagnostics.push('info: no tsconfig.json; running with --infer-tsconfig (scip-typescript writes one)');
    }
    const nodeOptions = [process.env.NODE_OPTIONS, `--max-old-space-size=${options.maxOldSpaceMb}`]
      .filter(Boolean)
      .join(' ');
    const proc = await exec(process.execPath, args, dir, { ...process.env, NODE_OPTIONS: nodeOptions });
    log.push(`$ NODE_OPTIONS='${nodeOptions}' node ${args.join(' ')}  (cwd ${dir})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
    if (proc.code !== 0) {
      status = 'failed';
      diagnostics.push(`error: scip-typescript ${describeExit(proc)}`);
    }
    const errorLines = [
      ...proc.stderr.split(/\r?\n/).filter((l) => /error TS\d+|\berror\b/i.test(l)),
      // scip-typescript prints tsconfig diagnostics on stdout.
      ...proc.stdout.split(/\r?\n/).filter((l) => /error TS\d+/i.test(l)),
    ];
    if (errorLines.length > 0) {
      status = worstStatus(status, 'partial');
      for (const l of errorLines.slice(0, 20)) diagnostics.push(`error: ${l.trim()}`);
    }
    if (!existsSync(scipFile) || statSync(scipFile).size === 0) {
      status = worstStatus(status, 'partial');
      diagnostics.push(`error: ${path.basename(scipFile)} missing or empty`);
    }

    // 4. Export-surface sidecar.
    try {
      const nested = repo.packages
        .map((p) => packageDir(repo, p))
        .filter((d) => d !== packageDir(repo, pkg))
        .map((d) => (existsSync(d) ? realpathSync(d) : d))
        .filter((d) => d.startsWith(dir + path.sep));
      const surface = computeExportSurface({
        packageId: pkg.packageId,
        repoRoot,
        pkgDir: dir,
        nestedPackageDirs: nested,
        entryPoints: pkg.entryPoints,
        tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
        orgPackageNames: new Set(
          input.orgPackages.flatMap(({ pkg: p }) => (p.manager === 'npm' && p.name !== null ? [p.name] : [])),
        ),
        orgPackageDirs: input.orgPackages.flatMap(({ repo: r, pkg: p }) => {
          const d = packageDir(r, p);
          return p.manager === 'npm' && p.name !== null && existsSync(d) ? [{ name: p.name, dir: realpathSync(d) }] : [];
        }),
        packageName: pkg.name,
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
      });
      writeFileSync(exportsFile, `${JSON.stringify(surface.sidecar, null, 2)}\n`);
      diagnostics.push(...surface.diagnostics);
      if (surface.partial) status = worstStatus(status, 'partial');
    } catch (err) {
      status = 'failed';
      diagnostics.push(`error: export surface failed: ${(err as Error).stack ?? String(err)}`);
    }

    log.push('--- diagnostics', ...diagnostics);
    writeFileSync(logFile, `${log.join('\n')}\n`);
    return result();
  },
};

/** Runs a subprocess; injectable so tests never spawn a package manager. */
export type Runner = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, shell?: boolean) => Promise<ExecResult>;

/**
 * Runs the lockfile's install when the lockfile's dir has no node_modules.
 * The lockfile is searched from the package dir up to the repo root, so a
 * workspace package installs at the workspace root. Returns false on failure.
 *
 * A missing pnpm/yarn binary falls back to `npm exec --yes --package=<pm>@<version>`,
 * the version taken from the nearest `packageManager` field or `latest`. A
 * missing bun skips the install with a warning (org deps are source-linked
 * regardless; only third-party types are lost, which never hides an org use).
 */
export async function install(
  repoRoot: string,
  pkgDir: string,
  diagnostics: string[],
  log: string[],
  run: Runner = exec,
): Promise<boolean> {
  for (let d = pkgDir; ; d = path.dirname(d)) {
    for (const [lockfile, pm, args] of LOCKFILES) {
      if (!existsSync(path.join(d, lockfile))) continue;
      const rel = path.relative(repoRoot, d) || '.';
      if (isInstalled(path.join(d, 'node_modules'))) {
        diagnostics.push(`info: ${rel}/node_modules exists; install skipped`);
        return true;
      }
      // Windows: npm/pnpm/yarn are .cmd shims and need a shell.
      const shell = process.platform === 'win32';
      let cmd: string = pm;
      let cmdArgs = args;
      let proc = await run(cmd, cmdArgs, d, process.env, shell);
      log.push(`$ ${cmd} ${cmdArgs.join(' ')}  (cwd ${d})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
      if (proc.errno === 'ENOENT' && pm === 'bun') {
        diagnostics.push(`warn: bun is not installed (spawn bun ENOENT); install skipped in ${rel}`);
        return true;
      }
      if (proc.errno === 'ENOENT' && pm !== 'npm') {
        const want = packageManagerVersion(repoRoot, d, pm);
        const fb = npmExecFallback(pm, want.version);
        diagnostics.push(
          `info: ${pm} is not installed (spawn ${pm} ENOENT); falling back to npm exec --yes --package=${fb.spec} ` +
            `(version ${want.version} ${want.source})`,
        );
        cmd = 'npm';
        cmdArgs = ['exec', '--yes', `--package=${fb.spec}`, '--', fb.bin, ...(fb.args ?? args)];
        proc = await run(cmd, cmdArgs, d, process.env, shell);
        log.push(`$ ${cmd} ${cmdArgs.join(' ')}  (cwd ${d})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
      }
      if (proc.errno !== undefined || proc.code !== 0) {
        diagnostics.push(`error: ${cmd} ${cmdArgs.join(' ')} in ${rel} ${describeExit(proc)}`);
        return false;
      }
      diagnostics.push(`info: ran ${cmd} ${cmdArgs.join(' ')} in ${rel}`);
      return true;
    }
    if (d === repoRoot || path.dirname(d) === d) break;
  }
  diagnostics.push('info: no lockfile; install skipped');
  return true;
}

/** `could not start (ENOENT: spawn pnpm ENOENT)` / `exited with code 1` / `was killed by SIGTERM`. */
function describeExit(proc: ExecResult): string {
  if (proc.errno !== undefined) return `could not start (${proc.errno}: ${proc.errorMessage ?? 'spawn failed'})`;
  if (proc.signal !== null) return `was killed by ${proc.signal}`;
  return `exited with code ${proc.code}`;
}

/**
 * The version of `pm` named by the nearest `packageManager` field (`pnpm@9.1.0+sha512...`)
 * from the lockfile dir up to the repo root, else `latest`.
 */
function packageManagerVersion(
  repoRoot: string,
  lockDir: string,
  pm: PackageManager,
): { version: string; source: string } {
  for (let d = lockDir; ; d = path.dirname(d)) {
    let field: unknown;
    try {
      field = (JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8')) as { packageManager?: unknown }).packageManager;
    } catch {
      field = undefined;
    }
    if (typeof field === 'string') {
      const m = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(field);
      const rel = path.relative(repoRoot, path.join(d, 'package.json')).split(path.sep).join('/');
      if (m !== null && m[1] === pm) return { version: m[2]!, source: `from packageManager in ${rel}` };
    }
    if (d === repoRoot || path.dirname(d) === d) break;
  }
  return { version: 'latest', source: '(no matching packageManager field)' };
}

/**
 * npm package + bin for running `pm` through `npm exec`. Yarn 2+ (berry) ships
 * as `@yarnpkg/cli-dist` and has neither `--frozen-lockfile` nor `--ignore-scripts`
 * (`--immutable` / `--mode=skip-build` instead).
 */
function npmExecFallback(pm: PackageManager, version: string): { spec: string; bin: string; args?: string[] } {
  if (pm === 'yarn' && /^[2-9]|^\d{2,}/.test(version)) {
    return { spec: `@yarnpkg/cli-dist@${version}`, bin: 'yarn', args: ['install', '--immutable', '--mode=skip-build'] };
  }
  return { spec: `${pm}@${version}`, bin: pm };
}

/**
 * True when node_modules exists and holds more than our own source links (a
 * previous `--no-install` run may have created it just for the links). npm ci
 * wipes node_modules, so an existing real install is never reinstalled.
 */
function isInstalled(nodeModules: string): boolean {
  if (!existsSync(nodeModules)) return false;
  const onlyLinks = (dir: string, allowScopes: boolean): boolean =>
    readdirSync(dir, { withFileTypes: true }).every(
      (e) =>
        e.isSymbolicLink() ||
        (e.isDirectory() && isShadowDir(path.join(dir, e.name))) ||
        (allowScopes && e.name === '.sentei-displaced') ||
        (allowScopes && e.isDirectory() && e.name.startsWith('@') && onlyLinks(path.join(dir, e.name), false)),
    );
  return !onlyLinks(nodeModules, true);
}

/**
 * Makes `<pkgDir>/node_modules/<dep>` resolve to the org package's checkout
 * for every dep resolved to an org package. Touches nothing else in
 * node_modules. A real directory in the way is moved aside to
 * `node_modules/.sentei-displaced/` (never deleted); a stale symlink or one of
 * our shadow dirs is replaced.
 *
 * Normally the link is a relative symlink to the checkout. When the checkout's
 * package.json declares entry targets that do not exist (unbuilt `dist/`), the
 * link is a shadow package dir instead (see `writeShadow`), so TypeScript
 * resolves the package to its sources.
 */
function linkOrgDeps(input: IndexerInput, pkgDir: string, diagnostics: string[]): void {
  const nodeModules = path.join(pkgDir, 'node_modules');
  for (const dep of input.pkg.deps) {
    if (dep.resolvedPackageId === null || dep.resolvedPackageId === undefined) continue;
    if (dep.resolvedPackageId === input.pkg.packageId) continue; // self-reference
    const target = input.lookup(dep.resolvedPackageId);
    if (target === undefined) {
      diagnostics.push(`warn: ${dep.name} resolves to ${dep.resolvedPackageId}, which is not in discover.json`);
      continue;
    }
    const targetDir = packageDir(target.repo, target.pkg);
    if (!existsSync(targetDir)) {
      diagnostics.push(`warn: ${dep.name}: org checkout ${targetDir} does not exist; not linked`);
      continue;
    }
    const link = path.join(nodeModules, ...dep.name.split('/'));
    mkdirSync(path.dirname(link), { recursive: true });
    const relTarget = path.relative(path.dirname(link), targetDir);
    const shadow = shadowManifest(targetDir);

    let existing;
    try {
      existing = lstatSync(link);
    } catch {
      existing = undefined;
    }
    if (existing?.isSymbolicLink()) {
      const current = path.resolve(path.dirname(link), readlinkSync(link));
      if (shadow === undefined && existsSync(current) && realpathSync(current) === realpathSync(targetDir)) continue;
      unlinkSync(link);
      if (shadow === undefined) diagnostics.push(`info: replaced stale symlink node_modules/${dep.name}`);
    } else if (existing?.isDirectory() && isShadowDir(link)) {
      rmSync(link, { recursive: true }); // ours: only symlinks, package.json and the marker
    } else if (existing !== undefined) {
      const displaced = path.join(nodeModules, '.sentei-displaced', `${dep.name.replace(/\//g, '__')}-${Date.now()}`);
      mkdirSync(path.dirname(displaced), { recursive: true });
      renameSync(link, displaced);
      diagnostics.push(
        `info: replaced installed node_modules/${dep.name} with a source link (moved to ${path.relative(pkgDir, displaced)})`,
      );
    }
    if (shadow !== undefined) {
      writeShadow(link, targetDir, shadow.json);
      diagnostics.push(
        `info: node_modules/${dep.name} is a shadow of ${relTarget} (unbuilt entry targets rewritten to sources: ` +
          `${shadow.rewritten.join(', ')}${shadow.missing.length > 0 ? `; still missing: ${shadow.missing.join(', ')}` : ''})`,
      );
      continue;
    }
    // On win32 use a junction (no admin rights needed); junctions need an absolute target.
    if (process.platform === 'win32') symlinkSync(targetDir, link, 'junction');
    else symlinkSync(relTarget, link, 'dir');
    diagnostics.push(`info: linked node_modules/${dep.name} -> ${relTarget}`);
  }
}

// ---------------------------------------------------------------------------
// Shadow packages (org libs whose package.json points at unbuilt output)
// ---------------------------------------------------------------------------

/** Marker file that makes a node_modules dir ours (replaced on every run). */
const SHADOW_MARKER = '.sentei-shadow';

function isShadowDir(dir: string): boolean {
  return existsSync(path.join(dir, SHADOW_MARKER));
}

/**
 * A shadow package: a real dir at `node_modules/<dep>` holding a rewritten
 * package.json plus a symlink to every other top-level entry of the checkout
 * (never its package.json, node_modules or .git). TypeScript resolves the
 * package through the shadow package.json, but every file it loads is reached
 * through a symlink, so its realpath is in the checkout and scip-typescript
 * derives the symbol's package from the checkout's own package.json: consumer
 * references carry exactly the lib's definition symbols.
 */
function writeShadow(link: string, targetDir: string, json: Record<string, unknown>): void {
  mkdirSync(link);
  writeFileSync(path.join(link, 'package.json'), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(
    path.join(link, SHADOW_MARKER),
    `Written by sentei: a source-linked shadow of ${targetDir}.\nReplaced on every index run; safe to delete.\n`,
  );
  for (const e of readdirSync(targetDir, { withFileTypes: true })) {
    if (e.name === 'package.json' || e.name === 'node_modules' || e.name === '.git' || e.name === SHADOW_MARKER) continue;
    const src = path.join(targetDir, e.name);
    const dst = path.join(link, e.name);
    const isDir = e.isDirectory() || (e.isSymbolicLink() && existsSync(src) && statSync(src).isDirectory());
    if (process.platform === 'win32') {
      if (isDir) symlinkSync(src, dst, 'junction');
      else copyFileSync(src, dst); // file symlinks need privileges on Windows
    } else {
      symlinkSync(path.relative(link, src), dst, isDir ? 'dir' : 'file');
    }
  }
}

interface ShadowManifest {
  json: Record<string, unknown>;
  /** `field: old → new` for each rewritten target. */
  rewritten: string[];
  /** Declared targets that are missing and have no source counterpart (left as is). */
  missing: string[];
}

/**
 * The rewritten package.json when some declared entry target (`main`, `module`,
 * `types`/`typings`, `browser`, `bin`, every string leaf of `exports`, plus
 * `typesVersions` paths) does not exist in the checkout and has an existing
 * source counterpart; undefined when a plain symlink is enough.
 */
function shadowManifest(targetDir: string): ShadowManifest | undefined {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const rewritten: string[] = [];
  const missing: string[] = [];
  const rewrite = (field: string, v: string): string => {
    const r = rewriteTarget(targetDir, v);
    if (r === undefined) return v;
    if (r === null) {
      missing.push(`${field}: ${v}`);
      return v;
    }
    rewritten.push(`${field}: ${v} → ${r}`);
    return r;
  };
  const mapLeaves = (field: string, v: unknown): unknown => {
    if (typeof v === 'string') return rewrite(field, v);
    if (Array.isArray(v)) return v.map((x) => mapLeaves(field, x));
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapLeaves(`${field}.${k}`, x)]));
    }
    return v;
  };
  const out: Record<string, unknown> = { ...json };
  for (const key of ['main', 'module', 'types', 'typings', 'browser'] as const) {
    if (typeof json[key] === 'string') out[key] = rewrite(key, json[key]);
  }
  if (typeof json['bin'] === 'string' || (typeof json['bin'] === 'object' && json['bin'] !== null)) {
    out['bin'] = mapLeaves('bin', json['bin']);
  }
  if (json['exports'] !== undefined) out['exports'] = mapLeaves('exports', json['exports']);
  if (typeof json['typesVersions'] === 'object' && json['typesVersions'] !== null) {
    out['typesVersions'] = mapLeaves('typesVersions', json['typesVersions']);
  }
  return rewritten.length > 0 ? { json: out, rewritten, missing } : undefined;
}

// Mirrors the dist→src rule of `distToSrc` in packages/core/src/manifests.ts
// (dist|lib|build|out/<path>.{js,cjs,mjs,jsx,d.ts,...} → src/<path>.{ts,tsx}),
// re-implemented here because that helper is not exported. One addition: when
// the direct counterpart does not exist, one directory after the build dir is
// dropped too (`dist/types/index.d.ts`, `dist/cjs/index.js` → `src/index.ts`),
// the layout of libs that emit per-format subdirectories.
const BUILD_DIR = /^(?:dist|lib|build|out)\//;
const BUILD_SUBDIR = /^(?:dist|lib|build|out)\/[^/*]+\/(?=.)/;
const BUILT_EXT = /(?:\.d\.[cm]?ts|\.[cm]?js|\.jsx)$/;
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.tsx', '/index.d.ts', '/index.js'];

/**
 * The rewritten target when `target` does not exist in `dir` and a source
 * counterpart does; `undefined` when it exists (or is not a path), `null` when it
 * is missing without a counterpart. `*` patterns are rewritten textually and
 * "exist" when some file matches.
 */
function rewriteTarget(dir: string, target: string): string | undefined | null {
  const dot = target.startsWith('./');
  const rel = dot ? target.slice(2) : target;
  if (rel === '' || rel.startsWith('/') || rel.startsWith('../') || /^[a-z]+:/i.test(rel)) return undefined;
  if (targetExists(dir, rel)) return undefined;
  if (!BUILD_DIR.test(rel)) return null;
  const stems = [rel.replace(BUILD_DIR, 'src/')];
  if (BUILD_SUBDIR.test(rel)) stems.push(rel.replace(BUILD_SUBDIR, 'src/'));
  const exts = BUILT_EXT.test(rel) ? ['.ts', '.tsx'] : [''];
  for (const stem of stems) {
    for (const ext of exts) {
      const cand = stem.replace(BUILT_EXT, '') + ext;
      if (targetExists(dir, cand)) return (dot ? './' : '') + cand;
    }
  }
  return null;
}

/** A target file (extensionless allowed) or a `*` pattern matching at least one file. */
function targetExists(dir: string, rel: string): boolean {
  if (!rel.includes('*')) return RESOLVE_EXTS.some((ext) => existsSync(path.join(dir, ...(rel + ext).split('/'))));
  const star = rel.indexOf('*');
  const base = rel.slice(0, rel.lastIndexOf('/', star) + 1);
  const parts = rel.split('*').map((p) => p.replace(/[\\^$.+?()|{}[\]]/g, '\\$&'));
  const re = new RegExp(`^${parts[0]}(.+)${parts.slice(1).join('\\1')}$`);
  const budget = { n: 20000 };
  const walk = (abs: string, relDir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (--budget.n < 0) return false;
      const r = relDir + e.name;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && walk(path.join(abs, e.name), `${r}/`)) return true;
      } else if (re.test(r)) {
        return true;
      }
    }
    return false;
  };
  return walk(path.join(dir, ...base.split('/').filter(Boolean)), base);
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be spawned (`ENOENT`: binary not on PATH). */
  errno?: string;
  errorMessage?: string;
}

function exec(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, shell = false): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', (err: NodeJS.ErrnoException) =>
      resolve({
        code: -1,
        signal: null,
        stdout,
        stderr: `${stderr}${err.message}\n`,
        errno: err.code ?? 'EUNKNOWN',
        errorMessage: err.message,
      }),
    );
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
