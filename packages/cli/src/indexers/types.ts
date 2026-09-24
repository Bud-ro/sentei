// Indexer boundary contract (PLAN.md §6.6), adapted for M1: an indexer sees the
// whole repo (it may hold several packages) and the org package lookup, because
// cross-repo linking needs the other checkouts' paths.

/** Shape of `work/discover.json`, restricted to the fields the index stage reads. */
export interface DiscoverFile {
  org: string;
  /** Org policy (discover copies it from sentei.json); absent keys read as false. */
  policy?: Partial<ConsumerPolicy>;
  repos: DiscoveredRepo[];
}

/** The policy keys the index stage reads (PLAN.md §6.5). */
export interface ConsumerPolicy {
  /** When false, test files (core TEST_GLOBS: *.test.*, test/, __tests__/, mocks/, fixtures/, e2e/, ...) are not consumers. */
  countTestsAsConsumers: boolean;
  /** When false, docs files (core DOCS_GLOBS: docs/, examples/, demo/) are not consumers. */
  countDocsAsConsumers: boolean;
}

export interface DiscoveredRepo {
  /** `<org>/<name>`, e.g. `acme/lib-core`. */
  repo: string;
  /** Absolute path of the checkout. */
  localPath: string;
  defaultBranch?: string | null;
  headSha: string | null;
  packages: DiscoveredPackage[];
  /**
   * Manifests discover ignored (examples, templates, fixtures, ...): witness-only.
   * Their dirs are skipped by the out-of-program scan of an org package that
   * contains them. Absent in older discover.json files.
   */
  ignoredManifests?: DiscoveredIgnoredManifest[];
}

/** The fields of a `repos[].ignoredManifests[]` entry the index stage reads. */
export interface DiscoveredIgnoredManifest {
  /** Manifest dir relative to the repo root, POSIX (`.` for the root). */
  path: string;
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
  /**
   * The work dir. Install subprocesses keep every global/state/cache write
   * (XDG dirs, pnpm store, yarn global folder, corepack) under `<workDir>/.pm/`.
   * The index stage always sets it; absent (direct adapter calls in tests), a
   * `sentei-pm` dir under the OS temp dir is used.
   */
  workDir?: string;
}

