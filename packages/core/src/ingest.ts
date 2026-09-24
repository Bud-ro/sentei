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
import { DISCOVER_REASON_PREFIX } from './discover.ts';
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
   * not make this package opaque). Absent: untargeted.
   */
  flags?: Array<{
    flag: 'namespace_dynamic' | 'dynamic_access'; reason: string; file: string | null; line?: number; col?: number;
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
   * targeted `unindexed_consumer` flag: it blocks verdicts of that package only. Optional.
   */
  unindexedImports?: Array<{ file: string; module: string; targetPackage: string }>;
  /**
   * Declarations the runtime or a tool invokes without any code reference (Dart `main()`
   * of a script, a build.yaml builder factory, dart_dev's `config`), at their name
   * identifier (0-based, repo-relative file). Each becomes an `entry_symbols` row (a
   * reachability seed that never gets a verdict or a private_dead row, whether or not
   * its file is an entry or it is exported) and keeps an edge from its document's
   * module symbol. Optional.
   */
  entrySymbols?: Array<{ file: string; line: number; col: number; name: string }>;
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
  /** Sidecar entrySymbols that matched no definition (warned). */
  unmatchedEntrySymbols: number;
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
  warnings: number;
}

/**
 * package_flags that ingest owns (and so deletes on every run). `unindexed_consumer`
 * is shared with discover: discover writes untargeted rows (files in languages we have
 * no indexer for), ingest writes targeted rows (sidecar unindexedImports). Ingest
 * deletes only the targeted ones, so discover's rows survive every ingest.
 * `opaque_consumer` is shared too: discover writes rows whose reason starts with
 * DISCOVER_REASON_PREFIX (`discover: unresolved entry point …`); ingest deletes only
 * the others.
 */
const INGEST_FLAGS = ['opaque_consumer', 'index_failed', 'dynamic_access', 'namespace_dynamic'] as const;
type IngestFlag = (typeof INGEST_FLAGS)[number] | 'unindexed_consumer';
const SIDECAR_FLAGS: ReadonlySet<string> = new Set(['namespace_dynamic', 'dynamic_access']);

