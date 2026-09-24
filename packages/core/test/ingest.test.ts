import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { ingestOrg, repoSlug, type ExportsSidecar, type IngestCounts, type IngestDiscoverInput, type RepoIndexFile } from '../src/ingest.ts';
import { IndexSchema } from '../src/scip/scip_pb.ts';
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
interface DocSpec { path: string; occurrences: OccSpec[] }

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

  it('attributes undefined anonymous-literal members to the nearest defined ancestor; other missing members stay unresolved', () => {
    // The typeLiteral / property counters depend on the program that indexed the file, so
    // the consumer's `Foo#typeLiteral9:foo.` never matches the library's name.
    writeScip('acme/mono', 'app.scip', [{
      path: 'src/main.ts',
      occurrences: [
        { range: [2, 9, 13], symbol: `${APP}src/\`main.ts\`/main().`, roles: 1, enclosing: [2, 0, 9, 1] },
        { range: [3, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#typeLiteral9:foo.` },
        { range: [4, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#bar().typeLiteral1:x.typeLiteral2:y.` },
        { range: [5, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#gone().` },
        { range: [6, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#gone.typeLiteral1:x.` }, // gone. is real skew
        { range: [7, 2, 5], symbol: `${LIB_OLD}src/\`a.ts\`/Foo#\`<constructor>\`().typeLiteral0:opt.` },
      ],
    }]);
    run();
    const foo = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#`);
    const bar = id(`scip-typescript npm @acme/lib . src/\`a.ts\`/Foo#bar().`);
    expect(db.prepare(`SELECT symbol_id, line FROM occurrences WHERE package_id = 'npm:@acme/app' AND (role & 1) = 0 ORDER BY line`).all())
      .toEqual([{ symbol_id: foo, line: 3 }, { symbol_id: bar, line: 4 }, { symbol_id: foo, line: 7 }]);
    expect(db.prepare('SELECT symbol_str FROM unresolved_refs ORDER BY line').all()).toEqual([
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Foo#gone().' },
      { symbol_str: 'scip-typescript npm @acme/lib . src/`a.ts`/Foo#gone.typeLiteral1:x.' },
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
    expect(logs.some((l) => /warning: 1 sidecar entry symbol\(s\) match no SCIP definition: npm:@acme\/lib nope at src\/a\.ts:41:1/.test(l))).toBe(true);
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
