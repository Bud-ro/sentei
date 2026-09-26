// `ingest` stage core (PLAN.md §6.3): SCIP indexes + export sidecars -> symbols,
// documents, occurrences, edges, unresolved_refs, package_flags.
//
// Inputs (all under workDir):
//   index/<repo slug>/index.json      written by the index stage (slug = repo with '/' -> '__')
//   index/<repo slug>/<pkg>.scip      one SCIP index per package, run in the package dir
//   index/<repo slug>/<pkg>.exports.json   export surface sidecar (SCIP has no export info)
// plus the discover model (work/discover.json) for package paths, entry points, overlays.
//
// This module and scip/ are the only places that know about SCIP; everything
// downstream reads the tables. The whole org is rebuilt in ONE transaction.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { parsePackageRef, packageRefMatches } from './config.ts';
import { DISCOVER_REASON_PREFIX } from './discover.ts';
import { matchGlob } from './glob.ts';
import { GENERATED_GLOBS, inVendoredDir } from './globs.ts';
import {
  normalizeSymbolVersion,
  occurrenceEnclosingSpan,
  occurrenceStart,
  parseDescriptors,
  parseScipSymbol,
  readScipIndex,
  SymbolInformation_Kind,
  SymbolRole,
  type Descriptor,
  type Document,
  type Occurrence,
  type Span,
} from './scip/read.ts';

// ---------------------------------------------------------------------------
// Input shapes (structural: the discover/index stages own the writers)
// ---------------------------------------------------------------------------

/** The parts of work/discover.json that ingest reads. */
export interface IngestDiscoverInput {
  repos: Array<{
    repo: string;
    config?: { extraEdges?: Array<{ from: string; to: string }> };
    packages: Array<{
      packageId: string;
      /** Package dir, repo-relative POSIX; '.' for the root. */
      path: string;
      /** Repo-relative POSIX. */
      entryPoints: string[];
      /**
       * Loaded by the runtime / a bundler (DiscoverPackage): seeds (documents.is_entry);
       * the exported declarations of those also in entryPoints become entry_symbols.
       * `bin` targets are here only. Optional.
       */
      runtimeEntryPoints?: string[];
      /**
       * Names the runtime instantiates (wrangler Durable Object classes): every exported
       * top-level symbol so named in one of the package's entry / runtime entry files
       * becomes an entry_symbol (kind runtime). Optional.
       */
      runtimeEntrySymbols?: string[];
    }>;
  }>;
}

/** work/index/<slug>/index.json */
export interface RepoIndexFile {
  repo: string;
  headSha: string | null;
  status: 'ok' | 'partial' | 'failed';
  packages: Array<{
    packageId: string;
    indexer: string;
    indexerVersion: string;
    status: 'ok' | 'partial' | 'failed';
    /** File name relative to the index.json dir (or absolute). */
    scip: string | null;
    exports: string | null;
    diagnostics: string[];
  }>;
}

/** <slug>.exports.json sidecar. Positions are 0-based; files repo-relative POSIX. */
export interface ExportsSidecar {
  packageId: string;
  entryPoints: string[];
  exports: Array<{
    entry: string;
    exportedAs: string;
    name: string;
    file: string;
    line: number;
    col: number;
    sites: Array<{ file: string; line: number; col: number }>;
    /** 'default-keyword': the position is the `default` keyword of an anonymous default export. */
    note?: string;
  }>;
  /** Module specifiers / entries whose exports could not be resolved -> dynamic_access. */
  unresolved: Array<string | { file?: string; reason?: string; [k: string]: unknown }>;
  /** Uncertainty found while reading the package's own code (optional). */
  /**
   * `targetPackage` (npm name), when present, names the org package whose members the
   * construct hides: the flag is then targeted at that package only (blocks it, does
   * not make this package opaque). Absent: untargeted. `opaque_consumer` comes targeted
   * (a deep build-output import of that package with no source to link).
   */
  flags?: Array<{
    flag: 'namespace_dynamic' | 'dynamic_access' | 'opaque_consumer'; reason: string; file: string | null; line?: number; col?: number;
    targetPackage?: string;
  }>;
  /** Imports of names an org package does not export (version skew; optional). */
  unresolvedImports?: Array<{ module: string; name: string; file: string; line: number | null; col: number | null }>;
  /**
   * `W.member` on an org namespace import, resolved by the type checker, where
   * scip-typescript 0.4.0 emits `local N` (member is an alias re-export). file/line/col
   * are the consumer position (repo-relative); targetFile is relative to the target
   * package dir; targetLine/targetCol are the declaration name identifier. Optional.
   */
  namespaceMemberRefs?: Array<{
    file: string; line: number; col: number; member: string;
    targetPackage: string; targetFile: string; targetLine: number; targetCol: number;
  }>;
  /**
   * Shorthand properties `{ grade }` whose value is declared in an org package (this
   * package or an imported org binding), resolved by the type checker: scip-typescript
   * 0.4.0 emits only the contextual property symbol for a shorthand in a contextually
   * typed object literal, no reference to the value. Same shape and handling as
   * namespaceMemberRefs (the target may be this package). Optional.
   */
  shorthandRefs?: Array<{
    file: string; line: number; col: number; member: string;
    targetPackage: string; targetFile: string; targetLine: number; targetCol: number;
  }>;
  /**
   * JS/TS files of the package outside every tsconfig program (so not indexed) that
   * import an org package, e.g. `eslint.config.mjs` importing `@acme/eslint-config`.
   * `file` is repo-relative; `targetPackage` the bare npm name imported. Each becomes a
   * targeted `unindexed_consumer` flag: it blocks verdicts of that package only. With a
   * `scope` (the file is script / docs / test code: SCRIPT_GLOBS / DOCS_GLOBS /
   * TEST_GLOBS) it becomes a `witness_files` row instead: no flag (unhead's `bench/`
   * blocked 377 findings), the witness scans the file as a consumer of the target.
   * With `relative: true` (own code imported by an unindexed own file) see
   * IngestCounts.relativeUnindexedImports. A `targetPackage` / module naming the package
   * itself (an own file importing it by name: outside the program, or inside it with
   * the self-import unresolved) becomes a self `witness_files` row (consumer = target),
   * whatever its scope. Optional.
   */
  /**
   * Exports of modules of other org packages that this package imports by a deep path
   * (`@acme/x/dist/module/lib/types`, source-linked): `entry` (the module) and `file`
   * (the declaration) relative to the target package dir, `name` the declared name.
   * Each matching top-level declaration goes on the target's export surface. Optional.
   */
  deepImportExports?: Array<{ targetPackage: string; entry: string; exportedAs: string; name: string; file: string }>;
  unindexedImports?: Array<{
    file: string; module: string; targetPackage: string; scope?: 'script' | 'docs' | 'test';
    /**
     * true: `module` is a repo-relative file of the package's OWN code (a `.vue` /
     * `.svelte` single-file component importing `./components`), `targetPackage` the
     * package itself. Never a package name: see IngestCounts.relativeUnindexedImports.
     */
    relative?: boolean;
  }>;
  /**
   * `{ ...ns }` spreads of an org namespace import (`import * as _pkg from './utils/pkg';
   * export const utils = Object.freeze({ ..._pkg })`): the object carries every export
   * of the module, which SCIP records only as a use of the local `_pkg`. file/line/col
   * are the consumer position (repo-relative); targetFile is relative to the target
   * package dir. Optional.
   */
  namespaceSpreadRefs?: Array<{ file: string; line: number; col: number; targetPackage: string; targetFile: string }>;
  /**
   * Repo-relative files of the package that are generated (`@generated` / "automatically
   * generated" / "do not edit" headers, or GENERATED_GLOBS): documents.is_generated.
   * Optional.
   */
  generatedFiles?: string[];
  /**
   * Declarations the runtime or a tool invokes without any code reference (Dart `main()`
   * of a script, a build.yaml builder factory, dart_dev's `config`), at their name
   * identifier (0-based, repo-relative file). Each becomes an `entry_symbols` row (a
   * reachability seed that never gets a verdict or a private_dead row, whether or not
   * its file is an entry or it is exported) and keeps an edge from its document's
   * module symbol. Optional.
   *
   * `kind` (default 'runtime'): 'ambient' for a global declaration the checker sees
   * without an import (`declare namespace` / `declare global` in a `.d.ts` such as
   * wrangler's `worker-configuration.d.ts`). Ambient entry symbols are seeds too, but
   * never make their package eligible for private_dead (entry_symbols.kind).
   */
  entrySymbols?: Array<{ file: string; line: number; col: number; name: string; kind?: 'runtime' | 'ambient' }>;
  /**
   * Dart conditional imports / exports (`import 'a.dart' if (dart.library.js_interop) 'b.dart'`):
   * `file` is the importing document and file/line/col the directive (0-based,
   * repo-relative); `target` the default URI the analyzer resolved (repo-relative path,
   * or a `package:` / `dart:` URI outside the repo), `alternatives` the `if (…)` URIs
   * resolved the same way. The index sees only `target`, so nothing references the
   * alternatives' declarations; see IngestCounts.conditionalImports. Optional.
   */
  conditionalImports?: Array<{
    file: string; line: number; col: number; target: string; alternatives: string[];
    /**
     * `export` for a conditional export (`export 'stub.dart' if (dart.library.io) 'io.dart';`):
     * the alternatives' twins also take the default's export surface (see
     * IngestCounts.conditionalExportSymbols). Absent (older sidecars) or `import`: uses only.
     */
    directive?: 'import' | 'export';
  }>;
}

export interface IngestOptions {
  db: DatabaseSync;
  workDir: string;
  discover: IngestDiscoverInput;
  log: (line: string) => void;
}

