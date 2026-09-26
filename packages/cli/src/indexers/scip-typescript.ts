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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitPackageId } from '@sentei/core';
import type { SurfaceJob, SurfaceWorkerResult } from './surface-worker.ts';
import type { DiscoveredPackage, DiscoveredRepo, ExportsSidecar, Indexer, IndexerInput, IndexerResult, IndexStatus } from './types.ts';
import { worstStatus } from './types.ts';

const require = createRequire(import.meta.url);

/** Absolute path of the pinned scip-typescript entry script. */
function scipTypescriptBin(): string {
  const pkgJson = require.resolve('@sourcegraph/scip-typescript/package.json');
  const { bin } = require(pkgJson) as { bin: Record<string, string> };
  return path.join(path.dirname(pkgJson), bin['scip-typescript'] ?? 'dist/src/main.js');
}

/**
 * Filesystem-safe name for a package's output files: manager, repo name (without the
 * org) and package name, so an npm and a pub package in the same dir (a `package.json`
 * next to a `pubspec.yaml`, often with the same name) never share a file, and two repos
 * publishing the same name never collide either:
 * `npm:acme/lib-core:@acme/core` → `npm__lib-core__acme__core`,
 * `pub:acme/x:acme_x` → `pub__x__acme_x`. A package id without a repo (old
 * `<manager>:<name>` form) gives `<manager>__<name>`. The Dart adapter uses this too.
 */
export function packageSlug(pkg: DiscoveredPackage): string {
  const base = pkg.name ?? (pkg.path === '.' ? 'root' : pkg.path);
  const clean = (s: string): string => s.replace(/^@/, '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
  const repo = splitPackageId(pkg.packageId)?.repo;
  const repoName = repo === undefined ? undefined : repo.slice(repo.indexOf('/') + 1);
  return [pkg.manager, ...(repoName === undefined ? [] : [repoName]), base].map(clean).join('__');
}

export function packageDir(repo: DiscoveredRepo, pkg: DiscoveredPackage): string {
  return path.resolve(repo.localPath, ...pkg.path.split('/'));
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Lockfile → package manager, in the order that breaks ties when a directory
 * holds several lockfiles and its package.json does not say which manager it
 * uses (see `choosePackageManager`).
 */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['package-lock.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/** The package-manager names a package.json declares: `packageManager` first, then `devEngines.packageManager`. */
function declaredManagers(pkgJson: unknown): Array<{ pm: PackageManager; field: string; version?: string }> {
  if (typeof pkgJson !== 'object' || pkgJson === null) return [];
  const json = pkgJson as { packageManager?: unknown; devEngines?: { packageManager?: unknown } };
  const out: Array<{ pm: PackageManager; field: string; version?: string }> = [];
  if (typeof json.packageManager === 'string') {
    const m = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(json.packageManager.trim()) ?? /^(npm|pnpm|yarn|bun)$/.exec(json.packageManager.trim());
    if (m !== null) out.push({ pm: m[1] as PackageManager, field: 'packageManager', ...(m[2] !== undefined ? { version: m[2] } : {}) });
  }
  const dev = json.devEngines?.packageManager;
  for (const e of Array.isArray(dev) ? dev : dev !== undefined ? [dev] : []) {
    if (typeof e !== 'object' || e === null) continue;
    const { name, version } = e as { name?: unknown; version?: unknown };
    if (name !== 'npm' && name !== 'pnpm' && name !== 'yarn' && name !== 'bun') continue;
    const ok = typeof version === 'string' && /^[\w.^~<>=|*\s-]+$/.test(version.trim());
    out.push({ pm: name, field: 'devEngines.packageManager', ...(ok ? { version: (version as string).trim() } : {}) });
  }
  return out;
}

/**
 * Which package manager installs a directory holding `lockfiles` (file names),
 * given the nearest package.json that declares a manager (`pkgJson`, or
 * undefined). Order:
 *   1. `packageManager` (`pnpm@9.12.0`, `yarn@4.5.0`, `npm@10`), when that
 *      manager's lockfile is present;
 *   2. `devEngines.packageManager` (object or array form), likewise;
 *   3. the first present lockfile in LOCKFILES order (npm, pnpm, yarn, bun).
 * A declared manager without its lockfile here cannot run a frozen install, so
 * it falls through to 3 (the `reason` says so). Undefined without lockfiles.
 */
export function choosePackageManager(
  pkgJson: unknown,
  lockfiles: readonly string[],
): { pm: PackageManager; lockfile: string; reason: string } | undefined {
  const present = LOCKFILES.filter(([f]) => lockfiles.includes(f));
  if (present.length === 0) return undefined;
  const declared = declaredManagers(pkgJson);
  for (const d of declared) {
    const hit = present.find(([, pm]) => pm === d.pm);
    if (hit !== undefined) return { pm: d.pm, lockfile: hit[0], reason: `${d.field} names ${d.pm}` };
  }
  const [lockfile, pm] = present[0]!;
  const unmet = declared.length > 0 ? `; ${declared[0]!.field} names ${declared[0]!.pm}, which has no lockfile here` : '';
  return { pm, lockfile, reason: `lockfile order${unmet}` };
}

/**
 * The nearest package.json from `dir` up to `repoRoot` that declares a package
 * manager (`packageManager` or `devEngines.packageManager`), parsed, with its
 * repo-relative POSIX path; undefined when none does.
 */
function nearestManagerManifest(repoRoot: string, dir: string): { json: unknown; rel: string } | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8'));
    } catch {
      json = undefined;
    }
    if (declaredManagers(json).length > 0) {
      return { json, rel: path.relative(repoRoot, path.join(d, 'package.json')).split(path.sep).join('/') };
    }
    if (d === repoRoot || path.dirname(d) === d) return undefined;
  }
}

