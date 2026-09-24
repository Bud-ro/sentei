import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyzeOrg } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { ingestOrg, repoSlug, type ExportsSidecar, type IngestCounts, type IngestDiscoverInput, type RepoIndexFile } from '../src/ingest.ts';
import { IndexSchema, SymbolInformation_Kind } from '../src/scip/scip_pb.ts';
import { buildOrgSmallInputs, findScipTypescript, type OrgSmallInputs } from './helpers/orgSmallScip.ts';

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ['symbols', 'documents', 'occurrences', 'edges', 'unresolved_refs', 'package_flags', 'repos', 'packages', 'package_deps']) {
    out[t] = count(db, `SELECT count(*) AS n FROM ${t}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// End to end on fixtures/org-small with real scip-typescript output
// ---------------------------------------------------------------------------

const scipTs = findScipTypescript();
if (!scipTs) {
  // eslint-disable-next-line no-console
  console.warn('[ingest.test] @sourcegraph/scip-typescript not installed; skipping org-small ingest tests');
}

describe.skipIf(!scipTs)('ingestOrg on fixtures/org-small (scip-typescript)', () => {
  let inputs: OrgSmallInputs;
  let db: DatabaseSync;
  let counts: IngestCounts;
  const logs: string[] = [];

  beforeAll(() => {
    inputs = buildOrgSmallInputs(scipTs!); // .scip files generated once for this describe
    db = openDb(':memory:');
    inputs.seedDb(db);
    counts = ingestOrg({ db, workDir: inputs.workDir, discover: inputs.discover, log: (l) => logs.push(l) });
  }, 120_000);

  afterAll(() => {
    db?.close();
    inputs?.cleanup();
  });

  const sym = (name: string): { symbol_id: number; is_exported: number; package_id: string } => {
    const row = db.prepare("SELECT symbol_id, is_exported, package_id FROM symbols WHERE name = ? AND kind <> 'file'").get(name);
    if (!row) throw new Error(`no symbol ${name}`);
    return row as { symbol_id: number; is_exported: number; package_id: string };
  };
  const hasEdge = (from: string, to: string): boolean =>
    count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?', sym(from).symbol_id, sym(to).symbol_id) > 0;

  it('logs counts and no warnings (every sidecar export matched a definition)', () => {
    expect(counts.unmatchedExports).toBe(0);
    expect(counts.warnings).toBe(0);
    expect(logs.at(-1)).toMatch(/^\[ingest\] documents=4 symbols=\d+ occurrences=\d+ edges=\d+ exported=3 unresolved=0/);
    expect(counts.documents).toBe(4);
  });

  it('stores version-normalized symbol strings', () => {
    const row = db.prepare("SELECT symbol_str FROM symbols WHERE name = 'usedFn'").get() as { symbol_str: string };
    expect(row.symbol_str).toBe('scip-typescript npm @acme/core . src/`fns.ts`/usedFn().');
    expect(count(db, "SELECT count(*) AS n FROM symbols WHERE symbol_str LIKE '% 1.0.0 %'")).toBe(0);
  });

  it('marks exactly the package export surface as exported', () => {
    for (const n of ['usedFn', 'unusedFn', 'internalOnlyFn']) expect(sym(n).is_exported, n).toBe(1);
    for (const n of ['privateHelper', 'islandA', 'islandB', 'helperFn', 'main']) expect(sym(n).is_exported, n).toBe(0);
  });

  it('does not intern parameters or locals', () => {
    expect(count(db, "SELECT count(*) AS n FROM symbols WHERE symbol_str LIKE '%().(%' OR symbol_str LIKE 'local %'")).toBe(0);
  });

  it('records the cross-package reference to usedFn as external', () => {
    expect(count(db, `SELECT count(*) AS n FROM occurrences o JOIN symbols s USING (symbol_id)
      WHERE s.name = 'usedFn' AND o.package_id = 'npm:@acme/app' AND o.is_external = 1 AND o.file = 'src/main.ts'`)).toBe(2);
    expect(sym('usedFn').package_id).toBe('npm:@acme/core');
  });

  it('flags the index.ts re-export identifiers as export sites, and nothing else', () => {
    const rows = db.prepare(`SELECT s.name, o.file, o.line, o.col FROM occurrences o JOIN symbols s USING (symbol_id)
      WHERE o.is_export_site = 1 ORDER BY o.col`).all();
    expect(rows).toEqual([
      { name: 'usedFn', file: 'src/index.ts', line: 1, col: 9 },
      { name: 'unusedFn', file: 'src/index.ts', line: 1, col: 17 },
      { name: 'internalOnlyFn', file: 'src/index.ts', line: 1, col: 27 },
    ]);
  });

  it('builds reachability edges from enclosing declarations', () => {
    expect(hasEdge('usedFn', 'privateHelper')).toBe(true);
    expect(hasEdge('usedFn', 'helperFn')).toBe(true);
    expect(hasEdge('helperFn', 'internalOnlyFn')).toBe(true);
    expect(hasEdge('islandA', 'islandB')).toBe(true);
    expect(hasEdge('islandB', 'islandA')).toBe(true);
    expect(hasEdge('main', 'usedFn')).toBe(true);
  });

  it('has no edge into islandA except from islandB', () => {
    const from = db.prepare(`SELECT f.name FROM edges e JOIN symbols t ON t.symbol_id = e.to_symbol_id
      JOIN symbols f ON f.symbol_id = e.from_symbol_id WHERE t.name = 'islandA'`).all();
    expect(from).toEqual([{ name: 'islandB' }]);
  });

  it('has no edges from export sites (index.ts module reaches only the fns.ts module)', () => {
    const rows = db.prepare(`SELECT t.name FROM edges e JOIN symbols f ON f.symbol_id = e.from_symbol_id
      JOIN symbols t ON t.symbol_id = e.to_symbol_id WHERE f.kind = '' AND f.name = 'src/index.ts' AND f.package_id = 'npm:@acme/core'`).all();
    expect(rows).toEqual([{ name: 'src/fns.ts' }]);
  });

  it('writes one document per file with module symbols and entry flags', () => {
    const rows = db.prepare(`SELECT d.package_id, d.file, d.is_entry, s.name AS module FROM documents d
      JOIN symbols s ON s.symbol_id = d.module_symbol_id ORDER BY d.package_id, d.file`).all();
    expect(rows).toEqual([
      { package_id: 'npm:@acme/app', file: 'src/main.ts', is_entry: 1, module: 'src/main.ts' },
      { package_id: 'npm:@acme/core', file: 'src/fns.ts', is_entry: 0, module: 'src/fns.ts' },
      { package_id: 'npm:@acme/core', file: 'src/helper.ts', is_entry: 0, module: 'src/helper.ts' },
      { package_id: 'npm:@acme/core', file: 'src/index.ts', is_entry: 1, module: 'src/index.ts' },
    ]);
  });

  it('updates repo index status and passes foreign_key_check', () => {
    expect(db.prepare('SELECT repo, index_status FROM repos ORDER BY repo').all()).toEqual([
      { repo: 'acme/app', index_status: 'ok' },
      { repo: 'acme/lib-core', index_status: 'ok' },
    ]);
    expect(count(db, 'SELECT count(*) AS n FROM repos WHERE indexed_at IS NULL')).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(count(db, 'SELECT count(*) AS n FROM package_flags')).toBe(0);
  });

  it('is idempotent', () => {
    const before = tableCounts(db);
    const again = ingestOrg({ db, workDir: inputs.workDir, discover: inputs.discover, log: () => {} });
    expect(tableCounts(db)).toEqual(before);
    expect(again).toEqual(counts);
  });
});

// ---------------------------------------------------------------------------
// Synthetic SCIP: behaviours the fixture does not exercise yet
// ---------------------------------------------------------------------------

interface OccSpec { range: number[]; symbol: string; roles?: number; enclosing?: number[] }
interface DocSpec { path: string; occurrences: OccSpec[]; symbols?: Array<{ symbol: string; kind: SymbolInformation_Kind }> }

const LIB = 'scip-typescript npm @acme/lib 2.0.0 ';
const LIB_OLD = 'scip-typescript npm @acme/lib 1.0.0 ';
const APP = 'scip-typescript npm @acme/app 1.0.0 ';

describe('ingestOrg (synthetic SCIP)', () => {
  let root: string;
  let workDir: string;
  let db: DatabaseSync;
  let logs: string[];

  function writeScip(repo: string, file: string, docs: DocSpec[]): void {
    const dir = join(workDir, 'index', repoSlug(repo));
    mkdirSync(dir, { recursive: true });
    const idx = create(IndexSchema, {
      documents: docs.map((d) => ({
        relativePath: d.path,
        occurrences: d.occurrences.map((o) => ({ range: o.range, symbol: o.symbol, symbolRoles: o.roles ?? 0, enclosingRange: o.enclosing ?? [] })),
        symbols: (d.symbols ?? []).map((x) => ({ symbol: x.symbol, kind: x.kind })),
      })),
    });
    writeFileSync(join(dir, file), toBinary(IndexSchema, idx));
  }
  function writeJson(repo: string, file: string, data: unknown): void {
    const dir = join(workDir, 'index', repoSlug(repo));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), JSON.stringify(data));
  }
  function indexJson(repo: string, pkgs: Array<Partial<RepoIndexFile['packages'][number]> & { packageId: string }>, status: RepoIndexFile['status'] = 'ok'): void {
    writeJson(repo, 'index.json', {
      repo, headSha: 'abc', status,
      packages: pkgs.map((p) => ({ indexer: 'scip-typescript', indexerVersion: '0.4.0', status: 'ok', scip: null, exports: null, diagnostics: [], ...p })),
    } satisfies RepoIndexFile);
  }
  function sidecar(packageId: string, exports: ExportsSidecar['exports'] = [], unresolved: ExportsSidecar['unresolved'] = []): ExportsSidecar {
    return { packageId, entryPoints: [], exports, unresolved };
  }
  const exp = (name: string, file: string, line: number, col: number, sites: Array<{ file: string; line: number; col: number }> = []) =>
    ({ entry: 'src/index.ts', exportedAs: name, name, file, line, col, sites });

  /** Monorepo acme/mono: root package @acme/lib at '.', nested @acme/app at 'apps/app'. */
  function discover(extraEdges: Array<{ from: string; to: string }> = []): IngestDiscoverInput {
    return {
      repos: [{
        repo: 'acme/mono',
        config: { extraEdges },
        packages: [
          { packageId: 'npm:@acme/lib', path: '.', entryPoints: ['src/index.ts'] },
          { packageId: 'npm:@acme/app', path: 'apps/app', entryPoints: ['apps/app/src/main.ts'] },
        ],
      }],
    };
  }
  function run(d = discover()): IngestCounts {
    return ingestOrg({ db, workDir, discover: d, log: (l) => logs.push(l) });
  }
  const id = (str: string): number => (db.prepare('SELECT symbol_id AS n FROM symbols WHERE symbol_str = ?').get(str) as { n: number } | undefined)?.n ?? -1;

  beforeEach(() => {
    root = mkdtempSync(join(process.env['TMPDIR'] ?? '.', 'sentei-ingest-syn-'));
    workDir = join(root, 'work');
    logs = [];
    db = openDb(':memory:');
    db.prepare("INSERT INTO repos (repo) VALUES ('acme/mono')").run();
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:@acme/lib', 'acme/mono', '.', 'npm', '@acme/lib', 'private')").run();
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:@acme/app', 'acme/mono', 'apps/app', 'npm', '@acme/app', 'private')").run();

    // Root index (run at '.') also sees apps/app files and a node_modules / out-of-repo doc.
    writeScip('acme/mono', 'lib.scip', [
      {
        path: 'src/a.ts',
        occurrences: [
          { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
          { range: [1, 13, 16], symbol: `${LIB}src/\`a.ts\`/Foo#`, roles: 1, enclosing: [1, 0, 6, 1] },
          { range: [2, 2, 5], symbol: `${LIB}src/\`a.ts\`/Foo#bar().`, roles: 1, enclosing: [2, 2, 4, 3] },
          { range: [3, 4, 10], symbol: `${LIB}src/\`a.ts\`/helper().` }, // inside bar -> edge bar -> helper
          { range: [3, 11, 12], symbol: 'local 0' },
          { range: [5, 2, 5], symbol: `${LIB}src/\`a.ts\`/Foo#baz.`, roles: 1 }, // no enclosing range
          { range: [8, 9, 15], symbol: `${LIB}src/\`a.ts\`/helper().`, roles: 1, enclosing: [8, 0, 8, 30] },
          { range: [8, 16, 17], symbol: `${LIB}src/\`a.ts\`/helper().(x)`, roles: 1 },
          { range: [9, 0, 6], symbol: `${LIB}src/\`a.ts\`/helper().` }, // top level -> edge module -> helper
          { range: [9, 7, 10], symbol: 'scip-typescript npm typescript 5.9.3 lib/`lib.es5.d.ts`/Array#' },
        ],
      },
      { path: 'node_modules/x/index.ts', occurrences: [{ range: [0, 0, 0], symbol: `${LIB}node_modules/x/\`index.ts\`/nm().`, roles: 1 }] },
      { path: '../outside.ts', occurrences: [{ range: [0, 0, 0], symbol: `${LIB}\`outside.ts\`/out().`, roles: 1 }] },
    ]);
    // App index, run in apps/app. Pinned to @acme/lib 1.0.0: usedFn links, goneFn is unresolved.
    // No module symbol emitted -> synthetic file symbol.
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [
        { range: [0, 9, 12], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#` },
        { range: [1, 0, 6], symbol: `${LIB_OLD}src/\`a.ts\`/goneFn().` },
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 4, 1] },
        { range: [3, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#bar().` },
        { range: [3, 6, 9], symbol: `${APP}src/\`main.ts\`/ghost().` }, // same-package unknown: ignored
      ],
    }]);
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [
      exp('Foo', 'src/a.ts', 1, 13),
      exp('helper', 'src/a.ts', 8, 9, [{ file: 'src/a.ts', line: 9, col: 0 }]),
    ]));
    writeJson('acme/mono', 'app.exports.json', sidecar('npm:@acme/app'));
    indexJson('acme/mono', [
      { packageId: 'npm:@acme/lib', scip: 'lib.scip', exports: 'lib.exports.json' },
      { packageId: 'npm:@acme/app', scip: 'app.scip', exports: 'app.exports.json' },
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('maps documents by longest package path prefix and skips node_modules / out-of-repo files', () => {
    const c = run();
    expect(db.prepare('SELECT package_id, file, is_entry FROM documents ORDER BY file').all()).toEqual([
      { package_id: 'npm:@acme/app', file: 'apps/app/src/main.ts', is_entry: 1 },
      { package_id: 'npm:@acme/lib', file: 'src/a.ts', is_entry: 0 },
    ]);
    expect(c.documents).toBe(2);
    expect(count(db, "SELECT count(*) AS n FROM symbols WHERE name IN ('nm', 'out')")).toBe(0);
  });

  it('creates a synthetic file symbol when the indexer emits no module symbol', () => {
    run();
    const row = db.prepare("SELECT s.symbol_str, s.kind, s.name, s.line, s.col FROM documents d JOIN symbols s ON s.symbol_id = d.module_symbol_id WHERE d.package_id = 'npm:@acme/app'").get();
    expect(row).toEqual({ symbol_str: 'sentei file npm:@acme/app apps/app/src/main.ts', kind: 'file', name: 'apps/app/src/main.ts', line: 0, col: 0 });
  });

  it('links a consumer pinned to another version, and records unknown org symbols as unresolved_refs', () => {
    run();
    expect(count(db, `SELECT count(*) AS n FROM occurrences WHERE symbol_id = ? AND package_id = 'npm:@acme/app' AND is_external = 1`,
      id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#bar().`))).toBe(1);
    expect(db.prepare('SELECT consumer_package_id, target_package_id, symbol_str, file, line, col FROM unresolved_refs').all()).toEqual([
      { consumer_package_id: 'npm:@acme/app', target_package_id: 'npm:@acme/lib', symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/goneFn().', file: 'apps/app/src/main.ts', line: 1, col: 0 },
    ]);
  });

  it('records a reference to an undefined `<constructor>` against its defined owner, not as unresolved', () => {
    // scip-dart names an implicit constructor call `Shown()` as Shown#`<constructor>`().,
    // a symbol no index defines. Any other missing member stays version skew.
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 6, 1] },
        { range: [3, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#\`<constructor>\`().` },
        { range: [4, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#gone().` },
        { range: [5, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Nope#\`<constructor>\`().` }, // owner undefined too
      ],
    }]);
    run();
    const foo = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#`);
    const main = id(`scip-typescript npm @acme/app . src/\`main.ts\`/main().`);
    expect(db.prepare(`SELECT symbol_id, file, line, col, role, enclosing_symbol_id, is_external FROM occurrences
      WHERE package_id = 'npm:@acme/app' AND (role & 1) = 0`).all()).toEqual([
      { symbol_id: foo, file: 'apps/app/src/main.ts', line: 3, col: 2, role: 0, enclosing_symbol_id: main, is_external: 1 },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM symbols WHERE name = '<constructor>'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ? AND source = 'scip'", main, foo)).toBe(1);
    expect((db.prepare('SELECT symbol_str, line FROM unresolved_refs ORDER BY line').all() as Array<{ symbol_str: string; line: number }>)).toEqual([
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Foo#gone().', line: 4 },
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Nope#`<constructor>`().', line: 5 },
    ]);
  });

  it('attributes any undefined ref through an anonymous descriptor to the nearest defined ancestor; other missing members stay unresolved', () => {
    // The typeLiteral / property counters depend on the program that indexed the file, so
    // the consumer's `Foo#typeLiteral9:foo.` never matches the library's name; contextual
    // type chains (`ErrorBoundary.FC:PropsWithChildren:typeLiteral5:fallback.`) name
    // descriptors the library index never defines.
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 12, 1] },
        { range: [3, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#typeLiteral9:foo.` },
        { range: [4, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#bar().typeLiteral1:x.typeLiteral2:y.` },
        { range: [5, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#gone().` }, // real skew
        { range: [6, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#gone.typeLiteral1:x.` }, // through an anonymous descriptor
        { range: [7, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#\`<constructor>\`().typeLiteral0:opt.` },
        { range: [8, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/ErrorBoundary.FC:PropsWithChildren:typeLiteral5:fallback.` },
        { range: [9, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Gone.FC:typeLiteral5:x.` }, // top-level Gone missing: skew
        { range: [10, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#\`<constructor>\`().gone.` }, // below a ctor, named: skew
      ],
    }]);
    writeScip('acme/mono', 'lib.scip', [{
      path: 'src/a.ts',
      occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 13, 16], symbol: `${LIB}src/\`a.ts\`/Foo#`, roles: 1, enclosing: [1, 0, 6, 1] },
        { range: [2, 2, 5], symbol: `${LIB}src/\`a.ts\`/Foo#bar().`, roles: 1, enclosing: [2, 2, 4, 3] },
        { range: [8, 6, 19], symbol: `${LIB}src/\`a.ts\`/ErrorBoundary.`, roles: 1 },
      ],
    }]);
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [exp('Foo', 'src/a.ts', 1, 13)]));
    run();
    const foo = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#`);
    const bar = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#bar().`);
    const eb = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/ErrorBoundary.`);
    expect(eb).toBeGreaterThan(0);
    expect(db.prepare(`SELECT symbol_id, line FROM occurrences WHERE package_id = 'npm:@acme/app' AND (role & 1) = 0 ORDER BY line`).all())
      .toEqual([
        { symbol_id: foo, line: 3 }, { symbol_id: bar, line: 4 }, { symbol_id: foo, line: 6 }, { symbol_id: foo, line: 7 },
        { symbol_id: eb, line: 8 },
      ]);
    expect(db.prepare('SELECT symbol_str FROM unresolved_refs ORDER BY line').all()).toEqual([
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Foo#gone().' },
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Gone.FC:typeLiteral5:x.' },
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Foo#`<constructor>`().gone.' },
    ]);
  });

  it("marks scip-typescript's counter-suffixed anonymous literal members as kind anonymous-member", () => {
    writeScip('acme/mono', 'lib.scip', [{
      path: 'src/a.ts',
      occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 6, 9], symbol: `${LIB}src/\`a.ts\`/pms.`, roles: 1, enclosing: [1, 0, 1, 20] },
        { range: [2, 2, 5], symbol: `${LIB}src/\`a.ts\`/npm0:`, roles: 1 }, // initializer not covered by pms's range
        { range: [3, 2, 5], symbol: `${LIB}src/\`a.ts\`/Props#typeLiteral3:__html.`, roles: 1 },
        { range: [4, 2, 5], symbol: `${LIB}src/\`a.ts\`/Props#`, roles: 1 },
      ],
    }]);
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib'));
    run();
    expect(db.prepare("SELECT name, kind FROM symbols WHERE package_id = 'npm:@acme/lib' ORDER BY name").all()).toEqual([
      { name: 'Props', kind: '' },
      { name: '__html', kind: 'anonymous-member' },
      { name: 'npm0', kind: 'anonymous-member' },
      { name: 'pms', kind: '' },
      { name: 'src/a.ts', kind: '' },
    ]);
  });

  it('resolves parents, adds owner -> member edges, and never makes a file a parent', () => {
    run();
    const foo = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#`);
    const bar = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#bar().`);
    const baz = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#baz.`);
    const helper = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/helper().`);
    const parents = db.prepare('SELECT symbol_id, parent_symbol_id FROM symbols WHERE parent_symbol_id IS NOT NULL ORDER BY symbol_id').all();
    expect(parents).toEqual([{ symbol_id: bar, parent_symbol_id: foo }, { symbol_id: baz, parent_symbol_id: foo }]);
    expect(count(db, "SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id IN (?, ?) AND source = 'scip'", foo, bar, baz)).toBe(2);
    // Innermost enclosing declaration: bar (not Foo) encloses the helper() call.
    expect(count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?', bar, helper)).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?', foo, helper)).toBe(0);
  });

  it('marks sidecar exports, and export-site occurrences make no edges', () => {
    run();
    expect(db.prepare('SELECT name FROM symbols WHERE is_exported = 1 ORDER BY name').all()).toEqual([{ name: 'Foo' }, { name: 'helper' }]);
    const helper = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/helper().`);
    expect(db.prepare('SELECT line, is_export_site FROM occurrences WHERE symbol_id = ? AND role = 0 ORDER BY line').all(helper)).toEqual([
      { line: 3, is_export_site: 0 },
      { line: 9, is_export_site: 1 },
    ]);
    // The line-9 reference is at top level of a.ts; being an export site, it makes no module -> helper edge.
    const mod = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/`);
    expect(count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?', mod, helper)).toBe(0);
  });

  it('adds a top-level reference edge from the module symbol when it is not an export site', () => {
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [exp('helper', 'src/a.ts', 8, 9)]));
    run();
    const mod = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/`);
    const helper = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/helper().`);
    expect(count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?', mod, helper)).toBe(1);
  });

  it('models an anonymous default export (no SCIP symbol) as a synthetic `default` kept alive by imports of its file', () => {
    const ANON = `${LIB}src/\`anon.ts\`/`;
    const UNUSED = `${LIB}src/\`unused.ts\`/`;
    writeScip('acme/mono', 'lib.scip', [
      { path: 'src/anon.ts', occurrences: [
        { range: [0, 0, 0], symbol: ANON, roles: 1, enclosing: [0, 0, 3, 0] },
        { range: [2, 20, 26], symbol: `${LIB}src/\`anon.ts\`/helper().` }, // unknown same-package: ignored
      ] },
      { path: 'src/unused.ts', occurrences: [{ range: [0, 0, 0], symbol: UNUSED, roles: 1 }] },
    ]);
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [{ range: [0, 17, 35], symbol: `${LIB_OLD}src/\`anon.ts\`/` }],
    }]);
    const anonExp = (file: string) => ({ ...exp('default', file, 2, 7), note: 'default-keyword' });
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [anonExp('src/anon.ts'), anonExp('src/anon.ts'), anonExp('src/unused.ts')]));
    const c = run();
    expect(c.unmatchedExports).toBe(0);
    const rows = db.prepare(`SELECT s.symbol_str, s.name, s.line, s.col, s.is_exported,
        (SELECT count(*) FROM occurrences o WHERE o.symbol_id = s.symbol_id AND o.is_external = 1) AS ext
      FROM symbols s WHERE s.name = 'default' ORDER BY s.file`).all();
    expect(rows).toEqual([
      { symbol_str: 'sentei default npm:@acme/lib src/anon.ts', name: 'default', line: 2, col: 7, is_exported: 1, ext: 1 },
      { symbol_str: 'sentei default npm:@acme/lib src/unused.ts', name: 'default', line: 2, col: 7, is_exported: 1, ext: 0 },
    ]);
    const anonDefault = id('sentei default npm:@acme/lib src/anon.ts');
    const appModule = id('sentei file npm:@acme/app apps/app/src/main.ts');
    expect(count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?', appModule, anonDefault)).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ?',
      anonDefault, id('scip-typescript npm @acme/lib . src/`anon.ts`/'))).toBe(1);
  });

  it('adds namespace member refs SCIP missed, never duplicates ones it has, and warns on unknown targets', () => {
    const ref = (line: number, col: number, member: string, targetLine: number, targetCol: number, targetPackage = '@acme/lib') =>
      ({ file: 'apps/app/src/main.ts', line, col, member, targetPackage, targetFile: 'src/a.ts', targetLine, targetCol });
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      namespaceMemberRefs: [
        ref(3, 10, 'helper', 8, 9), //       SCIP emitted `local N` here: inside main() -> edge main -> helper
        ref(3, 2, 'bar', 2, 2), //           SCIP already resolved Foo#bar() at this position
        ref(3, 20, 'gone', 40, 0), //        no definition at the target position
        ref(3, 30, 'pad', 0, 0, 'left-pad'), // not an org package
      ],
    });
    const c = run();
    const helper = id('scip-typescript npm @acme/lib . src/`a.ts`/helper().');
    const bar = id('scip-typescript npm @acme/lib . src/`a.ts`/Foo#bar().');
    const main = id('scip-typescript npm @acme/app . src/`main.ts`/main().');
    expect(db.prepare(`SELECT package_id, def_package_id, file, line, col, role, enclosing_symbol_id, is_export_site, is_external
      FROM occurrences WHERE symbol_id = ? AND package_id = 'npm:@acme/app'`).all(helper)).toEqual([
      { package_id: 'npm:@acme/app', def_package_id: 'npm:@acme/lib', file: 'apps/app/src/main.ts', line: 3, col: 10, role: 0,
        enclosing_symbol_id: main, is_export_site: 0, is_external: 1 },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ? AND source = 'scip'", main, helper)).toBe(1);
    expect(count(db, "SELECT count(*) AS n FROM occurrences WHERE symbol_id = ? AND package_id = 'npm:@acme/app'", bar)).toBe(1);
    expect(c.namespaceMemberRefs).toBe(1);
    expect(c.unmatchedNamespaceMemberRefs).toBe(1);
    expect(c.warnings).toBe(2);
    expect(logs.some((l) => /warning: 1 namespace member ref\(s\) match no SCIP definition: .*gone/.test(l))).toBe(true);
    expect(logs.some((l) => /namespace member ref .*pad .*not an org package/.test(l))).toBe(true);
    // Idempotent.
    const before = tableCounts(db);
    expect(run().namespaceMemberRefs).toBe(1);
    expect(tableCounts(db)).toEqual(before);
  });

  it('adds shorthand refs like namespace member refs (same package or cross-package), counted separately', () => {
    const ref = (file: string, line: number, col: number, member: string, targetLine: number, targetCol: number, targetPackage = '@acme/lib') =>
      ({ file, line, col, member, targetPackage, targetFile: 'src/a.ts', targetLine, targetCol });
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      shorthandRefs: [ref('apps/app/src/main.ts', 3, 10, 'helper', 8, 9), ref('apps/app/src/main.ts', 3, 20, 'gone', 40, 0)],
    });
    writeJson('acme/mono', 'lib.exports.json', {
      ...sidecar('npm:@acme/lib', [exp('Foo', 'src/a.ts', 1, 13)]),
      // `{ helper }` inside Foo#bar(): a same-package use of helper.
      shorthandRefs: [ref('src/a.ts', 3, 20, 'helper', 8, 9)],
    });
    const c = run();
    const helper = id('scip-typescript npm @acme/lib . src/`a.ts`/helper().');
    const bar = id('scip-typescript npm @acme/lib . src/`a.ts`/Foo#bar().');
    const main = id('scip-typescript npm @acme/app . src/`main.ts`/main().');
    expect(db.prepare('SELECT package_id, line, col, enclosing_symbol_id, is_external FROM occurrences WHERE symbol_id = ? AND role = 0 AND col IN (10, 20) ORDER BY package_id')
      .all(helper)).toEqual([
      { package_id: 'npm:@acme/app', line: 3, col: 10, enclosing_symbol_id: main, is_external: 1 },
      { package_id: 'npm:@acme/lib', line: 3, col: 20, enclosing_symbol_id: bar, is_external: 0 },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ? AND source = 'scip'", main, helper)).toBe(1);
    expect(c.shorthandRefs).toBe(2);
    expect(c.namespaceMemberRefs).toBe(0);
    expect(c.unmatchedShorthandRefs).toBe(1);
    expect(logs.some((l) => /warning: 1 shorthand ref\(s\) match no SCIP definition: .*gone/.test(l))).toBe(true);
  });

  it('records every export alias in symbol_exports (entry, exported name), including anonymous defaults', () => {
    writeScip('acme/mono', 'lib.scip', [
      { path: 'src/a.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 13, 16], symbol: `${LIB}src/\`a.ts\`/Foo#`, roles: 1 },
      ] },
      { path: 'src/anon.ts', occurrences: [{ range: [0, 0, 0], symbol: `${LIB}src/\`anon.ts\`/`, roles: 1 }] },
    ]);
    const e = (entry: string, exportedAs: string, name: string, file: string, line: number, col: number, note?: string) =>
      ({ entry, exportedAs, name, file, line, col, sites: [], ...(note ? { note } : {}) });
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [
      e('src/index.ts', 'Foo', 'Foo', 'src/a.ts', 1, 13),
      e('src/index.ts', 'Bar', 'Foo', 'src/a.ts', 1, 13), // export { Foo as Bar }
      e('src/index.ts', 'Bar', 'Foo', 'src/a.ts', 1, 13), // duplicate record
      e('src/other.ts', 'default', 'Foo', 'src/a.ts', 1, 13), // export default Foo
      e('src/anon.ts', 'default', 'default', 'src/anon.ts', 2, 7, 'default-keyword'),
      e('src/index.ts', 'nope', 'nope', 'src/a.ts', 40, 0), // unmatched: no row
    ]));
    const c = run();
    expect(db.prepare(`SELECT s.name, x.entry_file, x.exported_as FROM symbol_exports x JOIN symbols s USING (symbol_id)
      ORDER BY s.name, x.entry_file, x.exported_as`).all()).toEqual([
      { name: 'Foo', entry_file: 'src/index.ts', exported_as: 'Bar' },
      { name: 'Foo', entry_file: 'src/index.ts', exported_as: 'Foo' },
      { name: 'Foo', entry_file: 'src/other.ts', exported_as: 'default' },
      { name: 'default', entry_file: 'src/anon.ts', exported_as: 'default' },
    ]);
    expect(c.exportAliases).toBe(4);
    expect(c.unmatchedExports).toBe(1);
    // Rebuilt on every run (cascade from symbols).
    run();
    expect(count(db, 'SELECT count(*) AS n FROM symbol_exports')).toBe(4);
  });

  it('warns about sidecar exports that match no definition', () => {
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [exp('Foo', 'src/a.ts', 1, 13), exp('nope', 'src/a.ts', 40, 0)]));
    const c = run();
    expect(c.unmatchedExports).toBe(1);
    expect(logs.some((l) => /warning: 1 sidecar export\(s\) match no SCIP definition: npm:@acme\/lib nope/.test(l))).toBe(true);
  });

  it('flags dynamic_access from sidecar unresolved entries', () => {
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [], [{ file: 'src/index.ts', reason: "export * from 'missing'" }, 'plain reason']));
    run();
    expect(db.prepare('SELECT package_id, flag, reason, file FROM package_flags ORDER BY reason').all()).toEqual([
      { package_id: 'npm:@acme/lib', flag: 'dynamic_access', reason: "export * from 'missing'", file: 'src/index.ts' },
      { package_id: 'npm:@acme/lib', flag: 'dynamic_access', reason: 'plain reason', file: null },
    ]);
  });

  it('records sidecar flags for the sidecar package', () => {
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      flags: [
        { flag: 'namespace_dynamic', reason: 'X[key] on @acme/lib namespace', file: 'apps/app/src/main.ts', line: 3, col: 2 },
        { flag: 'dynamic_access', reason: "require('@acme/' + name)", file: 'apps/app/src/main.ts', line: 4, col: 0 },
      ],
    });
    run();
    expect(db.prepare('SELECT package_id, flag, reason, file FROM package_flags ORDER BY flag').all()).toEqual([
      { package_id: 'npm:@acme/app', flag: 'dynamic_access', reason: "require('@acme/' + name)", file: 'apps/app/src/main.ts' },
      { package_id: 'npm:@acme/app', flag: 'namespace_dynamic', reason: 'X[key] on @acme/lib namespace', file: 'apps/app/src/main.ts' },
    ]);
    // Idempotent: ingest owns these flags and replaces them.
    run();
    expect(count(db, 'SELECT count(*) AS n FROM package_flags')).toBe(2);
  });

  it('targets a sidecar flag at another org package when targetPackage names one, else leaves it untargeted', () => {
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      flags: [
        { flag: 'namespace_dynamic', reason: 'X[key] on @acme/lib', file: 'apps/app/src/main.ts', line: 3, col: 2, targetPackage: '@acme/lib' },
        { flag: 'namespace_dynamic', reason: 'X[key] on @acme/app', file: 'apps/app/src/main.ts', line: 4, col: 2, targetPackage: '@acme/app' },
        { flag: 'namespace_dynamic', reason: 'X[key] on left-pad', file: 'apps/app/src/main.ts', line: 5, col: 2, targetPackage: 'left-pad' },
        { flag: 'dynamic_access', reason: "require('@acme/' + name)", file: 'apps/app/src/main.ts', line: 6, col: 0 },
      ],
    });
    const c = run();
    expect(db.prepare('SELECT flag, reason, target_package_id FROM package_flags ORDER BY reason').all()).toEqual([
      { flag: 'namespace_dynamic', reason: 'X[key] on @acme/app', target_package_id: null },
      { flag: 'namespace_dynamic', reason: 'X[key] on @acme/lib', target_package_id: 'npm:@acme/lib' },
      { flag: 'namespace_dynamic', reason: 'X[key] on left-pad', target_package_id: null },
      { flag: 'dynamic_access', reason: "require('@acme/' + name)", target_package_id: null },
    ]);
    expect(logs.some((l) => /namespace_dynamic flag targets "left-pad", not an org package; kept untargeted/.test(l))).toBe(true);
    expect(c.warnings).toBe(1);
  });

  it('rejects an unknown sidecar flag', () => {
    writeJson('acme/mono', 'app.exports.json', { ...sidecar('npm:@acme/app'), flags: [{ flag: 'looks_fine', reason: 'x', file: null }] });
    expect(() => run()).toThrow(/unknown flag "looks_fine"/);
  });

  it('records sidecar unresolvedImports into org packages as unresolved_refs, warning on the rest', () => {
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      unresolvedImports: [
        { module: '@acme/lib/deep/path', name: 'removedFn', file: 'apps/app/src/main.ts', line: 0, col: 9 },
        { module: 'left-pad', name: 'pad', file: 'apps/app/src/main.ts', line: 1, col: 9 },
        { module: '@acme/app', name: 'self', file: 'apps/app/src/main.ts', line: 2, col: 9 },
      ],
    });
    const c = run();
    expect(db.prepare("SELECT target_package_id, symbol_str, file, line, col FROM unresolved_refs WHERE symbol_str = 'removedFn'").all()).toEqual([
      { target_package_id: 'npm:@acme/lib', symbol_str: 'removedFn', file: 'apps/app/src/main.ts', line: 0, col: 9 },
    ]);
    expect(c.unresolved).toBe(2); // + goneFn from the SCIP index
    expect(c.warnings).toBe(2);
  });

  it('an unresolved import of a name the target exports at HEAD is a use (occurrence + edge), not skew', () => {
    // c12 (nodenext) cannot follow pathe's extensionless `export * from "./_path"`, so its
    // checker reports `resolve` as not exported although pathe exports it at HEAD.
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [
      exp('Foo', 'src/a.ts', 1, 13),
      { ...exp('helper', 'src/a.ts', 8, 9), exportedAs: 'aliasedHelper' }, // export { helper as aliasedHelper }
    ]));
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      unresolvedImports: [
        { module: '@acme/lib', name: 'Foo', file: 'apps/app/src/main.ts', line: 10, col: 9 }, //          exported name
        { module: '@acme/lib/sub', name: 'aliasedHelper', file: 'apps/app/src/main.ts', line: 11, col: 9 }, // alias
        { module: '@acme/lib', name: 'removedFn', file: 'apps/app/src/main.ts', line: 12, col: 9 }, //   real skew
        { module: '@acme/lib', name: 'Foo', file: 'apps/app/src/unindexed.ts', line: 0, col: 9 }, //   no document
      ],
    });
    const c = run();
    const foo = id('scip-typescript npm @acme/lib . src/`a.ts`/Foo#');
    const helper = id('scip-typescript npm @acme/lib . src/`a.ts`/helper().');
    const appModule = id('sentei file npm:@acme/app apps/app/src/main.ts');
    expect(db.prepare(`SELECT symbol_id, line, col, role, enclosing_symbol_id, is_external FROM occurrences
      WHERE package_id = 'npm:@acme/app' AND symbol_id IN (?, ?) AND line >= 10 ORDER BY line`).all(foo, helper)).toEqual([
      { symbol_id: foo, line: 10, col: 9, role: 0, enclosing_symbol_id: appModule, is_external: 1 },
      { symbol_id: helper, line: 11, col: 9, role: 0, enclosing_symbol_id: appModule, is_external: 1 },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ? AND source = 'scip'", appModule, helper)).toBe(1);
    expect(db.prepare("SELECT symbol_str, file FROM unresolved_refs WHERE symbol_str NOT LIKE 'scip-typescript %' ORDER BY symbol_str").all()).toEqual([
      { symbol_str: 'Foo', file: 'apps/app/src/unindexed.ts' },
      { symbol_str: 'removedFn', file: 'apps/app/src/main.ts' },
    ]);
    expect(c.resolvedUnresolvedImports).toBe(2);
    expect(c.unresolved).toBe(3); // + goneFn from the SCIP index
    expect(logs.at(-1)).toMatch(/ resolvedUnresolvedImports=2/);
  });

  it('keeps discover\'s opaque_consumer rows (reason prefix "discover: ") and rebuilds its own', () => {
    db.prepare(`INSERT INTO package_flags (package_id, flag, reason, file) VALUES
      ('npm:@acme/lib', 'opaque_consumer', 'discover: unresolved entry point ./dist/vue.mjs', 'package.json'),
      ('npm:@acme/lib', 'opaque_consumer', 'stale from an earlier ingest', NULL)`).run();
    run();
    expect(db.prepare('SELECT package_id, flag, reason FROM package_flags').all()).toEqual([
      { package_id: 'npm:@acme/lib', flag: 'opaque_consumer', reason: 'discover: unresolved entry point ./dist/vue.mjs' },
    ]);
  });

  it('flags partial / failed / missing packages and records repo status', () => {
    indexJson('acme/mono', [
      { packageId: 'npm:@acme/lib', status: 'partial', scip: 'lib.scip', exports: 'lib.exports.json', diagnostics: ['info: no lockfile', 'error: TS2307: nope\nmore', 'error: second'] },
      { packageId: 'npm:@acme/app', status: 'failed', diagnostics: ['tsc crashed'] },
    ], 'partial');
    run();
    expect(db.prepare('SELECT package_id, flag, reason FROM package_flags ORDER BY package_id').all()).toEqual([
      { package_id: 'npm:@acme/app', flag: 'index_failed', reason: 'tsc crashed' },
      { package_id: 'npm:@acme/lib', flag: 'opaque_consumer', reason: 'error: TS2307: nope' },
    ]);
    expect(db.prepare('SELECT index_status FROM repos').get()).toEqual({ index_status: 'partial' });
    expect(count(db, "SELECT count(*) AS n FROM documents WHERE package_id = 'npm:@acme/app'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM documents WHERE package_id = 'npm:@acme/lib'")).toBe(1);
  });

  it('flags every package index_failed when the repo has no index.json', () => {
    rmSync(join(workDir, 'index', 'acme__mono', 'index.json'));
    run();
    expect(db.prepare('SELECT package_id, flag FROM package_flags ORDER BY package_id').all()).toEqual([
      { package_id: 'npm:@acme/app', flag: 'index_failed' },
      { package_id: 'npm:@acme/lib', flag: 'index_failed' },
    ]);
    expect(db.prepare('SELECT index_status FROM repos').get()).toEqual({ index_status: 'failed' });
  });

  it('inserts overlay edges from a file to named or all exported symbols, warning on unknown targets', () => {
    const c = run(discover([
      { from: 'file:apps/app/src/main.ts', to: 'npm:@acme/lib#*' },
      { from: 'file:src/a.ts', to: 'npm:@acme/lib#helper' },
      { from: 'file:src/a.ts', to: 'npm:@acme/lib#doesNotExist' },
      { from: 'file:nowhere.ts', to: 'npm:@acme/lib#*' },
    ]));
    const rows = db.prepare(`SELECT f.name AS from_name, t.name AS to_name FROM edges e
      JOIN symbols f ON f.symbol_id = e.from_symbol_id JOIN symbols t ON t.symbol_id = e.to_symbol_id
      WHERE e.source = 'overlay' ORDER BY 1, 2`).all();
    expect(rows).toEqual([
      { from_name: 'apps/app/src/main.ts', to_name: 'Foo' },
      { from_name: 'apps/app/src/main.ts', to_name: 'helper' },
      { from_name: 'src/a.ts', to_name: 'helper' },
    ]);
    expect(c.warnings).toBe(2);
  });

  it('rolls back everything on failure and refuses packages missing from the DB', () => {
    run();
    const before = tableCounts(db);
    writeJson('acme/mono', 'lib.exports.json', { ...sidecar('npm:@acme/other') });
    expect(() => run()).toThrow(/packageId npm:@acme\/other/);
    expect(tableCounts(db)).toEqual(before);
    db.prepare("DELETE FROM packages WHERE package_id = 'npm:@acme/app'").run();
    expect(() => run()).toThrow(/not in the database; run discover first/);
  });

  it('keeps the owning package\'s index for a nested package file and recognises its package-relative module symbol', () => {
    // The root index (run at '.') also contains apps/app/src/main.ts; scip-typescript names
    // its symbols relative to the nearest package.json: `src/main.ts`, not the relativePath.
    const APP_MAIN = `${APP}src/\`main.ts\`/`;
    const rootCopy: DocSpec = {
      path: 'apps/app/src/main.ts',
      occurrences: [
        { range: [0, 0, 0], symbol: APP_MAIN, roles: 1 },
        { range: [1, 9, 14], symbol: `${APP}src/\`main.ts\`/stale().`, roles: 1, enclosing: [1, 0, 1, 20] },
      ],
    };
    const ownCopy: DocSpec = {
      path: 'src/main.ts',
      occurrences: [
        { range: [0, 0, 0], symbol: APP_MAIN, roles: 1 },
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 4, 1] },
      ],
    };
    const libDoc: DocSpec = { path: 'src/a.ts', occurrences: [{ range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 }] };
    writeScip('acme/mono', 'lib.scip', [libDoc, rootCopy]);
    writeScip('acme/mono', 'app.scip', [ownCopy]);
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib'));
    const appDocs = () => db.prepare(`SELECT d.file, d.is_entry, s.symbol_str FROM documents d JOIN symbols s ON s.symbol_id = d.module_symbol_id
      WHERE d.package_id = 'npm:@acme/app'`).all();
    const appSymbols = () => (db.prepare("SELECT name FROM symbols WHERE package_id = 'npm:@acme/app' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const expected = [{ file: 'apps/app/src/main.ts', is_entry: 1, symbol_str: 'scip-typescript npm @acme/app . src/`main.ts`/' }];

    // Both indexes: the owner's own index wins although the root index comes first.
    let c = run();
    expect(appDocs()).toEqual(expected);
    expect(appSymbols()).toEqual(['apps/app/src/main.ts', 'main']);
    expect(c.warnings).toBe(0);

    // Only the root index has it (the app's own index failed): still one module symbol,
    // the SCIP one, marked as the entry; no synthetic file symbol, no orphan.
    indexJson('acme/mono', [
      { packageId: 'npm:@acme/lib', scip: 'lib.scip', exports: 'lib.exports.json' },
      { packageId: 'npm:@acme/app', status: 'failed', diagnostics: ['error: boom'] },
    ]);
    c = run();
    expect(appDocs()).toEqual(expected);
    expect(appSymbols()).toEqual(['apps/app/src/main.ts', 'stale']);
    expect(count(db, "SELECT count(*) AS n FROM symbols WHERE symbol_str LIKE 'sentei file %'")).toBe(0);
    expect(c.warnings).toBe(0);

    // The same package's index containing the file twice with different contents warns.
    writeScip('acme/mono', 'app.scip', [ownCopy, { ...ownCopy, occurrences: ownCopy.occurrences.slice(0, 1) }, ownCopy]);
    indexJson('acme/mono', [
      { packageId: 'npm:@acme/lib', scip: 'lib.scip', exports: 'lib.exports.json' },
      { packageId: 'npm:@acme/app', scip: 'app.scip', exports: 'app.exports.json' },
    ]);
    c = run();
    expect(appSymbols()).toEqual(['apps/app/src/main.ts', 'main']);
    expect(c.warnings).toBe(1);
    expect(logs.at(-2)).toMatch(/apps\/app\/src\/main\.ts \(npm:@acme\/app\) appears 3 times, with different contents, in the index of npm:@acme\/app/);
  });

  it('prefers an error, then a warn diagnostic as the flag reason', () => {
    indexJson('acme/mono', [
      { packageId: 'npm:@acme/lib', status: 'partial', scip: 'lib.scip', exports: 'lib.exports.json',
        diagnostics: ['info: install skipped', 'warn: entry point not in program\nmore', 'warn: second'] },
      { packageId: 'npm:@acme/app', status: 'failed', diagnostics: ['info: only info'] },
    ], 'partial');
    run();
    expect(db.prepare('SELECT package_id, reason FROM package_flags ORDER BY package_id').all()).toEqual([
      { package_id: 'npm:@acme/app', reason: 'info: only info' },
      { package_id: 'npm:@acme/lib', reason: 'warn: entry point not in program' },
    ]);
  });

  it('turns sidecar unindexedImports into targeted unindexed_consumer flags, keeping discover\'s untargeted ones', () => {
    db.prepare("INSERT INTO package_flags (package_id, flag, reason) VALUES ('npm:@acme/app', 'unindexed_consumer', 'build.py')").run();
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      unindexedImports: [
        { file: 'apps/app/eslint.config.mjs', module: '@acme/lib/eslint', targetPackage: '@acme/lib' },
        { file: 'apps/app/eslint.config.mjs', module: 'left-pad', targetPackage: 'left-pad' },
        { file: 'apps/app/vite.config.mjs', module: '@acme/app', targetPackage: '@acme/app' },
      ],
    });
    const c = run();
    const rows = () => db.prepare('SELECT package_id, flag, reason, file, target_package_id FROM package_flags ORDER BY target_package_id').all();
    const expected = [
      { package_id: 'npm:@acme/app', flag: 'unindexed_consumer', reason: 'build.py', file: null, target_package_id: null },
      { package_id: 'npm:@acme/app', flag: 'unindexed_consumer', reason: 'unindexed file imports @acme/lib/eslint',
        file: 'apps/app/eslint.config.mjs', target_package_id: 'npm:@acme/lib' },
    ];
    expect(rows()).toEqual(expected);
    expect(c.warnings).toBe(2);
    run();
    expect(rows()).toEqual(expected);
  });

  it('namespaceSpreadRefs: edges to every symbol of the target module; occurrences for its exports unless a namespace_dynamic flag covers them (codeup)', () => {
    // codeup: `import * as _pkg from './pkg'; export const utils = Object.freeze({ ..._pkg })`.
    writeScip('acme/mono', 'lib.scip', [
      { path: 'src/index.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`index.ts\`/`, roles: 1 },
        { range: [1, 13, 18], symbol: `${LIB}src/\`index.ts\`/utils.`, roles: 1, enclosing: [1, 0, 1, 60] },
      ] },
      { path: 'src/pkg.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`pkg.ts\`/`, roles: 1 },
        { range: [1, 16, 20], symbol: `${LIB}src/\`pkg.ts\`/pkgA().`, roles: 1, enclosing: [1, 0, 1, 30] },
        { range: [2, 16, 20], symbol: `${LIB}src/\`pkg.ts\`/pkgB().`, roles: 1, enclosing: [2, 0, 4, 1] },
        { range: [3, 8, 13], symbol: `${LIB}src/\`pkg.ts\`/pkgB().inner.`, roles: 1 },
      ] },
    ]);
    writeScip('acme/mono', 'app.scip', [{ path: 'src/main.ts', occurrences: [
      { range: [0, 0, 0], symbol: `${APP}src/\`main.ts\`/`, roles: 1 },
      { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 4, 1] },
    ] }]);
    writeJson('acme/mono', 'lib.exports.json', {
      ...sidecar('npm:@acme/lib', [exp('utils', 'src/index.ts', 1, 13), exp('pkgA', 'src/pkg.ts', 1, 16)]),
      namespaceSpreadRefs: [
        { file: 'src/index.ts', line: 1, col: 40, targetPackage: '@acme/lib', targetFile: 'src/pkg.ts' },
        { file: 'src/index.ts', line: 1, col: 50, targetPackage: '@acme/lib', targetFile: 'src/nope.ts' },
      ],
    });
    const spreadFromApp = { file: 'apps/app/src/main.ts', line: 3, col: 4, targetPackage: '@acme/lib', targetFile: 'src/pkg.ts' };
    writeJson('acme/mono', 'app.exports.json', { ...sidecar('npm:@acme/app'), namespaceSpreadRefs: [spreadFromApp] });
    const c = run();
    const utils = id(`${'scip-typescript npm @acme/lib . '}src/\`index.ts\`/utils.`);
    const main = id('scip-typescript npm @acme/app . src/`main.ts`/main().');
    const [pkgA, pkgB, inner] = ['pkgA().', 'pkgB().', 'pkgB().inner.'].map((d) => id(`scip-typescript npm @acme/lib . src/\`pkg.ts\`/${d}`));
    const edgesFrom = (from: number): number[] =>
      (db.prepare('SELECT to_symbol_id AS t FROM edges WHERE from_symbol_id = ? ORDER BY t').all(from) as Array<{ t: number }>).map((r) => r.t);
    expect(edgesFrom(utils)).toEqual([pkgA!, pkgB!, inner!].sort((a, b) => a - b));
    expect(edgesFrom(main)).toEqual([pkgA!, pkgB!, inner!].sort((a, b) => a - b));
    // Same package: an occurrence for the exported top-level pkgA only. Cross-package (no flag): pkgA too.
    const occ = (sid: number): unknown[] => db.prepare('SELECT package_id, file, line, col, enclosing_symbol_id FROM occurrences WHERE symbol_id = ? AND role = 0 ORDER BY package_id').all(sid);
    expect(occ(pkgA!)).toEqual([
      { package_id: 'npm:@acme/app', file: 'apps/app/src/main.ts', line: 3, col: 4, enclosing_symbol_id: main },
      { package_id: 'npm:@acme/lib', file: 'src/index.ts', line: 1, col: 40, enclosing_symbol_id: utils },
    ]);
    expect(occ(pkgB!)).toEqual([]);
    expect(c.namespaceSpreadRefs).toBe(2);
    expect(c.unmatchedNamespaceSpreadRefs).toBe(1);
    expect(logs.some((l) => /warning: 1 namespace spread ref\(s\) match no indexed document: .*src\/nope\.ts/.test(l))).toBe(true);
    // pkgB is private, reached only through the spread: not already_unreachable; it goes
    // only with `utils` (itself an unused export here: a candidate).
    db.prepare("INSERT OR REPLACE INTO policy (key, value) VALUES ('minAgeDays', '0')").run();
    analyzeOrg({ db, now: 1_800_000_000, log: () => {} });
    expect(db.prepare("SELECT s.name, f.reasons FROM findings f JOIN symbols s USING (symbol_id) WHERE f.verdict = 'private_dead' AND s.package_id = 'npm:@acme/lib'").all())
      .toEqual([{ name: 'pkgB', reasons: '["unlocked_by:utils"]' }]);

    // A namespace_dynamic flag of the consumer on the target: edges only (the flag blocks).
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      namespaceSpreadRefs: [spreadFromApp],
      flags: [{ flag: 'namespace_dynamic', reason: 'D[key]', file: 'apps/app/src/main.ts', targetPackage: '@acme/lib' }],
    });
    run();
    expect(occ(id('scip-typescript npm @acme/lib . src/`pkg.ts`/pkgA().'))).toEqual([
      { package_id: 'npm:@acme/lib', file: 'src/index.ts', line: 1, col: 40, enclosing_symbol_id: id(`scip-typescript npm @acme/lib . src/\`index.ts\`/utils.`) },
    ]);
    expect(edgesFrom(id('scip-typescript npm @acme/app . src/`main.ts`/main().'))).toHaveLength(3);
  });

  it('drops SCIP references to a missing module symbol of another org package (skew residue, not a symbol)', () => {
    writeScip('acme/mono', 'app.scip', [{ path: 'src/main.ts', occurrences: [
      { range: [0, 17, 30], symbol: `${LIB_OLD}src/\`utils.d.ts\`/` },
      { range: [1, 0, 6], symbol: `${LIB_OLD}src/\`a.ts\`/goneFn().` },
    ] }]);
    const c = run();
    expect(c.droppedModuleRefs).toBe(1);
    expect(db.prepare('SELECT symbol_str FROM unresolved_refs').all()).toEqual([{ symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/goneFn().' }]);
    expect(logs.some((l) => l.includes('droppedModuleRefs=1'))).toBe(true);
  });

  it('makes the exported top-level declarations of runtime entry files entry_symbols (imports map arms, Vite inputs)', () => {
    writeScip('acme/mono', 'lib.scip', [
      { path: 'src/a.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 13, 19], symbol: `${LIB}src/\`a.ts\`/digest().`, roles: 1, enclosing: [1, 0, 1, 30] },
        { range: [2, 13, 19], symbol: `${LIB}src/\`a.ts\`/priv().`, roles: 1, enclosing: [2, 0, 2, 30] },
      ] },
    ]);
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib', [{ ...exp('digest', 'src/a.ts', 1, 13), entry: 'src/a.ts' }]));
    const d = discover();
    d.repos[0]!.packages[0]!.entryPoints.push('src/a.ts');
    d.repos[0]!.packages[0]!.runtimeEntryPoints = ['src/a.ts'];
    const c = run(d);
    expect(c.runtimeEntrySymbols).toBe(1);
    expect(db.prepare('SELECT s.name FROM entry_symbols e JOIN symbols s USING (symbol_id)').all()).toEqual([{ name: 'digest' }]);
  });

  it('relative unindexedImports (own SFC importing own code): self witness_files row, the module\'s privates kept, no flag', () => {
    writeScip('acme/mono', 'lib.scip', [
      { path: 'src/a.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 13, 19], symbol: `${LIB}src/\`a.ts\`/shown().`, roles: 1, enclosing: [1, 0, 1, 30] },
        { range: [2, 13, 19], symbol: `${LIB}src/\`a.ts\`/Api#`, roles: 1, enclosing: [2, 0, 4, 1] },
        { range: [3, 2, 5], symbol: `${LIB}src/\`a.ts\`/Api#run().`, roles: 1 },
        { range: [5, 13, 19], symbol: `${LIB}src/\`a.ts\`/pub().`, roles: 1, enclosing: [5, 0, 5, 30] },
      ] },
    ]);
    writeJson('acme/mono', 'lib.exports.json', {
      ...sidecar('npm:@acme/lib', [exp('pub', 'src/a.ts', 5, 13)]),
      unindexedImports: [
        { file: 'components/Card.vue', module: 'src/a', targetPackage: '@acme/lib', relative: true },
        { file: 'components/Gone.vue', module: 'src/missing.ts', targetPackage: '@acme/lib', relative: true },
      ],
    });
    const c = run();
    expect(c.relativeUnindexedImports).toBe(2);
    expect(db.prepare('SELECT consumer_package_id, target_package_id, file FROM witness_files ORDER BY file').all()).toEqual([
      { consumer_package_id: 'npm:@acme/lib', target_package_id: 'npm:@acme/lib', file: 'components/Card.vue' },
      { consumer_package_id: 'npm:@acme/lib', target_package_id: 'npm:@acme/lib', file: 'components/Gone.vue' },
    ]);
    // Top-level non-exported declarations of the imported module: entry_symbols (members and exports not).
    expect(db.prepare('SELECT s.name FROM entry_symbols e JOIN symbols s USING (symbol_id) ORDER BY s.name').all()).toEqual([{ name: 'Api' }, { name: 'shown' }]);
    expect(count(db, "SELECT count(*) AS n FROM package_flags WHERE flag = 'unindexed_consumer'")).toBe(0);
    expect(logs.some((l) => l.includes('does not name another org package'))).toBe(false);
    expect(logs.some((l) => /components\/Gone\.vue imports own module "src\/missing\.ts", which is not an indexed document/.test(l))).toBe(true);
  });

  it('routes scoped unindexedImports (script/docs/test files) to witness_files instead of flags', () => {
    writeJson('acme/mono', 'app.exports.json', {
      ...sidecar('npm:@acme/app'),
      unindexedImports: [
        { file: 'apps/app/bench/run.ts', module: '@acme/lib', targetPackage: '@acme/lib', scope: 'script' },
        { file: 'apps/app/docs/x.ts', module: '@acme/lib/deep', targetPackage: '@acme/lib', scope: 'docs' },
        { file: 'apps/app/eslint.config.mjs', module: '@acme/lib', targetPackage: '@acme/lib' },
      ],
    });
    const c = run();
    expect(db.prepare('SELECT consumer_package_id, target_package_id, file FROM witness_files ORDER BY file').all()).toEqual([
      { consumer_package_id: 'npm:@acme/app', target_package_id: 'npm:@acme/lib', file: 'apps/app/bench/run.ts' },
      { consumer_package_id: 'npm:@acme/app', target_package_id: 'npm:@acme/lib', file: 'apps/app/docs/x.ts' },
    ]);
    expect(db.prepare("SELECT file FROM package_flags WHERE flag = 'unindexed_consumer'").all()).toEqual([{ file: 'apps/app/eslint.config.mjs' }]);
    expect(c.witnessFiles).toBe(2);
    run();
    expect(count(db, 'SELECT count(*) AS n FROM witness_files')).toBe(2);
  });

  it('marks sidecar generatedFiles and GENERATED_GLOBS documents is_generated; their declarations get no verdicts', () => {
    writeScip('acme/mono', 'lib.scip', [
      { path: 'src/a.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 13, 16], symbol: `${LIB}src/\`a.ts\`/Gen#`, roles: 1, enclosing: [1, 0, 1, 20] },
      ] },
      { path: 'src/b.generated.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`b.generated.ts\`/`, roles: 1 },
        { range: [1, 13, 16], symbol: `${LIB}src/\`b.generated.ts\`/Glob#`, roles: 1, enclosing: [1, 0, 1, 20] },
      ] },
      { path: 'src/c.ts', occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`c.ts\`/`, roles: 1 },
        { range: [1, 13, 16], symbol: `${LIB}src/\`c.ts\`/Plain#`, roles: 1, enclosing: [1, 0, 1, 20] },
      ] },
    ]);
    writeJson('acme/mono', 'lib.exports.json', {
      ...sidecar('npm:@acme/lib', [exp('Gen', 'src/a.ts', 1, 13), exp('Glob', 'src/b.generated.ts', 1, 13), exp('Plain', 'src/c.ts', 1, 13)]),
      generatedFiles: ['src/a.ts'],
    });
    const c = run();
    expect(c.generatedDocuments).toBe(2);
    expect(db.prepare("SELECT file, is_generated FROM documents WHERE package_id = 'npm:@acme/lib' ORDER BY file").all()).toEqual([
      { file: 'src/a.ts', is_generated: 1 }, { file: 'src/b.generated.ts', is_generated: 1 }, { file: 'src/c.ts', is_generated: 0 },
    ]);
    db.prepare("INSERT OR REPLACE INTO policy (key, value) VALUES ('minAgeDays', '0')").run();
    analyzeOrg({ db, now: 1_800_000_000, log: () => {} });
    expect(db.prepare("SELECT s.name FROM findings f JOIN symbols s USING (symbol_id) WHERE s.package_id = 'npm:@acme/lib' ORDER BY s.name").all()).toEqual([{ name: 'Plain' }]);
  });

  it('adds module -> symbol edges for sidecar entrySymbols without exporting them, warning on unmatched ones', () => {
    writeJson('acme/mono', 'lib.exports.json', {
      ...sidecar('npm:@acme/lib', [exp('Foo', 'src/a.ts', 1, 13)]),
      entrySymbols: [
        { file: 'src/a.ts', line: 2, col: 2, name: 'bar' },
        { file: 'src/a.ts', line: 40, col: 0, name: 'nope' },
      ],
    });
    const c = run();
    const mod = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/`);
    const bar = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#bar().`);
    expect(count(db, "SELECT count(*) AS n FROM edges WHERE from_symbol_id = ? AND to_symbol_id = ? AND source = 'scip'", mod, bar)).toBe(1);
    expect(db.prepare('SELECT is_exported FROM symbols WHERE symbol_id = ?').get(bar)).toEqual({ is_exported: 0 });
    expect(c.unmatchedEntrySymbols).toBe(1);
    expect(db.prepare('SELECT symbol_id FROM entry_symbols').all()).toEqual([{ symbol_id: bar }]);
    expect(logs.some((l) => /warning: 1 sidecar entry symbol\(s\) match no SCIP definition: npm:@acme\/lib nope at src\/a\.ts:41:1/.test(l))).toBe(true);
  });

  it('flags a package whose index has unparseable symbols index_failed and ingests the rest of the org', () => {
    const BAD = [`${APP}src/\`main.ts\`/Foo#==().`, `${APP}null(tags)`];
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 4, 1] },
        { range: [3, 2, 5], symbol: BAD[0]!, roles: 1 },
        { range: [3, 6, 9], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#bar().` },
        { range: [4, 2, 5], symbol: BAD[1]! },
        { range: [5, 2, 5], symbol: BAD[0]! },
        { range: [6, 2, 5], symbol: 'scip-dart pub dart:core 3.11.0 dart:core/`map.dart`/Map#[]=().' }, // third-party: skipped
      ],
    }]);
    const c = run();
    expect(c.packageErrors).toBe(1);
    expect(c.skippedInvalidOccurrences).toBe(0); // the whole package is skipped, not counted per occurrence
    expect(db.prepare('SELECT package_id, flag, reason FROM package_flags').all()).toEqual([
      { package_id: 'npm:@acme/app', flag: 'index_failed', reason: `invalid SCIP symbol ${JSON.stringify(BAD[0])} (+1 more)` },
    ]);
    // Nothing of the failed package (not even its sidecar); the rest of the org is ingested.
    expect(count(db, "SELECT count(*) AS n FROM documents WHERE package_id = 'npm:@acme/app'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM symbols WHERE package_id = 'npm:@acme/app'")).toBe(0);
    expect(db.prepare("SELECT name FROM symbols WHERE package_id = 'npm:@acme/lib' AND is_exported = 1 ORDER BY name").all())
      .toEqual([{ name: 'Foo' }, { name: 'helper' }]);
    expect(logs.some((l) => l.includes('npm:@acme/app: 2 invalid SCIP symbol(s)'))).toBe(true);
    expect(logs.at(-1)).toMatch(/ packageErrors=1$/);

    // An undecodable .scip fails its package the same way.
    writeFileSync(join(workDir, 'index', 'acme__mono', 'app.scip'), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]));
    const c2 = run();
    expect(c2.packageErrors).toBe(1);
    expect(db.prepare('SELECT package_id, flag, reason FROM package_flags').all()).toEqual([
      { package_id: 'npm:@acme/app', flag: 'index_failed', reason: expect.stringMatching(/^unreadable \.scip: /) },
    ]);
    expect(count(db, "SELECT count(*) AS n FROM documents WHERE package_id = 'npm:@acme/lib'")).toBe(1);
  });

  it('drops occurrences of unparseable third-party symbols (counted) without failing the package', () => {
    const THIRD = ['scip-dart pub dart:core 3.11.0 dart:core/`map.dart`/Map#[]=().', 'scip-typescript npm left  pad 1.0.0 `x.ts`/a#==().'];
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 4, 1] },
        { range: [3, 2, 5], symbol: THIRD[0]! },
        { range: [3, 6, 9], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#bar().` },
        { range: [4, 2, 5], symbol: THIRD[0]! },
        { range: [4, 6, 9], symbol: THIRD[1]! },
      ],
    }]);
    const c = run();
    expect(c.packageErrors).toBe(0);
    expect(c.skippedInvalidOccurrences).toBe(3);
    expect(count(db, 'SELECT count(*) AS n FROM package_flags')).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM occurrences WHERE file = 'apps/app/src/main.ts'")).toBe(2); // main def + Foo#bar ref
    expect(logs.at(-1)).toMatch(/ skippedInvalidOccurrences=3$/);
    // A malformed symbol with no recognisable package still fails the package.
    writeScip('acme/mono', 'app.scip', [{ path: 'src/main.ts', occurrences: [{ range: [0, 0, 1], symbol: 'scip-dart pub' }] }]);
    expect(run().packageErrors).toBe(1);
  });

  it('gives a document to the package with the same manager as its index when an npm and a pub package share a dir', () => {
    db.prepare("INSERT INTO repos (repo) VALUES ('acme/mix')").run();
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:mix', 'acme/mix', '.', 'npm', 'mix', 'private')").run();
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('pub:mix', 'acme/mix', '.', 'pub', 'mix', 'private')").run();
    const NPM = 'scip-typescript npm mix 1.0.0 ';
    const PUB = 'scip-dart pub mix 1.0.0 ';
    for (const order of [['npm', 'pub'], ['pub', 'npm']] as const) {
      writeScip('acme/mix', 'npm.scip', [{ path: 'web/a.js', occurrences: [
        { range: [0, 0, 0], symbol: `${NPM}web/\`a.js\`/`, roles: 1 },
        { range: [1, 9, 12], symbol: `${NPM}web/\`a.js\`/jsFn().`, roles: 1 },
      ] }]);
      writeScip('acme/mix', 'pub.scip', [{ path: 'lib/a.dart', occurrences: [
        { range: [0, 0, 0], symbol: `${PUB}lib/\`a.dart\`/`, roles: 1 },
        { range: [1, 5, 11], symbol: `${PUB}lib/\`a.dart\`/dartFn().`, roles: 1 },
      ] }]);
      writeJson('acme/mix', 'npm.exports.json', sidecar('npm:mix'));
      writeJson('acme/mix', 'pub.exports.json', sidecar('pub:mix'));
      const entries = {
        npm: { packageId: 'npm:mix', scip: 'npm.scip', exports: 'npm.exports.json' },
        pub: { packageId: 'pub:mix', scip: 'pub.scip', exports: 'pub.exports.json' },
      };
      indexJson('acme/mix', order.map((m) => entries[m]));
      const pkgsInOrder = order.map((m) => ({ packageId: `${m}:mix`, path: '.', entryPoints: [] }));
      run({ repos: [...discover().repos, { repo: 'acme/mix', packages: pkgsInOrder }] });
      expect(db.prepare("SELECT package_id, file FROM documents WHERE package_id LIKE '%:mix' ORDER BY package_id").all(), order.join()).toEqual([
        { package_id: 'npm:mix', file: 'web/a.js' },
        { package_id: 'pub:mix', file: 'lib/a.dart' },
      ]);
      expect(db.prepare("SELECT package_id, name FROM symbols WHERE name IN ('jsFn', 'dartFn') ORDER BY name").all()).toEqual([
        { package_id: 'pub:mix', name: 'dartFn' },
        { package_id: 'npm:mix', name: 'jsFn' },
      ]);
    }
    // No same-manager package encloses the document: the longest-prefix rule still applies.
    writeScip('acme/mono', 'lib.scip', [{ path: 'apps/app/src/x.ts', occurrences: [{ range: [0, 0, 0], symbol: `${APP}src/\`x.ts\`/`, roles: 1 }] }]);
    writeScip('acme/mix', 'pub.scip', [{ path: '../tool/b.js', occurrences: [{ range: [0, 0, 0], symbol: `${NPM}tool/\`b.js\`/`, roles: 1 }] }]);
    db.prepare("DELETE FROM packages WHERE package_id = 'npm:mix'").run();
    db.prepare("UPDATE packages SET path = 'lib' WHERE package_id = 'pub:mix'").run();
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:mix', 'acme/mix', '.', 'npm', 'mix', 'private')").run();
    indexJson('acme/mix', [{ packageId: 'pub:mix', scip: 'pub.scip', exports: 'pub.exports.json' }, { packageId: 'npm:mix', status: 'failed' }]);
    run({ repos: [...discover().repos, { repo: 'acme/mix', packages: [
      { packageId: 'pub:mix', path: 'lib', entryPoints: [] }, { packageId: 'npm:mix', path: '.', entryPoints: [] },
    ] }] });
    // tool/b.js, seen by the pub index run in lib/: no pub package encloses it, the npm one at '.' does.
    expect(db.prepare("SELECT package_id, file FROM documents WHERE package_id LIKE '%:mix'").all()).toEqual([{ package_id: 'npm:mix', file: 'tool/b.js' }]);
    expect(db.prepare("SELECT package_id, file FROM documents WHERE file = 'apps/app/src/x.ts'").all()).toEqual([{ package_id: 'npm:@acme/app', file: 'apps/app/src/x.ts' }]);
  });

  it('marks scip-dart import prefixes (non-module namespaces) as kind import-prefix, and only those', () => {
    db.prepare("INSERT INTO repos (repo) VALUES ('acme/dart')").run();
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('pub:d', 'acme/dart', '.', 'pub', 'd', 'private')").run();
    const D = 'scip-dart pub d 1.0.0 lib/`a.dart`/';
    const NS = SymbolInformation_Kind.Namespace;
    writeScip('acme/dart', 'd.scip', [{
      path: 'lib/a.dart',
      occurrences: [
        { range: [0, 0, 0], symbol: D, roles: 1 },
        { range: [1, 20, 22], symbol: `${D}$0.`, roles: 1 }, // import 'x.dart' as $0;
        { range: [2, 20, 21], symbol: `${D}p.`, roles: 1 }, // import 'y.dart' as p;
        { range: [3, 20, 21], symbol: `${D}q/`, roles: 1 }, // a fixed fork might emit a namespace descriptor
        { range: [4, 5, 8], symbol: `${D}foo().`, roles: 1 },
        { range: [5, 2, 4], symbol: `${D}$0.` },
      ],
      symbols: [{ symbol: D, kind: NS }, { symbol: `${D}$0.`, kind: NS }, { symbol: `${D}p.`, kind: NS }, { symbol: `${D}foo().`, kind: SymbolInformation_Kind.Function }],
    }]);
    writeJson('acme/dart', 'd.exports.json', sidecar('pub:d'));
    indexJson('acme/dart', [{ packageId: 'pub:d', indexer: 'scip-dart', scip: 'd.scip', exports: 'd.exports.json' }]);
    // A TypeScript namespace declaration of kind Namespace stays a namespace.
    writeScip('acme/mono', 'lib.scip', [{
      path: 'src/a.ts',
      occurrences: [
        { range: [0, 0, 0], symbol: `${LIB}src/\`a.ts\`/`, roles: 1 },
        { range: [1, 10, 12], symbol: `${LIB}src/\`a.ts\`/NS/`, roles: 1 },
      ],
      symbols: [{ symbol: `${LIB}src/\`a.ts\`/NS/`, kind: NS }],
    }]);
    writeJson('acme/mono', 'lib.exports.json', sidecar('npm:@acme/lib'));
    const d = discover();
    d.repos.push({ repo: 'acme/dart', packages: [{ packageId: 'pub:d', path: '.', entryPoints: ['lib/a.dart'] }] });
    run(d);
    expect(db.prepare("SELECT name, kind FROM symbols WHERE package_id IN ('pub:d', 'npm:@acme/lib') ORDER BY package_id, name").all()).toEqual([
      { name: 'NS', kind: 'namespace' },
      { name: 'src/a.ts', kind: '' },
      { name: '$0', kind: 'import-prefix' },
      { name: 'foo', kind: 'function' },
      { name: 'lib/a.dart', kind: 'namespace' },
      { name: 'p', kind: 'import-prefix' },
      { name: 'q', kind: 'import-prefix' },
    ]);
  });

  it('refuses to run before discover, and clears the analyzed marker', () => {
    run();
    db.exec("CREATE TABLE IF NOT EXISTS run_params (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO run_params VALUES ('analyzed_at', '1'), ('now', '1')");
    run();
    expect(db.prepare('SELECT key FROM run_params').all()).toEqual([{ key: 'now' }]);
    const empty = openDb(':memory:');
    try {
      expect(() => ingestOrg({ db: empty, workDir, discover: { repos: [] }, log: () => {} })).toThrow(/no packages; run discover first/);
    } finally {
      empty.close();
    }
  });

  it('leaves discover-owned rows and non-ingest flags alone, and is idempotent', () => {
    db.prepare("INSERT INTO package_flags (package_id, flag, reason) VALUES ('npm:@acme/app', 'unindexed_consumer', 'build.py')").run();
    db.prepare("INSERT INTO keep_rules (package_id, symbol_name) VALUES ('npm:@acme/lib', 'Foo')").run();
    run();
    const first = tableCounts(db);
    run();
    expect(tableCounts(db)).toEqual(first);
    expect(count(db, "SELECT count(*) AS n FROM package_flags WHERE flag = 'unindexed_consumer'")).toBe(1);
    expect(count(db, 'SELECT count(*) AS n FROM keep_rules')).toBe(1);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
