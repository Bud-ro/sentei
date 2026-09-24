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
  flags?: Array<{ flag: 'namespace_dynamic' | 'dynamic_access'; reason: string; file: string | null; line?: number; col?: number }>;
  /** Imports of names an org package does not export (version skew; optional). */
  unresolvedImports?: Array<{ module: string; name: string; file: string; line: number | null; col: number | null }>;
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
  warnings: number;
}

/** package_flags that ingest owns (and so deletes on every run). */
const INGEST_FLAGS = ['opaque_consumer', 'index_failed', 'dynamic_access', 'namespace_dynamic'] as const;
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
  repo: string;
  path: string; // '' for the repo root, else 'a/b'
  entryPoints: Set<string>;
}

interface DocWork {
  repo: string;
  packageId: string;
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
  for (const r of discover.repos) {
    for (const p of r.packages) {
      if (dbPkgs.get(p.packageId) !== r.repo) {
        throw new Error(`sentei: ingest: package ${p.packageId} (repo ${r.repo}) is not in the database; run discover first`);
      }
      pkgs.set(p.packageId, { packageId: p.packageId, repo: r.repo, path: normPkgPath(p.path), entryPoints: new Set(p.entryPoints) });
    }
  }

  const counts: IngestCounts = {
    documents: 0, symbols: 0, occurrences: 0, edges: 0, exported: 0, unresolved: 0, flags: 0, unmatchedExports: 0, warnings: 0,
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
    db.exec('DELETE FROM symbols');
    db.exec(`DELETE FROM package_flags WHERE flag IN (${INGEST_FLAGS.map((f) => `'${f}'`).join(', ')})`);

    const st = {
      flag: db.prepare('INSERT INTO package_flags (package_id, flag, reason, file) VALUES (?, ?, ?, ?)'),
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
    };
    const addFlag = (packageId: string, flag: (typeof INGEST_FLAGS)[number], reason: string, file: string | null): void => {
      st.flag.run(packageId, flag, reason, file);
      counts.flags += 1;
    };

    // ---- Load index.json / sidecars, map documents to packages ------------
    const docs: DocWork[] = [];
    const seenDocs = new Set<string>();
    /** `${repo}\0${file}\0${line}\0${col}` of export-clause identifiers (sidecar sites). */
    const exportSites = new Set<string>();
    const sidecars: Array<{ packageId: string; repo: string; data: ExportsSidecar }> = [];

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
        // info:/warn:/error:), else the first diagnostic; first line only.
        const diag = ip.diagnostics.find((d) => d.startsWith('error:')) ?? ip.diagnostics[0];
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

        const index = readScipIndex(resolveFile(ip.scip));
        for (const doc of index.documents) {
          const file = posix.normalize(posix.join(pkg.path || '.', doc.relativePath.replaceAll('\\', '/')));
          if (file.startsWith('../') || file === '..' || posix.isAbsolute(file)) continue; // outside the repo
          if (file.split('/').includes('node_modules')) continue;
          const owner = repoPkgs.find((p) => p.path === '' || file === p.path || file.startsWith(`${p.path}/`));
          if (!owner) continue; // not under any org package of this repo
          const key = `${owner.packageId}\0${file}`;
          if (seenDocs.has(key)) {
            warn(`${file} (${owner.packageId}) appears in more than one index; first occurrence kept`);
            continue;
          }
          seenDocs.add(key);
          docs.push({ repo: r.repo, packageId: owner.packageId, file, doc, moduleSymbolId: 0, spans: [] });
        }
      }
    }

    // ---- Pass 1: definitions ---------------------------------------------
    const symbols = new Map<string, SymRow>(); // normalized symbol_str -> row
    const parsedCache = new Map<string, ParsedGlobal | null>();
    const parse = (raw: string): ParsedGlobal | null => {
      let p = parsedCache.get(raw);
      if (p !== undefined) return p;
      p = null;
      if (raw !== '' && !raw.startsWith('local ')) {
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
            && p.descriptors.map((d) => d.name).join('/') === posix.normalize(w.doc.relativePath.replaceAll('\\', '/'));
          const kind = KIND_NAMES.get(symbolKinds(w).get(o.symbol) ?? 0) ?? '';
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

    for (const w of docs) {
      for (const o of w.doc.occurrences) {
        const p = parse(o.symbol);
        if (!interesting(p)) continue;
        const start = occurrenceStart(o);
        if (!start) continue;
        const norm = normalizeSymbolVersion(o.symbol);
        const row = symbols.get(norm);
        if (!row) {
          const target = symbolPackage(p);
          if (target !== undefined && target !== w.packageId) {
            st.unresolved.run(w.packageId, target, norm, w.file, start.line, start.col);
            counts.unresolved += 1;
          }
          continue;
        }
        const isDef = (o.symbolRoles & DEFINITION) !== 0;
        // Innermost definition in this document whose enclosing_range contains the start.
        let enclosing: { symbolId: number; span: Span } | undefined;
        for (const s of w.spans) {
          if (isDef && s.symbolId === row.symbolId) continue;
          if (!contains(s.span, start.line, start.col)) continue;
          if (!enclosing || startsAfter(s.span, enclosing.span)) enclosing = s;
        }
        const enclosingId = enclosing?.symbolId ?? w.moduleSymbolId;
        const isSite = exportSites.has(`${w.repo}\0${w.file}\0${start.line}\0${start.col}`) ? 1 : 0;
        st.occurrence.run(row.symbolId, w.packageId, row.packageId, w.file, start.line, start.col, o.symbolRoles, enclosingId, isSite);
        counts.occurrences += 1;
        if (!isDef && !isSite) edgeRun(st.edge, byId.get(enclosingId)!, row, 'scip');
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
      }
      for (const u of data.unresolved) {
        const reason = typeof u === 'string' ? u : (u.reason ?? JSON.stringify(u));
        const file = typeof u === 'string' ? null : (u.file ?? null);
        addFlag(packageId, 'dynamic_access', reason, file);
      }
      for (const f of data.flags ?? []) {
        if (!SIDECAR_FLAGS.has(f.flag)) throw new Error(`sentei: ${packageId} exports sidecar: unknown flag ${JSON.stringify(f.flag)}`);
        addFlag(packageId, f.flag, f.reason, f.file ?? null);
      }
      const manager = packageId.slice(0, packageId.indexOf(':'));
      for (const u of data.unresolvedImports ?? []) {
        const target = `${manager}:${barePackageName(u.module)}`;
        if (!pkgs.has(target) || target === packageId) {
          warn(`${packageId}: unresolved import ${JSON.stringify(u.name)} from ${JSON.stringify(u.module)} at ${u.file}`
            + ` does not name another org package, ignored`);
          continue;
        }
        st.unresolved.run(packageId, target, u.name, u.file, u.line ?? null, u.col ?? null);
        counts.unresolved += 1;
      }
    }
    counts.exported = exportedIds.size;
    counts.unmatchedExports = unmatched.length;
    if (unmatched.length > 0) warn(`${unmatched.length} sidecar export(s) match no SCIP definition: ${unmatched.join('; ')}`);

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
    + `exported=${counts.exported} unresolved=${counts.unresolved} flags=${counts.flags} unmatchedExports=${counts.unmatchedExports}`);
  return counts;
}
