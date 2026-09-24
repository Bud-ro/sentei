// scip-typescript adapter (PLAN.md §6.2, §6.6). The indexer runs as a
// subprocess; the pinned copy is a dependency of @sentei/cli, never a global.
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
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

const LOCKFILES: ReadonlyArray<readonly [string, string, string[]]> = [
  ['package-lock.json', 'npm', ['ci', '--ignore-scripts']],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile', '--ignore-scripts']],
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
      diagnostics.push(`error: scip-typescript exited with ${proc.code ?? proc.signal}`);
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

/**
 * Runs the lockfile's install when the lockfile's dir has no node_modules.
 * The lockfile is searched from the package dir up to the repo root, so a
 * workspace package installs at the workspace root. Returns false on failure.
 */
async function install(repoRoot: string, pkgDir: string, diagnostics: string[], log: string[]): Promise<boolean> {
  for (let d = pkgDir; ; d = path.dirname(d)) {
    for (const [lockfile, cmd, args] of LOCKFILES) {
      if (!existsSync(path.join(d, lockfile))) continue;
      const rel = path.relative(repoRoot, d) || '.';
      if (isInstalled(path.join(d, 'node_modules'))) {
        diagnostics.push(`info: ${rel}/node_modules exists; install skipped`);
        return true;
      }
      // Windows: npm/pnpm/yarn are .cmd shims and need a shell.
      const proc = await exec(cmd, args, d, process.env, process.platform === 'win32');
      log.push(`$ ${cmd} ${args.join(' ')}  (cwd ${d})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
      if (proc.code !== 0) {
        diagnostics.push(`error: ${cmd} ${args.join(' ')} in ${rel} exited with ${proc.code ?? proc.signal}`);
        return false;
      }
      diagnostics.push(`info: ran ${cmd} ${args.join(' ')} in ${rel}`);
      return true;
    }
    if (d === repoRoot || path.dirname(d) === d) break;
  }
  diagnostics.push('info: no lockfile; install skipped');
  return true;
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
        (allowScopes && e.name === '.sentei-displaced') ||
        (allowScopes && e.isDirectory() && e.name.startsWith('@') && onlyLinks(path.join(dir, e.name), false)),
    );
  return !onlyLinks(nodeModules, true);
}

/**
 * Makes `<pkgDir>/node_modules/<dep>` a relative symlink to the org package's
 * checkout for every dep resolved to an org package. Touches nothing else in
 * node_modules. A real directory in the way is moved aside to
 * `node_modules/.sentei-displaced/` (never deleted); a stale symlink is replaced.
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

    let existing;
    try {
      existing = lstatSync(link);
    } catch {
      existing = undefined;
    }
    if (existing?.isSymbolicLink()) {
      const current = path.resolve(path.dirname(link), readlinkSync(link));
      if (existsSync(current) && realpathSync(current) === realpathSync(targetDir)) continue;
      unlinkSync(link);
      diagnostics.push(`info: replaced stale symlink node_modules/${dep.name}`);
    } else if (existing !== undefined) {
      const displaced = path.join(nodeModules, '.sentei-displaced', `${dep.name.replace(/\//g, '__')}-${Date.now()}`);
      mkdirSync(path.dirname(displaced), { recursive: true });
      renameSync(link, displaced);
      diagnostics.push(
        `info: replaced installed node_modules/${dep.name} with a source link (moved to ${path.relative(pkgDir, displaced)})`,
      );
    }
    // On win32 use a junction (no admin rights needed); junctions need an absolute target.
    if (process.platform === 'win32') symlinkSync(targetDir, link, 'junction');
    else symlinkSync(relTarget, link, 'dir');
    diagnostics.push(`info: linked node_modules/${dep.name} -> ${relTarget}`);
  }
}

interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, shell = false): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${err.message}\n` }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