export interface IndexerInput {
  repo: DiscoveredRepo;
  pkg: DiscoveredPackage;
  /** Look up any org package by package id (across all repos). */
  lookup: (packageId: string) => OrgPackage | undefined;
  /** Every org package (all repos), e.g. to tell org imports from third-party ones. */
  orgPackages: readonly OrgPackage[];
  options: IndexerOptions;
  /** Org policy from discover.json (absent: tests and docs do not count as consumers). */
  policy?: Partial<ConsumerPolicy>;
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
  /**
   * Every shorthand property `{ grade }` whose value symbol (the checker's
   * `getShorthandAssignmentValueSymbol`, aliases followed) is declared in an
   * org package: this package's own files or an imported org binding. Position
   * is the shorthand identifier; target is the declaration's name.
   * Workaround for an upstream gap (PLAN.md §6.6): scip-typescript 0.4.0 emits
   * only the contextual property symbol (`PracticalTask#grade().`) for a
   * shorthand in a contextually typed object literal, no reference to the
   * value `grade`, so the value looks unused. Function-local declarations are
   * skipped (SCIP gives them `local N` symbols; they are never verdict
   * subjects). Recorded whether or not SCIP linked it; ingest dedupes.
   * Always `[]` for Dart.
   */
  shorthandRefs: ShorthandRef[];
  /**
   * Every value use of a namespace import (`import * as X from '<module>'`)
   * other than `X.member` / `X['lit']` (a spread `{...X}`, an argument
   * `f(X)` / `Object.keys(X)`, an assignment `const y = X`, `export { X }`),
   * when the module resolves to a file inside an org package checkout: this
   * package's own files (relative imports) or another org package. The
   * members read are not statically known; ingest adds a reference to every
   * top-level symbol of `targetFile` (over-approximation, fail closed).
   * Position is the namespace identifier. Imports of another org package by
   * name also keep producing the `namespace_dynamic` flag. Always `[]` for Dart.
   */
  namespaceSpreadRefs: NamespaceSpreadRef[];
  /**
   * Imports found by a text scan of files in the package that no indexed
   * program covers: code files outside every tsconfig (`eslint.config.mjs`,
   * `scripts/*.mjs`, `test/*.mjs`) and single-file components / MDX (`.vue`,
   * `.svelte`, `.astro`, `.marko`, `.mdx`, never indexed by scip-typescript).
   * Each is a consumer SCIP cannot see. Two kinds:
   *  - an org package imported by name (`module` = the specifier): unscoped,
   *    ingest turns it into a targeted `unindexed_consumer` flag blocking
   *    `targetPackage` only; scoped (`scope` set), a `witness_files` row;
   *  - SFC files only, `relative: true`: a relative import of one of this
   *    package's own code files (`module` = that file, repo-relative POSIX;
   *    `targetPackage` = this package), whose declarations it uses.
   * Test/docs/script files are recorded with their `scope` whatever the
   * consumer policy says (core routes scoped entries to the witness).
   * Always `[]` for Dart.
   */
  unindexedImports: UnindexedImport[];
  /**
   * Own files (repo-relative POSIX, sorted) that are generated: the path matches
   * core GENERATED_GLOBS or lies under a tool-output dir (`.nuxt/`, `.svelte-kit/`,
   * ...), or a comment in the first 20 lines says `@generated`, "automatically
   * generated", "auto-generated" or "do not edit". Covers every own code / SFC
   * file (walked like `unindexedImports`) and every own file of the indexed
   * programs. Core excludes their declarations from verdicts / private_dead and
   * from self-witness scans. Absent for Dart (core's GENERATED_GLOBS cover it).
   */
  generatedFiles?: string[];
  /**
   * Declarations the runtime or a tool invokes by convention, with no reference
   * in code. Dart (dart-surface): top-level `main` of a `lib/*.dart` entry and
   * of every non-test library outside `lib/` (bin/, tool/, benchmark/, web/,
   * example/, root scripts: run directly); build.yaml `builder_factories` /
   * `builder_factory` of the `import:` library; dart_dev's
   * `tool/dart_dev/config.dart` top-level `config`. The file need not be a
   * discover entry point, and the symbol may be exported (a builder factory in
   * a `lib/*.dart` library). Position is the declaration's name. TypeScript
   * (export-surface): ambient contributions consumed by the augmented module or
   * the global scope, never by reference: every declaration inside `declare
   * module 'x' {}` / `declare global {}` at any nesting (and the module
   * declaration's own name), and non-exported top-level declarations of `.d.ts`
   * files that are not on the export surface (`declare const process`,
   * `declare namespace JSX`). Members of ordinary namespaces are not included.
   */
  entrySymbols: Array<SourcePosition & { name: string }>;
}

export interface UnindexedImport {
  /** Repo-relative POSIX path of the unindexed file. */
  file: string;
  /**
   * Module specifier as written; with `relative`, the imported own file instead
   * (the relative specifier resolved, repo-relative POSIX).
   */
  module: string;
  /** npm name of the org package it imports (this package's own name with `relative`). */
  targetPackage: string;
  /**
   * Set when `file` is test (core TEST_GLOBS), else docs (DOCS_GLOBS), else
   * script code (the directory shapes of SCRIPT_GLOBS: playground/, bench/,
   * scripts/, ...; tool configs `*.config.*` stay unscoped). Core routes scoped
   * entries to the witness, never to flags.
   */
  scope?: 'script' | 'docs' | 'test';
  /** An SFC's relative import of this package's own code file (see `module`). */
  relative?: true;
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

export interface NamespaceSpreadRef extends SourcePosition {
  /** npm name of the org package holding the namespace's module (this package for a relative import). */
  targetPackage: string;
  /** The module file relative to that package's dir, POSIX. */
  targetFile: string;
}

/** Same shape as `NamespaceMemberRef`; `member` is the shorthand name. */
export type ShorthandRef = NamespaceMemberRef;

export interface UnresolvedImport extends SourcePosition {
  /** Module specifier as written. */
  module: string;
  /**
   * Imported (not local) name; position is that identifier. `*` for a deep
   * `/dist/` import of an org package that does not resolve (position: the
   * module specifier): a private-path import whose members cannot be mapped.
   */
  name: string;
}

export interface ConsumerFlag extends SourcePosition {
  flag: 'namespace_dynamic' | 'dynamic_access';
  /** One line naming the construct. */
  reason: string;
  /**
   * npm name of the org package whose members are hidden, when known: set for
   * `namespace_dynamic` (the namespace import's specifier names it). Absent for
   * `dynamic_access` (a computed specifier, even `'@acme/' + x`, may reach any
   * org package): an untargeted flag blocks every org package.
   */
  targetPackage?: string;
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
