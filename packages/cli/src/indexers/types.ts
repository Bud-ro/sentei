// Indexer boundary contract (PLAN.md §6.6), adapted for M1: an indexer sees the
// whole repo (it may hold several packages) and the org package lookup, because
// cross-repo linking needs the other checkouts' paths.

/** Shape of `work/discover.json`, restricted to the fields the index stage reads. */
export interface DiscoverFile {
  org: string;
  repos: DiscoveredRepo[];
}

export interface DiscoveredRepo {
  /** `<org>/<name>`, e.g. `acme/lib-core`. */
  repo: string;
  /** Absolute path of the checkout. */
  localPath: string;
  defaultBranch?: string | null;
  headSha: string | null;
  packages: DiscoveredPackage[];
}

export interface DiscoveredPackage {
  /** `<manager>:<name>`, e.g. `npm:@acme/core`. */
  packageId: string;
  /** Package dir relative to the repo root, POSIX (`.` for the root). */
  path: string;
  manager: 'npm' | 'pub' | (string & {});
  name: string | null;
  version?: string | null;
  visibility?: string;
  /** Entry files relative to the repo root, POSIX. */
  entryPoints: string[];
  deps: DiscoveredDep[];
}

export interface DiscoveredDep {
  name: string;
  manager: string;
  constraint?: string | null;
  /** Set when the dep is an org package. */
  resolvedPackageId: string | null;
}

/** An org package together with the repo that holds it. */
export interface OrgPackage {
  repo: DiscoveredRepo;
  pkg: DiscoveredPackage;
}

export interface IndexerOptions {
  /** Run the package manager install when a lockfile exists and node_modules does not. */
  install: boolean;
  /** Heap limit for the indexer subprocess (`--max-old-space-size`). */
  maxOldSpaceMb: number;
}

export interface IndexerInput {
  repo: DiscoveredRepo;
  pkg: DiscoveredPackage;
  /** Look up any org package by package id (across all repos). */
  lookup: (packageId: string) => OrgPackage | undefined;
  options: IndexerOptions;
}

export type IndexStatus = 'ok' | 'partial' | 'failed';

export interface IndexerResult {
  status: IndexStatus;
  /** Human-readable lines, prefixed `info:`, `warn:` or `error:`. */
  diagnostics: string[];
  /** Absolute path of the produced `.scip` file (may not exist when failed). */
  scipFile: string;
  /** Absolute path of the export-surface sidecar (may not exist when failed). */
  exportsFile: string;
}

export interface Indexer {
  name: string;
  /** Pinned; bump deliberately (PLAN.md §6.6). */
  version: string;
  /** Does this indexer own this package? Only `repo`/`pkg` are consulted. */
  detect(input: Pick<IndexerInput, 'repo' | 'pkg'>): boolean;
  run(input: IndexerInput, outDir: string): Promise<IndexerResult>;
}

/** Export-surface sidecar written next to each `.scip` file. */
export interface ExportsSidecar {
  packageId: string;
  /** Entry points (repo-relative) that were in the program and were read. */
  entryPoints: string[];
  /** Entry points from discover that were not part of the program (status is partial). */
  missingEntryPoints: string[];
  exports: ExportRecord[];
  /** Module specifiers (or entry files) whose exports could not be resolved. */
  unresolved: string[];
}

export interface SourcePosition {
  /** Repo-relative POSIX path. */
  file: string;
  /** 0-based line. */
  line: number;
  /** 0-based UTF-16 column. */
  col: number;
}

export interface ExportRecord extends SourcePosition {
  /** Entry file (repo-relative) this export is reachable from. */
  entry: string;
  /** Name under which the entry exports it (`ns.x` for namespace re-exports). */
  exportedAs: string;
  /** Declared name (`default` for anonymous default exports). */
  name: string;
  /** Set to `default-keyword` when the position is the `default` keyword. */
  note?: string;
  /** Occurrences inside export statements that must not count as references. */
  sites: SourcePosition[];
}

const RANK: Record<IndexStatus, number> = { ok: 0, partial: 1, failed: 2 };

/** The worse of two statuses (failed > partial > ok). */
export function worstStatus(a: IndexStatus, b: IndexStatus): IndexStatus {
  return RANK[a] >= RANK[b] ? a : b;
}