export interface IngestCounts {
  documents: number;
  symbols: number;
  occurrences: number;
  edges: number;
  exported: number;
  unresolved: number;
  flags: number;
  /** Sidecar exports that matched no definition (warned). */
  unmatchedExports: number;
  /** Occurrences (+ edges) added from sidecar namespaceMemberRefs that SCIP missed. */
  namespaceMemberRefs: number;
  /** namespaceMemberRefs whose target matched no definition (warned). */
  unmatchedNamespaceMemberRefs: number;
  /** Occurrences (+ edges) added from sidecar shorthandRefs that SCIP missed. */
  shorthandRefs: number;
  /** shorthandRefs whose target matched no definition (warned). */
  unmatchedShorthandRefs: number;
  /** symbol_exports rows (distinct (symbol, entry, exported name)). */
  exportAliases: number;
  /**
   * Sidecar unresolvedImports whose name the target exports at HEAD: recorded as uses
   * (occurrences + edges), not as unresolved_refs.
   */
  resolvedUnresolvedImports: number;
  /** Symbols put on a package's export surface only by another package's deep import (sidecar deepImportExports). */
  deepImportExports: number;
  /** Sidecar entrySymbols that matched no definition (warned). */
  unmatchedEntrySymbols: number;
  /**
   * Sidecar conditionalImports alternatives applied: an in-repo alternative document B of
   * a conditional directive in A with default target T. A conditional import requires B
   * to offer T's API, and the index resolved every use against T, so each symbol X of T
   * lends its references to B's twin X' (the symbol with the same descriptors after the
   * module path; for a top-level X without one, B's top-level symbol of the same name):
   * a copy of every reference occurrence of X and of every edge into X. B's declarations
   * are then used wherever T's are; what B's own code alone uses follows through B's
   * edges, and B's members through their owners. When T is not an indexed document of
   * the repo (a `package:` / `dart:` URI, or no module symbol to match descriptors on),
   * every top-level symbol of B gets an edge from A's module symbol and from each
   * top-level symbol of A (reachable whenever A is) and, when exported, an occurrence at
   * the directive (fail closed). An alternative in another package than A is seeded
   * (entry_symbols): reachability never crosses packages.
   */
  conditionalImports: number;
  /** conditionalImports alternatives symbols mirrored from a same-named symbol of the target. */
  conditionalMirroredSymbols: number;
  /**
   * Conditional exports (`directive: 'export'`): twins X' of the default's symbols X that
   * took X's export surface (X's symbol_exports rows copied to X', `is_exported = 1`),
   * plus public top-level symbols of an alternative seeded as runtime entry_symbols when
   * the default is not an indexed document (nothing to match twins on; fail closed).
   * Without it the twins were used (mirrored references) but not exported, so nothing
   * seeded them and they and their private helpers were `private_dead
   * already_unreachable` (supabase_common's `*_io.dart`: 6 rows).
   */
  conditionalExportSymbols: number;
  /** conditionalImports entries or alternatives that are not indexed documents of the repo (warned). */
  unmatchedConditionalImports: number;
  /**
   * Definitions not interned because another package already defined the same key (the
   * first package ingested keeps it). Warned when the symbol is an org package's own;
   * a third-party symbol two packages declare (module augmentation) is only logged.
   */
  sharedDefinitions: number;
  /** Sidecar namespaceSpreadRefs applied (edges to every symbol of the target module). */
  namespaceSpreadRefs: number;
  /** namespaceSpreadRefs whose consumer or target module is not an indexed document (warned). */
  unmatchedNamespaceSpreadRefs: number;
  /**
   * SCIP references into another org package whose symbol has only namespace
   * descriptors (a module symbol such as `…/\`utils.d.ts\`/`): not a reference to a
   * declaration, so not version skew; dropped instead of an unresolved_refs row.
   */
  droppedModuleRefs: number;
  /** witness_files rows (scoped sidecar unindexedImports). */
  witnessFiles: number;
  /** Documents marked is_generated (sidecar generatedFiles or GENERATED_GLOBS). */
  generatedDocuments: number;
  /**
   * Exported top-level declarations of runtime entry files (discover
   * runtimeEntryPoints: `imports` map arms, Vite / HTML client entries) made
   * entry_symbols: loaded by the runtime or a bundler, never a verdict.
   */
  runtimeEntrySymbols: number;
  /**
   * Sidecar unindexedImports with `relative: true`: an unindexed own file (a `.vue` /
   * `.svelte` component) importing the package's own module `module`. Each becomes a
   * self `witness_files` row (consumer = target = the package: the witness name-searches
   * the component, so a package export it names is downgraded), and the imported
   * module's top-level declarations that are not package exports become entry_symbols
   * (we cannot see which names the component uses: keep them all alive, fail closed).
   * An imported module that is not an indexed document is warned about.
   */
  relativeUnindexedImports: number;
  /**
   * Packages whose .scip could not be used (undecodable, or containing unparseable SCIP
   * symbols): flagged index_failed and skipped, the rest of the org ingested (warned).
   */
  packageErrors: number;
  /**
   * Occurrences dropped because their symbol does not parse but names a package outside
   * the org (e.g. scip-dart's `dart:core … Map#[]=().`): ingest would drop them anyway.
   */
  skippedInvalidOccurrences: number;
  /**
   * Occurrences / sidecar refs dropped because their package NAME belongs to several org
   * packages and the consumer's manifest deps do not say which one it means (see
   * resolveName in ingestOrg). The consumer is flagged `ambiguous_dep` at every
   * candidate (discover already did when it declares the dep; ingest adds the rows,
   * reason `ingest: …`, when it does not), so the dropped uses cannot make them look dead.
   */
  ambiguousSymbolRefs: number;
  warnings: number;
}

/**
 * package_flags that ingest owns (and so deletes on every run). `unindexed_consumer`
 * is shared with discover: discover writes untargeted rows (files in languages we have
 * no indexer for), ingest writes targeted rows (sidecar unindexedImports). Ingest
 * deletes only the targeted ones, so discover's rows survive every ingest.
 * `opaque_consumer` is shared too: discover writes rows whose reason starts with
 * DISCOVER_REASON_PREFIX (`discover: unresolved entry point …`); ingest deletes only
 * the others. `ambiguous_dep` likewise: ingest deletes only rows whose reason starts
 * with INGEST_AMBIGUOUS_PREFIX.
 */
const INGEST_FLAGS = ['opaque_consumer', 'index_failed', 'dynamic_access', 'namespace_dynamic'] as const;
type IngestFlag = (typeof INGEST_FLAGS)[number] | 'unindexed_consumer' | 'ambiguous_dep';
/** Reason prefix of the `ambiguous_dep` rows ingest writes (and deletes); discover's lack it. */
const INGEST_AMBIGUOUS_PREFIX = 'ingest: ';
const SIDECAR_FLAGS: ReadonlySet<string> = new Set(['namespace_dynamic', 'dynamic_access', 'opaque_consumer']);

/**
 * Bare package name of a module specifier: npm `@scope/x/deep` -> `@scope/x`, `x/deep`
 * -> `x`; Dart `package:flame/components.dart` -> `flame` (the `package:` scheme is
 * stripped; before, the name kept it, so every Dart unresolved import was dropped as
 * "does not name another org package" and a name removed from a `show` clause never
 * became a version-skew row).
 */
