import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StageContext } from '../context.ts';
import { failureInputHash, isCached, toolchainVersion, type CacheDecision } from '../indexers/cache.ts';
import { scipDart } from '../indexers/scip-dart.ts';
import { scipTypescript } from '../indexers/scip-typescript.ts';
import type {
  DiscoveredPackage,
  DiscoveredRepo,
  DiscoverFile,
  Indexer,
  IndexerOptions,
  IndexStatus,
  OrgPackage,
  PrepareResult,
} from '../indexers/types.ts';
import { worstStatus } from '../indexers/types.ts';

/** Registered indexers; the first one that detects a package owns it. */
export const INDEXERS: readonly Indexer[] = [scipTypescript, scipDart];

export interface IndexOptions extends IndexerOptions {
  /** Re-index every package even when its cached result can be reused. */
  force: boolean;
  /** `--retry-failed`: re-index packages whose cached result is partial / failed (ok ones stay cached). */
  retryFailed: boolean;
}

export const DEFAULT_INDEX_OPTIONS: IndexOptions = { force: false, retryFailed: false, install: true, maxOldSpaceMb: 8192 };

/** More packages than this: `index` prints `N/M packages ...` progress lines. */
export const PROGRESS_THRESHOLD = 20;

/** Every how many packages a progress line is printed (about ten per phase, at least every 10). */
export function progressStep(total: number): number {
  return Math.max(10, Math.ceil(total / 10));
}

/** `work/index/<repo slug>/index.json`. */
export interface RepoIndex {
  repo: string;
  headSha: string | null;
  status: IndexStatus;
  /** True when every package's result was made with installed third-party deps. */
  install: boolean;
  packages: PackageIndex[];
}

export interface PackageIndex {
  packageId: string;
  indexer: string | null;
  indexerVersion: string | null;
  status: IndexStatus;
  /** File names relative to the repo's index dir (null when no indexer ran). */
  scip: string | null;
  exports: string | null;
  diagnostics: string[];
  /** Whether this result was made with installed third-party deps (an install run does not reuse a no-install result). */
  install: boolean;
  /** failureInputHash when this result was made (the failure cache compares it; absent in older files and for unowned packages). */
  inputHash?: string;
  /** When this result was made, epoch seconds (absent in older files). */
  indexedAt?: number;
}

