import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { analyzeOrg, type AnalyzeCounts } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { ingestOrg } from '../src/ingest.ts';
import { buildOrgSmallInputs, findScipTypescript, type OrgSmallInputs } from './helpers/orgSmallScip.ts';

const DAY = 86_400;
const NOW = 1_800_000_000;

let db: DatabaseSync;
let logs: string[];

function run(sql: string, ...params: Array<string | number | null>): void {
  db.prepare(sql).run(...params);
}

function setPolicy(key: string, value: unknown): void {
  run('INSERT INTO policy (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// A tiny hand-built org: packages, documents (with module symbols), symbols,
// occurrences and edges exactly as ingest would write them.
// ---------------------------------------------------------------------------

const symPkg = new Map<number, string>();
let seq = 0;

function pkg(name: string, visibility = 'private'): string {
  const id = `npm:${name}`;
  run('INSERT INTO repos (repo) VALUES (?)', `acme/${name.replace(/^@acme\//, '')}`);
  run("INSERT INTO packages (package_id, repo, path, manager, name, version, visibility) VALUES (?, ?, '.', 'npm', ?, '1.0.0', ?)",
    id, `acme/${name.replace(/^@acme\//, '')}`, name, visibility);
  return id;
}

function dep(consumer: string, lib: string): void {
  run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id) VALUES (?, ?, 'npm', ?)",
    consumer, lib.slice('npm:'.length), lib);
}

