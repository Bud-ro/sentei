import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { defaultOrgConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { writeDiscoverToDb } from '../src/discover.ts';
import { blockerHint, buildReport, capCell, capList, formatSummary, formatTable, MAX_CELL, ORG_DEAD_ASSERTION, parseViews, skewSymbolName, VIEW_DESCRIPTIONS } from '../src/report.ts';

const NOW = 1_700_000_000;
const VERSION = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

let db: DatabaseSync;
/** 'blocked' once the analyze agent adds it to the findings CHECK; 'needs_review' before. */
let BLOCKED: string;

function run(sql: string, ...params: Array<string | number | null>): void {
  db.prepare(sql).run(...params);
}

function setPolicy(key: string, value: unknown): void {
  run('INSERT INTO policy (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

function addRepo(repo: string, sha: string | null, status: string | null): void {
  run('INSERT INTO repos (repo, default_branch, head_sha, indexed_at, index_status) VALUES (?, ?, ?, ?, ?)', repo, 'main', sha, NOW, status);
}

function addPackage(name: string, repo: string, visibility = 'private', deps: string[] = []): string {
  const id = `npm:${repo}:${name}`;
  run('INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, repo, `packages/${name.replace(/^@acme\//, '')}`, 'npm', name, '1.0.0', visibility, '["src/index.ts"]');
  for (const d of deps) {
    run('INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id) VALUES (?, ?, ?, ?, ?)',
      id, d.slice(d.lastIndexOf(':') + 1), 'npm', '^1.0.0', d);
  }
  return id;
}

function addSymbol(pkg: string, name: string, opts: { file?: string; line?: number | null; col?: number | null; kind?: string | null; exported?: boolean } = {}): number {
  const file = opts.file ?? 'src/index.ts';
  const r = db.prepare('INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`scip-typescript npm ${pkg.slice(pkg.lastIndexOf(':') + 1)} . src/\`${file.slice(4)}\`/${name}().`, pkg, file,
      opts.line === undefined ? 0 : opts.line, opts.col === undefined ? 0 : opts.col,
      opts.kind === undefined ? 'Function' : opts.kind, name, opts.exported === false ? 0 : 1);
  return Number(r.lastInsertRowid);
}

function addModule(pkg: string, file: string): void {
  const r = db.prepare('INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name) VALUES (?, ?, ?, NULL, NULL, NULL, ?)')
    .run(`sentei file ${pkg} ${file}`, pkg, file, file);
  run('INSERT INTO documents (package_id, file, module_symbol_id, is_entry) VALUES (?, ?, ?, 1)', pkg, file, Number(r.lastInsertRowid));
}

function addFinding(symbolId: number, verdict: string, reasons: string[], blockedBy: string[] = []): void {
  const wouldDelete = verdict === 'deletion_candidate'
    || (verdict === 'deprecation_candidate' && (!reasons.includes('internal_refs_only') || reasons.includes('dead_island')));
  if (wouldDelete) run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', symbolId, NOW);
  run('INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, ?)',
    symbolId, verdict, JSON.stringify(reasons), JSON.stringify(blockedBy));
}

function addFlag(pkg: string, flag: string, reason: string | null, file: string | null): void {
  run('INSERT INTO package_flags (package_id, flag, reason, file) VALUES (?, ?, ?, ?)', pkg, flag, reason, file);
}

function addSkew(consumer: string, target: string, symbolStr: string, file: string, line: number | null, col: number | null): void {
  run('INSERT INTO unresolved_refs (consumer_package_id, target_package_id, symbol_str, file, line, col) VALUES (?, ?, ?, ?, ?, ?)',
    consumer, target, symbolStr, file, line, col);
}

/**
 * Org:
 *   acme/lib-core   ok       npm:acme/lib-core:@acme/util (private; deletion/unexport/private_dead)
 *                            npm:acme/lib-core:@acme/core (private; consumed by app + broken -> blocked by broken)
 *   acme/lib-pub    ok       npm:acme/lib-pub:@acme/pub (published-public; consumed by dyn -> blocked by dyn)
 *                            npm:acme/lib-pub:@acme/open (published-public, no consumer; deprecations)
 *   acme/app        ok       npm:acme/app:@acme/app (consumer of util + core; version skew rows)
 *   acme/repo-broken failed  npm:acme/repo-broken:@acme/broken (index_failed; consumer of core)
 *   acme/app-dyn    partial  npm:acme/app-dyn:@acme/dyn (namespace_dynamic + dynamic_access; consumer of pub)
 */
/** What analyzeOrg leaves behind besides findings: the views and the analyzed_at marker. */
function markAnalyzed(d: DatabaseSync): void {
  d.exec(analyzeSql());
  d.prepare("INSERT OR REPLACE INTO run_params (key, value) VALUES ('analyzed_at', '0')").run();
}

function seed(): void {
  markAnalyzed(db);
  setPolicy('minAgeDays', 0);
  addRepo('acme/lib-core', 'sha-core', 'ok');
  addRepo('acme/lib-pub', 'sha-pub', 'ok');
  addRepo('acme/app', 'sha-app', 'ok');
  addRepo('acme/repo-broken', null, 'failed');
  addRepo('acme/app-dyn', 'sha-dyn', 'partial');
  const util = addPackage('@acme/util', 'acme/lib-core');
  const core = addPackage('@acme/core', 'acme/lib-core');
  const pub = addPackage('@acme/pub', 'acme/lib-pub', 'published-public');
  const open = addPackage('@acme/open', 'acme/lib-pub', 'published-public');
  const app = addPackage('@acme/app', 'acme/app', 'private', [util, core]);
  const broken = addPackage('@acme/broken', 'acme/repo-broken', 'private', [core]);
  const dyn = addPackage('@acme/dyn', 'acme/app-dyn', 'private', [pub]);
  addFlag(broken, 'index_failed', 'tsconfig.json: invalid JSON', null);
  addFlag(dyn, 'namespace_dynamic', 'P[key]', 'src/main.ts');
  addFlag(dyn, 'dynamic_access', "require('@acme/' + name)", 'src/load.cts');

  addModule(util, 'src/index.ts');
  addFinding(addSymbol(util, 'unusedFn', { file: 'src/fns.ts', line: 8, col: 16 }), 'deletion_candidate', ['no_refs']);
  addFinding(addSymbol(util, 'internalOnly', { line: 2, col: 16, kind: null }), 'unexport_candidate', ['internal_refs_only']);
  addFinding(addSymbol(util, 'islandFn', { file: 'src/fns.ts', line: 30, col: 16 }), 'deletion_candidate', ['internal_refs_only', 'dead_island']);
  addFinding(addSymbol(util, 'helper', { file: 'src/fns.ts', line: 20, col: 9, exported: false }), 'private_dead', ['unlocked_by:unusedFn']);
  addFinding(addSymbol(util, '_island', { file: 'src/fns.ts', line: null, col: null, exported: false }), 'private_dead', ['already_unreachable']);
  addSymbol(util, 'aliveFn');

  addFinding(addSymbol(core, 'coreDead'), BLOCKED, ['no_refs'], [`${broken}:index_failed`]);
  addFinding(addSymbol(core, 'coreMentioned'), 'needs_review', ['no_refs', 'witness_mismatch:npm:acme/app:@acme/app:src/main.ts:3']);

  addFinding(addSymbol(pub, 'pubB'), BLOCKED, ['no_refs'], [`${dyn}:dynamic_access`, `${dyn}:namespace_dynamic`]);
  addFinding(addSymbol(pub, 'pubA'), BLOCKED, ['only_test_refs'], [`${dyn}:dynamic_access`, `${dyn}:namespace_dynamic`]);

  addFinding(addSymbol(open, 'openDead', { line: 4, col: 16 }), 'deprecation_candidate', ['no_refs']);
  addFinding(addSymbol(open, 'openTested', { line: 5, col: 16 }), 'deprecation_candidate', ['only_test_refs']);
  addFinding(addSymbol(open, 'openIsland', { line: 6, col: 16 }), 'deprecation_candidate', ['internal_refs_only', 'dead_island']);
  addFinding(addSymbol(open, 'openInternal', { line: 7, col: 16 }), 'deprecation_candidate', ['internal_refs_only']);
  addFinding(addSymbol(open, 'openHelper', { line: 8, col: 9, exported: false }), 'private_dead', ['unlocked_by:openDead']);
  addFinding(addSymbol(open, 'openOld', { line: 9, col: 9, exported: false }), 'private_dead', ['already_unreachable']);

  // Bare sidecar name, the same reference again as a SCIP symbol (deduped), and a SCIP-only one.
  addSkew(app, util, 'removedFn', 'src/main.ts', 3, 9);
  addSkew(app, util, 'scip-typescript npm @acme/util . src/`index.ts`/removedFn().', 'src/main.ts', 3, 9);
  addSkew(app, util, 'scip-typescript npm @acme/util . src/`index.ts`/Gone#method().', 'src/other.ts', 10, 0);
  addSkew(dyn, pub, 'oldPub', 'src/main.ts', null, null);
}

beforeEach(() => {
  db = openDb(':memory:');
  try {
    db.exec("SAVEPOINT probe; INSERT INTO repos (repo) VALUES ('probe/x'); INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:probe/x:probe', 'probe/x', '.', 'npm', 'probe', 'private'); INSERT INTO symbols (symbol_str, package_id, file, name) VALUES ('probe', 'npm:probe/x:probe', 'f', 'probe'); INSERT INTO findings (symbol_id, verdict) VALUES (last_insert_rowid(), 'blocked'); ROLLBACK TO probe; RELEASE probe;");
    BLOCKED = 'blocked';
  } catch {
    db.exec('ROLLBACK TO probe; RELEASE probe;');
    BLOCKED = 'needs_review';
  }
  seed();
});

describe('buildReport', () => {
  it('produces the exact report JSON', () => {
    const report = buildReport({ db, now: NOW });
    const counts = (o: Partial<Record<string, number>>): Record<string, number> => ({
      org_dead: 0,
      delete: 0, deprecate: 0, unexport: 0, private_dead: 0, needs_review: 0, blocked: 0, ...o,
    });
    const blockedCounts = (n: number, review = 0): Record<string, number> =>
      BLOCKED === 'blocked' ? counts({ blocked: n, needs_review: review }) : counts({ needs_review: n + review });
    const core = { package_id: 'npm:acme/lib-core:@acme/core', name: '@acme/core', repo: 'acme/lib-core' };
    const util = { package_id: 'npm:acme/lib-core:@acme/util', name: '@acme/util', repo: 'acme/lib-core' };
    const open = { package_id: 'npm:acme/lib-pub:@acme/open', name: '@acme/open', repo: 'acme/lib-pub' };
    const pub = { package_id: 'npm:acme/lib-pub:@acme/pub', name: '@acme/pub', repo: 'acme/lib-pub' };
    const dynBlockers = ['npm:acme/app-dyn:@acme/dyn:dynamic_access', 'npm:acme/app-dyn:@acme/dyn:namespace_dynamic'];
    const findings = [
      { ...core, symbol: 'coreDead', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
        verdict: BLOCKED, reasons: ['no_refs'], blocked_by: ['npm:acme/repo-broken:@acme/broken:index_failed'] },
      { ...core, symbol: 'coreMentioned', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
        verdict: 'needs_review', reasons: ['no_refs', 'witness_mismatch:npm:acme/app:@acme/app:src/main.ts:3'], blocked_by: [] },
      { ...util, symbol: '_island', file: 'src/fns.ts', line: null, col: null, kind: 'Function',
        verdict: 'private_dead', reasons: ['already_unreachable'], blocked_by: [] },
      { ...util, symbol: 'helper', file: 'src/fns.ts', line: 21, col: 10, kind: 'Function',
        verdict: 'private_dead', reasons: ['unlocked_by:unusedFn'], blocked_by: [] },
      { ...util, symbol: 'internalOnly', file: 'src/index.ts', line: 3, col: 17, kind: '',
        verdict: 'unexport_candidate', reasons: ['internal_refs_only'], blocked_by: [] },
      { ...util, symbol: 'islandFn', file: 'src/fns.ts', line: 31, col: 17, kind: 'Function',
        verdict: 'deletion_candidate', reasons: ['internal_refs_only', 'dead_island'], blocked_by: [] },
      { ...util, symbol: 'unusedFn', file: 'src/fns.ts', line: 9, col: 17, kind: 'Function',
        verdict: 'deletion_candidate', reasons: ['no_refs'], blocked_by: [] },
      { ...open, symbol: 'openDead', file: 'src/index.ts', line: 5, col: 17, kind: 'Function',
        verdict: 'deprecation_candidate', reasons: ['no_refs'], blocked_by: [] },
      { ...open, symbol: 'openHelper', file: 'src/index.ts', line: 9, col: 10, kind: 'Function',
        verdict: 'private_dead', reasons: ['unlocked_by:openDead'], blocked_by: [] },
      { ...open, symbol: 'openInternal', file: 'src/index.ts', line: 8, col: 17, kind: 'Function',
        verdict: 'deprecation_candidate', reasons: ['internal_refs_only'], blocked_by: [] },
      { ...open, symbol: 'openIsland', file: 'src/index.ts', line: 7, col: 17, kind: 'Function',
        verdict: 'deprecation_candidate', reasons: ['internal_refs_only', 'dead_island'], blocked_by: [] },
      { ...open, symbol: 'openOld', file: 'src/index.ts', line: 10, col: 10, kind: 'Function',
        verdict: 'private_dead', reasons: ['already_unreachable'], blocked_by: [] },
      { ...open, symbol: 'openTested', file: 'src/index.ts', line: 6, col: 17, kind: 'Function',
        verdict: 'deprecation_candidate', reasons: ['only_test_refs'], blocked_by: [] },
      { ...pub, symbol: 'pubA', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
        verdict: BLOCKED, reasons: ['only_test_refs'], blocked_by: dynBlockers },
      { ...pub, symbol: 'pubB', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
        verdict: BLOCKED, reasons: ['no_refs'], blocked_by: dynBlockers },
    ];
    const pick = (...keys: string[]): typeof findings => keys.map((k) => findings.find((f) => `${f.name}#${f.symbol}` === k)!);
    const versionSkew = [
      { package_id: 'npm:acme/app-dyn:@acme/dyn', repo: 'acme/app-dyn', symbol: 'oldPub', file: 'src/main.ts', line: null, col: null, target_package_id: 'npm:acme/lib-pub:@acme/pub' },
      { package_id: 'npm:acme/app:@acme/app', repo: 'acme/app', symbol: 'method', file: 'src/other.ts', line: 11, col: 1, target_package_id: 'npm:acme/lib-core:@acme/util' },
      { package_id: 'npm:acme/app:@acme/app', repo: 'acme/app', symbol: 'removedFn', file: 'src/main.ts', line: 4, col: 10, target_package_id: 'npm:acme/lib-core:@acme/util' },
    ];
    const deprecate = pick('@acme/open#openDead', '@acme/open#openIsland', '@acme/open#openTested');
    const blockedRows = pick('@acme/core#coreDead', '@acme/pub#pubA', '@acme/pub#pubB');
    const reviewRows = pick('@acme/core#coreMentioned');
    expect(report).toEqual({
      tool: { name: 'sentei', version: VERSION },
      generatedAt: NOW,
      generatedAtIso: new Date(NOW * 1000).toISOString(),
      policy: { minAgeDays: 0, trustPrivateRegistry: true, countTestsAsConsumers: false, countDocsAsConsumers: false },
      warnings: [
        'minAgeDays is 0: age policy disabled; symbols of any age (including ones added yesterday) can be candidates',
        'repo acme/app-dyn: index partial; its packages are opaque and block verdicts for every org package they depend on',
        'repo acme/repo-broken: index failed for npm:acme/repo-broken:@acme/broken; it is opaque and blocks verdicts for every org package it depends on',
      ],
      findings,
      versionSkew,
      diagnostics: { unresolved_same_repo: [], unresolved_opaque_target: [], unresolved_unindexed_module: [], unresolved_moved_at_head: [] },
      views: {
        delete: { description: VIEW_DESCRIPTIONS.delete, rows: pick('@acme/util#islandFn', '@acme/util#unusedFn') },
        deprecate: { description: VIEW_DESCRIPTIONS.deprecate, rows: deprecate },
        // The same rows as deprecate, under the assertion; openHelper (unlocked only by a
        // deprecation) is dead only if the assertion holds, openOld is dead regardless.
        org_dead: { description: VIEW_DESCRIPTIONS.org_dead, assertion: ORG_DEAD_ASSERTION, rows: deprecate,
          private_dead: pick('@acme/open#openHelper') },
        unexport: { description: VIEW_DESCRIPTIONS.unexport, rows: pick('@acme/util#internalOnly'), published: pick('@acme/open#openInternal') },
        private_dead: { description: VIEW_DESCRIPTIONS.private_dead, rows: pick('@acme/util#_island', '@acme/util#helper', '@acme/open#openOld') },
        needs_review: { description: VIEW_DESCRIPTIONS.needs_review, rows: BLOCKED === 'blocked' ? reviewRows : pick('@acme/core#coreDead', '@acme/core#coreMentioned', '@acme/pub#pubA', '@acme/pub#pubB') },
        blocked: { description: VIEW_DESCRIPTIONS.blocked, rows: BLOCKED === 'blocked' ? blockedRows : [] },
        version_skew: { description: VIEW_DESCRIPTIONS.version_skew, rows: versionSkew },
      },
      packages: [
        { package_id: 'npm:acme/app-dyn:@acme/dyn', name: '@acme/dyn', repo: 'acme/app-dyn', visibility: 'private', private: true, opaque: true,
          flags: [
            { flag: 'dynamic_access', reason: "require('@acme/' + name)", file: 'src/load.cts' },
            { flag: 'namespace_dynamic', reason: 'P[key]', file: 'src/main.ts' },
          ],
          consumers: [], blocked_by: [], counts: counts({}), exported: 0, symbols: 0 },
        { package_id: 'npm:acme/app:@acme/app', name: '@acme/app', repo: 'acme/app', visibility: 'private', private: true, opaque: false, flags: [],
          consumers: [], blocked_by: [], counts: counts({}), exported: 0, symbols: 0 },
        { ...core, visibility: 'private', private: true, opaque: false, flags: [],
          consumers: ['npm:acme/app:@acme/app', 'npm:acme/repo-broken:@acme/broken'], blocked_by: ['npm:acme/repo-broken:@acme/broken:index_failed'],
          counts: blockedCounts(1, 1), exported: 2, symbols: 2 },
        { ...util, visibility: 'private', private: true, opaque: false, flags: [],
          consumers: ['npm:acme/app:@acme/app'], blocked_by: [],
          counts: counts({ delete: 2, unexport: 1, private_dead: 2 }), exported: 4, symbols: 6 },
        { ...open, visibility: 'published-public', private: false, opaque: false, flags: [], consumers: [], blocked_by: [],
          counts: counts({ deprecate: 3, org_dead: 4, unexport: 1, private_dead: 1 }), exported: 4, symbols: 6 },
        { ...pub, visibility: 'published-public', private: false, opaque: false, flags: [],
          consumers: ['npm:acme/app-dyn:@acme/dyn'], blocked_by: dynBlockers,
          counts: blockedCounts(2), exported: 2, symbols: 2 },
        { package_id: 'npm:acme/repo-broken:@acme/broken', name: '@acme/broken', repo: 'acme/repo-broken', visibility: 'private', private: true, opaque: true,
          flags: [{ flag: 'index_failed', reason: 'tsconfig.json: invalid JSON', file: null }],
          consumers: [], blocked_by: [], counts: counts({}), exported: 0, symbols: 0 },
      ],
      blockers: [
        { blocker_package_id: 'npm:acme/app-dyn:@acme/dyn', repo: 'acme/app-dyn', flags: ['dynamic_access', 'namespace_dynamic'],
          reasons: ["src/load.cts: require('@acme/' + name)", 'src/main.ts: P[key]'], blocks_packages: ['npm:acme/lib-pub:@acme/pub'], blocked_findings: 2,
          hint: "dynamic import / require: src/load.cts: require('@acme/' + name); dynamic namespace access: src/main.ts: P[key]" },
        { blocker_package_id: 'npm:acme/repo-broken:@acme/broken', repo: 'acme/repo-broken', flags: ['index_failed'],
          reasons: ['tsconfig.json: invalid JSON'], blocks_packages: ['npm:acme/lib-core:@acme/core'], blocked_findings: 1,
          hint: 'index failed: tsconfig.json: invalid JSON (log: <work>/index/acme__repo-broken/npm__repo-broken__acme__broken.log); '
            + 'nothing in the org depends on it; if it is an example or demo, exclude it in the org sentei.json: "ignoreManifests": ["repo-broken/packages/broken/package.json"]' },
      ],
      repos: [
        { repo: 'acme/app', head_sha: 'sha-app', index_status: 'ok' },
        { repo: 'acme/app-dyn', head_sha: 'sha-dyn', index_status: 'partial' },
        { repo: 'acme/lib-core', head_sha: 'sha-core', index_status: 'ok' },
        { repo: 'acme/lib-pub', head_sha: 'sha-pub', index_status: 'ok' },
        { repo: 'acme/repo-broken', head_sha: null, index_status: 'failed' },
      ],
    });
  });

  it('omits the age warning when the policy is on, reports trustPrivateRegistry in `private`, and survives JSON round-trip', () => {
    setPolicy('minAgeDays', 180);
    let report = buildReport({ db, now: NOW });
    expect(report.warnings.some((w) => w.includes('minAgeDays'))).toBe(false);
    expect(report.policy).toMatchObject({ minAgeDays: 180 });
    expect(report.policy).not.toHaveProperty('assumeClosedWorld');
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    run("UPDATE packages SET visibility = 'published-private' WHERE package_id = 'npm:acme/lib-core:@acme/util'");
    report = buildReport({ db, now: NOW });
    expect(report.packages.find((p) => p.package_id === 'npm:acme/lib-core:@acme/util')?.private).toBe(true);
    setPolicy('trustPrivateRegistry', false);
    report = buildReport({ db, now: NOW });
    expect(report.packages.find((p) => p.package_id === 'npm:acme/lib-core:@acme/util')?.private).toBe(false);
  });

  it('throws on a verdict no view places', () => {
    const d = openDb(':memory:');
    try {
      markAnalyzed(d);
      d.exec("PRAGMA ignore_check_constraints = ON");
      d.exec("INSERT INTO repos (repo) VALUES ('acme/x'); INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:acme/x:x', 'acme/x', '.', 'npm', 'x', 'private')");
      d.exec("INSERT INTO symbols (symbol_str, package_id, file, name) VALUES ('s', 'npm:acme/x:x', 'f', 's')");
      d.exec("INSERT INTO findings (symbol_id, verdict) VALUES (last_insert_rowid(), 'something_new')");
      expect(() => buildReport({ db: d, now: NOW })).toThrow(/no view for verdict "something_new"/);
    } finally {
      d.close();
    }
  });

  it('reports a missing policy key as null (the views read it as false)', () => {
    run("DELETE FROM policy WHERE key = 'countDocsAsConsumers'");
    expect(buildReport({ db, now: NOW }).policy.countDocsAsConsumers).toBeNull();
  });

  it('defaults generatedAt to the current time', () => {
    const before = Math.floor(Date.now() / 1000);
    const { generatedAt, generatedAtIso } = buildReport({ db });
    expect(generatedAt).toBeGreaterThanOrEqual(before);
    expect(generatedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(generatedAtIso).toBe(new Date(generatedAt * 1000).toISOString());
    expect(buildReport({ db, now: 1_700_000_000 }).generatedAtIso).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('skewSymbolName', () => {
  it('passes bare names through and takes the trailing descriptor of SCIP symbols', () => {
    expect(skewSymbolName('removedFn')).toBe('removedFn');
    expect(skewSymbolName('scip-typescript npm @acme/w . src/`index.ts`/removedFn().')).toBe('removedFn');
    expect(skewSymbolName('scip-typescript npm @acme/w . src/`index.ts`/Foo#')).toBe('Foo');
    expect(skewSymbolName('not a scip `symbol')).toBe('not a scip `symbol');
  });
});

describe('parseViews', () => {
  it('splits commas, accepts hyphens, dedupes into REPORT_VIEWS order, rejects unknown names', () => {
    expect(parseViews(['org-dead,delete', 'delete', ' private_dead '])).toEqual(['delete', 'org_dead', 'private_dead']);
    expect(parseViews([])).toEqual([]);
    expect(() => parseViews(['closed_world'])).toThrow(/--view: unknown view "closed_world" \(known: delete, deprecate, org_dead, /);
  });
});

describe('formatSummary', () => {
  it('shouts the warnings first, then packages, view totals, top blockers and version skew', () => {
    const text = formatSummary(buildReport({ db, now: NOW }));
    const lines = text.split('\n');
    expect(lines[0]).toBe(`sentei ${VERSION} report, generated 2023-11-14T22:13:20Z`);
    expect(lines[1]).toBe('policy: minAgeDays=0 trustPrivateRegistry=true countTestsAsConsumers=false countDocsAsConsumers=false');
    expect(lines[3]).toMatch(/^!{78}$/);
    expect(lines[4]).toMatch(/^!! WARNING: minAgeDays is 0/);
    expect(lines[7]).toMatch(/^!{78}$/);
    // Printable text only (no control codes); the one non-ASCII character is the cut-cell ellipsis.
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x20-\x7e\n\u2026]*$/);

    const header = lines.indexOf('Packages (7), 15 finding(s)');
    expect(header).toBeGreaterThan(7);
    expect(lines[header + 1]).toMatch(/^PACKAGE +REPO +VISIBILITY +PRIVATE +OPAQUE +DELETE +DEPRECATE +ORG-DEAD +UNEXPORT +PRIV-DEAD +REVIEW +BLOCKED +BLOCKED BY$/);
    // PACKAGE is the name, REPO the repo: together the package id, readable.
    const util = lines.find((l) => l.startsWith('@acme/util '));
    expect(util).toMatch(/^@acme\/util +acme\/lib-core +private +yes +2 +0 +0 +1 +2 +0 +0$/);
    expect(lines.find((l) => l.startsWith('@acme/open '))).toMatch(/^@acme\/open +acme\/lib-pub +published-public +0 +3 +4 +1 +1 +0 +0$/);
    const pub = lines.find((l) => l.startsWith('@acme/pub '));
    // Two blocker ids do not fit in one cell (MAX_CELL): the first, then a count.
    expect(pub).toMatch(/^@acme\/pub +acme\/lib-pub +published-public +0 .*npm:acme\/app-dyn:@acme\/dyn:dynamic_access … \+1 more \(report\.json\)$/);
    expect(lines.find((l) => l.startsWith('@acme/broken '))).toMatch(/acme\/repo-broken +private +yes +yes +0/);
    expect(lines.find((l) => l.startsWith('TOTAL '))).toMatch(/^TOTAL +2 +3 +4 +2 +3 +1 +3$/);
    // Every row of the package table has its BLOCKED BY column at the same offset.
    const col = lines[header + 1]!.indexOf('BLOCKED BY');
    expect(pub!.indexOf('npm:acme/app-dyn:@acme/dyn:')).toBe(col);

    // View totals: ORG-DEAD once, as the DEPRECATE count with a footnote; islands are a reason.
    const views = lines.indexOf('Views');
    expect(views).toBeGreaterThan(header);
    expect(lines.slice(views + 1, views + 9)).toEqual([
      '  DELETE            2  (no_refs 1, dead_island 1)',
      '  DEPRECATE         3  (no_refs 1, only_test_refs 1, dead_island 1)',
      '  ORG-DEAD          3*  (= DEPRECATE, + 1 private helper(s) they unlock)',
      '  UNEXPORT          2  (1 in published packages: deprecate the export first)',
      '  PRIV-DEAD         3',
      '  REVIEW            1',
      '  BLOCKED           3',
      '  VERSION-SKEW      3',
    ]);
    expect(lines[views + 9]).toBe('dead_island: exports used only by other candidates (delete / deprecate them together).');
    expect(lines[views + 10]).toBe(`* ORG-DEAD lists the DEPRECATE rows as deletions, asserting: ${ORG_DEAD_ASSERTION}`);

    const top = lines.indexOf('Top blockers (opaque consumers preventing verdicts; fix these first)');
    expect(top).toBeGreaterThan(views);
    expect(lines[top + 1]).toMatch(/^BLOCKER +REPO +FLAGS +FINDINGS +BLOCKS PACKAGES$/);
    expect(lines[top + 3]).toMatch(/^npm:acme\/app-dyn:@acme\/dyn +acme\/app-dyn +dynamic_access,namespace_dynamic +2 +npm:acme\/lib-pub:@acme\/pub$/);
    expect(lines[top + 4]).toMatch(/^npm:acme\/repo-broken:@acme\/broken +acme\/repo-broken +index_failed +1 +npm:acme\/lib-core:@acme\/core$/);
    expect(text.trimEnd().split('\n').at(-1)).toBe('Version skew: 3 reference(s) from 2 package(s) to symbols missing at HEAD');
  });

  it('breaks candidate rows down by only_docs_refs too (a row with test and docs uses counts once, as only_test_refs)', () => {
    const open = 'npm:acme/lib-pub:@acme/open';
    addFinding(addSymbol(open, 'openExample', { line: 10, col: 16 }), 'deprecation_candidate', ['only_docs_refs']);
    addFinding(addSymbol(open, 'openExample2', { line: 11, col: 16 }), 'deprecation_candidate', ['only_docs_refs']);
    addFinding(addSymbol(open, 'openBoth', { line: 12, col: 16 }), 'deprecation_candidate', ['only_test_refs', 'only_docs_refs']);
    const r = buildReport({ db, now: NOW });
    expect(r.findings.find((f) => f.symbol === 'openBoth')!.reasons).toEqual(['only_test_refs', 'only_docs_refs']);
    expect(formatSummary(r).split('\n')).toContain('  DEPRECATE         6  (no_refs 1, only_test_refs 2, only_docs_refs 2, dead_island 1)');
  });

  it('prints only the selected views (report --view)', () => {
    const lines = formatSummary(buildReport({ db, now: NOW }), { views: parseViews(['org-dead,delete']) }).split('\n');
    expect(lines[2]).toBe('views: delete, org_dead');
    const header = lines.findIndex((l) => l.startsWith('PACKAGE '));
    expect(lines[header]).toMatch(/^PACKAGE +REPO +VISIBILITY +PRIVATE +OPAQUE +DELETE +ORG-DEAD +BLOCKED BY$/);
    const views = lines.indexOf('Views');
    expect(lines.slice(views + 1, views + 3).map((l) => l.trim().split(/ +/)[0])).toEqual(['DELETE', 'ORG-DEAD']);
    expect(lines[views + 3]).toMatch(/^dead_island:/);
    expect(lines[views + 4]).toMatch(/^\* ORG-DEAD lists the DEPRECATE rows as deletions/);
    expect(lines.some((l) => l.startsWith('Top blockers') || l.startsWith('Version skew'))).toBe(false);
    // Without org_dead, no footnote.
    const plain = formatSummary(buildReport({ db, now: NOW }), { views: ['deprecate'] });
    expect(plain).not.toContain('ORG-DEAD');
    expect(plain).toContain('  DEPRECATE         3');
  });

  it('says so when nothing blocks and prints no warning banner when there are no warnings', () => {
    const empty = openDb(':memory:');
    try {
      empty.prepare("UPDATE policy SET value = '180' WHERE key = 'minAgeDays'").run();
      markAnalyzed(empty);
      const text = formatSummary(buildReport({ db: empty, now: NOW }));
      expect(text).not.toContain('WARNING');
      expect(text).toContain('Top blockers (opaque consumers preventing verdicts; fix these first)\n  none\n');
      expect(text).toContain('Version skew: 0 reference(s) from 0 package(s)');
    } finally {
      empty.close();
    }
  });
});

describe('buildReport guards and skew filtering', () => {
  it('refuses a DB that analyze has not processed', () => {
    const fresh = openDb(':memory:');
    try {
      expect(() => buildReport({ db: fresh, now: NOW })).toThrow(/not been analyzed; run analyze first/);
    } finally {
      fresh.close();
    }
  });

  const app = 'npm:acme/app:@acme/app';
  const util = 'npm:acme/lib-core:@acme/util';
  const SEED_SKEW = 3; // the seed's rows into healthy packages in other repos: real skew
  const skewTargets = (r: ReturnType<typeof buildReport>): string[] => r.versionSkew.map((v) => `${v.target_package_id}#${v.symbol}`);

  it('drops version skew into a package whose index failed, counting it under unresolved_opaque_target', () => {
    const broken = 'npm:acme/repo-broken:@acme/broken';
    addSkew(app, broken, 'scip-typescript npm @acme/broken . src/`index.ts`/anything().', 'src/main.ts', 1, 0);
    addSkew(app, broken, 'brokenName', 'src/main.ts', 2, 0);
    const r = buildReport({ db, now: NOW });
    expect(r.versionSkew.map((v) => v.target_package_id)).not.toContain(broken);
    expect(r.versionSkew).toHaveLength(SEED_SKEW);
    expect(r.diagnostics.unresolved_opaque_target).toEqual([{ target_package_id: broken, count: 2, examples: ['anything', 'brokenName'] }]);
    expect(r.warnings.some((w) => w.includes('unresolved reference'))).toBe(false);
  });

  it('a same-repo reference whose dependency admits HEAD is an indexing gap, not skew', () => {
    // Siblings of @acme/util (1.0.0) in acme/lib-core: a range HEAD satisfies, a
    // workspace dependency, and no declared dependency at all (hoisted).
    const range = addPackage('@acme/sib-range', 'acme/lib-core', 'private', [util]); // ^1.0.0
    const ws = addPackage('@acme/sib-ws', 'acme/lib-core', 'private', [util]);
    run("UPDATE package_deps SET dep_constraint = 'workspace:*' WHERE consumer_package_id = ?", ws);
    const hoisted = addPackage('@acme/sib-none', 'acme/lib-core');
    addSkew(range, util, 'scip-typescript npm @acme/util . src/`index.ts`/gapA().', 'packages/sib-range/src/a.ts', 1, 0);
    addSkew(range, util, 'scip-typescript npm @acme/util . src/`index.ts`/gapA().', 'packages/sib-range/src/a.ts', 5, 0);
    addSkew(ws, util, 'gapB', 'packages/sib-ws/src/a.ts', 1, 0);
    addSkew(hoisted, util, 'gapC', 'packages/sib-none/src/a.ts', 1, 0);
    addSkew(hoisted, util, 'gapD', 'packages/sib-none/src/a.ts', 2, 0);
    const r = buildReport({ db, now: NOW });
    expect(r.versionSkew).toHaveLength(SEED_SKEW);
    expect(r.diagnostics.unresolved_same_repo).toEqual([{ target_package_id: util, count: 5, examples: ['gapA', 'gapB', 'gapC'] }]);
    const text = formatSummary(r).trimEnd().split('\n');
    expect(text.at(-2)).toBe('Version skew: 3 reference(s) from 2 package(s) to symbols missing at HEAD');
    expect(text.at(-1)).toBe(`5 unresolved same-repo reference(s) (indexing gaps, not skew): ${util} 5`);
  });

  it('a same-repo consumer pinned to another version is still real skew (negative)', () => {
    // over_react_analyzer_plugin pins over_react 5.7.0 in the repo of over_react 5.8.0.
    const exact = addPackage('@acme/pin-exact', 'acme/lib-core', 'private', [util]);
    const major = addPackage('@acme/pin-major', 'acme/lib-core', 'private', [util]);
    const same = addPackage('@acme/pin-head', 'acme/lib-core', 'private', [util]);
    run("UPDATE package_deps SET dep_constraint = '0.9.0' WHERE consumer_package_id = ?", exact);
    run("UPDATE package_deps SET dep_constraint = '^0.9.0' WHERE consumer_package_id = ?", major);
    run("UPDATE package_deps SET dep_constraint = '1.0.0' WHERE consumer_package_id = ?", same);
    addSkew(exact, util, 'pinnedGone', 'packages/pin-exact/src/a.ts', 1, 0);
    addSkew(major, util, 'majorGone', 'packages/pin-major/src/a.ts', 1, 0);
    addSkew(same, util, 'headGap', 'packages/pin-head/src/a.ts', 1, 0);
    const r = buildReport({ db, now: NOW });
    expect(skewTargets(r)).toEqual(expect.arrayContaining([`${util}#pinnedGone`, `${util}#majorGone`]));
    expect(r.versionSkew).toHaveLength(SEED_SKEW + 2);
    expect(r.diagnostics.unresolved_same_repo).toEqual([{ target_package_id: util, count: 1, examples: ['headGap'] }]);
  });

  it('a target that is partial, has an unresolved (external alias) export, or exports nothing is not skew', () => {
    addRepo('acme/lib-partial', 'sha-p', 'partial');
    addRepo('acme/lib-alias', 'sha-a', 'ok');
    addRepo('acme/lib-empty', 'sha-e', 'ok');
    const partial = addPackage('@acme/partial', 'acme/lib-partial', 'private');
    const alias = addPackage('@acme/alias', 'acme/lib-alias', 'private');
    const empty = addPackage('@acme/empty', 'acme/lib-empty', 'private');
    addSymbol(partial, 'p1');
    addSymbol(alias, 'a1');
    addSymbol(empty, 'notExported', { exported: false });
    addFlag(partial, 'opaque_consumer', 'error TS2307', null);
    // `export { parse as parseCookies } from 'cookie'` with cookie not installed: the
    // target's own sidecar lists the export as unresolved (ingest: dynamic_access).
    addFlag(alias, 'dynamic_access', 'src/index.ts#parseCookies', null);
    addSkew(app, partial, 'partialName', 'src/main.ts', 1, 0);
    addSkew(app, alias, 'parseCookies', 'src/main.ts', 2, 0);
    addSkew(app, empty, 'emptyName', 'src/main.ts', 3, 0);
    const r = buildReport({ db, now: NOW });
    expect(r.versionSkew).toHaveLength(SEED_SKEW);
    expect(r.diagnostics.unresolved_opaque_target).toEqual([
      { target_package_id: alias, count: 1, examples: ['parseCookies'] },
      { target_package_id: empty, count: 1, examples: ['emptyName'] },
      { target_package_id: partial, count: 1, examples: ['partialName'] },
    ]);
  });

  it('deep dist imports and JSON-module members are unindexed modules, not skew; a missing source member stays skew', () => {
    addSkew(app, util, '*', 'src/deep.ts', 1, 0);
    addSkew(app, util, 'scip-typescript npm @acme/util . src/generated/`openapi.json`/`"k"0`:', 'src/json.ts', 1, 0);
    addSkew(app, util, 'scip-typescript npm @acme/util . src/generated/`openapi.ts`/goneFromTs().', 'src/json.ts', 2, 0);
    const r = buildReport({ db, now: NOW });
    expect(skewTargets(r)).toContain(`${util}#goneFromTs`);
    expect(r.versionSkew).toHaveLength(SEED_SKEW + 1);
    expect(r.diagnostics.unresolved_unindexed_module).toEqual([{ target_package_id: util, count: 2, examples: ['"k"0', '*'] }]);
    expect(formatSummary(r)).toContain(
      `2 unresolved reference(s) into unindexed modules (deep dist imports, JSON) (indexing gaps, not skew): ${util} 2\n`);
  });

  it('a name the target still defines at HEAD (moved file, accessor, inherited member) is not skew; a renamed owner stays skew', () => {
    // dart-lang: fixnum's Int64 moved to int64_native.dart behind a conditional export;
    // web_socket_channel's IOWebSocketChannel#sink is inherited from
    // AdapterWebSocketChannel at HEAD, and WebSocketChannel#stream from another org
    // package's StreamChannelMixin; web's ElementEventGetters was renamed (real skew).
    const P = 'scip-dart pub util . lib/';
    const sym = (pkg: string, str: string, name: string, parent: number | null = null): number => Number(db.prepare(
      'INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name, parent_symbol_id, is_exported) VALUES (?, ?, ?, 0, 0, NULL, ?, ?, ?)')
      .run(str, pkg, 'lib/x.dart', name, parent, parent === null ? 1 : 0).lastInsertRowid);
    const edge = (from: number, to: number, fromPkg: string, toPkg: string): void =>
      run("INSERT INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source) VALUES (?, ?, ?, ?, 'scip')", from, to, fromPkg, toPkg);
    const int64 = sym(util, `${P}src/\`int64_native.dart\`/Int64#`, 'Int64');
    sym(util, `${P}src/\`int64_native.dart\`/Int64#MAX_VALUE.`, 'MAX_VALUE', int64);
    sym(util, `${P}src/\`default.dart\`/\`<get>clock\`.`, '<get>clock');
    const io = sym(util, `${P}\`io.dart\`/IOWebSocketChannel#`, 'IOWebSocketChannel');
    const adapter = sym(util, `${P}\`adapter.dart\`/AdapterWebSocketChannel#`, 'AdapterWebSocketChannel');
    sym(util, `${P}\`adapter.dart\`/AdapterWebSocketChannel#sink.`, 'sink', adapter);
    edge(io, adapter, util, util);
    const channel = sym(util, `${P}src/\`channel.dart\`/WebSocketChannel#`, 'WebSocketChannel');
    addRepo('acme/stream', 'sha-s', 'ok');
    const stream = addPackage('@acme/stream', 'acme/stream');
    const mixin = sym(stream, 'scip-dart pub stream . lib/`stream_channel.dart`/StreamChannelMixin#', 'StreamChannelMixin');
    const iface = sym(stream, 'scip-dart pub stream . lib/`stream_channel.dart`/StreamChannel#', 'StreamChannel');
    sym(stream, 'scip-dart pub stream . lib/`stream_channel.dart`/StreamChannel#stream.', 'stream', iface);
    edge(channel, mixin, util, stream);
    edge(mixin, iface, stream, stream);
    // Members elsewhere that must NOT make these moved (negative): a same-named member
    // of an unrelated class, and an Events class the renamed owner's members moved to.
    const other = sym(util, `${P}\`other.dart\`/Other#`, 'Other');
    sym(util, `${P}\`other.dart\`/Other#close().`, 'close', other);
    const events = sym(util, `${P}\`events.dart\`/ElementEvents#`, 'ElementEvents');
    sym(util, `${P}\`events.dart\`/ElementEvents#\`<get>onClick\`.`, '<get>onClick', events);
    const moved = [
      `${P}src/\`int64.dart\`/Int64#`, `${P}src/\`int64.dart\`/Int64#MAX_VALUE.`, `${P}src/\`clock.dart\`/clock.`,
      `${P}\`io.dart\`/IOWebSocketChannel#sink.`, `${P}src/\`channel.dart\`/WebSocketChannel#\`<get>stream\`.`,
    ];
    const skew = [
      `${P}\`events.dart\`/ElementEventGetters#\`<get>onClick\`.`, // renamed owner
      `${P}\`io.dart\`/IOWebSocketChannel#close().`, // member gone; only an unrelated class has one
      `${P}src/\`int64.dart\`/Int64#gone.`, // owner moved, member gone
      `${P}\`gone.dart\`/`, // a missing file: never matches the empty descriptor
    ];
    for (const [i, str] of [...moved, ...skew].entries()) addSkew(app, util, str, 'src/main.ts', i + 1, 0);
    const r = buildReport({ db, now: NOW });
    expect(r.versionSkew).toHaveLength(SEED_SKEW + skew.length);
    expect(r.diagnostics.unresolved_moved_at_head).toEqual([
      { target_package_id: util, count: moved.length, examples: expect.any(Array) as unknown as string[] },
    ]);
    const cls = (db.prepare("SELECT symbol_str, class FROM unresolved_ref_classes WHERE consumer_package_id = ? AND file = 'src/main.ts' AND line > 0")
      .all(app) as Array<{ symbol_str: string; class: string }>).filter((x) => [...moved, ...skew].includes(x.symbol_str));
    expect(cls.filter((x) => x.class === 'moved_at_head').map((x) => x.symbol_str).sort()).toEqual([...moved].sort());
    expect(cls.filter((x) => x.class === 'version_skew').map((x) => x.symbol_str).sort()).toEqual([...skew].sort());
    expect(formatSummary(r)).toContain(`${moved.length} reference(s) to names HEAD defines elsewhere (moved file, accessor, inherited member) (the consumer's version declared them there; not skew): ${util} ${moved.length}\n`);
  });
});

describe('buildReport: dependencies on a name several org packages share', () => {
  it('says which package discover picked, or that none could be and the candidates are blocked', () => {
    addRepo('acme/fork', 'sha-fork', 'ok');
    const fork = addPackage('@acme/util', 'acme/fork');
    const util = 'npm:acme/lib-core:@acme/util';
    const app = 'npm:acme/app:@acme/app';
    const dyn = 'npm:acme/app-dyn:@acme/dyn';
    run("UPDATE package_deps SET resolution = 'published' WHERE consumer_package_id = ? AND dep_name = '@acme/util'", app);
    run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, ambiguous) VALUES (?, '@acme/util', 'npm', 1)", dyn);
    for (const t of [fork, util]) {
      run("INSERT INTO package_flags (package_id, flag, reason, file, target_package_id) VALUES (?, 'ambiguous_dep', ?, 'package.json', ?)",
        dyn, `dep @acme/util matches 2 org packages: ${fork}, ${util}`, t);
    }
    const r = buildReport({ db, now: NOW });
    expect(r.warnings).toContain(`${app} depends on @acme/util, which names several org packages; resolved to ${util} (published)`);
    expect(r.warnings).toContain(`ambiguous dependency: ${dyn} depends on @acme/util, which names several org packages (${fork}, ${util}); `
      + 'none could be preferred, so their verdicts are blocked (ambiguous_dep); exclude the wrong ones with ignoreManifests');
    expect(r.blockers.find((b) => b.blocker_package_id === dyn)!.flags).toContain('ambiguous_dep');
    expect(r.packages.find((p) => p.package_id === fork)!.blocked_by).toEqual([`${dyn}:ambiguous_dep`]);
  });
});

describe('buildReport: failed / partial repo warnings name what happened to each package', () => {
  it('a failed repo with one failed and one partial package says so for each (unifont)', () => {
    const d = openDb(':memory:');
    try {
      d.exec(`INSERT INTO repos (repo, index_status) VALUES ('acme/fonts', 'failed');
        INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES
          ('npm:acme/fonts:unifont', 'acme/fonts', '.', 'npm', 'unifont', 'private'),
          ('npm:acme/fonts:tools', 'acme/fonts', 'tools', 'npm', 'tools', 'private'),
          ('npm:acme/fonts:docs', 'acme/fonts', 'docs', 'npm', 'docs', 'private');
        INSERT INTO package_flags (package_id, flag, reason) VALUES
          ('npm:acme/fonts:unifont', 'opaque_consumer', 'warn: 3 missing entry points'),
          ('npm:acme/fonts:tools', 'index_failed', 'error: tsc crashed'),
          ('npm:acme/fonts:docs', 'opaque_consumer', 'discover: unresolved entry point ./dist/x.js');`);
      markAnalyzed(d);
      expect(buildReport({ db: d, now: NOW }).warnings).toContain(
        'repo acme/fonts: index failed for npm:acme/fonts:tools; index partial for npm:acme/fonts:unifont; opaque (discover) for npm:acme/fonts:docs; '
        + 'they are opaque and block verdicts for every org package they depend on',
      );
    } finally {
      d.close();
    }
  });
});

describe('buildReport: excluded repos that carry manifests', () => {
  it('discover persists them; report.json names every one, the summary the first ten', () => {
    const d = openDb(':memory:');
    try {
      const excludedRepos = [
        // supabase/supabase: excluded by the user, the org's main consumer monorepo.
        { repo: 'acme/supabase', reason: 'excluded by repos.exclude "supabase"', manifests: ['apps/studio/package.json', 'package.json'] },
        { repo: 'acme/hw', reason: 'language C not in repos.languages; no package.json or pubspec.yaml in the HEAD tree', manifests: [] },
        { repo: 'acme/old', reason: 'archived (--include-archived to keep)', manifests: null },
        ...Array.from({ length: 10 }, (_, i) => ({ repo: `acme/stale${i}`, reason: 'last push 2020-01-01 before repos.minPushed 730d', manifests: ['pubspec.yaml'] })),
        { repo: 'acme/zz-gone', reason: 'clone failed: git clone: timeout', manifests: ['package.json'] },
      ];
      writeDiscoverToDb(d, {
        org: 'acme', source: { kind: 'github', org: 'acme', apiUrl: 'x', lockfile: null, clonesDir: 'x' }, generatedAt: NOW,
        policy: defaultOrgConfig().policy, keep: [], repos: [], excludedRepos,
      });
      markAnalyzed(d);
      const report = buildReport({ db: d, now: NOW });
      const names = ['acme/stale0', 'acme/stale1', 'acme/stale2', 'acme/stale3', 'acme/stale4', 'acme/stale5', 'acme/stale6', 'acme/stale7', 'acme/stale8', 'acme/stale9'];
      const full = '12 excluded repo(s) have package manifests and may consume org packages (their references are invisible): '
        + `${names.map((n) => `${n} (minPushed, 1 manifest)`).join(', ')}, acme/supabase (repos.exclude, 2 manifests), acme/zz-gone (clone failed, 1 manifest)`;
      expect(report.warnings).toEqual([full]);
      const text = formatSummary(report);
      expect(text).toContain(`!! WARNING: 12 excluded repo(s) have package manifests and may consume org packages (their references are invisible): `
        + `${names.map((n) => `${n} (minPushed, 1 manifest)`).join(', ')} … and 2 more (all in report.json warnings)\n`);
      expect(text).not.toContain('acme/supabase');
      // A rediscover replaces the rows; no manifests → no warning.
      writeDiscoverToDb(d, {
        org: 'acme', source: { kind: 'local', dir: 'x' }, generatedAt: NOW, policy: defaultOrgConfig().policy, keep: [], repos: [],
      });
      expect(buildReport({ db: d, now: NOW }).warnings).toEqual([]);
    } finally {
      d.close();
    }
  });
});

describe('formatTable', () => {
  it('pads columns and right-aligns numbers', () => {
    expect(formatTable(['A', 'NUM'], [['long-name', '1'], ['x', '100']], ['l', 'r'])).toEqual([
      'A          NUM',
      '---------  ---',
      'long-name    1',
      'x          100',
    ]);
  });

  it(`cuts a cell longer than ${MAX_CELL} characters with an ellipsis`, () => {
    const long = 'x'.repeat(200);
    const [, , row] = formatTable(['A', 'B'], [[long, '1']], ['l', 'r']);
    expect(row).toBe(`${'x'.repeat(MAX_CELL - 1)}…  1`);
    expect(capCell('short')).toBe('short');
  });
});

describe('capList', () => {
  const ids = (n: number, len = 20): string[] => Array.from({ length: n }, (_, i) => `b${i}`.padEnd(len, '.'));

  it('names at most three items, then how many more are in report.json', () => {
    expect(capList(ids(3))).toBe(ids(3).join(', '));
    expect(capList(ids(10, 10))).toBe(`${ids(3, 10).join(', ')} … +7 more (report.json)`);
    expect(capList([])).toBe('');
  });

  it(`names only as many as fit in ${MAX_CELL} characters, at least one`, () => {
    // Blocker ids are long (`pub:dart-lang/<repo>:<name>:index_failed`).
    const long = ids(5, 45);
    expect(capList(long)).toBe(`${long[0]} … +4 more (report.json)`);
    expect(capList(ids(2, 45))).toBe(`${ids(2, 45)[0]} … +1 more (report.json)`);
    const huge = ids(2, 200);
    const cell = capList(huge);
    expect(cell.length).toBeLessThanOrEqual(MAX_CELL);
    expect(cell).toMatch(/^b0\.+… … \+1 more \(report\.json\)$/);
    expect(capList([huge[0]!])).toHaveLength(MAX_CELL);
  });
});

describe('formatSummary: long cells', () => {
  it('caps BLOCKED BY and BLOCKS PACKAGES; report.json keeps every id (dart-lang: 2517-character lines)', () => {
    const r = buildReport({ db, now: NOW });
    const blockers = Array.from({ length: 40 }, (_, i) => `pub:dart-lang/repo${i}:package_${i}:index_failed`);
    const pkg = r.packages.find((p) => p.name === '@acme/pub')!;
    pkg.blocked_by = blockers;
    r.blockers[0]!.blocks_packages = blockers.map((b) => b.replace(/:index_failed$/, ''));
    const lines = formatSummary(r).split('\n');
    const row = lines.find((l) => l.startsWith('@acme/pub '))!;
    expect(row).toContain(`${blockers[0]} … +39 more (report.json)`);
    const top = lines.indexOf('Top blockers (opaque consumers preventing verdicts; fix these first)');
    expect(lines[top + 3]).toMatch(/pub:dart-lang\/repo0:package_0 … \+39 more \(report\.json\)$/);
    // Every table line stays readable: no cell is longer than MAX_CELL.
    for (const l of lines) expect(l.length).toBeLessThan(400);
    expect(pkg.blocked_by).toHaveLength(40);
  });
});

describe('buildReport: manifests excluded by ignoreManifests', () => {
  it('discover persists them (config globs only); the report warns like it does for excluded repos', () => {
    const d = openDb(':memory:');
    try {
      const ignored = (manifest: string, ignoredBy?: string) => ({
        path: manifest.slice(0, manifest.lastIndexOf('/')) || '.', manifest, manager: 'pub' as const, name: null, deps: [], depsUnknown: false,
        ...(ignoredBy ? { ignoredBy } : {}),
      });
      writeDiscoverToDb(d, {
        org: 'acme', source: { kind: 'local', dir: 'x' }, generatedAt: NOW, policy: defaultOrgConfig().policy, keep: [],
        repos: [{
          repo: 'acme/over_react', localPath: 'x', defaultBranch: null, headSha: null, config: { extraEntryPoints: [], extraEdges: [], keep: [] }, packages: [],
          ignoredManifests: [
            ignored('app/over_react_redux/todo_client/pubspec.yaml', 'over_react/app/**'),
            ignored('example/pubspec.yaml'), // a default ignore dir: routine, not reported
            ...Array.from({ length: 11 }, (_, i) => ignored(`demos/d${i}/pubspec.yaml`, 'over_react/demos/*/pubspec.yaml')),
          ],
        }],
      });
      markAnalyzed(d);
      const report = buildReport({ db: d, now: NOW });
      expect(report.warnings).toHaveLength(1);
      const w = report.warnings[0]!;
      expect(w).toMatch(/^12 manifest\(s\) excluded by ignoreManifests are not org packages \(not indexed; only the text witness reads them\): /);
      expect(w).toContain('acme/over_react:app/over_react_redux/todo_client/pubspec.yaml ("over_react/app/**")');
      expect(w).not.toContain('example/pubspec.yaml');
      const text = formatSummary(report);
      expect(text).toContain('… and 2 more (all in report.json warnings)\n');
      // Rediscovering the repo without them clears the rows (cascade from repos).
      writeDiscoverToDb(d, { org: 'acme', source: { kind: 'local', dir: 'x' }, generatedAt: NOW, policy: defaultOrgConfig().policy, keep: [], repos: [] });
      expect(buildReport({ db: d, now: NOW }).warnings).toEqual([]);
    } finally {
      d.close();
    }
  });
});

describe('blocker hints', () => {
  const pkgOf = new Map([
    ['pub:acme/over_react:todo_client', { package_id: 'pub:acme/over_react:todo_client', repo: 'acme/over_react', path: 'app/todo_client', manager: 'pub', name: 'todo_client' }],
    ['npm:acme/a:@acme/x', { package_id: 'npm:acme/a:@acme/x', repo: 'acme/a', path: '.', manager: 'npm', name: '@acme/x' }],
    ['npm:acme/b:@acme/x', { package_id: 'npm:acme/b:@acme/x', repo: 'acme/b', path: 'packages/x', manager: 'npm', name: '@acme/x' }],
    ['npm:acme/app:app', { package_id: 'npm:acme/app:app', repo: 'acme/app', path: '.', manager: 'npm', name: 'app' }],
  ]);
  const flag = (f: string, reason: string | null, file: string | null = null, target: string | null = null) =>
    ({ flag: f, reason, file, target_package_id: target });

  it('index failure: first error line, the log, and for a package nothing depends on the ignoreManifests entry', () => {
    const reason = "error: dart pub get exited with 65: The lower bound of \"sdk: '>=2.11.0 <3.0.0'\" must be 2.12.0'\nmore output";
    const id = 'pub:acme/over_react:todo_client';
    expect(blockerHint(id, [flag('opaque_consumer', reason)], pkgOf, false, '/w')).toBe(
      'index partial: pre-null-safety SDK constraint, the current Dart SDK cannot resolve it: dart pub get exited with 65: '
      + "The lower bound of \"sdk: '>=2.11.0 <3.0.0'\" must be 2.12.0' (log: /w/index/acme__over_react/pub__over_react__todo_client.log); "
      + 'nothing in the org depends on it; if it is an example or demo, exclude it in the org sentei.json: '
      + '"ignoreManifests": ["over_react/app/todo_client/pubspec.yaml"]');
    // Something depends on it: fix the index, no ignore suggestion.
    expect(blockerHint(id, [flag('index_failed', 'error: tsc crashed')], pkgOf, true, '/w'))
      .toBe('index failed: tsc crashed (log: /w/index/acme__over_react/pub__over_react__todo_client.log)');
  });

  it('ambiguous dependency: candidates and the ignoreManifests entries (no pin exists)', () => {
    const reason = 'dep @acme/x matches 2 org packages: npm:acme/a:@acme/x, npm:acme/b:@acme/x';
    const rows = [flag('ambiguous_dep', reason, 'package.json', 'npm:acme/a:@acme/x'), flag('ambiguous_dep', reason, 'package.json', 'npm:acme/b:@acme/x')];
    expect(blockerHint('npm:acme/app:app', rows, pkgOf, false)).toBe(
      'dependency @acme/x names several org packages (npm:acme/a:@acme/x, npm:acme/b:@acme/x); sentei.json cannot pin a dependency, '
      + 'so exclude the ones it does not mean: "ignoreManifests": ["a/package.json", "b/packages/x/package.json"] minus the real one');
  });

  it('discover-unresolved entry point, unindexed code, dynamic access', () => {
    expect(blockerHint('npm:acme/app:app', [flag('opaque_consumer', 'discover: unresolved entry point ./dist/x.js', 'package.json')], pkgOf, false))
      .toBe('manifest entry point(s) resolve to no file: ./dist/x.js (package.json); build output missing from the checkout? '
        + 'The package surface is unknown until it resolves');
    expect(blockerHint('npm:acme/app:app', [flag('unindexed_consumer', '2 .py file(s), e.g. scripts/a.py', 'scripts/a.py')], pkgOf, false))
      .toBe('code in a language sentei cannot index: 2 .py file(s), e.g. scripts/a.py; its uses of org packages are invisible');
    expect(blockerHint('npm:acme/app:app', [flag('dynamic_access', "require(x)", 'a.cjs'), flag('dynamic_access', 'import(y)', 'b.ts')], pkgOf, false))
      .toBe('dynamic import / require: a.cjs: require(x) (+1 more)');
  });

  it('the summary prints a "What to do" line per shown blocker, with the work dir in log paths', () => {
    addFlag('npm:acme/app-dyn:@acme/dyn', 'index_failed', 'error: boom', null);
    const text = formatSummary(buildReport({ db, now: NOW, workDir: '/tmp/w' }));
    expect(text).toContain('What to do:\n  npm:acme/app-dyn:@acme/dyn: index failed: boom (log: /tmp/w/index/acme__app-dyn/npm__app-dyn__acme__dyn.log); ');
    expect(text).toContain('  npm:acme/repo-broken:@acme/broken: index failed: tsconfig.json: invalid JSON (log: /tmp/w/index/');
  });
});
