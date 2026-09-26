// Index cache check (PLAN.md §6.2: indexes are cacheable by head_sha), per package.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { packageSlug } from './scip-typescript.ts';
import type { ConsumerPolicy, DiscoveredPackage, DiscoveredRepo, Indexer, IndexStatus, OrgPackage } from './types.ts';

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
  /** failureInputHash of the run that made this result (absent in older files: a failure is never reused). */
  inputHash?: string;
  /** When this result was made, epoch seconds (absent in older files). */
  indexedAt?: number;
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
  /** `--retry-failed`: never reuse a partial / failed result. */
  retryFailed?: boolean;
  /**
   * Per package id, this run's failureInputHash. A partial / failed result is
   * reused only when its recorded hash equals this one; absent → never reused.
   */
  inputHashes?: ReadonlyMap<string, string>;
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
 *   - for an owned package whose entry is `partial` / `failed` (the failure
 *     cache): not `--retry-failed`, and the entry's `inputHash` equals this
 *     run's (failureInputHash: toolchain, install mode, policy and the head
 *     shas of the org packages it resolves through; a failure usually comes
 *     from the environment: a sibling's pubspec, the SDK). The dart-lang run
 *     retried 75 failing `pub get`s on every rerun, minutes each. An unowned
 *     package is always `failed` and only a changed owner can change it, which
 *     the owner check catches;
 *   - it was installed when this run installs;
 *   - its `.scip` and sidecar files still exist under today's names
 *     (`packageSlug`; older runs named them without the manager prefix, and an
 *     npm and a pub package in one dir could overwrite each other's files). A
 *     `failed` entry need not have them (ingest flags it either way).
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
        if (options.retryFailed === true) return { reuse: false, reason: `previous status ${p.status}; --retry-failed` };
        const want = options.inputHashes?.get(pkg.packageId);
        if (want === undefined || p.inputHash !== want) {
          return {
            reuse: false,
            reason: `previous status ${p.status}; ${p.inputHash === undefined ? 'no input hash recorded' : 'inputs changed (toolchain, install mode, policy or org dependencies)'}`,
          };
        }
      }
      if (p.indexer !== null && options.install && (p.install ?? prev.install) !== true) {
        return { reuse: false, reason: 'previous run did not install dependencies' };
      }
      if (p.indexer !== null && typeof p.scip === 'string' && p.scip !== `${packageSlug(pkg)}.scip`) {
        return { reuse: false, reason: `output file name changed (${p.scip})` };
      }
      if (p.status !== 'failed') {
        for (const f of [p.scip, p.exports]) {
          if (typeof f === 'string' && !existsSync(path.resolve(dir, f))) return { reuse: false, reason: `${f} missing` };
        }
      }
      return { reuse: true, entry: p };
    };
    out.set(pkg.packageId, decide());
  }
  return out;
}

/** What failureInputHash covers besides the package itself. */
export interface FailureInputs {
  indexer: Indexer;
  install: boolean;
  /** toolchainVersion(pkg.manager). */
  toolchain: string;
  policy?: Partial<ConsumerPolicy>;
  lookup: (packageId: string) => OrgPackage | undefined;
}

/**
 * The inputs a partial / failed result depends on, hashed (sha256 hex): the
 * package (id, path, manager, its repo's head sha: its files and manifest), the
 * indexer and version, the install mode, the toolchain version, the consumer
 * policy, and every org package it resolves through, transitively (resolved or
 * candidate ids with their repos' head shas: `pub get` of a package reads its org
 * dependencies' pubspecs through the source-link overrides). Any change retries
 * the failure; an ok result stays keyed by head sha and indexer version only.
 */
export function failureInputHash(repo: DiscoveredRepo, pkg: DiscoveredPackage, inputs: FailureInputs): string {
  const seen = new Set<string>([pkg.packageId]);
  const queue = [pkg];
  const orgDeps: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const d of cur.deps) {
      for (const id of [d.resolvedPackageId, ...(d.candidates ?? [])]) {
        if (id === null || id === undefined || seen.has(id)) continue;
        seen.add(id);
        const org = inputs.lookup(id);
        orgDeps.push(`${id}@${org?.repo.headSha ?? 'unknown'}`);
        if (org !== undefined) queue.push(org.pkg);
      }
    }
  }
  orgDeps.sort();
  const policy = Object.fromEntries(Object.entries(inputs.policy ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)));
  const key = JSON.stringify({
    v: 1,
    packageId: pkg.packageId,
    path: pkg.path,
    manager: pkg.manager,
    headSha: repo.headSha,
    indexer: `${inputs.indexer.name}@${inputs.indexer.version}`,
    install: inputs.install,
    toolchain: inputs.toolchain,
    policy,
    orgDeps,
  });
  return createHash('sha256').update(key).digest('hex');
}

/** Runs a command and resolves with its trimmed output, or null when it cannot run (injectable for tests). */
export type VersionProbe = (cmd: string, args: string[]) => Promise<string | null>;

const probe: VersionProbe = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      resolve(err ? null : `${stdout}${stderr}`.trim());
    });
  });

/** The Flutter SDK version on PATH (its version file), or null; never runs `flutter` (slow). */
function flutterVersionFile(): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const bin = path.join(dir, 'flutter');
    if (!existsSync(bin)) continue;
    try {
      const root = path.dirname(path.dirname(realpathSync(bin)));
      for (const f of [path.join(root, 'bin', 'cache', 'flutter.version.json'), path.join(root, 'version')]) {
        if (existsSync(f)) return `${root}: ${readFileSync(f, 'utf8').replace(/\s+/g, ' ').trim()}`;
      }
      return root;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The toolchain version string of a package manager, part of failureInputHash:
 * `node <version>` for npm (the package manager runs under it; its own version
 * comes from the lockfile / packageManager pin, which the head sha covers), and
 * `dart --version` plus the Flutter SDK on PATH for pub. Unknown managers and
 * unrunnable tools give a fixed string (a later install of the tool changes it).
 */
export async function toolchainVersion(manager: string, run: VersionProbe = probe): Promise<string> {
  if (manager === 'npm') return `node ${process.version}`;
  if (manager === 'pub') {
    const dart = (await run('dart', ['--version'])) ?? 'dart unavailable';
    return `${dart}; flutter ${flutterVersionFile() ?? 'unavailable'}`;
  }
  return `${manager}: unknown`;
}
