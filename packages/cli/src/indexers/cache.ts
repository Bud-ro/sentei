// Index cache check (PLAN.md §6.2: indexes are cacheable by head_sha).
import { existsSync, readFileSync } from 'node:fs';
import type { DiscoveredPackage, DiscoveredRepo, Indexer, IndexStatus } from './types.ts';

/**
 * The fields of `work/index/<repo>/index.json` the cache reads. Structurally a
 * subset of `RepoIndex` in stages/index.ts, plus `install` (whether the run
 * installed third-party deps; absent in older files, read as false).
 */
export interface CachedRepoIndex {
  headSha: string | null;
  status: IndexStatus;
  install?: boolean;
  packages: Array<{ packageId: string; indexer: string | null; indexerVersion: string | null; status: IndexStatus }>;
}

export interface CacheOptions {
  /** Whether this run installs third-party deps. */
  install: boolean;
  /** Receives one line saying why a present index.json is not reused. */
  log?: (line: string) => void;
}

/**
 * A repo is reused when its index.json has the same non-null headSha and the
 * same packages, each owned by the same indexer at the same version, and:
 *   - no package indexed by an indexer is `partial`/`failed` (such results depend
 *     on the environment — missing installs, unbuilt siblings, adapter bugs — so
 *     they are always retried; a package no indexer owns stays `failed` and does
 *     not block reuse, since only a changed owner could change it, which the
 *     owner check already catches);
 *   - it was not indexed without install when this run installs.
 */
export function isCached(
  indexJson: string,
  repo: DiscoveredRepo,
  owners: ReadonlyArray<readonly [DiscoveredPackage, Indexer | undefined]>,
  options: CacheOptions,
): boolean {
  const why = (reason: string): false => {
    options.log?.(`[index] ${repo.repo}: not reusing cached index (${reason})`);
    return false;
  };
  if (repo.headSha === null || !existsSync(indexJson)) return false;
  let prev: CachedRepoIndex;
  try {
    prev = JSON.parse(readFileSync(indexJson, 'utf8')) as CachedRepoIndex;
  } catch {
    return why('index.json unreadable');
  }
  if (prev.headSha !== repo.headSha) return false;
  if (!Array.isArray(prev.packages) || prev.packages.length !== owners.length) return why('package set changed');
  const sameOwners = owners.every(([pkg, ix]) => {
    const p = prev.packages.find((q) => q.packageId === pkg.packageId);
    return p !== undefined && p.indexer === (ix?.name ?? null) && p.indexerVersion === (ix?.version ?? null);
  });
  if (!sameOwners) return why('packages or indexer versions changed');
  const bad = prev.packages.filter((p) => p.indexer !== null && p.status !== 'ok');
  if (bad.length > 0) {
    return why(`previous status ${bad.map((p) => `${p.packageId}=${p.status}`).join(', ')}; partial/failed results are always retried`);
  }
  if (options.install && prev.install !== true) return why('previous run did not install dependencies');
  return true;
}