/** Install arguments per manager. */
const LEGACY_ARGS: Record<PackageManager, string[]> = {
  npm: ['ci', '--ignore-scripts'],
  pnpm: ['install', '--frozen-lockfile', '--ignore-scripts'],
  yarn: ['install', '--frozen-lockfile', '--ignore-scripts'],
  bun: ['install', '--frozen-lockfile', '--ignore-scripts'],
};

/** Directories never searched for sources (tsconfig inference, the no-code check). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage']);

/** What source files a package dir holds (outside SKIP_DIRS and dot dirs). */
export interface SourceScan {
  /** A `.ts`/`.tsx`/`.mts`/`.cts` file (declaration files included). */
  ts: boolean;
  /** A `.js`/`.jsx`/`.mjs`/`.cjs` file. */
  js: boolean;
  /** The walk hit its budget before finding a TypeScript file: absent kinds are unknown. */
  truncated: boolean;
}

/** Walks `dir` for source files; stops at the first TypeScript file or after `budget` entries. */
export function scanSources(dir: string, budget = { n: 5000 }): SourceScan {
  const out: SourceScan = { ts: false, js: false, truncated: false };
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.ts || out.truncated) return;
      if (--budget.n < 0) {
        out.truncated = true;
        return;
      }
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(d, e.name));
      } else if (/\.[cm]?tsx?$/.test(e.name)) {
        out.ts = true;
      } else if (/\.(?:[cm]?js|jsx)$/.test(e.name)) {
        out.js = true;
      }
    }
  };
  walk(dir);
  return out;
}

/** scip-typescript's inferred configs (`inferTsconfig.ts`): TypeScript sources, or JavaScript only. */
const NO_JS_TSCONFIG = '{}';
const ALLOW_JS_TSCONFIG = '{"compilerOptions":{"allowJs":true}}';

/**
 * Makes sure `<dir>/tsconfig.json` exists before scip-typescript runs, and
 * returns what it did (an `info:` line) or undefined. We infer it ourselves
 * rather than pass `--infer-tsconfig`: scip-typescript's inference walks
 * node_modules, finds a `.ts` there and writes `{}` (no allowJs) for a
 * JavaScript-only package, which then indexes nothing ("no files got
 * indexed"; react_testing_library's js_src). The file stays in the checkout,
 * as scip-typescript's did, and the export surface reads it too. A `{}` left by
 * an earlier run in a package with JavaScript sources only is upgraded the same
 * way (as `{}` it could only ever index nothing).
 */
export function ensureTsconfig(dir: string, scan: SourceScan): string | undefined {
  const file = path.join(dir, 'tsconfig.json');
  const wanted = !scan.ts && scan.js ? ALLOW_JS_TSCONFIG : NO_JS_TSCONFIG;
  if (!existsSync(file)) {
    writeFileSync(file, wanted);
    return `info: no tsconfig.json; wrote ${wanted} (${wanted === ALLOW_JS_TSCONFIG ? 'JavaScript sources only' : 'TypeScript sources'}, node_modules not searched)`;
  }
  if (wanted !== ALLOW_JS_TSCONFIG) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length > 0) return undefined;
  writeFileSync(file, wanted);
  return `info: tsconfig.json is {} but the package has JavaScript sources only (it would index nothing); rewrote it as ${wanted}`;
}