function insertSymbol(packageId: string, file: string, name: string, kind: string, opts: SymOpts = {}): number {
  seq += 1;
  const r = db.prepare(`INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name, parent_symbol_id, is_exported, first_seen_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(`test ${packageId} ${file} ${name} ${seq}`, packageId, file, seq, kind, name,
    opts.parent ?? null, opts.exported ? 1 : 0, opts.firstSeenAt === undefined ? NOW - 1000 * DAY : opts.firstSeenAt);
  const id = Number(r.lastInsertRowid);
  symPkg.set(id, packageId);
  return id;
}

/** A document and its module symbol; returns the module symbol id. */
function doc(packageId: string, file: string, entry = false): number {
  const m = insertSymbol(packageId, file, file, '', { firstSeenAt: null });
  run('INSERT INTO documents (package_id, file, module_symbol_id, is_entry) VALUES (?, ?, ?, ?)', packageId, file, m, entry ? 1 : 0);
  return m;
}

interface SymOpts { exported?: boolean; parent?: number; firstSeenAt?: number | null; file?: string }

/** A declaration in `file` of `packageId` (definition occurrence enclosed by `enclosing`, default the file module). */
function sym(packageId: string, file: string, name: string, opts: SymOpts & { enclosing?: number } = {}): number {
  const id = insertSymbol(packageId, file, name, 'function', opts);
  const moduleId = (db.prepare('SELECT module_symbol_id AS m FROM documents WHERE package_id = ? AND file = ?').get(packageId, file) as { m: number }).m;
  occ(id, packageId, file, opts.enclosing ?? moduleId, { role: 1 });
  if (opts.parent !== undefined) edge(opts.parent, id); // ingest's parent edge
  return id;
}

function occ(symbolId: number, filePackage: string, file: string, enclosing: number | null, o: { role?: number; exportSite?: boolean } = {}): void {
  run(`INSERT INTO occurrences (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id, is_export_site)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`, symbolId, filePackage, symPkg.get(symbolId)!, file, o.role ?? 8, enclosing, o.exportSite ? 1 : 0);
}

function edge(from: number, to: number, source = 'scip'): void {
  run(`INSERT OR IGNORE INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source) VALUES (?, ?, ?, ?, ?)`,
    from, to, symPkg.get(from)!, symPkg.get(to)!, source);
}

/** `from` (a declaration or module symbol in `file`) uses `to`: a reference occurrence + an edge, as ingest writes them. */
function use(from: number, to: number, file: string): void {
  occ(to, symPkg.get(from)!, file, from);
  edge(from, to);
}

interface Row { name: string; verdict: string; reasons: string[]; blocked_by: string[] }

function analyze(now = NOW): AnalyzeCounts {
  return analyzeOrg({ db, now, log: (l) => logs.push(l) });
}

function findings(): Row[] {
  return (db.prepare(`SELECT s.name, f.verdict, f.reasons, f.blocked_by FROM findings f JOIN symbols s USING (symbol_id)
    ORDER BY s.package_id, s.name, f.verdict`).all() as Array<{ name: string; verdict: string; reasons: string; blocked_by: string }>)
    .map((r) => ({ name: r.name, verdict: r.verdict, reasons: JSON.parse(r.reasons) as string[], blocked_by: JSON.parse(r.blocked_by) as string[] }));
}

const f = (name: string, verdict: string, reasons: string[], blocked_by: string[] = []): Row => ({ name, verdict, reasons, blocked_by });
const DELETE = ['no_refs', 'witness_pending'];

describe('analyzeOrg on hand-built rows', () => {
  let lib: string;
  let app: string;
  let libIndex: number;
  let libFns: number;
  let appMain: number;

  beforeEach(() => {
    db = openDb(':memory:');
    logs = [];
    setPolicy('minAgeDays', 0);
    lib = pkg('@acme/lib');
    app = pkg('@acme/app');
    dep(app, lib);
    libIndex = doc(lib, 'src/index.ts', true);
    libFns = doc(lib, 'src/fns.ts');
    edge(libIndex, libFns); // `export ... from './fns'` module specifier
    appMain = doc(app, 'src/main.ts', true);
  });

  afterEach(() => db.close());

  /** An exported symbol of lib alive via a normal external reference. */
  function aliveExport(name: string): number {
    const s = sym(lib, 'src/fns.ts', name, { exported: true });
    use(appMain, s, 'src/main.ts');
    return s;
  }

  it('reports an unreferenced export as needs_review + witness_pending and leaves live exports alone', () => {
    aliveExport('used');
    sym(lib, 'src/fns.ts', 'unused', { exported: true });
    const counts = analyze();
    expect(findings()).toEqual([f('unused', 'needs_review', DELETE)]);
    expect(counts.byVerdict).toEqual({ needs_review: 1 });
    expect(logs.at(-1)).toMatch(/^\[analyze\] findings=1 needs_review=1 reachable=\d+$/);
  });

  it('excludes self-references (recursion, nested declarations) from internal refs', () => {
    const rec = sym(lib, 'src/fns.ts', 'rec', { exported: true });
    use(rec, rec, 'src/fns.ts'); // rec calls itself
    const inner = sym(lib, 'src/fns.ts', 'inner', { parent: rec });
    use(inner, rec, 'src/fns.ts'); // a member of rec refers back to rec
    const nested = sym(lib, 'src/fns.ts', 'nested', { enclosing: rec }); // declared inside rec's body
    use(nested, rec, 'src/fns.ts');
    analyze();
    expect(db.prepare('SELECT count(*) AS n FROM internal_refs WHERE symbol_id = ?').get(rec)).toEqual({ n: 0 });
    expect(findings()).toEqual([f('rec', 'needs_review', DELETE)]);

    // A use from anywhere else in the package is an internal ref.
    const other = sym(lib, 'src/fns.ts', 'other', { exported: true });
    use(appMain, other, 'src/main.ts');
    use(other, rec, 'src/fns.ts');
    analyze();
    expect(findings()).toEqual([f('rec', 'unexport_candidate', ['internal_refs_only'])]);
  });

  it('does not count export-clause identifiers as references', () => {
    const s = sym(lib, 'src/fns.ts', 'reexported', { exported: true });
    occ(s, lib, 'src/index.ts', libIndex, { exportSite: true });
    analyze();
    expect(findings()).toEqual([f('reexported', 'needs_review', DELETE)]);
  });

  it('matches the test and docs globs with or without a leading segment', () => {
    for (const file of ['src/a.test.ts', 'b.test.js', 'test/c.ts', 'src/test/d.ts', 'src/__tests__/e.ts', 'lib/f_test.dart', 'docs/g.ts', 'src/docs/h.ts', 'src/testing/i.ts', 'src/latest/j.ts', 'x.test/k.ts']) {
      doc(app, file);
    }
    analyze();
    const files = (view: string): string[] =>
      (db.prepare(`SELECT file FROM ${view} WHERE package_id = ? ORDER BY file`).all(app) as Array<{ file: string }>).map((r) => r.file);
    expect(files('test_files')).toEqual(['b.test.js', 'lib/f_test.dart', 'src/__tests__/e.ts', 'src/a.test.ts', 'src/test/d.ts', 'test/c.ts']);
    expect(files('doc_files')).toEqual(['docs/g.ts', 'src/docs/h.ts']);
  });

  it('ignores refs from consumer test files (only_test_refs) unless countTestsAsConsumers', () => {
    const testMod = doc(app, 'src/lib.test.ts');
    const s = sym(lib, 'src/fns.ts', 'testOnly', { exported: true });
    use(testMod, s, 'src/lib.test.ts');
    analyze();
    expect(findings()).toEqual([f('testOnly', 'needs_review', ['only_test_refs', 'witness_pending'])]);
    expect(db.prepare('SELECT symbol_id FROM test_only_refs').all()).toEqual([{ symbol_id: s }]);
    expect(db.prepare('SELECT count(*) AS n FROM external_refs').get()).toEqual({ n: 0 });

    setPolicy('countTestsAsConsumers', true);
    analyze();
    expect(findings()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM test_only_refs').get()).toEqual({ n: 0 });
  });

  it('ignores refs from consumer docs files unless countDocsAsConsumers', () => {
    const docsMod = doc(app, 'docs/example.ts');
    const s = sym(lib, 'src/fns.ts', 'docOnly', { exported: true });
    use(docsMod, s, 'docs/example.ts');
    analyze();
    expect(findings()).toEqual([f('docOnly', 'needs_review', DELETE)]);
    setPolicy('countDocsAsConsumers', true);
    analyze();
    expect(findings()).toEqual([]);
  });

  it('applies minAgeDays to closed-world verdicts, failing closed on unknown age', () => {
    sym(lib, 'src/fns.ts', 'unknownAge', { exported: true, firstSeenAt: null });
    sym(lib, 'src/fns.ts', 'old', { exported: true, firstSeenAt: NOW - 181 * DAY });
    sym(lib, 'src/fns.ts', 'young', { exported: true, firstSeenAt: NOW - 10 * DAY });
    const oldInternal = sym(lib, 'src/fns.ts', 'oldInternal', { exported: true, firstSeenAt: NOW - 180 * DAY });
    const youngInternal = sym(lib, 'src/fns.ts', 'youngInternal', { exported: true, firstSeenAt: NOW - 179 * DAY });
    const user = aliveExport('user');
    use(user, oldInternal, 'src/fns.ts');
    use(user, youngInternal, 'src/fns.ts');

    analyze();
    expect(findings()).toEqual([
      f('old', 'needs_review', DELETE),
      f('oldInternal', 'unexport_candidate', ['internal_refs_only']),
      f('unknownAge', 'needs_review', DELETE),
      f('young', 'needs_review', DELETE),
      f('youngInternal', 'unexport_candidate', ['internal_refs_only']),
    ]);

    setPolicy('minAgeDays', 180);
    analyze();
    expect(findings()).toEqual([
      f('old', 'needs_review', DELETE),
      f('oldInternal', 'unexport_candidate', ['internal_refs_only']),
    ]);
    // `now` is a run parameter: a year later everything with a known age qualifies.
    analyze(NOW + 365 * DAY);
    expect(findings().map((r) => r.name)).toEqual(['old', 'oldInternal', 'young', 'youngInternal']);
  });

  it('fails closed when minAgeDays is missing from policy', () => {
    sym(lib, 'src/fns.ts', 'unused', { exported: true });
    run("DELETE FROM policy WHERE key = 'minAgeDays'");
    analyze();
    expect(findings()).toEqual([]);
  });

  it('suppresses kept symbols (exact name and *)', () => {
    sym(lib, 'src/fns.ts', 'keepMe', { exported: true });
    sym(lib, 'src/fns.ts', 'dropMe', { exported: true });
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'keepMe')", lib);
    analyze();
    expect(findings()).toEqual([f('dropMe', 'needs_review', DELETE)]);
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, '*')", lib);
    analyze();
    expect(findings()).toEqual([]);
  });

  it('gives open-world packages deprecation_candidate + open_world, and assumeClosedWorld flips them', () => {
    const pub = pkg('@acme/pub', 'published-public');
    dep(app, pub);
    doc(pub, 'src/index.ts', true);
    const unused = sym(pub, 'src/index.ts', 'pubUnused', { exported: true });
    const internal = sym(pub, 'src/index.ts', 'pubInternal', { exported: true });
    sym(pub, 'src/index.ts', 'pubYoung', { exported: true, firstSeenAt: NOW });
    const helper = sym(pub, 'src/index.ts', 'pubHelper');
    use(unused, helper, 'src/index.ts');
    const used = sym(pub, 'src/index.ts', 'pubUsed', { exported: true });
    use(appMain, used, 'src/main.ts');
    use(used, internal, 'src/index.ts');
    setPolicy('minAgeDays', 180);

    analyze();
    // The age rule gates only closed-world verdicts (PLAN.md §6.5 tree); deprecations
    // are not candidates, so pubHelper stays reachable.
    expect(findings()).toEqual([
      f('pubInternal', 'deprecation_candidate', ['internal_refs_only', 'open_world']),
      f('pubUnused', 'deprecation_candidate', ['no_refs', 'open_world']),
      f('pubYoung', 'deprecation_candidate', ['no_refs', 'open_world']),
    ]);

    setPolicy('assumeClosedWorld', true);
    analyze();
    expect(findings()).toEqual([
      f('pubHelper', 'private_dead', ['unlocked_by:pubUnused']),
      f('pubInternal', 'unexport_candidate', ['internal_refs_only']),
      f('pubUnused', 'needs_review', DELETE),
    ]);

    // published-private is closed-world only with trustPrivateRegistry.
    setPolicy('assumeClosedWorld', false);
    run("UPDATE packages SET visibility = 'published-private' WHERE package_id = ?", pub);
    analyze();
    expect(findings().map((r) => r.verdict)).toEqual(['private_dead', 'unexport_candidate', 'needs_review']);
    setPolicy('trustPrivateRegistry', false);
    analyze();
    expect(findings().map((r) => r.verdict)).toEqual(['deprecation_candidate', 'deprecation_candidate', 'deprecation_candidate']);
  });

  it('turns would-be verdicts of a package with opaque consumers into blocked, with sorted blocked_by', () => {
    const z = pkg('@acme/z-broken');
    const a = pkg('@acme/a-dynamic');
    dep(z, lib);
    dep(a, lib);
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'index_failed', 'x')", z);
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'namespace_dynamic', 'x')", a);
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'dynamic_access', 'x')", a);
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'dynamic_access', 'another file')", a);
    aliveExport('used'); // alive stays alive: no row
    sym(lib, 'src/fns.ts', 'unused', { exported: true });
    const internal = sym(lib, 'src/fns.ts', 'internal', { exported: true });
    const helper = sym(lib, 'src/fns.ts', 'helper');
    use(helper, internal, 'src/fns.ts');
    const island = sym(lib, 'src/fns.ts', 'island');
    use(island, island, 'src/fns.ts');
    sym(lib, 'src/fns.ts', 'kept', { exported: true });
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'kept')", lib);

    analyze();
    const blockedBy = ['npm:@acme/a-dynamic:dynamic_access', 'npm:@acme/a-dynamic:namespace_dynamic', 'npm:@acme/z-broken:index_failed'];
    // No private_dead in a blocked package either.
    expect(findings()).toEqual([
      f('internal', 'blocked', ['internal_refs_only'], blockedBy),
      f('unused', 'blocked', ['no_refs'], blockedBy),
    ]);
  });

  it('blocks verdicts of a package that is itself opaque', () => {
    sym(lib, 'src/fns.ts', 'unused', { exported: true });
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'opaque_consumer', 'partial index')", lib);
    analyze();
    expect(findings()).toEqual([f('unused', 'blocked', ['no_refs'], ['npm:@acme/lib:opaque_consumer'])]);
  });

  it('reports a private circular island as already_unreachable', () => {
    aliveExport('used');
    const a = sym(lib, 'src/fns.ts', 'islandA');
    const b = sym(lib, 'src/fns.ts', 'islandB');
    use(a, b, 'src/fns.ts');
    use(b, a, 'src/fns.ts');
    analyze();
    expect(findings()).toEqual([
      f('islandA', 'private_dead', ['already_unreachable']),
      f('islandB', 'private_dead', ['already_unreachable']),
    ]);
    const reach = db.prepare('SELECT name, is_entry_reachable AS r FROM symbols WHERE package_id = ? ORDER BY name').all(lib);
    expect(reach).toEqual([
      { name: 'islandA', r: 0 },
      { name: 'islandB', r: 0 },
      { name: 'src/fns.ts', r: 1 },
      { name: 'src/index.ts', r: 1 },
      { name: 'used', r: 1 },
    ]);
  });

  it('names every candidate that unlocks a helper, through chains, and nothing still reachable', () => {
    const live = aliveExport('live');
    const dead1 = sym(lib, 'src/fns.ts', 'dead1', { exported: true });
    const dead2 = sym(lib, 'src/fns.ts', 'dead2', { exported: true });
    const h1 = sym(lib, 'src/fns.ts', 'h1');
    const h2 = sym(lib, 'src/fns.ts', 'h2');
    const shared = sym(lib, 'src/fns.ts', 'shared');
    const stillUsed = sym(lib, 'src/fns.ts', 'stillUsed');
    const afterLive = sym(lib, 'src/fns.ts', 'afterLive');
    use(dead1, h1, 'src/fns.ts');
    use(h1, h2, 'src/fns.ts'); // chain dead1 -> h1 -> h2
    use(h2, shared, 'src/fns.ts');
    use(dead2, shared, 'src/fns.ts');
    use(dead1, stillUsed, 'src/fns.ts');
    use(live, stillUsed, 'src/fns.ts');
    use(stillUsed, afterLive, 'src/fns.ts');
    // An unexport candidate unlocks what only it reached, once nothing reaches it.
    const unexp = sym(lib, 'src/fns.ts', 'unexp', { exported: true });
    use(h2, unexp, 'src/fns.ts');
    const h3 = sym(lib, 'src/fns.ts', 'h3');
    use(unexp, h3, 'src/fns.ts');

    analyze();
    expect(findings()).toEqual([
      f('dead1', 'needs_review', DELETE),
      f('dead2', 'needs_review', DELETE),
      f('h1', 'private_dead', ['unlocked_by:dead1']),
      f('h2', 'private_dead', ['unlocked_by:dead1']),
      f('h3', 'private_dead', ['unlocked_by:dead1', 'unlocked_by:unexp']),
      f('shared', 'private_dead', ['unlocked_by:dead1', 'unlocked_by:dead2']),
      f('unexp', 'unexport_candidate', ['internal_refs_only']),
    ]);
  });

  it('never reports members of an exported class, nor members of a reported/candidate declaration', () => {
    const cls = aliveExport('LiveClass');
    sym(lib, 'src/fns.ts', 'unusedMethod', { parent: cls });
    const deadCls = sym(lib, 'src/fns.ts', 'DeadClass', { exported: true });
    const m = sym(lib, 'src/fns.ts', 'deadMethod', { parent: deadCls });
    sym(lib, 'src/fns.ts', 'deadField', { parent: m });
    const privCls = sym(lib, 'src/fns.ts', 'PrivateDeadClass');
    sym(lib, 'src/fns.ts', 'privMethod', { parent: privCls });
    const fn = sym(lib, 'src/fns.ts', 'privateDeadFn');
    sym(lib, 'src/fns.ts', 'literalProp', { enclosing: fn }); // e.g. scip-typescript `tag0:` in a function body
    const liveFn = aliveExport('liveFn');
    sym(lib, 'src/fns.ts', 'liveLiteralProp', { enclosing: liveFn });
    analyze();
    expect(findings()).toEqual([
      f('DeadClass', 'needs_review', DELETE),
      f('PrivateDeadClass', 'private_dead', ['already_unreachable']),
      f('privateDeadFn', 'private_dead', ['already_unreachable']),
    ]);
  });

  it('never reports file symbols, test/docs-file declarations, or packages without seeds', () => {
    aliveExport('used');
    doc(lib, 'src/orphan.ts'); // non-entry module nobody imports
    const t = doc(lib, 'src/fns.test.ts');
    sym(lib, 'src/fns.test.ts', 'testHelper', { enclosing: t });
    doc(lib, 'docs/example.ts');
    sym(lib, 'docs/example.ts', 'exampleHelper');
    run("INSERT INTO symbols (symbol_str, package_id, file, kind, name) VALUES ('sentei file x', ?, 'src/x.ts', 'file', 'src/x.ts')", lib);
    // A package with no entry document and no export: entry points unknown, not "all dead".
    const noSeed = pkg('@acme/no-seed');
    doc(noSeed, 'src/a.ts');
    sym(noSeed, 'src/a.ts', 'looksDead');
    analyze();
    expect(findings()).toEqual([]);
  });

  it('counts overlay edges as references', () => {
    const s = sym(lib, 'src/fns.ts', 'viaOverlay', { exported: true });
    edge(appMain, s, 'overlay');
    const t = sym(lib, 'src/fns.ts', 'viaLocalOverlay', { exported: true });
    edge(libFns, t, 'overlay');
    analyze();
    expect(findings()).toEqual([f('viaLocalOverlay', 'unexport_candidate', ['internal_refs_only'])]);
  });

  it('recomputes from scratch: clears findings and witness_ok, idempotent', () => {
    const s = sym(lib, 'src/fns.ts', 'unused', { exported: true });
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, 1)', s);
    run("INSERT INTO findings (symbol_id, verdict) VALUES (?, 'deletion_candidate')", s);
    analyze();
    expect(db.prepare('SELECT count(*) AS n FROM witness_ok').get()).toEqual({ n: 0 });
    const first = findings();
    analyze();
    expect(findings()).toEqual(first);
    expect(first).toEqual([f('unused', 'needs_review', DELETE)]);
  });

  it('rolls back everything when a findings trigger fires', () => {
    sym(lib, 'src/fns.ts', 'unused', { exported: true });
    analyze();
    // A trigger that fires mid-run aborts the whole recompute; the previous findings survive.
    const before = findings();
    db.exec(`CREATE TRIGGER sabotage BEFORE INSERT ON findings WHEN NEW.verdict = 'needs_review'
      BEGIN SELECT RAISE(ABORT, 'sentei: sabotage'); END`);
    expect(() => analyze()).toThrow(/sentei: sabotage/);
    expect(findings()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// End to end on fixtures/org-small (lib-core + app) with real scip-typescript output
// ---------------------------------------------------------------------------

const scipTs = findScipTypescript();

describe.skipIf(!scipTs)('analyzeOrg on fixtures/org-small lib-core + app (scip-typescript)', () => {
  let inputs: OrgSmallInputs;

  beforeAll(() => {
    inputs = buildOrgSmallInputs(scipTs!);
    db = openDb(':memory:');
    logs = [];
    inputs.seedDb(db);
    setPolicy('minAgeDays', 0); // fixtures/org-small/sentei.json: no git history yet
    ingestOrg({ db, workDir: inputs.workDir, discover: inputs.discover, log: () => {} });
  }, 120_000);

  afterAll(() => {
    db?.close();
    inputs?.cleanup();
  });

  it('produces exactly the expected findings', () => {
    analyze();
    const rows = db.prepare(`SELECT s.package_id, s.name AS symbol, s.file, f.verdict, f.reasons, f.blocked_by
      FROM findings f JOIN symbols s USING (symbol_id) ORDER BY s.package_id, s.name, f.verdict`).all();
    expect(rows).toEqual([
      { package_id: 'npm:@acme/core', symbol: 'internalOnlyFn', file: 'src/fns.ts', verdict: 'unexport_candidate', reasons: '["internal_refs_only"]', blocked_by: '[]' },
      { package_id: 'npm:@acme/core', symbol: 'islandA', file: 'src/fns.ts', verdict: 'private_dead', reasons: '["already_unreachable"]', blocked_by: '[]' },
      { package_id: 'npm:@acme/core', symbol: 'islandB', file: 'src/fns.ts', verdict: 'private_dead', reasons: '["already_unreachable"]', blocked_by: '[]' },
      { package_id: 'npm:@acme/core', symbol: 'unusedFn', file: 'src/fns.ts', verdict: 'needs_review', reasons: '["no_refs","witness_pending"]', blocked_by: '[]' },
    ]);
    expect(logs.at(-1)).toMatch(/^\[analyze\] findings=4 needs_review=1 private_dead=2 unexport_candidate=1 reachable=\d+$/);
  });

  it('marks everything but the island reachable', () => {
    const unreachable = db.prepare('SELECT name FROM symbols WHERE is_entry_reachable = 0 ORDER BY name').all();
    expect(unreachable).toEqual([{ name: 'islandA' }, { name: 'islandB' }]);
  });

  it('keeps unusedFn alive when the org is not closed-world, as a deprecation', () => {
    run("UPDATE packages SET visibility = 'published-public' WHERE package_id = 'npm:@acme/core'");
    analyze();
    const rows = db.prepare(`SELECT s.name, f.verdict, f.reasons FROM findings f JOIN symbols s USING (symbol_id)
      WHERE s.is_exported = 1 ORDER BY s.name`).all();
    expect(rows).toEqual([
      { name: 'internalOnlyFn', verdict: 'deprecation_candidate', reasons: '["internal_refs_only","open_world"]' },
      { name: 'unusedFn', verdict: 'deprecation_candidate', reasons: '["no_refs","open_world"]' },
    ]);
    run("UPDATE packages SET visibility = 'private' WHERE package_id = 'npm:@acme/core'");
  });
});