export function barePackageName(module: string): string {
  const spec = module.startsWith('package:') ? module.slice('package:'.length) : module;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

export function repoSlug(repo: string): string {
  return repo.replaceAll('/', '__');
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

interface PkgInfo {
  packageId: string;
  /** `npm` / `pub`: the packageId prefix. */
  manager: string;
  repo: string;
  path: string; // '' for the repo root, else 'a/b'
  entryPoints: Set<string>;
  runtimeEntryPoints: Set<string>;
  runtimeEntrySymbols: Set<string>;
}

interface DocWork {
  repo: string;
  packageId: string;
  /** The owning package's dir ('' for the repo root). */
  ownerPath: string;
  /** Repo-relative POSIX. */
  file: string;
  doc: Document;
  moduleSymbolId: number;
  /** Definitions in this doc with an enclosing range, for enclosing-symbol lookup. */
  spans: Array<{ symbolId: number; span: Span }>;
}

/** SymbolInformation.kind per symbol string, built once per document. */
const kindCache = new WeakMap<Document, Map<string, number>>();
function symbolKinds(w: DocWork): Map<string, number> {
  let m = kindCache.get(w.doc);
  if (!m) {
    m = new Map(w.doc.symbols.map((s) => [s.symbol, s.kind]));
    kindCache.set(w.doc, m);
  }
  return m;
}

interface SymRow {
  symbolId: number;
  packageId: string;
}

const DEFINITION = SymbolRole.Definition;

/** Reverse map of SymbolInformation.Kind numbers to lowercased names. */
const KIND_NAMES = new Map<number, string>(
  Object.entries(SymbolInformation_Kind)
    .filter(([k, v]) => typeof v === 'number' && k !== 'UnspecifiedKind')
    .map(([k, v]) => [v as number, k.toLowerCase()]),
);

function managerOf(packageId: string): string {
  return packageId.slice(0, packageId.indexOf(':'));
}

/**
 * `<manager>:<name>` from the package components of a raw SCIP symbol string (scheme,
 * manager, name; two spaces escape one), read tolerantly so that it works on a symbol
 * whose descriptors do not parse. undefined when those components are not all there.
 */
function rawSymbolPackage(str: string): string | undefined {
  const comps: string[] = [];
  let cur = '';
  for (let i = 0; i < str.length && comps.length < 3; i += 1) {
    if (str[i] !== ' ') {
      cur += str[i];
    } else if (str[i + 1] === ' ') {
      cur += ' ';
      i += 1;
    } else {
      comps.push(cur);
      cur = '';
    }
  }
  if (comps.length < 3 || comps[0] === '') return undefined;
  const dot = (c: string): string => (c === '.' ? '' : c);
  return `${dot(comps[1]!)}:${dot(comps[2]!)}`;
}

/**
 * The reason a partial / failed index result gives its `opaque_consumer` /
 * `index_failed` flag, first line only, or null when there are no diagnostics:
 *   1. the diagnostic the adapter names as the cause of its status: the LAST
 *      `cause: <diagnostic>` line (the TypeScript adapter adds one each time its
 *      status got worse, so the last one explains the final status);
 *   2. else (the Dart adapter, older index.json files) the first `error:` diagnostic
 *      (diagnostics are prefixed info:/warn:/error:), else the first `warn:`, else the
 *      first diagnostic. (An `info: install skipped` line is never the reason if
 *      anything worse was reported.)
 * Without the cause line, a partial TypeScript package was flagged with whatever
 * warning came first (supabase: "1 TypeScript error diagnostic(s) (status
 * unaffected)", a test file's witness-only import).
 */
export function statusReason(diagnostics: readonly string[]): string | null {
  const cause = diagnostics.findLast((d) => d.startsWith('cause: '));
  const diag = (cause !== undefined ? cause.slice('cause: '.length) : undefined)
    ?? diagnostics.find((d) => d.startsWith('error:'))
    ?? diagnostics.find((d) => d.startsWith('warn:'))
    ?? diagnostics[0];
  return (diag ?? '').split('\n')[0] || null;
}

/**
 * Interning key of a version-normalized SCIP symbol (`norm`: version already '.') of
 * org package `packageId`. SCIP names a package only by `<manager> <name>`, and several
 * org packages may share a name (package ids are `<manager>:<repo>:<name>`): then the
 * version component is replaced by the package id (it contains no space), so the two
 * packages' `src/\`index.ts\`/foo().` stay distinct symbols. Unshared names (and
 * non-org symbols: packageId undefined) keep `norm` as is.
 */
export function symbolKey(norm: string, packageId: string | undefined, shared: boolean): string {
  if (packageId === undefined || !shared) return norm;
  // norm = scheme ' ' manager ' ' name ' ' '.' ' ' descriptors, spaces in a component doubled.
  let comps = 0;
  for (let i = 0; i < norm.length; i += 1) {
    if (norm[i] !== ' ') continue;
    if (norm[i + 1] === ' ') {
      i += 1;
      continue;
    }
    comps += 1;
    if (comps === 3) return `${norm.slice(0, i + 1)}${packageId.replaceAll(' ', '  ')}${norm.slice(i + 2)}`;
  }
  return norm;
}

/**
 * Interning key of a version-normalized SCIP symbol whose package NAME is the `.`
 * placeholder (anonymous), attributed to org package `packageId` named `name`: the name
 * component becomes `name` and the version component `packageId` (both escaped).
 * scip-typescript names the symbols of every package.json without `"name"` `npm . .`,
 * so without this `lib/\`utils.ts\`/cn().` of two nameless apps (sentei's
 * `_unnamed/<dir>` packages, in one repo or in two) was ONE symbol: the first package
 * ingested owned it and the other's references resolved into it (supabase: 150 of
 * multiplayer.dev's references landed in hack-the-base `dec-24` files, 93 edges ran
 * between unnamed packages). A nameless package cannot be imported by name, so its
 * anonymous symbols are only ever its own. undefined when `norm` does not have the
 * anonymous name (or does not parse).
 */
export function anonymousSymbolKey(norm: string, packageId: string, name: string): string | undefined {
  // Components: scheme, manager, name, version; spaces inside a component are doubled.
  const starts: number[] = [0];
  for (let i = 0; i < norm.length && starts.length < 5; i += 1) {
    if (norm[i] !== ' ') continue;
    if (norm[i + 1] === ' ') {
      i += 1;
      continue;
    }
    starts.push(i + 1);
  }
  if (starts.length < 5) return undefined;
  const nameComp = norm.slice(starts[2]!, starts[3]! - 1);
  if (nameComp !== '.') return undefined;
  const esc = (c: string): string => (c === '' ? '.' : c.replaceAll(' ', '  '));
  return `${norm.slice(0, starts[2]!)}${esc(name)} ${esc(packageId)} ${norm.slice(starts[4]!)}`;
}

/**
 * Validate the occurrence symbols of one index (locals and '' skipped; `valid` caches
 * strings known to parse). An unparseable symbol whose package is not an org package
 * (`isOrg`) goes to `skipped` (its occurrences are dropped, counted in `skippedOccurrences`):
 * ingest never interns a non-org symbol anyway. Any other unparseable symbol (an org
 * package's, or one without a recognisable package) is returned in `bad`, first-seen
 * order, deduplicated: it fails the package.
 */
function checkSymbols(
  documents: readonly Document[], valid: Set<string>, skipped: Set<string>, isOrg: (packageId: string) => boolean,
): { bad: string[]; skippedOccurrences: number } {
  const bad = new Set<string>();
  let skippedOccurrences = 0;
  for (const doc of documents) {
    for (const o of doc.occurrences) {
      const s = o.symbol;
      if (s === '' || s.startsWith('local ') || valid.has(s) || bad.has(s)) continue;
      if (skipped.has(s)) {
        skippedOccurrences += 1;
        continue;
      }
      try {
        const g = parseScipSymbol(s);
        if (!g.local) parseDescriptors(g.descriptors);
        valid.add(s);
      } catch {
        const pkg = rawSymbolPackage(s);
        if (pkg !== undefined && !isOrg(pkg)) {
          skipped.add(s);
          skippedOccurrences += 1;
        } else {
          bad.add(s);
        }
      }
    }
  }
  return { bad: [...bad], skippedOccurrences };
}

/**
 * scip-dart (the fork, until fixed) defines every `import '…' as p` prefix as a symbol
 * (`lib/\`a.dart\`/p.`, SymbolInformation kind Namespace): syntax, not a declaration,
 * never exported and never dead code. Recognised as a scip-dart definition that is not
 * the document's module symbol and is either of SCIP kind Namespace or has a namespace
 * descriptor last (Dart has no namespace declarations). Other indexers are untouched
 * (a TypeScript `namespace X {}` is a real declaration).
 */
function isImportPrefix(p: ParsedGlobal, scipKind: number, isModule: boolean): boolean {
  if (p.scheme !== 'scip-dart' || isModule) return false;
  return scipKind === SymbolInformation_Kind.Namespace || p.descriptors.at(-1)?.suffix === 'namespace';
}

/**
 * The declared name when `descriptors` (the part of a symbol after its module path)
 * name a top-level declaration (one non-namespace descriptor: `createStorage().`,
 * `Storage#`, `kMode.`), else undefined.
 */
function topLevelName(descriptors: string): string | undefined {
  try {
    const ds = parseDescriptors(descriptors);
    return ds.length === 1 && ds[0]!.suffix !== 'namespace' ? ds[0]!.name : undefined;
  } catch {
    return undefined;
  }
}

function normPkgPath(p: string): string {
  const n = posix.normalize(p.replaceAll('\\', '/'));
  return n === '.' || n === './' ? '' : n.replace(/\/$/, '');
}

function contains(span: Span, line: number, col: number): boolean {
  if (line < span.startLine || line > span.endLine) return false;
  if (line === span.startLine && col < span.startCol) return false;
  if (line === span.endLine && col >= span.endCol) return false;
  return true;
}

/** a starts at or after b (so, among spans containing a point, a is nested deeper). */
function startsAfter(a: Span, b: Span): boolean {
  return a.startLine > b.startLine || (a.startLine === b.startLine && a.startCol > b.startCol);
}

type ParsedGlobal = { scheme: string; manager: string; name: string; descriptors: Descriptor[] };

/**
 * Whether a module symbol's descriptor path names document `w`. scip-typescript
 * computes the path relative to the nearest package.json, which for a file of a
 * nested workspace package seen through the root index is the path relative to the
 * owning package dir, not the index's `relativePath`. Also accepted: the exact
 * repo-relative path, and any path suffix at a segment boundary (a file under an
 * ignored nested manifest, e.g. examples/x/package.json, is named relative to that
 * manifest). Only definitions in `w` whose descriptors are all namespaces get here,
 * so a suffix match cannot pick up a TS namespace declaration (those follow the file
 * descriptors).
 */
function isModulePath(descPath: string, w: DocWork): boolean {
  if (descPath === '') return false;
  const ownerRel = w.ownerPath === '' ? w.file : w.file.slice(w.ownerPath.length + 1);
  return descPath === ownerRel || descPath === w.file || w.file.endsWith(`/${descPath}`);
}

/**
 * scip-typescript naming convention: members of anonymous object and type literals get
 * a counter-suffixed meta descriptor, `<property name><N>:` for an object-literal
 * property (always directly under the file: `src/\`a.ts\`/npm0:`) and
 * `typeLiteral<N>:` for a type literal (`Props#style.typeLiteral3:__html.`). N is a
 * per-file counter of the program that indexed the file, so it differs between
 * programs, and these symbols are never independent declarations.
 */
function isAnonymousDescriptor(d: Descriptor): boolean {
  return d.suffix === 'meta' && /\d$/.test(d.name);
}

/** The symbol is (a member of) an anonymous literal: some descriptor is counter-suffixed. */
function isAnonymousMember(ds: readonly Descriptor[]): boolean {
  return ds.some(isAnonymousDescriptor);
}

// ---------------------------------------------------------------------------
// ingestOrg
// ---------------------------------------------------------------------------

/**
 * Rebuild every SCIP-derived row for the whole org in one transaction.
 * Repos / packages / package_deps / policy / keep_rules (discover's tables) are
 * left alone and must already contain every discovered package.
 *
 * Symbol identity: `symbol_str` is the SCIP symbol with its package version
 * replaced by `.`, so a consumer indexed against another version of an org
 * package still links to HEAD's definition. A reference into an org package
 * whose (normalized) symbol has no definition there becomes an unresolved_refs row.
 */
export function ingestOrg(opts: IngestOptions): IngestCounts {
  const { db, workDir, discover, log } = opts;
  let warnings = 0;
  const warn = (m: string): void => {
    warnings += 1;
    log(`[ingest] warning: ${m}`);
  };

  // Packages from discover, cross-checked against the DB (discover owns those rows).
  const pkgs = new Map<string, PkgInfo>();
  // Name resolution (package ids are `<manager>:<repo>:<name>`; SCIP symbols and sidecar
  // targets carry only the name): every org package by `<manager>:<name>`, each package's
  // own name, and each consumer's manifest deps resolved by discover, by target name.
  const byName = new Map<string, string[]>();
  const nameKeyOf = new Map<string, string>();
  for (const r of db.prepare('SELECT package_id, manager, name FROM packages ORDER BY package_id').all() as Array<{
    package_id: string; manager: string; name: string;
  }>) {
    const key = `${r.manager}:${r.name}`;
    nameKeyOf.set(r.package_id, key);
    byName.set(key, [...(byName.get(key) ?? []), r.package_id]);
  }
  const depByName = new Map<string, Map<string, string>>();
  for (const r of db.prepare(`SELECT d.consumer_package_id AS c, p.manager || ':' || p.name AS key, d.resolved_package_id AS id
    FROM package_deps d JOIN packages p ON p.package_id = d.resolved_package_id ORDER BY d.consumer_package_id, d.dep_name`).all() as Array<{
    c: string; key: string; id: string;
  }>) {
    let m = depByName.get(r.c);
    if (!m) depByName.set(r.c, (m = new Map()));
    if (!m.has(r.key)) m.set(r.key, r.id);
  }
  /** Several org packages have this `<manager>:<name>`. */
  const sharedName = (key: string): boolean => (byName.get(key)?.length ?? 0) > 1;
  /**
   * The org package that consumer `consumer` means by package name `<manager>:<name>`
   * (`key`): its own name -> itself; the only org package of that name -> it; the
   * package its manifest dep of that name resolved to (discover: same repo, else the
   * only published one) -> it. `ambiguous` (with every candidate) when the name is
   * shared and none of those applies; `undefined` for a non-org name.
   */
  const resolveName = (consumer: string, key: string): string | { ambiguous: string[] } | undefined => {
    const cands = byName.get(key);
    if (cands === undefined) return undefined;
    if (nameKeyOf.get(consumer) === key) return consumer;
    if (cands.length === 1) return cands[0]!;
    return depByName.get(consumer)?.get(key) ?? { ambiguous: cands };
  };
  const dbPkgs = new Map(
    (db.prepare('SELECT package_id, repo FROM packages').all() as Array<{ package_id: string; repo: string }>)
      .map((r) => [r.package_id, r.repo]),
  );
  if (dbPkgs.size === 0) throw new Error('sentei: ingest: the database has no packages; run discover first');
  for (const r of discover.repos) {
    for (const p of r.packages) {
      if (dbPkgs.get(p.packageId) !== r.repo) {
        throw new Error(`sentei: ingest: package ${p.packageId} (repo ${r.repo}) is not in the database; run discover first`);
      }
      pkgs.set(p.packageId, {
        packageId: p.packageId, manager: managerOf(p.packageId), repo: r.repo, path: normPkgPath(p.path), entryPoints: new Set(p.entryPoints),
        runtimeEntryPoints: new Set(p.runtimeEntryPoints ?? []),
        runtimeEntrySymbols: new Set(p.runtimeEntrySymbols ?? []),
      });
    }
  }

  const counts: IngestCounts = {
    documents: 0, symbols: 0, occurrences: 0, edges: 0, exported: 0, unresolved: 0, flags: 0, unmatchedExports: 0,
    namespaceMemberRefs: 0, unmatchedNamespaceMemberRefs: 0, shorthandRefs: 0, unmatchedShorthandRefs: 0, exportAliases: 0,
    resolvedUnresolvedImports: 0, deepImportExports: 0,
    unmatchedEntrySymbols: 0, namespaceSpreadRefs: 0, unmatchedNamespaceSpreadRefs: 0, droppedModuleRefs: 0, witnessFiles: 0,
    generatedDocuments: 0, runtimeEntrySymbols: 0, relativeUnindexedImports: 0, packageErrors: 0, skippedInvalidOccurrences: 0,
    ambiguousSymbolRefs: 0, conditionalImports: 0, conditionalMirroredSymbols: 0, conditionalExportSymbols: 0, unmatchedConditionalImports: 0, sharedDefinitions: 0, warnings: 0,
  };

  db.exec('BEGIN');
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    // Children first is not required (cascades), but explicit deletes keep this obvious.
    db.exec('DELETE FROM findings');
    db.exec('DELETE FROM witness_ok');
    db.exec('DELETE FROM edges');
    db.exec('DELETE FROM occurrences');
    db.exec('DELETE FROM unresolved_refs');
    db.exec('DELETE FROM witness_files');
    db.exec('DELETE FROM documents');
    db.exec('DELETE FROM entry_symbols');
    db.exec('DELETE FROM symbols');
    db.prepare(`DELETE FROM package_flags WHERE (flag IN (${INGEST_FLAGS.map((f) => `'${f}'`).join(', ')})
        AND NOT (flag = 'opaque_consumer' AND substr(coalesce(reason, ''), 1, ?) = ?))
      OR (flag = 'unindexed_consumer' AND target_package_id IS NOT NULL)
      OR (flag = 'ambiguous_dep' AND substr(coalesce(reason, ''), 1, ?) = ?)`)
      .run(DISCOVER_REASON_PREFIX.length, DISCOVER_REASON_PREFIX, INGEST_AMBIGUOUS_PREFIX.length, INGEST_AMBIGUOUS_PREFIX);
    // Findings are gone, so the DB is no longer analyzed (witness/report check this marker;
    // run_params is created by analyze.sql, so it may not exist yet).
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_params'").get()) {
      db.exec("DELETE FROM run_params WHERE key = 'analyzed_at'");
    }

    const st = {
      flag: db.prepare('INSERT INTO package_flags (package_id, flag, reason, file, target_package_id) VALUES (?, ?, ?, ?, ?)'),
      repoStatus: db.prepare('UPDATE repos SET index_status = ?, indexed_at = ? WHERE repo = ?'),
      symbol: db.prepare('INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      parent: db.prepare('UPDATE symbols SET parent_symbol_id = ? WHERE symbol_id = ?'),
      document: db.prepare('INSERT INTO documents (package_id, file, module_symbol_id, is_entry, is_generated) VALUES (?, ?, ?, ?, ?)'),
      witnessFile: db.prepare('INSERT OR IGNORE INTO witness_files (consumer_package_id, target_package_id, file) VALUES (?, ?, ?)'),
      occurrence: db.prepare(`INSERT INTO occurrences
        (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id, is_export_site)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      edge: db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source)
        VALUES (?, ?, ?, ?, ?)`),
      unresolved: db.prepare(`INSERT INTO unresolved_refs (consumer_package_id, target_package_id, symbol_str, file, line, col)
        VALUES (?, ?, ?, ?, ?, ?)`),
      exported: db.prepare('UPDATE symbols SET is_exported = 1 WHERE symbol_id = ?'),
      exportAlias: db.prepare('INSERT OR IGNORE INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, ?, ?)'),
      // 'runtime' wins over 'ambient' when a symbol is seeded both ways.
      entrySymbol: db.prepare(`INSERT INTO entry_symbols (symbol_id, kind) VALUES (?, ?)
        ON CONFLICT (symbol_id) DO UPDATE SET kind = 'runtime' WHERE excluded.kind = 'runtime' AND kind <> 'runtime'`),
    };
    const addFlag = (packageId: string, flag: IngestFlag, reason: string, file: string | null, target: string | null = null): void => {
      st.flag.run(packageId, flag, reason, file, target);
      counts.flags += 1;
    };
    /**
     * A use by `consumer` of shared package name `key` that cannot be attributed
     * (resolveName: ambiguous) is dropped; the consumer is then flagged ambiguous_dep at
     * every candidate once all refs are read ("Ambiguous package names" below), fail closed.
     */
    const ambiguousUses = new Map<string, { consumer: string; key: string; candidates: string[]; file: string | null }>();
    const noteAmbiguous = (consumer: string, key: string, candidates: string[], file: string | null): void => {
      counts.ambiguousSymbolRefs += 1;
      const k = `${consumer}\0${key}`;
      if (!ambiguousUses.has(k)) ambiguousUses.set(k, { consumer, key, candidates, file });
    };

    // ---- Load index.json / sidecars, map documents to packages ------------
    /**
     * Every (owner package, file) seen, with each index that contains it, in load order.
     * A root-package index of a workspace monorepo also contains the nested packages'
     * files; the owner's own index is preferred (see pickDocs below).
     */
    const docCandidates = new Map<string, Array<{ w: DocWork; indexPackageId: string }>>();
    /** `${repo}\0${file}\0${line}\0${col}` of export-clause identifiers (sidecar sites). */
    const exportSites = new Set<string>();
    const sidecars: Array<{ packageId: string; repo: string; data: ExportsSidecar }> = [];
    /** Symbol strings already known to parse (shared across indexes). */
    const validSymbols = new Set<string>();
    /** Unparseable symbols of non-org packages: their occurrences are dropped (checkSymbols). */
    const skippedSymbols = new Set<string>();

    for (const r of discover.repos) {
      const repoPkgs = r.packages.map((p) => pkgs.get(p.packageId)!).sort((a, b) => b.path.length - a.path.length);
      const dir = join(workDir, 'index', repoSlug(r.repo));
      const indexFile = join(dir, 'index.json');
      if (!existsSync(indexFile)) {
        warn(`${r.repo}: no ${indexFile}; every package in the repo is flagged index_failed`);
        for (const p of repoPkgs) addFlag(p.packageId, 'index_failed', 'repo not indexed (no index.json)', null);
        st.repoStatus.run('failed', null, r.repo);
        continue;
      }
      const idx = JSON.parse(readFileSync(indexFile, 'utf8')) as RepoIndexFile;
      if (idx.repo !== r.repo) throw new Error(`sentei: ${indexFile}: repo is ${JSON.stringify(idx.repo)}, expected ${JSON.stringify(r.repo)}`);
      if (!['ok', 'partial', 'failed'].includes(idx.status)) throw new Error(`sentei: ${indexFile}: bad status ${JSON.stringify(idx.status)}`);
      st.repoStatus.run(idx.status, Math.floor(statSync(indexFile).mtimeMs / 1000), r.repo);

      const indexed = new Map(idx.packages.map((p) => [p.packageId, p]));
      for (const p of repoPkgs) {
        if (!indexed.has(p.packageId)) addFlag(p.packageId, 'index_failed', 'package missing from index.json', null);
      }
      const resolveFile = (f: string): string => (isAbsolute(f) ? f : join(dir, f));

      for (const ip of idx.packages) {
        const pkg = pkgs.get(ip.packageId);
        if (!pkg || pkg.repo !== r.repo) throw new Error(`sentei: ${indexFile}: unknown package ${ip.packageId} for repo ${r.repo}`);
        // Reason of the opaque_consumer / index_failed flag: statusReason.
        const firstDiag = statusReason(ip.diagnostics);
        if (ip.status === 'partial') addFlag(pkg.packageId, 'opaque_consumer', firstDiag ?? 'index partial', null);
        if (ip.status === 'failed') {
          addFlag(pkg.packageId, 'index_failed', firstDiag ?? 'index failed', null);
          continue;
        }
        if (!ip.scip || !existsSync(resolveFile(ip.scip))) {
          warn(`${ip.packageId}: status ${ip.status} but no .scip file; flagged index_failed`);
          addFlag(pkg.packageId, 'index_failed', 'no .scip file', null);
          continue;
        }
        // Decode and validate before using anything of this package: an undecodable
        // index, or one with an occurrence whose ORG symbol does not parse (scip-dart emits
        // e.g. `Foo#==().` unescaped), fails THIS package only (index_failed: opaque,
        // blocks what it depends on), never the org. Its sidecar is not read either.
        // Unparseable third-party symbols only lose their occurrences (checkSymbols).
        let index: ReturnType<typeof readScipIndex>;
        try {
          index = readScipIndex(resolveFile(ip.scip));
        } catch (err) {
          const why = `unreadable .scip: ${(err as Error).message.split('\n')[0]}`;
          warn(`${ip.packageId}: ${why}; flagged index_failed`);
          addFlag(pkg.packageId, 'index_failed', why, null);
          counts.packageErrors += 1;
          continue;
        }
        const { bad, skippedOccurrences } = checkSymbols(index.documents, validSymbols, skippedSymbols, (key) => byName.has(key));
        if (bad.length > 0) {
          const why = `invalid SCIP symbol ${JSON.stringify(bad[0])}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`;
          warn(`${ip.packageId}: ${bad.length} invalid SCIP symbol(s), e.g. ${JSON.stringify(bad[0])}; flagged index_failed, package skipped`);
          addFlag(pkg.packageId, 'index_failed', why, null);
          counts.packageErrors += 1;
          continue;
        }
        counts.skippedInvalidOccurrences += skippedOccurrences;
        if (ip.exports && existsSync(resolveFile(ip.exports))) {
          const data = JSON.parse(readFileSync(resolveFile(ip.exports), 'utf8')) as ExportsSidecar;
          if (data.packageId !== ip.packageId) throw new Error(`sentei: ${ip.exports}: packageId ${data.packageId}, expected ${ip.packageId}`);
          sidecars.push({ packageId: ip.packageId, repo: r.repo, data });
          for (const e of data.exports) {
            for (const s of e.sites) exportSites.add(`${r.repo}\0${s.file}\0${s.line}\0${s.col}`);
          }
        } else {
          // No export surface known: nothing in the package is exported, which is
          // fail-open for its symbols' verdicts, so make the package opaque instead.
          warn(`${ip.packageId}: no exports sidecar; flagged opaque_consumer`);
          addFlag(pkg.packageId, 'opaque_consumer', 'no exports sidecar', null);
        }

        // Owner of a document: the innermost enclosing package of the INDEX's manager (a
        // Dart file seen by the pub index of a dir that also has a package.json belongs to
        // the pub package), else the innermost enclosing package of any manager.
        const encloses = (p: PkgInfo, file: string): boolean => p.path === '' || file === p.path || file.startsWith(`${p.path}/`);
        for (const doc of index.documents) {
          const file = posix.normalize(posix.join(pkg.path || '.', doc.relativePath.replaceAll('\\', '/')));
          if (file.startsWith('../') || file === '..' || posix.isAbsolute(file)) continue; // outside the repo
          if (file.split('/').includes('node_modules')) continue;
          const owner = repoPkgs.find((p) => p.manager === pkg.manager && encloses(p, file)) ?? repoPkgs.find((p) => encloses(p, file));
          if (!owner) continue; // not under any org package of this repo
          const key = `${owner.packageId}\0${file}`;
          let list = docCandidates.get(key);
          if (!list) docCandidates.set(key, (list = []));
          list.push({
            w: { repo: r.repo, packageId: owner.packageId, ownerPath: owner.path, file, doc, moduleSymbolId: 0, spans: [] },
            indexPackageId: ip.packageId,
          });
        }
      }
    }

    // One document per (owner, file). Preference: the owning package's own index (its
    // symbols and module symbol are computed relative to that package, like every
    // other index's, but only the owner's index is guaranteed to cover the file with
    // the owner's tsconfig); otherwise the index of the nearest enclosing package (the
    // longest package path, in practice the root index of a workspace); ties keep the
    // first in load order (discover repo order, index.json package order). A warning
    // only when one package's index contains the same file twice.
    const docs: DocWork[] = [];
    const pathOf = (packageId: string): number => pkgs.get(packageId)!.path.length;
    for (const list of docCandidates.values()) {
      const owner = list[0]!.w.packageId;
      const own = list.filter((c) => c.indexPackageId === owner);
      let chosen = own[0];
      if (!chosen) {
        chosen = list[0]!;
        for (const c of list) if (pathOf(c.indexPackageId) > pathOf(chosen.indexPackageId)) chosen = c;
      }
      const same = list.filter((c) => c.indexPackageId === chosen!.indexPackageId);
      if (same.length > 1) {
        // scip-typescript run over several tsconfig projects emits a shared file once per
        // project; identical copies are harmless, differing ones mean lost information.
        const sig = (d: Document): string => d.occurrences.map((o) => `${o.symbol}@${o.range.join(',')}/${o.symbolRoles}`).join('\n');
        const first = sig(chosen.w.doc);
        const differing = same.filter((c) => sig(c.w.doc) !== first).length;
        if (differing > 0) {
          warn(`${chosen.w.file} (${owner}) appears ${same.length} times, with different contents, in the index of `
            + `${chosen.indexPackageId}; first occurrence kept`);
        }
      }
      docs.push(chosen.w);
    }

    // ---- Pass 1: definitions ---------------------------------------------
    const symbols = new Map<string, SymRow>(); // normalized symbol_str -> row
    const parsedCache = new Map<string, ParsedGlobal | null>();
    const parse = (raw: string): ParsedGlobal | null => {
      let p = parsedCache.get(raw);
      if (p !== undefined) return p;
      p = null;
      if (raw !== '' && !raw.startsWith('local ') && !skippedSymbols.has(raw)) {
        const g = parseScipSymbol(raw);
        if (!g.local) p = { scheme: g.scheme, manager: g.manager, name: g.name, descriptors: parseDescriptors(g.descriptors) };
      }
      parsedCache.set(raw, p);
      return p;
    };
    /** Symbols we never intern: locals, parameters, type parameters (never exported, never cross-package). */
    const interesting = (p: ParsedGlobal | null): p is ParsedGlobal => {
      const last = p?.descriptors.at(-1);
      return last !== undefined && last.suffix !== 'parameter' && last.suffix !== 'type_parameter';
    };
    /**
     * The org package symbol `p` belongs to, as seen from document `w` (resolveName), and
     * its interning key (symbolKey). `ambiguous`: a shared name `w`'s package cannot
     * attribute (noteAmbiguous).
     */
    const symbolTarget = (w: DocWork, p: ParsedGlobal, norm: string):
      { pkg: string | undefined; key: string } | { ambiguous: string[]; nameKey: string } => {
      if (p.name === '') {
        // Anonymous package (`npm . .`): the document's own package (anonymousSymbolKey).
        const own = nameKeyOf.get(w.packageId);
        const key = own === undefined ? undefined : anonymousSymbolKey(norm, w.packageId, own.slice(own.indexOf(':') + 1));
        if (key !== undefined) return { pkg: w.packageId, key };
      }
      const nameKey = `${p.manager}:${p.name}`;
      const pkg = resolveName(w.packageId, nameKey);
      if (typeof pkg === 'object') return { ambiguous: pkg.ambiguous, nameKey };
      return { pkg, key: symbolKey(norm, pkg, sharedName(nameKey)) };
    };
    /** `${repo}\0${file}\0${line}\0${col}` of every definition occurrence -> symbol_id. */
    const defPositions = new Map<string, number>();
    /** Definitions of one interning key in several packages, per (owner, other) pair (pass 1). */
    const sharedDefs = new Map<string, { owner: string; other: string; count: number; example: string; claimed: boolean }>();
    const noteSharedDefinition = (owner: string, other: string, norm: string, claimed: boolean): void => {
      const k = `${owner}\0${other}\0${claimed ? 1 : 0}`;
      const e = sharedDefs.get(k);
      if (e) e.count += 1;
      else sharedDefs.set(k, { owner, other, count: 1, example: norm, claimed });
    };

    const defineSymbol = (w: DocWork, norm: string, p: ParsedGlobal, line: number, col: number, kind: string, isModule: boolean): number => {
      const last = p.descriptors.at(-1)!;
      const name = isModule ? w.file : last.name;
      const res = st.symbol.run(norm, w.packageId, w.file, line, col, kind, name);
      const id = Number(res.lastInsertRowid);
      symbols.set(norm, { symbolId: id, packageId: w.packageId });
      counts.symbols += 1;
      return id;
    };

    // Two rounds: first definitions that live in their own package (the normal
    // case), then definitions of symbols whose SCIP package is another org package
    // (e.g. module augmentation) that no package defined itself.
    const deferred: Array<{ w: DocWork; o: Occurrence }> = [];
    for (const round of [0, 1] as const) {
      const work = round === 0
        ? docs.flatMap((w) => w.doc.occurrences.map((o) => ({ w, o })))
        : deferred;
      for (const { w, o } of work) {
        if (!(o.symbolRoles & DEFINITION)) continue;
        const p = parse(o.symbol);
        if (!interesting(p)) continue;
        const start = occurrenceStart(o);
        if (!start) continue;
        const t = symbolTarget(w, p, normalizeSymbolVersion(o.symbol));
        if ('ambiguous' in t) {
          // A definition in w of a symbol named for a shared package name w's package
          // does not own or depend on (module augmentation): not interned.
          if (round === 0) noteAmbiguous(w.packageId, t.nameKey, t.ambiguous, w.file);
          continue;
        }
        const own = t.pkg;
        if (round === 0 && own !== undefined && own !== w.packageId) {
          deferred.push({ w, o });
          continue;
        }
        const norm = t.key;
        let row = symbols.get(norm);
        if (!row) {
          const isModule = p.descriptors.every((d) => d.suffix === 'namespace')
            && isModulePath(p.descriptors.map((d) => d.name).join('/'), w);
          const scipKind = symbolKinds(w).get(o.symbol) ?? 0;
          const kind = isAnonymousMember(p.descriptors)
            ? 'anonymous-member'
            : isImportPrefix(p, scipKind, isModule)
              ? 'import-prefix'
              : KIND_NAMES.get(scipKind) ?? '';
          const id = defineSymbol(w, norm, p, start.line, start.col, kind, isModule);
          row = symbols.get(norm)!;
          if (isModule && w.moduleSymbolId === 0) w.moduleSymbolId = id;
        }
        // Later definitions of the same symbol (overloads, merged declarations) keep
        // the first location but still count for export matching and enclosing lookup.
        if (row.packageId !== w.packageId) {
          // Another package already owns this key: w's definition is not interned and
          // w's references resolve into the other package. Normal for a third-party
          // symbol both declare (module augmentation, `declare global`) and for round 1
          // (another org package's symbol, augmented); a bug when w claims the symbol as
          // its own (the nameless-package collision before anonymousSymbolKey).
          if (round === 0) noteSharedDefinition(row.packageId, w.packageId, norm, own === w.packageId);
          continue;
        }
        defPositions.set(`${w.repo}\0${w.file}\0${start.line}\0${start.col}`, row.symbolId);
        const span = occurrenceEnclosingSpan(o);
        if (span && row.symbolId !== w.moduleSymbolId) w.spans.push({ symbolId: row.symbolId, span });
      }
    }

    if (sharedDefs.size > 0) {
      const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
      const pairs = [...sharedDefs.values()].sort((a, b) => b.count - a.count || cmpStr(a.owner, b.owner) || cmpStr(a.other, b.other));
      counts.sharedDefinitions = pairs.reduce((n, p) => n + p.count, 0);
      // Assertion (warned, not thrown: the run stays usable): a package's OWN symbol
      // (its name, or its anonymous `npm . .` rewritten by anonymousSymbolKey) is never
      // defined by another package, since every key of a package's own symbols is unique
      // to it. A third-party symbol two packages declare is only noted.
      const claimed = pairs.filter((p) => p.claimed);
      if (claimed.length > 0) {
        warn(`${claimed.reduce((n, p) => n + p.count, 0)} symbol(s) claimed as their own by two packages; the first package `
          + `ingested keeps each and the other's references resolve into it: ${claimed.slice(0, 5).map((p) =>
            `${p.owner} / ${p.other} (${p.count}, e.g. ${p.example})`).join('; ')}${claimed.length > 5 ? `; +${claimed.length - 5} more pair(s)` : ''}`);
      }
      const other = pairs.filter((p) => !p.claimed);
      if (other.length > 0) {
        log(`[ingest] ${other.reduce((n, p) => n + p.count, 0)} third-party symbol definition(s) in ${other.length} package pair(s) `
          + 'were already defined by another package (module augmentation, declare global); the first keeps each');
      }
    }

    // Documents (+ synthetic file symbols where the indexer emitted no module symbol).
    // is_generated: listed in a sidecar's generatedFiles (TypeScript and, since
    // scip-dart +sentei.12, Dart: the same header sniff), a GENERATED_GLOBS path (a
    // Dart index cached by an older adapter has no such list), or vendored code in a
    // VENDORED_GLOBS directory below the package root (treated like generated code).
    const generated = new Set(sidecars.flatMap(({ repo, data }) => (data.generatedFiles ?? []).map((f) => `${repo}\0${f}`)));
    for (const w of docs) {
      if (w.moduleSymbolId === 0) {
        const norm = `sentei file ${w.packageId} ${w.file}`;
        const res = st.symbol.run(norm, w.packageId, w.file, 0, 0, 'file', w.file);
        w.moduleSymbolId = Number(res.lastInsertRowid);
        symbols.set(norm, { symbolId: w.moduleSymbolId, packageId: w.packageId });
        counts.symbols += 1;
      }
      const pk = pkgs.get(w.packageId)!;
      const isEntry = pk.entryPoints.has(w.file) || pk.runtimeEntryPoints.has(w.file) ? 1 : 0;
      const isGenerated = generated.has(`${w.repo}\0${w.file}`) || GENERATED_GLOBS.some((g) => matchGlob(g, w.file))
        || inVendoredDir(w.file, pk.path) ? 1 : 0;
      st.document.run(w.packageId, w.file, w.moduleSymbolId, isEntry, isGenerated);
      counts.documents += 1;
      counts.generatedDocuments += isGenerated;
    }

    // Parents: nearest enclosing descriptor that is an org symbol of the same package
    // (Foo#bar(). -> Foo#). A file is never a parent: a module is not a declaration that
    // keeps its top-level functions alive. A namespace descriptor is a parent only when
    // it is a real declaration (a TS `namespace X {}` / `declare namespace X {}`:
    // `WebAssembly/CompileError#` -> `WebAssembly/`): defined in the same document, not
    // that document's module symbol, not a scip-dart import prefix. The walk stops at
    // the first namespace descriptor either way (Dart module paths, TS file paths).
    const moduleIds = new Set(docs.map((w) => w.moduleSymbolId));
    const symbolFile = db.prepare('SELECT file, kind FROM symbols WHERE symbol_id = ?');
    for (const [norm, row] of symbols) {
      if (norm.startsWith('sentei file ')) continue;
      const g = parseScipSymbol(norm);
      if (g.local) continue;
      const ds = parseDescriptors(g.descriptors);
      const head = norm.slice(0, norm.length - g.descriptors.length);
      for (let i = ds.length - 1; i >= 1; i -= 1) {
        const parent = symbols.get(head + ds.slice(0, i).map((d) => d.text).join(''));
        if (ds[i - 1]!.suffix === 'namespace') {
          if (parent && parent.packageId === row.packageId && !moduleIds.has(parent.symbolId)) {
            const pf = symbolFile.get(parent.symbolId) as { file: string; kind: string };
            const rf = symbolFile.get(row.symbolId) as { file: string; kind: string };
            if (pf.file === rf.file && pf.kind !== 'import-prefix') st.parent.run(parent.symbolId, row.symbolId);
          }
          break;
        }
        if (parent && parent.packageId === row.packageId) {
          st.parent.run(parent.symbolId, row.symbolId);
          break;
        }
      }
    }

    // ---- Pass 2: references ----------------------------------------------
    const edgeRun = (s: StatementSync, from: SymRow, to: SymRow, source: 'scip' | 'overlay'): void => {
      const r = s.run(from.symbolId, to.symbolId, from.packageId, to.packageId, source);
      counts.edges += Number(r.changes);
    };
    const byId = new Map<number, SymRow>();
    for (const row of symbols.values()) byId.set(row.symbolId, row);

    /** Innermost definition in `w` whose enclosing_range contains (line, col), else the module symbol. */
    const enclosingAt = (w: DocWork, line: number, col: number, exclude?: number): number => {
      let enclosing: { symbolId: number; span: Span } | undefined;
      for (const s of w.spans) {
        if (s.symbolId === exclude) continue;
        if (!contains(s.span, line, col)) continue;
        if (!enclosing || startsAfter(s.span, enclosing.span)) enclosing = s;
      }
      return enclosing?.symbolId ?? w.moduleSymbolId;
    };

    /**
     * A reference to an undefined symbol is attributed to its nearest DEFINED descriptor
     * ancestor when the missing part is one no index can be expected to define:
     *   - anything whose descriptor chain passes through an anonymous literal
     *     (isAnonymousDescriptor), anywhere: the counter in `typeLiteral3:` / `npm0:`
     *     depends on the program that indexed the file, so a consumer's
     *     `Props.typeLiteral3:__html.` never matches the library's
     *     `Props.typeLiteral5:__html.`, and scip-typescript names contextual members
     *     through type-alias chains (`ErrorBoundary.FC:PropsWithChildren:typeLiteral5:fallback.`)
     *     that the defining index never emits. The nearest defined prefix (walking up)
     *     takes the occurrence, even when the named parts below it are missing too;
     *   - an implicit constructor: `Owner#<constructor>().` (scip-dart names `Shown()` so
     *     even when the class declares no constructor), with nothing (or only anonymous
     *     descriptors, covered above) below it.
     * Exception: the ancestor is never a file / namespace (a module symbol) unless the
     * first missing descriptor is itself anonymous (`src/\`a.ts\`/npm0:` object-literal
     * properties live directly under the file): a missing named top-level declaration
     * is real version skew. Anything else missing (`Foo#gone().`) stays an
     * unresolved_refs row.
     */
    const undefinedRefOwner = (norm: string, p: ParsedGlobal, roles: number): SymRow | undefined => {
      if ((roles & DEFINITION) !== 0) return undefined;
      const ds = p.descriptors;
      const suffix = ds.map((d) => d.text).join('');
      if (!norm.endsWith(suffix)) return undefined;
      const head = norm.slice(0, norm.length - suffix.length);
      const isCtor = (d: Descriptor | undefined): boolean => d?.suffix === 'method' && d.name === '<constructor>';
      const anonymous = ds.some(isAnonymousDescriptor);
      for (let k = ds.length - 1; k >= 1; k -= 1) {
        const row = symbols.get(head + ds.slice(0, k).map((d) => d.text).join(''));
        if (!row) continue;
        const first = ds[k]!;
        if (isAnonymousDescriptor(first)) return row;
        if (isCtor(first) && k === ds.length - 1) return row;
        const prefixIsModule = ds.slice(0, k).every((d) => d.suffix === 'namespace');
        return anonymous && !prefixIsModule ? row : undefined;
      }
      return undefined;
    };

    for (const w of docs) {
      for (const o of w.doc.occurrences) {
        const p = parse(o.symbol);
        if (!interesting(p)) continue;
        const start = occurrenceStart(o);
        if (!start) continue;
        const plain = normalizeSymbolVersion(o.symbol);
        const t = symbolTarget(w, p, plain);
        if ('ambiguous' in t) {
          if ((o.symbolRoles & DEFINITION) === 0) noteAmbiguous(w.packageId, t.nameKey, t.ambiguous, w.file); // defs: pass 1
          continue;
        }
        const norm = t.key;
        const row = symbols.get(norm) ?? undefinedRefOwner(norm, p, o.symbolRoles);
        if (!row) {
          const target = t.pkg;
          if (target !== undefined && target !== w.packageId) {
            // A module / namespace symbol (`…/\`utils.d.ts\`/`) names a file, not a
            // declaration: skew residue, not a missing symbol.
            if (p.descriptors.every((d) => d.suffix === 'namespace')) {
              counts.droppedModuleRefs += 1;
              continue;
            }
            st.unresolved.run(w.packageId, target, plain, w.file, start.line, start.col);
            counts.unresolved += 1;
          }
          continue;
        }
        const isDef = (o.symbolRoles & DEFINITION) !== 0;
        const enclosingId = enclosingAt(w, start.line, start.col, isDef ? row.symbolId : undefined);
        const isSite = exportSites.has(`${w.repo}\0${w.file}\0${start.line}\0${start.col}`) ? 1 : 0;
        st.occurrence.run(row.symbolId, w.packageId, row.packageId, w.file, start.line, start.col, o.symbolRoles, enclosingId, isSite);
        counts.occurrences += 1;
        if (!isDef && !isSite) edgeRun(st.edge, byId.get(enclosingId)!, row, 'scip');
      }
    }

    // ---- Checker-resolved refs SCIP missed (sidecar namespaceMemberRefs, shorthandRefs) ---
    // namespaceMemberRefs: scip-typescript 0.4.0 emits `local N` for `W.member` when W is
    // an org namespace import and member is an alias re-export. shorthandRefs: it emits
    // only the contextual property symbol for `{ grade }` in a contextually typed object
    // literal, no reference to the value `grade`. The index adapter records the
    // checker-resolved declaration instead. Added only where SCIP has no occurrence of
    // that symbol at the same position.
    {
      const docAt = new Map(docs.map((w) => [`${w.repo}\0${w.file}`, w]));
      const occAt = db.prepare('SELECT 1 FROM occurrences WHERE symbol_id = ? AND package_id = ? AND file = ? AND line = ? AND col = ? LIMIT 1');
      type CheckerRef = NonNullable<ExportsSidecar['namespaceMemberRefs']>[number];
      /** Adds the refs of one sidecar field; returns [added, unmatched labels]. */
      const addCheckerRefs = (what: string, packageId: string, repo: string, refs: readonly CheckerRef[]): [number, string[]] => {
        let added = 0;
        const unmatchedRefs: string[] = [];
        for (const r of refs) {
          const label = `${packageId} ${r.file}:${r.line + 1}:${r.col + 1} ${r.member} -> ${r.targetPackage}/${r.targetFile}:${r.targetLine + 1}:${r.targetCol + 1}`;
          const resolved = resolveName(packageId, `npm:${r.targetPackage}`);
          if (typeof resolved === 'object') {
            noteAmbiguous(packageId, `npm:${r.targetPackage}`, resolved.ambiguous, r.file);
            continue;
          }
          const target = resolved === undefined ? undefined : pkgs.get(resolved);
          if (!target) {
            warn(`${what} ${label}: target is not an org package, ignored`);
            continue;
          }
          const w = docAt.get(`${repo}\0${r.file}`);
          if (!w || w.packageId !== packageId) {
            warn(`${what} ${label}: consumer file is not an indexed document of ${packageId}, ignored`);
            continue;
          }
          const targetFile = posix.normalize(posix.join(target.path || '.', r.targetFile));
          const id = defPositions.get(`${target.repo}\0${targetFile}\0${r.targetLine}\0${r.targetCol}`);
          if (id === undefined) {
            unmatchedRefs.push(label);
            continue;
          }
          const row = byId.get(id)!;
          if (occAt.get(id, w.packageId, w.file, r.line, r.col)) continue; // SCIP already resolved it
          const enclosingId = enclosingAt(w, r.line, r.col);
          st.occurrence.run(id, w.packageId, row.packageId, w.file, r.line, r.col, 0, enclosingId, 0);
          counts.occurrences += 1;
          added += 1;
          edgeRun(st.edge, byId.get(enclosingId)!, row, 'scip');
        }
        return [added, unmatchedRefs];
      };
      const unmatchedNs: string[] = [];
      const unmatchedSh: string[] = [];
      for (const { packageId, repo, data } of sidecars) {
        const [ns, nsMiss] = addCheckerRefs('namespace member ref', packageId, repo, data.namespaceMemberRefs ?? []);
        counts.namespaceMemberRefs += ns;
        unmatchedNs.push(...nsMiss);
        const [sh, shMiss] = addCheckerRefs('shorthand ref', packageId, repo, data.shorthandRefs ?? []);
        counts.shorthandRefs += sh;
        unmatchedSh.push(...shMiss);
      }
      counts.unmatchedNamespaceMemberRefs = unmatchedNs.length;
      if (unmatchedNs.length > 0) {
        warn(`${unmatchedNs.length} namespace member ref(s) match no SCIP definition: ${unmatchedNs.join('; ')}`);
      }
      counts.unmatchedShorthandRefs = unmatchedSh.length;
      if (unmatchedSh.length > 0) {
        warn(`${unmatchedSh.length} shorthand ref(s) match no SCIP definition: ${unmatchedSh.join('; ')}`);
      }
    }

    // Members are reachable when their owner is.
    const parentEdges = db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source)
      SELECT parent_symbol_id, symbol_id, package_id, package_id, 'scip' FROM symbols WHERE parent_symbol_id IS NOT NULL`).run();
    counts.edges += Number(parentEdges.changes);

    // ---- Export surface from sidecars --------------------------------------
    // Anonymous default exports (`export default () => ...`) get NO symbol from
    // scip-typescript 0.4.0; an importer's only SCIP trace is its reference to the
    // module symbol (the `from '...'` specifier). The sidecar still reports the
    // export (at the `default` keyword). We model it as a synthetic symbol
    // 'sentei default <package_id> <file>' named `default`, and treat every
    // non-definition reference to the file's module symbol as a reference to it
    // (over-approximation: any import of the file keeps the default alive — fail
    // closed). The anonymous body's references are attributed to the module symbol,
    // so the default gets an edge default -> module.
    const moduleRefs = db.prepare(`SELECT package_id, file, line, col, role, enclosing_symbol_id FROM occurrences
      WHERE symbol_id = ? AND (role & 1) = 0 AND is_export_site = 0`);
    const anonymousDefault = (w: DocWork, line: number, col: number): number => {
      const norm = `sentei default ${w.packageId} ${w.file}`;
      const existing = symbols.get(norm);
      if (existing) return existing.symbolId;
      const res = st.symbol.run(norm, w.packageId, w.file, line, col, '', 'default');
      const row: SymRow = { symbolId: Number(res.lastInsertRowid), packageId: w.packageId };
      symbols.set(norm, row);
      byId.set(row.symbolId, row);
      counts.symbols += 1;
      const mod = byId.get(w.moduleSymbolId)!;
      edgeRun(st.edge, row, mod, 'scip');
      const refs = moduleRefs.all(w.moduleSymbolId) as Array<{
        package_id: string; file: string; line: number | null; col: number | null; role: number; enclosing_symbol_id: number;
      }>;
      for (const r of refs) {
        st.occurrence.run(row.symbolId, r.package_id, row.packageId, r.file, r.line, r.col, r.role, r.enclosing_symbol_id, 0);
        counts.occurrences += 1;
        edgeRun(st.edge, byId.get(r.enclosing_symbol_id)!, row, 'scip');
      }
      return row.symbolId;
    };

    const unmatched: string[] = [];
    const unmatchedEntry: string[] = [];
    const exportedIds = new Set<number>();
    /** Sidecar unindexedImports with `relative: true` (handled after the export surface). */
    const relativeImports: Array<{ packageId: string; repo: string; file: string; module: string }> = [];
    const docByFile = new Map(docs.map((w) => [`${w.repo}\0${w.file}`, w]));
    for (const { packageId, repo, data } of sidecars) {
      for (const e of data.exports) {
        const posKey = `${repo}\0${e.file}\0${e.line}\0${e.col}`;
        let id = defPositions.get(posKey);
        const w = docByFile.get(`${repo}\0${e.file}`);
        if (id === undefined && e.note === 'default-keyword' && w && w.packageId === packageId) {
          id = anonymousDefault(w, e.line, e.col);
          defPositions.set(posKey, id);
        }
        if (id === undefined) {
          unmatched.push(`${packageId} ${e.exportedAs} (${e.name} at ${e.file}:${e.line + 1}:${e.col + 1})`);
          continue;
        }
        if (!exportedIds.has(id)) {
          st.exported.run(id);
          exportedIds.add(id);
        }
        counts.exportAliases += Number(st.exportAlias.run(id, e.entry, e.exportedAs).changes);
      }
      for (const e of data.entrySymbols ?? []) {
        const id = defPositions.get(`${repo}\0${e.file}\0${e.line}\0${e.col}`);
        const w = docByFile.get(`${repo}\0${e.file}`);
        if (id === undefined || !w) {
          unmatchedEntry.push(`${packageId} ${e.name} at ${e.file}:${e.line + 1}:${e.col + 1}`);
          continue;
        }
        const kind = e.kind ?? 'runtime';
        if (kind !== 'runtime' && kind !== 'ambient') {
          throw new Error(`sentei: ${packageId} exports sidecar: unknown entry symbol kind ${JSON.stringify(kind)}`);
        }
        edgeRun(st.edge, byId.get(w.moduleSymbolId)!, byId.get(id)!, 'scip');
        st.entrySymbol.run(id, kind); // a seed on its own: the file need not be an entry
      }
      for (const u of data.unresolved) {
        const reason = typeof u === 'string' ? u : (u.reason ?? JSON.stringify(u));
        const file = typeof u === 'string' ? null : (u.file ?? null);
        addFlag(packageId, 'dynamic_access', reason, file);
      }
      for (const f of data.flags ?? []) {
        if (!SIDECAR_FLAGS.has(f.flag)) throw new Error(`sentei: ${packageId} exports sidecar: unknown flag ${JSON.stringify(f.flag)}`);
        // Targeted only at another org package; a self target or a non-org one stays
        // untargeted (fail closed: the package itself is opaque, and blocks its deps).
        // A shared name the consumer cannot attribute targets every candidate.
        let targets: Array<string | null> = [null];
        if (f.targetPackage !== undefined) {
          const t = resolveName(packageId, `npm:${f.targetPackage}`);
          if (typeof t === 'object') targets = t.ambiguous.filter((c) => c !== packageId);
          else if (t !== undefined && t !== packageId && pkgs.has(t)) targets = [t];
          else if (t !== packageId) warn(`${packageId}: ${f.flag} flag targets ${JSON.stringify(f.targetPackage)}, not an org package; kept untargeted`);
        }
        for (const target of targets) addFlag(packageId, f.flag, f.reason, f.file ?? null, target);
      }
      // Unindexed files importing an org package: we cannot see what they use, so the
      // target gets no verdict (blocked_packages); the consumer itself stays transparent.
      // Scoped ones (script / docs / test files) go to witness_files instead: they must
      // not block a whole package, the witness reads them.
      for (const u of data.unindexedImports ?? []) {
        if (u.relative === true) {
          relativeImports.push({ packageId, repo, file: u.file, module: u.module });
          continue;
        }
        const resolved = resolveName(packageId, `npm:${barePackageName(u.module)}`);
        // A shared name the consumer cannot attribute: treated as an import of every candidate.
        const targets = typeof resolved === 'object' ? resolved.ambiguous : resolved === undefined ? [] : [resolved];
        const target = targets.length === 1 ? targets[0]! : undefined;
        // A self import by name the program could not follow: an own file outside the
        // program (`build.config.ts`, `eslint.config.mjs`), or an indexed file whose
        // self-import did not resolve (`import('env-runner/runners/x')`): a self
        // witness_files row; the witness name-searches the file even when indexed (the
        // references through that import are missing from SCIP). Never a flag.
        if (target === packageId) {
          counts.witnessFiles += Number(st.witnessFile.run(packageId, packageId, u.file).changes);
          continue;
        }
        if (targets.length === 0) {
          warn(`${packageId}: unindexed import of ${JSON.stringify(u.module)} at ${u.file}`
            + ` does not name another org package, ignored`);
          continue;
        }
        for (const t of targets) {
          if (t === packageId) continue;
          if (u.scope !== undefined) counts.witnessFiles += Number(st.witnessFile.run(packageId, t, u.file).changes);
          else addFlag(packageId, 'unindexed_consumer', `unindexed file imports ${u.module}`, u.file, t);
        }
      }
    }
    // ---- Deep-import surface (sidecar deepImportExports) --------------------------
    // A module of package T that a consumer imports by a deep path
    // (`@acme/x/dist/module/lib/types`, source-linked to src/lib/types.ts) is an entry
    // point of T in all but name: its exports go on T's export surface, like the
    // sidecar exports of a declared entry (symbol_exports, entry_file = that module).
    // Otherwise the consumer's reference would reach a symbol reachability calls
    // private, and a used declaration would be reported private_dead. Matched by
    // (file, name) of a top-level declaration: the consumer's sidecar may be cached
    // while T moved on; a name that no longer matches marks nothing.
    {
      const topNamed = db.prepare('SELECT symbol_id FROM symbols WHERE package_id = ? AND file = ? AND name = ? AND parent_symbol_id IS NULL ORDER BY symbol_id');
      for (const { packageId, data } of sidecars) {
        for (const d of data.deepImportExports ?? []) {
          const resolved = resolveName(packageId, `npm:${d.targetPackage}`);
          const targets = typeof resolved === 'object' ? resolved.ambiguous : resolved === undefined ? [] : [resolved];
          for (const t of targets) {
            const info = pkgs.get(t);
            if (t === packageId || info === undefined) continue;
            const inPkg = (f: string): string => (info.path === '' ? f : `${info.path}/${f}`);
            for (const { symbol_id: id } of topNamed.all(t, inPkg(d.file), d.name) as Array<{ symbol_id: number }>) {
              if (!exportedIds.has(id)) {
                st.exported.run(id);
                exportedIds.add(id);
                counts.deepImportExports += 1;
              }
              counts.exportAliases += Number(st.exportAlias.run(id, inPkg(d.entry), d.exportedAs).changes);
            }
          }
        }
      }
    }
    // ---- Sidecar unresolvedImports (after every sidecar's exports are known) -----
    // The consumer's checker could not find `name` in the org package it imports. When
    // the target exports that name at HEAD (an alias in symbol_exports, or an exported
    // definition of that name), the miss is the consumer's compile options (c12 under
    // nodenext cannot follow pathe's extensionless `export * from "./_path"`), not version
    // skew: record a use (role 0 occurrence from the consumer document, enclosed by its
    // module symbol, + edge) of every such symbol. Otherwise (the name is really gone, or
    // the consumer file is not an indexed document) it is an unresolved_refs row.
    {
      const occAtPos = db.prepare('SELECT 1 FROM occurrences WHERE symbol_id = ? AND package_id = ? AND file = ? AND line = ? AND col = ? LIMIT 1');
      const exportedNamed = db.prepare(`SELECT DISTINCT s.symbol_id FROM symbols s
        WHERE s.package_id = ? AND s.is_exported = 1
          AND (s.name = ? OR EXISTS (SELECT 1 FROM symbol_exports x WHERE x.symbol_id = s.symbol_id AND x.exported_as = ?))
        ORDER BY s.symbol_id`);
      for (const { packageId, repo, data } of sidecars) {
        const manager = packageId.slice(0, packageId.indexOf(':'));
        for (const u of data.unresolvedImports ?? []) {
          const resolved = resolveName(packageId, `${manager}:${barePackageName(u.module)}`);
          if (typeof resolved === 'object') {
            noteAmbiguous(packageId, `${manager}:${barePackageName(u.module)}`, resolved.ambiguous, u.file);
            continue;
          }
          const target = resolved;
          if (target === undefined || target === packageId) {
            warn(`${packageId}: unresolved import ${JSON.stringify(u.name)} from ${JSON.stringify(u.module)} at ${u.file}`
              + ` does not name another org package, ignored`);
            continue;
          }
          const w = docByFile.get(`${repo}\0${u.file}`);
          const ids = w && w.packageId === packageId
            ? (exportedNamed.all(target, u.name, u.name) as Array<{ symbol_id: number }>).map((r) => r.symbol_id)
            : [];
          if (ids.length === 0) {
            st.unresolved.run(packageId, target, u.name, u.file, u.line ?? null, u.col ?? null);
            counts.unresolved += 1;
            continue;
          }
          const from = byId.get(w!.moduleSymbolId)!;
          for (const sid of ids) {
            const to = byId.get(sid)!;
            if (u.line != null && u.col != null && occAtPos.get(sid, packageId, u.file, u.line, u.col)) continue; // SCIP has it
            st.occurrence.run(sid, packageId, to.packageId, u.file, u.line ?? null, u.col ?? null, 0, from.symbolId, 0);
            counts.occurrences += 1;
            edgeRun(st.edge, from, to, 'scip');
          }
          counts.resolvedUnresolvedImports += 1;
        }
      }
    }

    // ---- Runtime entry files (after the export surface is known) ------------
    // An `imports` map arm (`#crypto` → digest.node.mjs / digest.mjs) or a Vite input is
    // loaded by the runtime / bundler: its exports are not package surface that some
    // importer must use, so they are entry_symbols (seeds, no verdict), like a Dart
    // `main`. Only exported top-level declarations; privates follow reachability.
    {
      const exportedTop = db.prepare(`SELECT symbol_id, name FROM symbols
        WHERE package_id = ? AND file = ? AND is_exported = 1 AND parent_symbol_id IS NULL ORDER BY symbol_id`);
      for (const w of docs) {
        const pk = pkgs.get(w.packageId)!;
        // A bin (runtime only, not an entry point) is a seed document; the package's
        // exports that happen to be declared in it stay ordinary exports.
        const runtimeFile = pk.runtimeEntryPoints.has(w.file) && pk.entryPoints.has(w.file);
        // A Durable Object class is instantiated by the Workers runtime by its name (the
        // wrangler binding's class_name), from whichever entry file exports it.
        const byName = pk.runtimeEntrySymbols.size > 0 && (pk.entryPoints.has(w.file) || pk.runtimeEntryPoints.has(w.file));
        if (!runtimeFile && !byName) continue;
        for (const r of exportedTop.all(w.packageId, w.file) as Array<{ symbol_id: number; name: string }>) {
          if (!runtimeFile && !pk.runtimeEntrySymbols.has(r.name)) continue;
          counts.runtimeEntrySymbols += Number(st.entrySymbol.run(r.symbol_id, 'runtime').changes);
        }
      }
    }

    // ---- Relative unindexed imports (own SFC files importing own modules) -----
    {
      const docAt = new Map(docs.map((w) => [`${w.repo}\0${w.file}`, w]));
      const topPrivate = db.prepare(`SELECT symbol_id FROM symbols
        WHERE package_id = ? AND file = ? AND parent_symbol_id IS NULL AND is_exported = 0 AND symbol_id <> ? ORDER BY symbol_id`);
      for (const r of relativeImports) {
        counts.witnessFiles += Number(st.witnessFile.run(r.packageId, r.packageId, r.file).changes);
        counts.relativeUnindexedImports += 1;
        const mod = posix.normalize(r.module);
        const w = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.js']
          .map((ext) => docAt.get(`${r.repo}\0${mod}${ext}`))
          .find((d) => d !== undefined && d.packageId === r.packageId);
        if (!w) {
          warn(`${r.packageId}: unindexed ${r.file} imports own module ${JSON.stringify(r.module)}, which is not an indexed document`);
          continue;
        }
        for (const t of topPrivate.all(w.packageId, w.file, w.moduleSymbolId) as Array<{ symbol_id: number }>) st.entrySymbol.run(t.symbol_id, 'runtime');
      }
    }

    // ---- Sidecar namespaceSpreadRefs (after the export surface is known) -------
    // `{ ..._pkg }` of `import * as _pkg from './utils/pkg'` hands out every export of the
    // module; SCIP sees only the local `_pkg`. Edges (reachability) from the enclosing
    // symbol at the consumer position to EVERY symbol defined in the target document
    // (top-level and nested, not the module symbol). Occurrences (reference counting)
    // for the target's top-level exported symbols (is_exported: those are the ones that
    // get verdicts; a namespace object holds only the module's exports): in the same
    // package (an entry export used only through the spread is used, not dead), and
    // across packages unless the consumer already has a namespace_dynamic flag targeted
    // at the target package (the index adapter pairs every cross-package spread / `D[k]`
    // with one): that flag already withholds the target's verdicts (`blocked`, which
    // names the blocker to fix), and counting would silently turn them into "alive".
    {
      const docAt = new Map(docs.map((w) => [`${w.repo}\0${w.file}`, w]));
      const occAt = db.prepare('SELECT 1 FROM occurrences WHERE symbol_id = ? AND package_id = ? AND file = ? AND line = ? AND col = ? LIMIT 1');
      const inDoc = db.prepare(`SELECT symbol_id, parent_symbol_id IS NULL AND is_exported = 1 AS counted
        FROM symbols WHERE package_id = ? AND file = ? AND symbol_id <> ? ORDER BY symbol_id`);
      const nsFlagged = db.prepare(`SELECT 1 FROM package_flags
        WHERE package_id = ? AND target_package_id = ? AND flag = 'namespace_dynamic' LIMIT 1`);
      const unmatchedSpread: string[] = [];
      for (const { packageId, repo, data } of sidecars) {
        for (const r of data.namespaceSpreadRefs ?? []) {
          const label = `${packageId} ${r.file}:${r.line + 1}:${r.col + 1} ...${r.targetPackage}/${r.targetFile}`;
          const resolved = resolveName(packageId, `npm:${r.targetPackage}`);
          if (typeof resolved === 'object') {
            noteAmbiguous(packageId, `npm:${r.targetPackage}`, resolved.ambiguous, r.file);
            continue;
          }
          const target = resolved === undefined ? undefined : pkgs.get(resolved);
          if (!target) {
            warn(`namespace spread ref ${label}: target is not an org package, ignored`);
            continue;
          }
          const w = docAt.get(`${repo}\0${r.file}`);
          const tw = docAt.get(`${target.repo}\0${posix.normalize(posix.join(target.path || '.', r.targetFile))}`);
          if (!w || w.packageId !== packageId || !tw || tw.packageId !== target.packageId) {
            unmatchedSpread.push(label);
            continue;
          }
          const from = byId.get(enclosingAt(w, r.line, r.col))!;
          const rows = inDoc.all(tw.packageId, tw.file, tw.moduleSymbolId) as Array<{ symbol_id: number; counted: number }>;
          const count = tw.packageId === w.packageId || !nsFlagged.get(w.packageId, tw.packageId);
          for (const t of rows) {
            const to = byId.get(t.symbol_id)!;
            edgeRun(st.edge, from, to, 'scip');
            if (count && t.counted === 1 && !occAt.get(t.symbol_id, w.packageId, w.file, r.line, r.col)) {
              st.occurrence.run(t.symbol_id, w.packageId, to.packageId, w.file, r.line, r.col, 0, from.symbolId, 0);
              counts.occurrences += 1;
            }
          }
          counts.namespaceSpreadRefs += 1;
        }
      }
      counts.unmatchedNamespaceSpreadRefs = unmatchedSpread.length;
      if (unmatchedSpread.length > 0) {
        warn(`${unmatchedSpread.length} namespace spread ref(s) match no indexed document: ${unmatchedSpread.join('; ')}`);
      }
    }

    // ---- Sidecar conditionalImports (after every occurrence is known) -----------
    // A conditional import or export selects one of several documents per platform; the
    // analyzer (and so the index) sees only the default target T. Alternatives are real
    // code on another platform: see IngestCounts.conditionalImports.
    {
      const docAt = new Map(docs.map((w) => [`${w.repo}\0${w.file}`, w]));
      const keyOf = new Map<number, string>();
      for (const [norm, row] of symbols) keyOf.set(row.symbolId, norm);
      const inDoc = db.prepare(`SELECT symbol_id, parent_symbol_id IS NULL AS top, is_exported, name
        FROM symbols WHERE package_id = ? AND file = ? AND symbol_id <> ? ORDER BY symbol_id`);
      const mirrorOccurrences = db.prepare(`INSERT INTO occurrences
          (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id, is_export_site)
        SELECT ?, o.package_id, ?, o.file, o.line, o.col, o.role, o.enclosing_symbol_id, 0
        FROM occurrences o
        WHERE o.symbol_id = ? AND (o.role & 1) = 0 AND o.is_export_site = 0
          AND NOT EXISTS (SELECT 1 FROM occurrences p WHERE p.symbol_id = ?1 AND p.package_id = o.package_id
            AND p.file = o.file AND p.line IS o.line AND p.col IS o.col)`);
      const mirrorEdges = db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source)
        SELECT from_symbol_id, ?, from_package_id, ?, source FROM edges WHERE to_symbol_id = ?`);
      const occAt = db.prepare('SELECT 1 FROM occurrences WHERE symbol_id = ? AND package_id = ? AND file = ? AND line = ? AND col = ? LIMIT 1');
      // Conditional export: the twin X' of an exported X is exported wherever X is.
      const copyExports = db.prepare(`INSERT OR IGNORE INTO symbol_exports (symbol_id, entry_file, exported_as)
        SELECT ?, entry_file, exported_as FROM symbol_exports WHERE symbol_id = ?`);
      const isUri = (u: string): boolean => /^[A-Za-z][\w+.-]*:/.test(u);
      const exportTwin = (x: number, twin: SymRow): void => {
        const added = Number(copyExports.run(twin.symbolId, x).changes);
        if (added === 0) return;
        counts.exportAliases += added;
        if (!exportedIds.has(twin.symbolId)) {
          st.exported.run(twin.symbolId);
          exportedIds.add(twin.symbolId);
          counts.conditionalExportSymbols += 1;
        }
      };
      const unmatchedCond: string[] = [];
      for (const { packageId, repo, data } of sidecars) {
        for (const c of data.conditionalImports ?? []) {
          const label = `${packageId} ${c.file}:${c.line + 1}:${c.col + 1}`;
          const a = docAt.get(`${repo}\0${posix.normalize(c.file)}`);
          if (!a) {
            unmatchedCond.push(`${label} (importing file is not an indexed document)`);
            continue;
          }
          const t = isUri(c.target) ? undefined : docAt.get(`${repo}\0${posix.normalize(c.target)}`);
          const tKey = t ? keyOf.get(t.moduleSymbolId) : undefined;
          // A's top-level declarations and module symbol: "A is reachable".
          const aSources = [a.moduleSymbolId, ...(inDoc.all(a.packageId, a.file, a.moduleSymbolId) as Array<{ symbol_id: number; top: number }>)
            .filter((r) => r.top === 1).map((r) => r.symbol_id)].map((id) => byId.get(id)!);
          for (const alt of c.alternatives) {
            if (isUri(alt)) continue; // outside the repo: not ours to keep alive
            const b = docAt.get(`${repo}\0${posix.normalize(alt)}`);
            if (!b) {
              unmatchedCond.push(`${label} alternative ${alt} (not an indexed document)`);
              continue;
            }
            const bKey = keyOf.get(b.moduleSymbolId);
            const bRows = inDoc.all(b.packageId, b.file, b.moduleSymbolId) as Array<{ symbol_id: number; top: number; is_exported: number; name: string }>;
            // Synthetic `sentei file` module symbols carry no descriptor path: nothing to match on.
            const matchable = t !== undefined && tKey !== undefined && bKey !== undefined && !tKey.startsWith('sentei ') && !bKey.startsWith('sentei ');
            if (matchable) {
              const bTopByName = new Map<string, number>();
              for (const r of bRows) {
                const k = keyOf.get(r.symbol_id);
                if (r.top === 1 && k !== undefined && k.startsWith(bKey)) {
                  const name = topLevelName(k.slice(bKey.length));
                  if (name !== undefined && !bTopByName.has(name)) bTopByName.set(name, r.symbol_id);
                }
              }
              for (const r of inDoc.all(t.packageId, t.file, t.moduleSymbolId) as Array<{ symbol_id: number }>) {
                const xKey = keyOf.get(r.symbol_id);
                if (xKey === undefined || !xKey.startsWith(tKey)) continue;
                const rest = xKey.slice(tKey.length);
                let twin = symbols.get(bKey + rest);
                if (!twin || twin.packageId !== b.packageId || twin.symbolId === b.moduleSymbolId) {
                  const name = topLevelName(rest);
                  const byName = name !== undefined ? bTopByName.get(name) : undefined;
                  twin = byName !== undefined ? byId.get(byName) : undefined;
                }
                if (!twin) continue;
                counts.occurrences += Number(mirrorOccurrences.run(twin.symbolId, twin.packageId, r.symbol_id).changes);
                counts.edges += Number(mirrorEdges.run(twin.symbolId, twin.packageId, r.symbol_id).changes);
                counts.conditionalMirroredSymbols += 1;
                if (c.directive === 'export') exportTwin(r.symbol_id, twin);
              }
            } else {
              // A conditional export whose default has no document to match twins on:
              // B's public API is exported on some platform, so it is kept alive whole
              // (runtime seeds: alive, no verdict; fail closed).
              if (c.directive === 'export') {
                for (const r of bRows) {
                  if (r.top !== 1 || r.name.startsWith('_')) continue;
                  counts.conditionalExportSymbols += Number(st.entrySymbol.run(r.symbol_id, 'runtime').changes);
                }
              }
              for (const r of bRows) {
                if (r.top !== 1) continue;
                const to = byId.get(r.symbol_id)!;
                for (const from of aSources) edgeRun(st.edge, from, to, 'scip');
                if (r.is_exported === 1 && !occAt.get(r.symbol_id, a.packageId, a.file, c.line, c.col)) {
                  st.occurrence.run(r.symbol_id, a.packageId, to.packageId, a.file, c.line, c.col, 0, a.moduleSymbolId, 0);
                  counts.occurrences += 1;
                }
              }
            }
            // Reachability never crosses packages (reach_edges): seed a foreign alternative.
            if (b.packageId !== a.packageId) {
              for (const r of bRows) if (r.top === 1) st.entrySymbol.run(r.symbol_id, 'runtime');
            }
            counts.conditionalImports += 1;
          }
        }
      }
      counts.unmatchedConditionalImports = unmatchedCond.length;
      if (unmatchedCond.length > 0) warn(`${unmatchedCond.length} conditional import(s) not applied: ${unmatchedCond.join('; ')}`);
    }

    counts.exported = exportedIds.size;
    counts.unmatchedExports = unmatched.length;
    if (unmatched.length > 0) warn(`${unmatched.length} sidecar export(s) match no SCIP definition: ${unmatched.join('; ')}`);
    counts.unmatchedEntrySymbols = unmatchedEntry.length;
    if (unmatchedEntry.length > 0) {
      warn(`${unmatchedEntry.length} sidecar entry symbol(s) match no SCIP definition: ${unmatchedEntry.join('; ')}`);
    }

    // ---- Overlays (sentei.json extraEdges) ---------------------------------
    const docModule = new Map(docs.map((w) => [`${w.repo}\0${w.file}`, w.moduleSymbolId]));
    const exportedByPkg = db.prepare('SELECT symbol_id, package_id, name FROM symbols WHERE is_exported = 1 AND package_id = ?');
    const allPkgRows = db.prepare('SELECT package_id, manager, repo, name FROM packages').all() as Array<{
      package_id: string; manager: string; repo: string; name: string;
    }>;
    for (const r of discover.repos) {
      for (const e of r.config?.extraEdges ?? []) {
        const label = `${r.repo} sentei.json extraEdges ${JSON.stringify(e)}`;
        if (!e.from.startsWith('file:')) {
          warn(`${label}: "from" must be "file:<repo-relative path>", ignored`);
          continue;
        }
        const fromId = docModule.get(`${r.repo}\0${posix.normalize(e.from.slice('file:'.length))}`);
        const m = /^([^#]+)#(.+)$/.exec(e.to);
        if (fromId === undefined || !m) {
          warn(`${label}: unknown source file or malformed target, ignored`);
          continue;
        }
        // `npm:<name>` names every package of that name (fail closed: more edges), `npm:<org>/<repo>:<name>` one.
        const ref = parsePackageRef(m[1]!);
        const toPkgs = ref === null ? [] : allPkgRows.filter((p) => packageRefMatches(ref, p)).map((p) => p.package_id);
        const targets = toPkgs.flatMap((id) => exportedByPkg.all(id) as Array<{ symbol_id: number; package_id: string; name: string }>)
          .filter((t) => m[2] === '*' || t.name === m[2]);
        if (targets.length === 0) {
          warn(`${label}: target matches no exported symbol, ignored`);
          continue;
        }
        for (const t of targets) edgeRun(st.edge, byId.get(fromId)!, { symbolId: t.symbol_id, packageId: t.package_id }, 'overlay');
      }
    }

    // ---- Ambiguous package names (noteAmbiguous) -----------------------------
    {
      const flagged = db.prepare(`SELECT 1 FROM package_flags
        WHERE package_id = ? AND target_package_id = ? AND flag = 'ambiguous_dep' LIMIT 1`);
      for (const a of ambiguousUses.values()) {
        const name = a.key.slice(a.key.indexOf(':') + 1);
        const reason = `${INGEST_AMBIGUOUS_PREFIX}uses of ${name} match ${a.candidates.length} org packages: ${a.candidates.join(', ')}`;
        let added = 0;
        for (const c of a.candidates) {
          if (c === a.consumer || flagged.get(a.consumer, c)) continue;
          addFlag(a.consumer, 'ambiguous_dep', reason, a.file, c);
          added += 1;
        }
        if (added > 0) {
          warn(`${a.consumer}: uses of ${name} match ${a.candidates.length} org packages (${a.candidates.join(', ')}) and no `
            + 'manifest dependency says which; dropped, every candidate blocked (ambiguous_dep). Declare the dependency, or '
            + 'exclude the other manifests with ignoreManifests in the org sentei.json');
        }
      }
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error(`sentei: foreign_key_check failed after ingest: ${JSON.stringify(violations)}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  counts.warnings = warnings;
  log(`[ingest] documents=${counts.documents} symbols=${counts.symbols} occurrences=${counts.occurrences} edges=${counts.edges} `
    + `exported=${counts.exported} unresolved=${counts.unresolved} flags=${counts.flags} unmatchedExports=${counts.unmatchedExports} `
    + `namespaceMemberRefs=${counts.namespaceMemberRefs} shorthandRefs=${counts.shorthandRefs} exportAliases=${counts.exportAliases}`
    + (counts.resolvedUnresolvedImports > 0 ? ` resolvedUnresolvedImports=${counts.resolvedUnresolvedImports}` : '')
    + (counts.deepImportExports > 0 ? ` deepImportExports=${counts.deepImportExports}` : '')
    + (counts.namespaceSpreadRefs > 0 ? ` namespaceSpreadRefs=${counts.namespaceSpreadRefs}` : '')
    + (counts.conditionalImports > 0 ? ` conditionalImports=${counts.conditionalImports} (mirrored ${counts.conditionalMirroredSymbols}`
      + `${counts.conditionalExportSymbols > 0 ? `, exported ${counts.conditionalExportSymbols}` : ''})` : '')
    + (counts.droppedModuleRefs > 0 ? ` droppedModuleRefs=${counts.droppedModuleRefs}` : '')
    + (counts.witnessFiles > 0 ? ` witnessFiles=${counts.witnessFiles}` : '')
    + (counts.generatedDocuments > 0 ? ` generatedDocuments=${counts.generatedDocuments}` : '')
    + (counts.packageErrors > 0 ? ` packageErrors=${counts.packageErrors}` : '')
    + (counts.skippedInvalidOccurrences > 0 ? ` skippedInvalidOccurrences=${counts.skippedInvalidOccurrences}` : '')
    + (counts.ambiguousSymbolRefs > 0 ? ` ambiguousSymbolRefs=${counts.ambiguousSymbolRefs}` : ''));
  return counts;
}