/** Bare package name of a module specifier: `@scope/x/deep` -> `@scope/x`, `x/deep` -> `x`. */
export function barePackageName(module: string): string {
  const parts = module.split('/');
  return module.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
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
      });
    }
  }

  const counts: IngestCounts = {
    documents: 0, symbols: 0, occurrences: 0, edges: 0, exported: 0, unresolved: 0, flags: 0, unmatchedExports: 0,
    namespaceMemberRefs: 0, unmatchedNamespaceMemberRefs: 0, shorthandRefs: 0, unmatchedShorthandRefs: 0, exportAliases: 0,
    resolvedUnresolvedImports: 0,
    unmatchedEntrySymbols: 0, packageErrors: 0, skippedInvalidOccurrences: 0, warnings: 0,
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
    db.exec('DELETE FROM documents');
    db.exec('DELETE FROM entry_symbols');
    db.exec('DELETE FROM symbols');
    db.prepare(`DELETE FROM package_flags WHERE (flag IN (${INGEST_FLAGS.map((f) => `'${f}'`).join(', ')})
        AND NOT (flag = 'opaque_consumer' AND substr(coalesce(reason, ''), 1, ?) = ?))
      OR (flag = 'unindexed_consumer' AND target_package_id IS NOT NULL)`)
      .run(DISCOVER_REASON_PREFIX.length, DISCOVER_REASON_PREFIX);
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
      document: db.prepare('INSERT INTO documents (package_id, file, module_symbol_id, is_entry) VALUES (?, ?, ?, ?)'),
      occurrence: db.prepare(`INSERT INTO occurrences
        (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id, is_export_site)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      edge: db.prepare(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source)
        VALUES (?, ?, ?, ?, ?)`),
      unresolved: db.prepare(`INSERT INTO unresolved_refs (consumer_package_id, target_package_id, symbol_str, file, line, col)
        VALUES (?, ?, ?, ?, ?, ?)`),
      exported: db.prepare('UPDATE symbols SET is_exported = 1 WHERE symbol_id = ?'),
      exportAlias: db.prepare('INSERT OR IGNORE INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, ?, ?)'),
      entrySymbol: db.prepare('INSERT OR IGNORE INTO entry_symbols (symbol_id) VALUES (?)'),
    };
    const addFlag = (packageId: string, flag: IngestFlag, reason: string, file: string | null, target: string | null = null): void => {
      st.flag.run(packageId, flag, reason, file, target);
      counts.flags += 1;
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
        // Reason: the first `error:` diagnostic if any (diagnostics are prefixed
        // info:/warn:/error:), else the first `warn:`, else the first diagnostic; first
        // line only. (An `info: install skipped` line is never the reason if anything
        // worse was reported.)
        const diag = ip.diagnostics.find((d) => d.startsWith('error:'))
          ?? ip.diagnostics.find((d) => d.startsWith('warn:'))
          ?? ip.diagnostics[0];
        const firstDiag = (diag ?? '').split('\n')[0] || null;
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
        const { bad, skippedOccurrences } = checkSymbols(index.documents, validSymbols, skippedSymbols, (id) => pkgs.has(id));
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
    const symbolPackage = (p: ParsedGlobal): string | undefined => {
      const id = `${p.manager}:${p.name}`;
      return pkgs.has(id) ? id : undefined;
    };
    /** `${repo}\0${file}\0${line}\0${col}` of every definition occurrence -> symbol_id. */
    const defPositions = new Map<string, number>();

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
        const own = symbolPackage(p);
        if (round === 0 && own !== undefined && own !== w.packageId) {
          deferred.push({ w, o });
          continue;
        }
        const norm = normalizeSymbolVersion(o.symbol);
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
        if (row.packageId !== w.packageId) continue;
        defPositions.set(`${w.repo}\0${w.file}\0${start.line}\0${start.col}`, row.symbolId);
        const span = occurrenceEnclosingSpan(o);
        if (span && row.symbolId !== w.moduleSymbolId) w.spans.push({ symbolId: row.symbolId, span });
      }
    }

    // Documents (+ synthetic file symbols where the indexer emitted no module symbol).
    for (const w of docs) {
      if (w.moduleSymbolId === 0) {
        const norm = `sentei file ${w.packageId} ${w.file}`;
        const res = st.symbol.run(norm, w.packageId, w.file, 0, 0, 'file', w.file);
        w.moduleSymbolId = Number(res.lastInsertRowid);
        symbols.set(norm, { symbolId: w.moduleSymbolId, packageId: w.packageId });
        counts.symbols += 1;
      }
      const isEntry = pkgs.get(w.packageId)!.entryPoints.has(w.file) ? 1 : 0;
      st.document.run(w.packageId, w.file, w.moduleSymbolId, isEntry);
      counts.documents += 1;
    }

    // Parents: nearest enclosing non-namespace descriptor that is an org symbol of
    // the same package (Foo#bar(). -> Foo#). Files/namespaces are never parents:
    // a module is not a declaration that keeps its top-level functions alive.
    for (const [norm, row] of symbols) {
      if (norm.startsWith('sentei file ')) continue;
      const g = parseScipSymbol(norm);
      if (g.local) continue;
      const ds = parseDescriptors(g.descriptors);
      const head = norm.slice(0, norm.length - g.descriptors.length);
      for (let i = ds.length - 1; i >= 1; i -= 1) {
        if (ds[i - 1]!.suffix === 'namespace') break;
        const parent = symbols.get(head + ds.slice(0, i).map((d) => d.text).join(''));
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
        const norm = normalizeSymbolVersion(o.symbol);
        const row = symbols.get(norm) ?? undefinedRefOwner(norm, p, o.symbolRoles);
        if (!row) {
          const target = symbolPackage(p);
          if (target !== undefined && target !== w.packageId) {
            st.unresolved.run(w.packageId, target, norm, w.file, start.line, start.col);
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
          const target = pkgs.get(`npm:${r.targetPackage}`);
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
        edgeRun(st.edge, byId.get(w.moduleSymbolId)!, byId.get(id)!, 'scip');
        st.entrySymbol.run(id); // a seed on its own: the file need not be an entry
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
        let target: string | null = null;
        if (f.targetPackage !== undefined) {
          const t = `npm:${f.targetPackage}`;
          if (pkgs.has(t) && t !== packageId) target = t;
          else if (t !== packageId) warn(`${packageId}: ${f.flag} flag targets ${JSON.stringify(f.targetPackage)}, not an org package; kept untargeted`);
        }
        addFlag(packageId, f.flag, f.reason, f.file ?? null, target);
      }
      // Unindexed files importing an org package: we cannot see what they use, so the
      // target gets no verdict (blocked_packages); the consumer itself stays transparent.
      for (const u of data.unindexedImports ?? []) {
        const target = `npm:${barePackageName(u.module)}`;
        if (!pkgs.has(target) || target === packageId) {
          warn(`${packageId}: unindexed import of ${JSON.stringify(u.module)} at ${u.file}`
            + ` does not name another org package, ignored`);
          continue;
        }
        addFlag(packageId, 'unindexed_consumer', `unindexed file imports ${u.module}`, u.file, target);
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
          const target = `${manager}:${barePackageName(u.module)}`;
          if (!pkgs.has(target) || target === packageId) {
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
        const targets = (exportedByPkg.all(m[1]!) as Array<{ symbol_id: number; package_id: string; name: string }>)
          .filter((t) => m[2] === '*' || t.name === m[2]);
        if (targets.length === 0) {
          warn(`${label}: target matches no exported symbol, ignored`);
          continue;
        }
        for (const t of targets) edgeRun(st.edge, byId.get(fromId)!, { symbolId: t.symbol_id, packageId: t.package_id }, 'overlay');
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
    + (counts.packageErrors > 0 ? ` packageErrors=${counts.packageErrors}` : '')
    + (counts.skippedInvalidOccurrences > 0 ? ` skippedInvalidOccurrences=${counts.skippedInvalidOccurrences}` : ''));
  return counts;
}