/** `acme/lib-core` → `acme__lib-core`. */
export function repoSlug(repo: string): string {
  return repo.replace(/\//g, '__');
}

/**
 * `index` stage (PLAN.md §6.2): run the pinned SCIP indexers per package. Ends with a
 * summary (indexed / cached / failed per indexer, one line per failed package), which
 * it also returns (`--strict` exits 2 when `failed > 0`).
 */
export async function index(ctx: StageContext, opts: Partial<IndexOptions> = {}): Promise<IndexSummary> {
  const options: IndexOptions = { ...DEFAULT_INDEX_OPTIONS, workDir: path.resolve(ctx.work), ...opts };
  const discoverPath = path.join(ctx.work, 'discover.json');
  if (!existsSync(discoverPath)) throw new Error(`[index] ${discoverPath} not found; run \`sentei discover\` first`);
  const discovered = JSON.parse(readFileSync(discoverPath, 'utf8')) as DiscoverFile;
  const policy = discovered.policy;

  const byId = new Map<string, OrgPackage>();
  for (const repo of discovered.repos) {
    for (const pkg of repo.packages) byId.set(pkg.packageId, { repo, pkg });
  }
  const lookup = (id: string): OrgPackage | undefined => byId.get(id);
  const orgPackages = [...byId.values()];

  // Plan: per repo, each package's owner, failure-cache input hash and cache decision.
  const toolchains = new Map<string, Promise<string>>();
  const toolchainOf = (manager: string): Promise<string> => {
    let t = toolchains.get(manager);
    if (t === undefined) toolchains.set(manager, (t = toolchainVersion(manager)));
    return t;
  };
  const plans: RepoPlan[] = [];
  for (const repo of discovered.repos) {
    const outDir = path.resolve(ctx.work, 'index', repoSlug(repo.repo));
    const indexJson = path.join(outDir, 'index.json');
    const owners = repo.packages.map((pkg) => [pkg, INDEXERS.find((ix) => ix.detect({ repo, pkg }))] as const);
    const inputHashes = new Map<string, string>();
    for (const [pkg, ix] of owners) {
      if (ix === undefined) continue;
      const toolchain = await toolchainOf(pkg.manager);
      inputHashes.set(pkg.packageId, failureInputHash(repo, pkg, { indexer: ix, install: options.install, toolchain, lookup, ...(policy ? { policy } : {}) }));
    }
    const decisions = options.force
      ? undefined
      : isCached(indexJson, repo, owners, { install: options.install, retryFailed: options.retryFailed, inputHashes });
    plans.push({ repo, outDir, indexJson, owners, inputHashes, decisions });
  }
  const cachedFailure = (plan: RepoPlan, pkg: DiscoveredPackage): boolean => {
    const d = plan.decisions?.get(pkg.packageId);
    return d?.reuse === true && d.entry.status !== 'ok';
  };

  // Phase 1: make every org package resolvable (install + source links) before
  // indexing any, since a consumer resolves an org dep's own org imports through
  // that dep's node_modules. Cached repos are prepared too (others resolve through
  // them), except packages whose cached failure will be reused: their prepare
  // failed or fell short with the same inputs (the dart-lang run repeated 75
  // failing `pub get`s on every rerun).
  const summary = emptySummary();
  const prepared = new Map<string, PrepareResult>();
  const toPrepare = plans.flatMap((plan) => plan.owners
    .filter(([pkg, ix]) => ix?.prepare !== undefined && !cachedFailure(plan, pkg))
    .map(([pkg, ix]) => ({ repo: plan.repo, pkg, indexer: ix! })));
  const prepStep = progressStep(toPrepare.length);
  let preparedCount = 0;
  for (const { repo, pkg, indexer } of toPrepare) {
    ctx.log(`[index] ${prepareLine(repo, pkg, options.install)}`);
    prepared.set(pkg.packageId, await indexer.prepare!({ repo, pkg, lookup, orgPackages, options, ...(policy ? { policy } : {}) }));
    preparedCount++;
    if (toPrepare.length > PROGRESS_THRESHOLD && (preparedCount % prepStep === 0 || preparedCount === toPrepare.length)) {
      ctx.log(`[index] ${preparedCount}/${toPrepare.length} packages prepared`);
    }
  }

  // Phase 2: index. Per package, a previous result that can be reused (same
  // headSha, indexer and version, install-compatible; ok, or a failure with the
  // same input hash) is kept verbatim; only the others are re-indexed, and
  // index.json is rewritten with both.
  const total = plans.reduce((n, p) => n + p.owners.length, 0);
  const step = progressStep(total);
  let done = 0;
  const progress = (): void => {
    done++;
    if (total > PROGRESS_THRESHOLD && (done % step === 0 || done === total)) ctx.log(`[index] ${done}/${total} packages done`);
  };
  for (const { repo, outDir, indexJson, owners, inputHashes, decisions } of plans) {
    mkdirSync(outDir, { recursive: true });
    const logOf = (entry: PackageIndex): string | null => {
      if (entry.scip === null) return null;
      const log = path.join(ctx.work, 'index', repoSlug(repo.repo), entry.scip.replace(/\.scip$/, '.log'));
      return existsSync(log) ? log : null;
    };

    const result: RepoIndex = { repo: repo.repo, headSha: repo.headSha, status: 'ok', install: true, packages: [] };
    for (const [pkg, indexer] of owners) {
      const decision = decisions?.get(pkg.packageId);
      if (decision?.reuse === true) {
        const entry = decision.entry as unknown as PackageIndex;
        result.packages.push(entry);
        result.status = worstStatus(result.status, entry.status);
        if (entry.indexer !== null && entry.install !== true) result.install = false;
        countPackage(summary, repo.repo, entry, true, logOf(entry));
        if (entry.status === 'ok' || entry.indexer === null) {
          ctx.log(`[index] ${repo.repo} ${pkg.packageId}: cached (${entry.status} at ${repo.headSha}; use --force to re-index)`);
        } else {
          // Replay the failure as the first run printed it, then say it is cached.
          const firstProblem = (entry.diagnostics ?? []).find((d) => d.startsWith('error:') || d.startsWith('warn:'));
          const log = logOf(entry);
          const when = typeof entry.indexedAt === 'number' ? new Date(entry.indexedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'an earlier run';
          ctx.log(`[index] ${repo.repo} ${pkg.packageId}: ${entry.status} (${entry.indexer}@${entry.indexerVersion})` +
            (firstProblem ? ` — ${firstProblem}` : ''));
          ctx.log(`[index]   cached failure from ${when}; rerun with --retry-failed to retry${log !== null ? ` (log: ${log})` : ''}`);
        }
        progress();
        continue;
      }
      const why = options.force ? '--force' : decision?.reuse === false ? decision.reason : undefined;
      let entry: PackageIndex;
      if (indexer === undefined) {
        entry = {
          packageId: pkg.packageId,
          indexer: null,
          indexerVersion: null,
          status: 'failed',
          scip: null,
          exports: null,
          diagnostics: ['error: no indexer'],
          install: options.install,
          indexedAt: Math.floor(Date.now() / 1000),
        };
      } else {
        const input = { repo, pkg, lookup, orgPackages, options, ...(policy ? { policy } : {}) };
        const prep = prepared.get(pkg.packageId);
        const r = await indexer.run(prep === undefined ? input : { ...input, prepared: prep }, outDir);
        entry = {
          packageId: pkg.packageId,
          indexer: indexer.name,
          indexerVersion: indexer.version,
          status: r.status,
          scip: path.relative(outDir, r.scipFile),
          exports: path.relative(outDir, r.exportsFile),
          diagnostics: r.diagnostics,
          install: options.install,
          ...(inputHashes.has(pkg.packageId) ? { inputHash: inputHashes.get(pkg.packageId)! } : {}),
          indexedAt: Math.floor(Date.now() / 1000),
        };
      }
      result.packages.push(entry);
      result.status = worstStatus(result.status, entry.status);
      if (entry.indexer !== null && !entry.install) result.install = false;
      countPackage(summary, repo.repo, entry, false, logOf(entry));
      const firstProblem = entry.diagnostics.find((d) => d.startsWith('error:') || d.startsWith('warn:'));
      ctx.log(
        `[index] ${repo.repo} ${pkg.packageId}: ${why !== undefined ? `re-indexed (${why}): ` : ''}${entry.status}` +
          (entry.indexer ? ` (${entry.indexer}@${entry.indexerVersion})` : '') +
          (entry.status !== 'ok' && firstProblem ? ` — ${firstProblem}` : ''),
      );
      progress();
    }
    writeFileSync(indexJson, `${JSON.stringify(result, null, 2)}\n`);
  }
  for (const line of formatIndexSummary(summary)) ctx.log(line);
  return summary;
}

/** One repo's plan: owners, failure-cache input hashes and cache decisions (undefined with --force). */
interface RepoPlan {
  repo: DiscoveredRepo;
  outDir: string;
  indexJson: string;
  owners: ReadonlyArray<readonly [DiscoveredPackage, Indexer | undefined]>;
  inputHashes: Map<string, string>;
  decisions: Map<string, CacheDecision> | undefined;
}

/** Lockfiles that name an npm-style package manager, in the order they are looked for. */
const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'],
];

/**
 * The line printed as a package's prepare step starts, so a long install phase is
 * not silent (the dart-lang index log printed nothing for its first ~10 minutes):
 * `pub get <id>` (`--offline` without installs), `installing <id> (<pm>)` with the
 * manager of the nearest lockfile between the package dir and the repo root
 * (`npm` when none; the adapter makes the final choice), `linking <id>
 * (--no-install)` for npm without installs.
 */
export function prepareLine(repo: DiscoveredRepo, pkg: DiscoveredPackage, install: boolean): string {
  if (pkg.manager === 'pub') return `pub get${install ? '' : ' --offline'} ${pkg.packageId}`;
  if (!install) return `linking ${pkg.packageId} (--no-install)`;
  if (pkg.manager !== 'npm') return `preparing ${pkg.packageId} (${pkg.manager})`;
  const root = path.resolve(repo.localPath);
  for (let dir = path.resolve(root, pkg.path); dir.startsWith(root); dir = path.dirname(dir)) {
    const hit = LOCKFILES.find(([file]) => existsSync(path.join(dir, file)));
    if (hit !== undefined) return `installing ${pkg.packageId} (${hit[1]})`;
    if (dir === root || path.dirname(dir) === dir) break;
  }
  return `installing ${pkg.packageId} (npm)`;
}

/** Per-indexer package counts of one `index` run (`(none)`: no indexer owns the package). */
export interface IndexCounts {
  /** Indexed in this run (any status). */
  indexed: number;
  /** Reused from a previous run (ok, or a cached partial / failed result: the failure cache). */
  cached: number;
  /** Status `failed` (fresh or reused), included in indexed / cached. */
  failed: number;
  /** Status `partial` (fresh or reused), included in indexed / cached. */
  partial: number;
}

export interface IndexFailure {
  repo: string;
  packageId: string;
  indexer: string | null;
  /** The first meaningful error line of the package's diagnostics (see firstMeaningfulError). */
  error: string;
  /** The package's log file (under <work>/index/<repo slug>/), null when none was written. */
  log: string | null;
}

/** What `index` returns and prints last (`sentei index --json` prints it as `{ "summary": … }`). */
export interface IndexSummary extends IndexCounts {
  byIndexer: Record<string, IndexCounts>;
  failures: IndexFailure[];
}

const NO_INDEXER = '(none)';

function emptyCounts(): IndexCounts {
  return { indexed: 0, cached: 0, failed: 0, partial: 0 };
}

/** Add one package result to the summary. */
export function countPackage(
  summary: IndexSummary, repo: string, entry: PackageIndex, cached: boolean, logFile: string | null,
): void {
  const key = entry.indexer ?? NO_INDEXER;
  const per = (summary.byIndexer[key] ??= emptyCounts());
  for (const c of [summary, per]) {
    if (cached) c.cached++;
    else c.indexed++;
    if (entry.status === 'failed') c.failed++;
    if (entry.status === 'partial') c.partial++;
  }
  if (entry.status === 'failed') {
    summary.failures.push({ repo, packageId: entry.packageId, indexer: entry.indexer, error: firstMeaningfulError(entry.diagnostics), log: logFile });
  }
}

export function emptySummary(): IndexSummary {
  return { ...emptyCounts(), byIndexer: {}, failures: [] };
}

/** A diagnostic that names the cause: a TS diagnostic code, an `XxxError:`, an errno, heap exhaustion, a timeout. */
const MEANINGFUL = /\bTS\d{3,5}\b|\b[A-Z]\w*Error:|\bE[A-Z]{3,}\b|out of memory|timed out|not found|no indexer|cannot|could not|failed to/i;

/**
 * The line of a failed package's diagnostics most likely to say why: among the
 * `error:` lines (else `warn:`, else all), skipping echoed source (`throw …`), stack
 * frames (`at …`) and the pipe-joined stderr tails of "exited with code" lines, the
 * first that looks like a cause (MEANINGFUL), else the first remaining one, else the
 * first line cut at its stderr tail. The `error:` prefix and a leading `Error: ` are
 * dropped; at most 200 characters.
 */
export function firstMeaningfulError(diagnostics: readonly string[]): string {
  const strip = (d: string): string => d.replace(/^(?:error|warn|info):\s*/, '').replace(/^Error:\s*/, '').trim();
  const pool = [/^error:/, /^warn:/, /./].map((re) => diagnostics.filter((d) => re.test(d))).find((xs) => xs.length > 0) ?? [];
  const lines = pool.map(strip);
  const clean = lines.filter((l) => l !== '' && !/^(?:throw\b|at\s|\^)/.test(l) && !l.includes(' | '));
  const pick = clean.find((l) => MEANINGFUL.test(l)) ?? clean[0] ?? (lines[0] ?? 'failed (no diagnostics)').split(' | ')[0]!.replace(/:\s*$/, '');
  return pick.length > 200 ? `${pick.slice(0, 199)}…` : pick;
}

/**
 * The end-of-run table: one line per indexer (indexed / cached / failed, partial when
 * any), a total when there are several, then one line per failed package: package id,
 * its first meaningful error, its log file.
 */
export function formatIndexSummary(summary: IndexSummary): string[] {
  const row = (name: string, c: IndexCounts): string[] => [
    name, String(c.indexed), String(c.cached), String(c.failed), String(c.partial),
  ];
  const rows = [['INDEXER', 'INDEXED', 'CACHED', 'FAILED', 'PARTIAL']];
  const names = Object.keys(summary.byIndexer).sort();
  for (const n of names) rows.push(row(n, summary.byIndexer[n]!));
  if (names.length !== 1) rows.push(row('total', summary));
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const out = [
    `[index] summary: ${summary.indexed} indexed, ${summary.cached} cached, ${summary.failed} failed` +
      (summary.partial > 0 ? `, ${summary.partial} partial` : ''),
    ...rows.map((r) => `  ${r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')}`.trimEnd()),
  ];
  if (summary.failures.length > 0) {
    out.push(`[index] ${summary.failures.length} package(s) failed to index; their consumers' findings are blocked (index_failed). (exit 2 with --strict):`);
    for (const f of summary.failures) out.push(`  ${f.packageId}: ${f.error}${f.log !== null ? ` (log: ${f.log})` : ''}`);
  }
  return out;
}
