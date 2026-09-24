import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StageContext } from '../context.ts';
import { scipTypescript } from '../indexers/scip-typescript.ts';
import type {
  DiscoverFile,
  DiscoveredPackage,
  DiscoveredRepo,
  Indexer,
  IndexerOptions,
  IndexStatus,
  OrgPackage,
} from '../indexers/types.ts';
import { worstStatus } from '../indexers/types.ts';

/** Registered indexers; the first one that detects a package owns it. */
export const INDEXERS: readonly Indexer[] = [scipTypescript];

export interface IndexOptions extends IndexerOptions {
  /** Re-index repos even when the cached index.json matches. */
  force: boolean;
}

export const DEFAULT_INDEX_OPTIONS: IndexOptions = { force: false, install: true, maxOldSpaceMb: 8192 };

/** `work/index/<repo slug>/index.json`. */
export interface RepoIndex {
  repo: string;
  headSha: string | null;
  status: IndexStatus;
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
}

/** `acme/lib-core` → `acme__lib-core`. */
export function repoSlug(repo: string): string {
  return repo.replace(/\//g, '__');
}

/** `index` stage (PLAN.md §6.2): run the pinned SCIP indexers per package. */
export async function index(ctx: StageContext, opts: Partial<IndexOptions> = {}): Promise<void> {
  const options: IndexOptions = { ...DEFAULT_INDEX_OPTIONS, ...opts };
  const discoverPath = path.join(ctx.work, 'discover.json');
  if (!existsSync(discoverPath)) throw new Error(`[index] ${discoverPath} not found; run \`sentei discover\` first`);
  const discovered = JSON.parse(readFileSync(discoverPath, 'utf8')) as DiscoverFile;

  const byId = new Map<string, OrgPackage>();
  for (const repo of discovered.repos) {
    for (const pkg of repo.packages) byId.set(pkg.packageId, { repo, pkg });
  }
  const lookup = (id: string): OrgPackage | undefined => byId.get(id);

  for (const repo of discovered.repos) {
    const outDir = path.resolve(ctx.work, 'index', repoSlug(repo.repo));
    const indexJson = path.join(outDir, 'index.json');
    const owners = repo.packages.map((pkg) => [pkg, INDEXERS.find((ix) => ix.detect({ repo, pkg }))] as const);

    if (!options.force && isCached(indexJson, repo, owners)) {
      ctx.log(`[index] ${repo.repo}: cached at ${repo.headSha} (use --force to re-index)`);
      continue;
    }
    mkdirSync(outDir, { recursive: true });

    const result: RepoIndex = { repo: repo.repo, headSha: repo.headSha, status: 'ok', packages: [] };
    for (const [pkg, indexer] of owners) {
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
        };
      } else {
        const r = await indexer.run({ repo, pkg, lookup, options }, outDir);
        entry = {
          packageId: pkg.packageId,
          indexer: indexer.name,
          indexerVersion: indexer.version,
          status: r.status,
          scip: path.relative(outDir, r.scipFile),
          exports: path.relative(outDir, r.exportsFile),
          diagnostics: r.diagnostics,
        };
      }
      result.packages.push(entry);
      result.status = worstStatus(result.status, entry.status);
      const firstProblem = entry.diagnostics.find((d) => d.startsWith('error:') || d.startsWith('warn:'));
      ctx.log(
        `[index] ${repo.repo} ${pkg.packageId}: ${entry.status}` +
          (entry.indexer ? ` (${entry.indexer}@${entry.indexerVersion})` : '') +
          (entry.status !== 'ok' && firstProblem ? ` — ${firstProblem}` : ''),
      );
    }
    writeFileSync(indexJson, `${JSON.stringify(result, null, 2)}\n`);
  }
}

/**
 * A repo is skipped when its index.json has the same non-null headSha and the
 * same packages, each owned by the same indexer at the same version.
 */
function isCached(
  indexJson: string,
  repo: DiscoveredRepo,
  owners: ReadonlyArray<readonly [DiscoveredPackage, Indexer | undefined]>,
): boolean {
  if (repo.headSha === null || !existsSync(indexJson)) return false;
  let prev: RepoIndex;
  try {
    prev = JSON.parse(readFileSync(indexJson, 'utf8')) as RepoIndex;
  } catch {
    return false;
  }
  if (prev.headSha !== repo.headSha || prev.packages.length !== owners.length) return false;
  return owners.every(([pkg, ix]) => {
    const p = prev.packages.find((q) => q.packageId === pkg.packageId);
    return p !== undefined && p.indexer === (ix?.name ?? null) && p.indexerVersion === (ix?.version ?? null);
  });
}
