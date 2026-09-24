// Index cache check (PLAN.md §6.2: indexes are cacheable by head_sha), per package.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { packageSlug } from './scip-typescript.ts';
import type { DiscoveredPackage, DiscoveredRepo, Indexer, IndexStatus } from './types.ts';

/**
 * A package entry of `work/index/<repo>/index.json` as the cache reads it.
 * Structurally a subset of `PackageIndex` in stages/index.ts; a reused entry is
 * copied verbatim, so its other fields are carried through untyped.
 */
export interface CachedPackageIndex {
  packageId: string;
  indexer: string | null;
  indexerVersion: string | null;
  status: IndexStatus;
  scip?: string | null;
  exports?: string | null;
  /** Whether third-party deps were installed for this result (absent in older files: the repo-level flag). */
  install?: boolean;
  [key: string]: unknown;
}

/**
 * The fields of `work/index/<repo>/index.json` the cache reads, plus `install`
 * (repo level; absent in older files, read as false).
 */
export interface CachedRepoIndex {
  headSha: string | null;
  status: IndexStatus;
  install?: boolean;
  packages: CachedPackageIndex[];
}

export interface CacheOptions {
  /** Whether this run installs third-party deps. */
  install: boolean;
}

/** Per package: reuse the previous entry verbatim, or re-index (with why, when something was cached). */
export type CacheDecision =
  | { reuse: true; entry: CachedPackageIndex }
  | { reuse: false; /** Absent when there was nothing to reuse (first index, new commit). */ reason?: string };

/**
 * Decides, per package of the repo, whether its previous result in index.json
 * can be reused. A package's entry is reused when:
 *   - index.json has the same non-null headSha as the repo;
 *   - the package has an entry owned by the same indexer at the same version
 *     (an unowned package: an entry with no indexer, too);
 *   - the entry's status is `ok` for an owned package (partial/failed results
 *     depend on the environment — missing installs, unbuilt siblings, adapter
 *     bugs — so they are always retried; an unowned package is always `failed`
 *     and only a changed owner can change it, which the owner check catches);
 *   - it was installed when this run installs;
 *   - its `.scip` and sidecar files still exist under today's names
 *     (`packageSlug`; older runs named them without the manager prefix, and an
 *     npm and a pub package in one dir could overwrite each other's files).
 * Keyed by packageId; every package of the repo has a decision.
 */
export function isCached(
  indexJson: string,
  repo: DiscoveredRepo,
  owners: ReadonlyArray<readonly [DiscoveredPackage, Indexer | undefined]>,
  options: CacheOptions,
): Map<string, CacheDecision> {
  const all = (d: CacheDecision): Map<string, CacheDecision> => new Map(owners.map(([pkg]) => [pkg.packageId, d]));
  if (repo.headSha === null || !existsSync(indexJson)) return all({ reuse: false });
  let prev: CachedRepoIndex;
  try {
    prev = JSON.parse(readFileSync(indexJson, 'utf8')) as CachedRepoIndex;
  } catch {
    return all({ reuse: false, reason: 'index.json unreadable' });
  }
  if (prev.headSha !== repo.headSha) return all({ reuse: false });
  const prevPackages = Array.isArray(prev.packages) ? prev.packages : [];
  const dir = path.dirname(indexJson);
  const out = new Map<string, CacheDecision>();
  for (const [pkg, ix] of owners) {
    const decide = (): CacheDecision => {
      const p = prevPackages.find((q) => q.packageId === pkg.packageId);
      if (p === undefined) return { reuse: false, reason: 'new package' };
      if (p.indexer !== (ix?.name ?? null) || p.indexerVersion !== (ix?.version ?? null)) {
        return { reuse: false, reason: `indexer changed: ${p.indexer ?? 'none'}@${p.indexerVersion ?? '-'}` };
      }
      if (p.indexer !== null && p.status !== 'ok') {
        return { reuse: false, reason: `previous status ${p.status}; partial/failed results are always retried` };
      }
      if (p.indexer !== null && options.install && (p.install ?? prev.install) !== true) {
        return { reuse: false, reason: 'previous run did not install dependencies' };
      }
      if (p.indexer !== null && typeof p.scip === 'string' && p.scip !== `${packageSlug(pkg)}.scip`) {
        return { reuse: false, reason: `output file name changed (${p.scip})` };
      }
      for (const f of [p.scip, p.exports]) {
        if (typeof f === 'string' && !existsSync(path.resolve(dir, f))) return { reuse: false, reason: `${f} missing` };
      }
      return { reuse: true, entry: p };
    };
    out.set(pkg.packageId, decide());
  }
  return out;
}