export const scipTypescript: Indexer = {
  name: 'scip-typescript',
  // Upstream version + our patch level. Bump the patch level whenever the
  // adapter's output (the sidecar) changes: it is the index cache key.
  // +sentei.1: shorthandRefs, targeted namespace_dynamic, deep dist imports.
  // +sentei.2: namespaceSpreadRefs; exports SCIP cannot define are not recorded
  //   (destructuring, JSDoc typedefs, expandos, JSON) or are `unresolved`
  //   (declared outside every tsconfig's files).
  // +sentei.3: unindexedImports `scope`, SFC scan (`relative` own imports),
  //   generatedFiles; heap retry without hover signatures; nuxt prepare.
  // +sentei.4: entrySymbols[].kind (`ambient`), members of `.d.ts` script
  //   namespaces, more generated-file headers and names (Wrangler, Go-style).
  // +sentei.5: exports resolving to a declaration outside the package (lib
  //   `globalThis`, node_modules, another org package) are neither records nor
  //   `unresolved`; imports of the package by its own name that SCIP cannot
  //   link (unindexed files, unresolved self modules) are `unindexedImports`
  //   with `targetPackage` = self; JavaScript entries outside the program are
  //   text-scanned into `unresolved`.
  version: '0.4.0+sentei.5',

  // Every npm package: one with no TypeScript/JavaScript sources at all gets an
  // empty index (status ok, `warn:`) in `run`, since it cannot hide a reference
  // (e.g. a `js_src/` bundle-build manifest in a Dart repo).
  detect({ repo, pkg }) {
    return pkg.manager === 'npm' && existsSync(path.join(packageDir(repo, pkg), 'package.json'));
  },

  async prepare(input) {
    const { repo, pkg, options } = input;
    const diagnostics: string[] = [];
    const log: string[] = [];
    let status: IndexStatus = 'ok';
    const dir = realpathSync(packageDir(repo, pkg));
    // 1. Install third-party deps (before source-linking: links create node_modules).
    if (options.install) {
      const installed = await install(realpathSync(repo.localPath), dir, diagnostics, log, exec, options.workDir);
      if (!installed) status = 'partial';
      // 1b. Nuxt apps: their tsconfig extends the generated `.nuxt/tsconfig.json`.
      else await nuxtPrepare(dir, diagnostics, log, exec, options.workDir);
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
    const log: string[] = [...prepared.log];

    // No source file at all: nothing to index and nothing that could reference
    // an org symbol. An empty index keeps the package from being opaque.
    const scan = scanSources(dir);
    if (!scan.ts && !scan.js && !scan.truncated) {
      diagnostics.push(
        existsSync(tsconfig)
          ? 'warn: tsconfig has no input files: the package has no TypeScript/JavaScript sources; wrote an empty index'
          : 'warn: no TypeScript/JavaScript sources in the package; wrote an empty index',
      );
      writeFileSync(scipFile, emptyScipIndex(pathToFileURL(dir).href));
      const empty: ExportsSidecar = {
        packageId: pkg.packageId,
        entryPoints: [],
        missingEntryPoints: [],
        exports: [],
        unresolved: [],
        unresolvedImports: [],
        flags: [],
        namespaceMemberRefs: [],
        shorthandRefs: [],
        namespaceSpreadRefs: [],
        unindexedImports: [],
        generatedFiles: [],
        entrySymbols: [],
      };
      writeFileSync(exportsFile, `${JSON.stringify(empty, null, 2)}\n`);
      log.push('--- diagnostics', ...diagnostics);
      writeFileSync(logFile, `${log.join('\n')}\n`);
      return result();
    }
    const inferred = ensureTsconfig(dir, scan);
    if (inferred !== undefined) diagnostics.push(inferred);

    // 3. Index (1–2 are `prepare`).
    const args = [scipTypescriptBin(), 'index', '--output', scipFile, '--no-progress-bar'];
    const proc = await runNode({
      what: 'scip-typescript',
      args,
      cwd: dir,
      maxOldSpaceMb: options.maxOldSpaceMb,
      log,
      diagnostics,
      beforeRetry: () => rmSync(scipFile, { force: true }),
      retry: SCIP_NODOCS_RETRY,
    });
    if (proc.code !== 0) {
      status = 'failed';
      diagnostics.push(`error: scip-typescript ${describeExit(proc)}${stderrTail(proc)}`);
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

    // 4. Export-surface sidecar, computed in a child process (surface-worker.ts).
    try {
      const nested = repo.packages
        .map((p) => packageDir(repo, p))
        .filter((d) => d !== packageDir(repo, pkg))
        .map((d) => (existsSync(d) ? realpathSync(d) : d))
        .filter((d) => d.startsWith(dir + path.sep));
      // Ignored manifests (examples, templates) strictly inside this package.
      const ignoredDirs = (repo.ignoredManifests ?? [])
        .map((m) => path.resolve(repo.localPath, ...m.path.split('/')))
        .map((d) => (existsSync(d) ? realpathSync(d) : d))
        .filter((d) => d.startsWith(dir + path.sep));
      const job: SurfaceJob = {
        sidecarFile: exportsFile,
        input: {
          packageId: pkg.packageId,
          repoRoot,
          pkgDir: dir,
          nestedPackageDirs: nested,
          ignoredDirs,
          entryPoints: pkg.entryPoints,
          tsconfig: existsSync(tsconfig) ? tsconfig : undefined,
          orgPackageNames: input.orgPackages.flatMap(({ pkg: p }) => (p.manager === 'npm' && p.name !== null ? [p.name] : [])),
          orgPackageDirs: input.orgPackages.flatMap(({ repo: r, pkg: p }) => {
            const d = packageDir(r, p);
            return p.manager === 'npm' && p.name !== null && existsSync(d) ? [{ name: p.name, dir: realpathSync(d) }] : [];
          }),
          packageName: pkg.name,
          ...(input.policy !== undefined ? { policy: input.policy } : {}),
        },
      };
      rmSync(exportsFile, { force: true }); // never leave a previous run's sidecar behind a failure
      const surface = await runSurfaceWorker(job, dir, options.maxOldSpaceMb, log, diagnostics);
      if (surface === undefined) {
        status = 'failed';
      } else {
        diagnostics.push(...surface.diagnostics);
        if (surface.partial) status = worstStatus(status, 'partial');
      }
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
 * A serialized `scip.Index` with metadata only (tool scip-typescript, the
 * project root, UTF-8 documents) and no documents: hand-encoded protobuf.
 */
export function emptyScipIndex(projectRoot: string): Uint8Array {
  const varint = (n: number): number[] => {
    const out: number[] = [];
    while (n > 0x7f) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
    return out;
  };
  const len = (field: number, bytes: number[]): number[] => [(field << 3) | 2, ...varint(bytes.length), ...bytes];
  const str = (field: number, s: string): number[] => len(field, [...Buffer.from(s, 'utf8')]);
  const toolInfo = [...str(1, 'scip-typescript'), ...str(2, '0.4.0')];
  const metadata = [...len(2, toolInfo), ...str(3, projectRoot), (4 << 3) | 0, 1];
  return Uint8Array.from(len(1, metadata));
}

/**
 * Runs a subprocess; injectable so tests never spawn a package manager. `input`
 * is written to its stdin; after `timeoutMs` the child is killed (SIGTERM).
 */
export type Runner = (
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  shell?: boolean,
  input?: string,
  timeoutMs?: number,
) => Promise<ExecResult>;

/**
 * The scip-typescript heap retry also preloads scip-typescript-nodocs.cjs: hover
 * signatures are not printed (TypeScript's type printer never finishes on some
 * recursive template-literal types, e.g. unjs/scule; sentei reads no SCIP
 * documentation).
 */
const SCIP_NODOCS_RETRY = {
  nodeArgs: ['--require', fileURLToPath(new URL('./scip-typescript-nodocs.cjs', import.meta.url))],
  note: 'and without hover signatures (SCIP documentation only; symbols and occurrences are unchanged)',
};

/** Absolute path of the export-surface worker script. */
const SURFACE_WORKER = fileURLToPath(new URL('./surface-worker.ts', import.meta.url));

/** True when a node subprocess died of heap exhaustion (V8 aborts: SIGABRT / exit 134). */
export function isHeapExhausted(proc: ExecResult): boolean {
  return proc.signal === 'SIGABRT' || proc.code === 134 || /heap out of memory|allocation failed - javascript heap/i.test(proc.stderr);
}

export interface RunNodeOptions {
  /** Name in diagnostics (`scip-typescript`, `export surface`). */
  what: string;
  /** Script and its arguments. */
  args: string[];
  cwd: string;
  maxOldSpaceMb: number;
  /** Written to the child's stdin. */
  input?: string;
  log: string[];
  diagnostics: string[];
  /** Runs before the retry (e.g. removes a partial output file). */
  beforeRetry?: () => void;
  /** Extra node options for the retry only (before the script), and why (appended to the `warn:`). */
  retry?: { nodeArgs: string[]; note: string };
  run?: Runner;
}

/**
 * Runs `node --max-old-space-size=<mb> <args>`. When the child runs out of
 * heap (SIGABRT, exit 134 or "heap out of memory" on stderr) it is retried
 * once with double the heap, with a `warn:` naming both sizes.
 */
export async function runNode(o: RunNodeOptions): Promise<ExecResult> {
  const run = o.run ?? exec;
  let heap = o.maxOldSpaceMb;
  let extra: string[] = [];
  const once = async (): Promise<ExecResult> => {
    const args = [`--max-old-space-size=${heap}`, ...extra, ...o.args];
    const proc = await run(process.execPath, args, o.cwd, process.env, false, o.input);
    o.log.push(`$ node ${args.join(' ')}  (cwd ${o.cwd})`, '--- stdout', truncateLog(proc.stdout), '--- stderr', proc.stderr);
    return proc;
  };
  let proc = await once();
  if (proc.code !== 0 && isHeapExhausted(proc)) {
    o.diagnostics.push(
      `warn: ${o.what} ran out of heap at --max-old-space-size=${heap} (${describeExit(proc)}); retrying once with ${heap * 2}` +
        (o.retry !== undefined ? ` ${o.retry.note}` : ''),
    );
    heap *= 2;
    extra = o.retry?.nodeArgs ?? [];
    o.beforeRetry?.();
    proc = await once();
  }
  return proc;
}

/** Stdout kept in the log (a worker's JSON result can be long). */
function truncateLog(s: string, max = 20000): string {
  return s.length > max ? `${s.slice(0, max)}\n... (${s.length - max} more characters)` : s;
}

/**
 * Runs the export-surface worker for one package. On success the sidecar is at
 * `job.sidecarFile`; undefined (with an `error:` diagnostic carrying the stderr
 * tail) when the worker failed or printed something that is not its result.
 */
export async function runSurfaceWorker(
  job: SurfaceJob,
  cwd: string,
  maxOldSpaceMb: number,
  log: string[],
  diagnostics: string[],
  run?: Runner,
): Promise<SurfaceWorkerResult | undefined> {
  const proc = await runNode({
    what: 'export surface',
    args: [SURFACE_WORKER],
    cwd,
    maxOldSpaceMb,
    input: JSON.stringify(job),
    log,
    diagnostics,
    ...(run !== undefined ? { run } : {}),
  });
  if (proc.errno !== undefined || proc.code !== 0) {
    diagnostics.push(`error: export surface failed: worker ${describeExit(proc)}${stderrTail(proc)}`);
    return undefined;
  }
  try {
    const r = JSON.parse(proc.stdout) as SurfaceWorkerResult;
    if (!Array.isArray(r.diagnostics) || typeof r.partial !== 'boolean') throw new Error('unexpected shape');
    return r;
  } catch (err) {
    diagnostics.push(`error: export surface failed: worker printed no result (${(err as Error).message})${stderrTail(proc)}`);
    return undefined;
  }
}

/**
 * `: <head and tail of stderr>`: the first `head` and last `tail` non-empty
 * lines (all of them when there are no more than `head + tail`; `…` marks the
 * lines dropped between), ` | `-joined. The head keeps the error that started
 * a cascade (nuxt prepare: `Cannot find module …/fontaine/dist/index.cjs`
 * followed by a long stack), the tail the final verdict. Each part is capped
 * at `max / 2` characters (the head keeps its start, the tail its end).
 * stdout is used when stderr is empty (pnpm prints its errors on stdout); ''
 * when both are empty.
 */
export function stderrTail(
  proc: Pick<ExecResult, 'stderr'> & Partial<Pick<ExecResult, 'stdout'>>,
  head = 3,
  tail = 5,
  max = 1000,
): string {
  const nonEmpty = (s: string): string[] =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '');
  let lines = nonEmpty(proc.stderr);
  if (lines.length === 0) lines = nonEmpty(proc.stdout ?? '');
  if (lines.length === 0) return '';
  const half = Math.floor(max / 2);
  if (lines.length <= head + tail) {
    const all = lines.join(' | ');
    return `: ${all.length > max ? `${all.slice(0, half)}…${all.slice(all.length - half)}` : all}`;
  }
  let first = lines.slice(0, head).join(' | ');
  let last = lines.slice(-tail).join(' | ');
  if (first.length > half) first = `${first.slice(0, half)}…`;
  if (last.length > half) last = `…${last.slice(last.length - half)}`;
  return `: ${first} | … | ${last}`;
}

/**
 * The environment of every install subprocess: all global, state and cache
 * writes of the package managers go under `<workDir>/.pm/` (sandboxed or shared
 * machines may forbid writing under `$HOME`; pnpm 10+ also takes a store lock
 * there). npm's own cache (`npm_config_cache`) is inherited unchanged. Returns
 * the env and the keys it set (logged, never the values).
 */
export function hermeticEnv(workDir: string, base: NodeJS.ProcessEnv = process.env): { env: NodeJS.ProcessEnv; keys: string[] } {
  const pm = path.resolve(workDir, '.pm');
  const set: Record<string, string> = {
    XDG_DATA_HOME: path.join(pm, 'xdg-data'),
    XDG_STATE_HOME: path.join(pm, 'xdg-state'),
    XDG_CONFIG_HOME: path.join(pm, 'xdg-config'),
    XDG_CACHE_HOME: path.join(pm, 'xdg-cache'),
    // pnpm: global bin dir (the store dir is passed as --store-dir).
    PNPM_HOME: path.join(pm, 'pnpm-home'),
    // yarn berry: global folder in the work dir, cache per project (.yarn/cache).
    YARN_GLOBAL_FOLDER: path.join(pm, 'yarn-global'),
    YARN_ENABLE_GLOBAL_CACHE: 'false',
    // corepack shims: downloads under the work dir, no strict packageManager check.
    COREPACK_HOME: path.join(pm, 'corepack'),
    COREPACK_ENABLE_STRICT: '0',
    // A repo's `engines` naming another node major must not abort the install
    // (npm and pnpm both read these; the checkout is only type-resolved, never run).
    npm_config_engine_strict: 'false',
    NPM_CONFIG_ENGINE_STRICT: 'false',
    pnpm_config_engine_strict: 'false', // pnpm 11 reads pnpm_config_*, not npm_config_*
    // Not set: pnpm_config_runtime_on_fail. pnpm 11 turns `devEngines.runtime`
    // with `onFail: "download"` into a `node@runtime:<range>` dev dependency that
    // is in the lockfile; overriding it makes `--frozen-lockfile` fail
    // (ERR_PNPM_OUTDATED_LOCKFILE), so such installs download node from nodejs.org.
  };
  // yarn berry ignores HTTP(S)_PROXY; it reads its own settings.
  const httpsProxy = base.HTTPS_PROXY ?? base.https_proxy;
  const httpProxy = base.HTTP_PROXY ?? base.http_proxy;
  if (httpsProxy !== undefined && httpsProxy !== '' && base.YARN_HTTPS_PROXY === undefined) set.YARN_HTTPS_PROXY = httpsProxy;
  if (httpProxy !== undefined && httpProxy !== '' && base.YARN_HTTP_PROXY === undefined) set.YARN_HTTP_PROXY = httpProxy;
  return { env: { ...base, ...set }, keys: Object.keys(set) };
}

/** `<workDir>/.pm/pnpm-store`, passed to pnpm as `--store-dir`. */
function pnpmStoreDir(workDir: string): string {
  return path.resolve(workDir, '.pm', 'pnpm-store');
}

/**
 * Runs the lockfile's install when the lockfile's dir has no node_modules.
 * The lockfile is searched from the package dir up to the repo root, so a
 * workspace package installs at the workspace root. Returns false on failure.
 *
 * The manager is `choosePackageManager`'s pick among the lockfiles of the
 * first dir that has any. A missing pnpm/yarn/bun binary falls back to
 * `npm exec --yes --package=<pm>@<version>`, the version from
 * `packageManagerVersion` (packageManager, devEngines, mise/.tool-versions,
 * the lockfile's major, a default major; never `latest`). A missing bun used
 * to skip the install, but then a tsconfig `extends` of an installed package
 * (`@tsconfig/bun`, `@tsconfig/node24`) cannot resolve and scip-typescript
 * indexes nothing (supabase/sdk, supabase/setup-cli).
 *
 * Every subprocess runs with `hermeticEnv(workDir)` (pnpm also gets
 * `--store-dir <workDir>/.pm/pnpm-store`); the env keys are logged once, before
 * the first subprocess. Without `workDir`, `<os tmpdir>/sentei-pm` is used.
 */
export async function install(
  repoRoot: string,
  pkgDir: string,
  diagnostics: string[],
  log: string[],
  run: Runner = exec,
  workDir: string = path.join(tmpdir(), 'sentei-pm'),
): Promise<boolean> {
  for (let d = pkgDir; ; d = path.dirname(d)) {
    const lockfiles = LOCKFILES.map(([f]) => f).filter((f) => existsSync(path.join(d, f)));
    const choice = choosePackageManager(nearestManagerManifest(repoRoot, d)?.json, lockfiles);
    if (choice !== undefined) {
      const { pm, lockfile } = choice;
      const baseArgs = LEGACY_ARGS[pm];
      const rel = path.relative(repoRoot, d) || '.';
      if (lockfiles.length > 1) {
        diagnostics.push(`info: ${lockfiles.join(', ')} in ${rel}; installing with ${pm} (${lockfile}: ${choice.reason})`);
      }
      if (isInstalled(path.join(d, 'node_modules'))) {
        diagnostics.push(`info: ${rel}/node_modules exists; install skipped`);
        return true;
      }
      const { env, keys } = hermeticEnv(workDir);
      for (const k of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PNPM_HOME', 'YARN_GLOBAL_FOLDER', 'COREPACK_HOME']) {
        mkdirSync(env[k]!, { recursive: true });
      }
      log.push(`# install env (hermetic, under ${path.resolve(workDir, '.pm')}): ${keys.join(', ')}`);
      const args = pm === 'pnpm' ? [...baseArgs, '--store-dir', pnpmStoreDir(workDir)] : baseArgs;
      // Windows: npm/pnpm/yarn are .cmd shims and need a shell.
      const shell = process.platform === 'win32';
      let cmd: string = pm;
      let cmdArgs = args;
      let proc = await run(cmd, cmdArgs, d, env, shell);
      log.push(`$ ${cmd} ${cmdArgs.join(' ')}  (cwd ${d})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
      if (proc.errno === 'ENOENT' && pm !== 'npm') {
        const want = packageManagerVersion(repoRoot, d, pm, lockfile);
        const fb = npmExecFallback(pm, want.version);
        diagnostics.push(
          `info: ${pm} is not installed (spawn ${pm} ENOENT); falling back to npm exec --yes --package=${fb.spec} ` +
            `(version ${want.version} ${want.source})`,
        );
        cmd = 'npm';
        // npm 11 checks the `devEngines` of the package.json at its local prefix
        // before `exec` (EBADDEVENGINES: `runtime` node ^24 on node 26, or
        // `packageManager` pnpm ≠ npm) and engine-strict does not turn that off;
        // only --force would, and it leaks into pnpm as npm_config_force (a
        // forced reinstall). So the prefix is an empty dir in the work dir: no
        // package.json, no devEngines check. The command still runs in `d`
        // (npm exec's run path is the cwd), and pnpm@x lands in npm's npx cache.
        const execPrefix = path.resolve(workDir, '.pm', 'npm-exec-prefix');
        mkdirSync(execPrefix, { recursive: true });
        cmdArgs = ['exec', '--yes', '--no-engine-strict', `--prefix=${execPrefix}`, `--package=${fb.spec}`, '--', fb.bin, ...(fb.args ?? args)];
        proc = await run(cmd, cmdArgs, d, env, shell);
        log.push(`$ ${cmd} ${cmdArgs.join(' ')}  (cwd ${d})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
      }
      if (proc.errno !== undefined || proc.code !== 0) {
        diagnostics.push(`error: ${cmd} ${cmdArgs.join(' ')} in ${rel} ${describeExit(proc)}${proc.errno === undefined ? stderrTail(proc) : ''}`);
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

/** Timeout of `nuxt prepare` (it may download nuxt through npm exec and runs module setup). */
export const NUXT_PREPARE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs `npm exec --yes -- nuxt prepare` in a package that has `nuxt` in
 * `dependencies` or `devDependencies` and no `.nuxt/tsconfig.json`: a Nuxt app's
 * tsconfig extends (or references) the generated `.nuxt/tsconfig*.json`, and
 * without it scip-typescript cannot read the config (TS5083). Hermetic env, 10
 * minute timeout, npm exec from the package dir so the installed nuxt is used.
 * Returns true when it ran and succeeded; on failure a `warn:` names the reason
 * and the package keeps whatever status indexing gives it (scip-typescript then
 * fails on the missing config, as before).
 */
export async function nuxtPrepare(
  pkgDir: string,
  diagnostics: string[],
  log: string[],
  run: Runner = exec,
  workDir: string = path.join(tmpdir(), 'sentei-pm'),
): Promise<boolean> {
  let json: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    json = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as typeof json;
  } catch {
    return false;
  }
  if (json.dependencies?.['nuxt'] === undefined && json.devDependencies?.['nuxt'] === undefined) return false;
  if (existsSync(path.join(pkgDir, '.nuxt', 'tsconfig.json'))) return false;
  const { env, keys } = hermeticEnv(workDir);
  for (const k of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'PNPM_HOME', 'YARN_GLOBAL_FOLDER', 'COREPACK_HOME']) {
    mkdirSync(env[k]!, { recursive: true });
  }
  log.push(`# nuxt prepare env (hermetic, under ${path.resolve(workDir, '.pm')}): ${keys.join(', ')}`);
  const args = ['exec', '--yes', '--', 'nuxt', 'prepare'];
  const proc = await run('npm', args, pkgDir, env, process.platform === 'win32', undefined, NUXT_PREPARE_TIMEOUT_MS);
  log.push(`$ npm ${args.join(' ')}  (cwd ${pkgDir})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
  if (proc.errno !== undefined || proc.code !== 0) {
    const timedOut = proc.errno === undefined && proc.signal === 'SIGTERM' ? ` (timeout ${NUXT_PREPARE_TIMEOUT_MS / 60000} min)` : '';
    diagnostics.push(
      `warn: nuxt app without .nuxt/tsconfig.json; npm ${args.join(' ')} ${describeExit(proc)}${timedOut}` +
        `${proc.errno === undefined ? stderrTail(proc) : ''}`,
    );
    return false;
  }
  diagnostics.push(`info: nuxt app without .nuxt/tsconfig.json; ran npm ${args.join(' ')}`);
  return true;
}

/** `could not start (ENOENT: spawn pnpm ENOENT)` / `exited with code 1` / `was killed by SIGTERM`. */
function describeExit(proc: ExecResult): string {
  if (proc.errno !== undefined) return `could not start (${proc.errno}: ${proc.errorMessage ?? 'spawn failed'})`;
  if (proc.signal !== null) return `was killed by ${proc.signal}`;
  return `exited with code ${proc.code}`;
}

/** Toolchain files that may pin a package manager, searched from the lockfile dir up to the repo root. */
const TOOL_VERSION_FILES = ['mise.toml', '.mise.toml', '.tool-versions'] as const;

/** Major used when nothing pins a version: the current long-lived majors, never `latest`. */
const DEFAULT_MAJOR: Record<Exclude<PackageManager, 'npm'>, string> = { pnpm: '9', yarn: '1', bun: '1' };

/**
 * The version of `pm` that a toolchain file pins, or undefined. `.tool-versions`
 * (asdf, mise): `pnpm 10.4.1` (the first version when several are listed);
 * `mise.toml` / `.mise.toml`: a `pnpm = "10"`, `pnpm = ["10", "9"]`,
 * `pnpm = { version = "10" }` or `"npm:pnpm" = "10"` line in the `[tools]` table.
 * Only versions and ranges count (`latest`, `lts` or a path do not).
 */
export function toolVersionPin(file: string, text: string, pm: PackageManager): string | undefined {
  const accept = (v: string | undefined): string | undefined =>
    v !== undefined && /^(?:v?\d[\w.+-]*|[\^~<>=][\w.^~<>=|*\s-]*)$/.test(v.trim()) ? v.trim().replace(/^v(?=\d)/, '') : undefined;
  const lines = text.split(/\r?\n/);
  if (path.basename(file) === '.tool-versions') {
    for (const raw of lines) {
      const [tool, ...versions] = raw.replace(/#.*/, '').trim().split(/\s+/);
      if (tool !== pm && tool !== `npm:${pm}`) continue;
      for (const v of versions) if (accept(v) !== undefined) return accept(v);
    }
    return undefined;
  }
  let inTools = false;
  for (const raw of lines) {
    const line = raw.trim();
    const section = /^\[\s*([^\]]+?)\s*\]/.exec(line);
    if (section !== null) {
      inTools = section[1] === 'tools';
      continue;
    }
    if (!inTools) continue;
    const m = /^(?:"(?:npm:)?([\w-]+)"|'(?:npm:)?([\w-]+)'|([\w-]+))\s*=\s*(.*)$/.exec(line);
    if (m === null || (m[1] ?? m[2] ?? m[3]) !== pm) continue;
    const value = m[4]!;
    const inTable = /\bversion\s*=\s*["']([^"']*)["']/.exec(value);
    const first = /["']([^"']*)["']/.exec(value);
    return accept((inTable ?? first)?.[1]);
  }
  return undefined;
}

/**
 * The major of `pm` that wrote a lockfile, from its text: pnpm `lockfileVersion`
 * ('9.0' → 9, also written by pnpm 10 and 11; '6.x' → 8; '5.4' → 7; other 5.x
 * → 6); yarn `# yarn lockfile v1` → 1, berry `__metadata.version` (≥ 7 → 4,
 * 5–6 → 3, ≤ 4 → 2); bun → 1. Anything else gets DEFAULT_MAJOR (`source` says so).
 */
export function pinnedVersion(pm: Exclude<PackageManager, 'npm'>, lockfile: string, text: string): { version: string; source: string } {
  const fallback = { version: DEFAULT_MAJOR[pm], source: `default major (${lockfile} names no version sentei knows)` };
  if (pm === 'pnpm') {
    const m = /^lockfileVersion:\s*['"]?(\d+)(?:\.(\d+))?/m.exec(text);
    if (m === null) return fallback;
    const [major, minor] = [Number(m[1]), Number(m[2] ?? 0)];
    const version = major >= 7 ? '9' : major === 6 ? '8' : major === 5 ? (minor >= 4 ? '7' : '6') : undefined;
    return version === undefined ? fallback : { version, source: `from lockfileVersion ${m[1]}.${m[2] ?? 0} in ${lockfile}` };
  }
  if (pm === 'yarn') {
    if (/^# yarn lockfile v1\b/m.test(text)) return { version: '1', source: `from the v1 header of ${lockfile}` };
    const m = /^__metadata:\s*\n(?:[ \t]+.*\n)*?[ \t]+version:\s*(\d+)/m.exec(text);
    if (m === null) return fallback;
    const v = Number(m[1]);
    return { version: v >= 7 ? '4' : v >= 5 ? '3' : '2', source: `from __metadata.version ${v} in ${lockfile}` };
  }
  return { version: '1', source: `from ${lockfile}` };
}

/**
 * The version of `pm` to run through `npm exec` when its binary is missing.
 * First match wins, each searched from the lockfile dir up to the repo root:
 *   1. `packageManager` (`pnpm@9.1.0+sha512...`) naming `pm`;
 *   2. `devEngines.packageManager` (`{ name, version }` or an array; a range is kept);
 *   3. a toolchain pin: `mise.toml`, `.mise.toml`, `.tool-versions`;
 *   4. the major that wrote the lockfile (`pinnedVersion`), else DEFAULT_MAJOR.
 * Never `latest`: a floating major changes install semantics (pnpm 12's store
 * lock failed every install it ran in the supabase run).
 */
function packageManagerVersion(
  repoRoot: string,
  lockDir: string,
  pm: Exclude<PackageManager, 'npm'>,
  lockfile: string,
): { version: string; source: string } {
  const walk = <T>(visit: (d: string) => T | undefined): T | undefined => {
    for (let d = lockDir; ; d = path.dirname(d)) {
      const hit = visit(d);
      if (hit !== undefined) return hit;
      if (d === repoRoot || path.dirname(d) === d) return undefined;
    }
  };
  const rel = (f: string): string => path.relative(repoRoot, f).split(path.sep).join('/');
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  for (const field of ['packageManager', 'devEngines.packageManager']) {
    const found = walk((d) => {
      let json: unknown;
      try {
        json = JSON.parse(read(path.join(d, 'package.json')) ?? '');
      } catch {
        json = undefined;
      }
      const hit = declaredManagers(json).find((e) => e.pm === pm && e.field === field && e.version !== undefined);
      return hit === undefined ? undefined : { version: hit.version!, source: `from ${field} in ${rel(path.join(d, 'package.json'))}` };
    });
    if (found !== undefined) return found;
  }
  const tool = walk((d) => {
    for (const f of TOOL_VERSION_FILES) {
      const text = read(path.join(d, f));
      const v = text === undefined ? undefined : toolVersionPin(f, text, pm);
      if (v !== undefined) return { version: v, source: `from ${rel(path.join(d, f))}` };
    }
    return undefined;
  });
  if (tool !== undefined) return tool;
  // bun.lockb is binary; bun's major needs no reading.
  return pinnedVersion(pm, lockfile, lockfile === 'bun.lockb' ? '' : (read(path.join(lockDir, lockfile)) ?? ''));
}

/**
 * npm package + bin for running `pm` through `npm exec`. Yarn 2+ (berry) ships
 * as `@yarnpkg/cli-dist` and has neither `--frozen-lockfile` nor `--ignore-scripts`
 * (`--immutable` / `--mode=skip-build` instead).
 */
function npmExecFallback(pm: PackageManager, version: string): { spec: string; bin: string; args?: string[] } {
  // The major of a version or a range (`^4.1.0`, `>=4`).
  if (pm === 'yarn' && /^(?:[2-9]|\d{2,})/.test(version.replace(/^[\s^~>=v]+/, ''))) {
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

function exec(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  shell = false,
  input?: string,
  timeoutMs?: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      shell,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    if (input !== undefined) {
      child.stdin!.on('error', () => {}); // EPIPE when the child exits early; its exit status tells the story
      child.stdin!.end(input);
    }
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr!.setEncoding('utf8').on('data', (c: string) => (stderr += c));
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
