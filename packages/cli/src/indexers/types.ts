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
  /** Every org package (all repos), e.g. to tell org imports from third-party ones. */
  orgPackages: readonly OrgPackage[];
  options: IndexerOptions;
  /** Result of this package's `prepare`, merged into the `run` result. */
  prepared?: PrepareResult;
}

/** Outcome of `Indexer.prepare` (install + source links). */
export interface PrepareResult {
  status: IndexStatus;
  diagnostics: string[];
  /** Subprocess output for the package's log file. */
  log: string[];
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
  /**
   * Makes the package's dependencies resolvable (install, org source links).
   * The stage calls it for every package in the org before any `run`, because
   * resolution is transitive: a consumer's import of org package A resolves A's
   * own org imports through A's node_modules.
   */
  prepare?(input: IndexerInput): Promise<PrepareResult>;
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
  /**
   * Named imports from org modules that resolve to nothing: the org package
   * does not export that name (version skew). Does not change status.
   */
  unresolvedImports: UnresolvedImport[];
  /** Consumer-side constructs that hide which org members are used. */
  flags: ConsumerFlag[];
  /**
   * Every static member access `X.m` / `X['m']` on an org namespace import,
   * resolved by the TypeScript checker to the member's declaration.
   * Workaround for an upstream gap (PLAN.md §6.6: workarounds live at the
   * indexer boundary): scip-typescript 0.4.0: namespace member access to an
   * alias re-export yields a local symbol (e.g. `W.namespaceUsed` where the
   * entry does `export { namespaceUsed } from './misc'`), so the reference is
   * lost. Recorded for every access whether or not SCIP resolved it; ingest
   * dedupes against existing occurrences.
   */
  namespaceMemberRefs: NamespaceMemberRef[];
}

export interface NamespaceMemberRef extends SourcePosition {
  /** Member name as accessed. Position is the member identifier (or the string literal for `X['m']`). */
  member: string;
  /** npm name of the org package holding the declaration. */
  targetPackage: string;
  /** Declaration file relative to that package's dir, POSIX. */
  targetFile: string;
  /** 0-based position of the declaration's name identifier (declaration start if it has none). */
  targetLine: number;
  targetCol: number;
}

export interface UnresolvedImport extends SourcePosition {
  /** Module specifier as written. */
  module: string;
  /** Imported (not local) name; position is that identifier. */
  name: string;
}

export interface ConsumerFlag extends SourcePosition {
  flag: 'namespace_dynamic' | 'dynamic_access';
  /** One line naming the construct. */
  reason: string;
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
