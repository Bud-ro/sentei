import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { ASSUME_CLOSED_WORLD_WARNING, buildReport, formatSummary, formatTable, skewSymbolName } from '../src/report.ts';

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
  const id = `npm:${name}`;
  run('INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, repo, '.', 'npm', name, '1.0.0', visibility, '["src/index.ts"]');
  for (const d of deps) {
    run('INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id) VALUES (?, ?, ?, ?, ?)',
      id, d.slice(4), 'npm', '^1.0.0', d);
  }
  return id;
}

function addSymbol(pkg: string, name: string, opts: { file?: string; line?: number | null; col?: number | null; kind?: string | null; exported?: boolean } = {}): number {
  const file = opts.file ?? 'src/index.ts';
  const r = db.prepare('INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`scip-typescript npm ${pkg.slice(4)} . src/\`${file.slice(4)}\`/${name}().`, pkg, file,
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
  if (verdict === 'deletion_candidate') run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', symbolId, NOW);
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
 *   acme/lib-core   ok       npm:@acme/util (private; deletion/unexport/private_dead)
 *                            npm:@acme/core (private; consumed by app + broken -> blocked by broken)
 *   acme/lib-pub    ok       npm:@acme/pub (published-public; consumed by dyn -> blocked by dyn)
 *   acme/app        ok       npm:@acme/app (consumer of util + core; version skew rows)
 *   acme/repo-broken failed  npm:@acme/broken (index_failed; consumer of core)
 *   acme/app-dyn    partial  npm:@acme/dyn (namespace_dynamic + dynamic_access; consumer of pub)
 */
/** What analyzeOrg leaves behind besides findings: the views and the analyzed_at marker. */
function markAnalyzed(d: DatabaseSync): void {
  d.exec(analyzeSql());
  d.prepare("INSERT OR REPLACE INTO run_params (key, value) VALUES ('analyzed_at', '0')").run();
}

function seed(): void {
  markAnalyzed(db);
  setPolicy('minAgeDays', 0);
  setPolicy('assumeClosedWorld', true);
  addRepo('acme/lib-core', 'sha-core', 'ok');
  addRepo('acme/lib-pub', 'sha-pub', 'ok');
  addRepo('acme/app', 'sha-app', 'ok');
  addRepo('acme/repo-broken', null, 'failed');
  addRepo('acme/app-dyn', 'sha-dyn', 'partial');
  const util = addPackage('@acme/util', 'acme/lib-core');
  const core = addPackage('@acme/core', 'acme/lib-core');
  const pub = addPackage('@acme/pub', 'acme/lib-pub', 'published-public');
  const app = addPackage('@acme/app', 'acme/app', 'private', [util, core]);
  const broken = addPackage('@acme/broken', 'acme/repo-broken', 'private', [core]);
  const dyn = addPackage('@acme/dyn', 'acme/app-dyn', 'private', [pub]);
  addFlag(broken, 'index_failed', 'tsconfig.json: invalid JSON', null);
  addFlag(dyn, 'namespace_dynamic', 'P[key]', 'src/main.ts');
  addFlag(dyn, 'dynamic_access', "require('@acme/' + name)", 'src/load.cts');

  addModule(util, 'src/index.ts');
  addFinding(addSymbol(util, 'unusedFn', { file: 'src/fns.ts', line: 8, col: 16 }), 'deletion_candidate', ['no_refs']);
  addFinding(addSymbol(util, 'internalOnly', { line: 2, col: 16, kind: null }), 'unexport_candidate', ['internal_refs_only']);
  addFinding(addSymbol(util, 'helper', { file: 'src/fns.ts', line: 20, col: 9, exported: false }), 'private_dead', ['unlocked_by:unusedFn']);
  addFinding(addSymbol(util, '_island', { file: 'src/fns.ts', line: null, col: null, exported: false }), 'private_dead', ['already_unreachable']);
  addSymbol(util, 'aliveFn');

  addFinding(addSymbol(core, 'coreDead'), BLOCKED, ['no_refs'], [`${broken}:index_failed`]);
  addFinding(addSymbol(core, 'coreMentioned'), 'needs_review', ['no_refs', 'witness_mismatch:npm:@acme/app:src/main.ts:3']);

  addFinding(addSymbol(pub, 'pubB'), BLOCKED, ['no_refs'], [`${dyn}:dynamic_access`, `${dyn}:namespace_dynamic`]);
  addFinding(addSymbol(pub, 'pubA'), BLOCKED, ['only_test_refs'], [`${dyn}:dynamic_access`, `${dyn}:namespace_dynamic`]);

  // Bare sidecar name, the same reference again as a SCIP symbol (deduped), and a SCIP-only one.
  addSkew(app, util, 'removedFn', 'src/main.ts', 3, 9);
  addSkew(app, util, 'scip-typescript npm @acme/util . src/`index.ts`/removedFn().', 'src/main.ts', 3, 9);
  addSkew(app, util, 'scip-typescript npm @acme/util . src/`index.ts`/Gone#method().', 'src/other.ts', 10, 0);
  addSkew(dyn, pub, 'oldPub', 'src/main.ts', null, null);
}

beforeEach(() => {
  db = openDb(':memory:');
  try {
    db.exec("SAVEPOINT probe; INSERT INTO repos (repo) VALUES ('probe/x'); INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:probe', 'probe/x', '.', 'npm', 'probe', 'private'); INSERT INTO symbols (symbol_str, package_id, file, name) VALUES ('probe', 'npm:probe', 'f', 'probe'); INSERT INTO findings (symbol_id, verdict) VALUES (last_insert_rowid(), 'blocked'); ROLLBACK TO probe; RELEASE probe;");
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
      deletion_candidate: 0, unexport_candidate: 0, deprecation_candidate: 0, private_dead: 0, needs_review: 0, blocked: 0, ...o,
    });
    const blockedCounts = (n: number, review = 0): Record<string, number> =>
      BLOCKED === 'blocked' ? counts({ blocked: n, needs_review: review }) : counts({ needs_review: n + review });
    expect(report).toEqual({
      tool: { name: 'sentei', version: VERSION },
      generatedAt: NOW,
      policy: { minAgeDays: 0, trustPrivateRegistry: true, assumeClosedWorld: true, countTestsAsConsumers: false, countDocsAsConsumers: false },
      warnings: [
        ASSUME_CLOSED_WORLD_WARNING,
        'minAgeDays is 0: age policy disabled; symbols of any age (including ones added yesterday) can be candidates',
        'repo acme/app-dyn: index partial; its packages are opaque and block verdicts for every org package they depend on',
        'repo acme/repo-broken: index failed; its packages are opaque and block verdicts for every org package they depend on',
      ],
      findings: [
        { package_id: 'npm:@acme/core', repo: 'acme/lib-core', symbol: 'coreDead', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
          verdict: BLOCKED, reasons: ['no_refs'], blocked_by: ['npm:@acme/broken:index_failed'] },
        { package_id: 'npm:@acme/core', repo: 'acme/lib-core', symbol: 'coreMentioned', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
          verdict: 'needs_review', reasons: ['no_refs', 'witness_mismatch:npm:@acme/app:src/main.ts:3'], blocked_by: [] },
        { package_id: 'npm:@acme/pub', repo: 'acme/lib-pub', symbol: 'pubA', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
          verdict: BLOCKED, reasons: ['only_test_refs'], blocked_by: ['npm:@acme/dyn:dynamic_access', 'npm:@acme/dyn:namespace_dynamic'] },
        { package_id: 'npm:@acme/pub', repo: 'acme/lib-pub', symbol: 'pubB', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
          verdict: BLOCKED, reasons: ['no_refs'], blocked_by: ['npm:@acme/dyn:dynamic_access', 'npm:@acme/dyn:namespace_dynamic'] },
        { package_id: 'npm:@acme/util', repo: 'acme/lib-core', symbol: '_island', file: 'src/fns.ts', line: null, col: null, kind: 'Function',
          verdict: 'private_dead', reasons: ['already_unreachable'], blocked_by: [] },
        { package_id: 'npm:@acme/util', repo: 'acme/lib-core', symbol: 'helper', file: 'src/fns.ts', line: 21, col: 10, kind: 'Function',
          verdict: 'private_dead', reasons: ['unlocked_by:unusedFn'], blocked_by: [] },
        { package_id: 'npm:@acme/util', repo: 'acme/lib-core', symbol: 'internalOnly', file: 'src/index.ts', line: 3, col: 17, kind: '',
          verdict: 'unexport_candidate', reasons: ['internal_refs_only'], blocked_by: [] },
        { package_id: 'npm:@acme/util', repo: 'acme/lib-core', symbol: 'unusedFn', file: 'src/fns.ts', line: 9, col: 17, kind: 'Function',
          verdict: 'deletion_candidate', reasons: ['no_refs'], blocked_by: [] },
      ],
      versionSkew: [
        { package_id: 'npm:@acme/app', repo: 'acme/app', symbol: 'method', file: 'src/other.ts', line: 11, col: 1, target_package_id: 'npm:@acme/util' },
        { package_id: 'npm:@acme/app', repo: 'acme/app', symbol: 'removedFn', file: 'src/main.ts', line: 4, col: 10, target_package_id: 'npm:@acme/util' },
        { package_id: 'npm:@acme/dyn', repo: 'acme/app-dyn', symbol: 'oldPub', file: 'src/main.ts', line: null, col: null, target_package_id: 'npm:@acme/pub' },
      ],
      packages: [
        { package_id: 'npm:@acme/app', repo: 'acme/app', visibility: 'private', closed_world: true, opaque: false, flags: [],
          consumers: [], blocked_by: [], counts: counts({}), exported: 0, symbols: 0 },
        { package_id: 'npm:@acme/broken', repo: 'acme/repo-broken', visibility: 'private', closed_world: true, opaque: true,
          flags: [{ flag: 'index_failed', reason: 'tsconfig.json: invalid JSON', file: null }],
          consumers: [], blocked_by: [], counts: counts({}), exported: 0, symbols: 0 },
        { package_id: 'npm:@acme/core', repo: 'acme/lib-core', visibility: 'private', closed_world: true, opaque: false, flags: [],
          consumers: ['npm:@acme/app', 'npm:@acme/broken'], blocked_by: ['npm:@acme/broken:index_failed'],
          counts: blockedCounts(1, 1), exported: 2, symbols: 2 },
        { package_id: 'npm:@acme/dyn', repo: 'acme/app-dyn', visibility: 'private', closed_world: true, opaque: true,
          flags: [
            { flag: 'dynamic_access', reason: "require('@acme/' + name)", file: 'src/load.cts' },
            { flag: 'namespace_dynamic', reason: 'P[key]', file: 'src/main.ts' },
          ],
          consumers: [], blocked_by: [], counts: counts({}), exported: 0, symbols: 0 },
        { package_id: 'npm:@acme/pub', repo: 'acme/lib-pub', visibility: 'published-public', closed_world: true, opaque: false, flags: [],
          consumers: ['npm:@acme/dyn'], blocked_by: ['npm:@acme/dyn:dynamic_access', 'npm:@acme/dyn:namespace_dynamic'],
          counts: blockedCounts(2), exported: 2, symbols: 2 },
        { package_id: 'npm:@acme/util', repo: 'acme/lib-core', visibility: 'private', closed_world: true, opaque: false, flags: [],
          consumers: ['npm:@acme/app'], blocked_by: [],
          counts: counts({ deletion_candidate: 1, unexport_candidate: 1, private_dead: 2 }), exported: 3, symbols: 5 },
      ],
      blockers: [
        { blocker_package_id: 'npm:@acme/dyn', repo: 'acme/app-dyn', flags: ['dynamic_access', 'namespace_dynamic'],
          reasons: ["src/load.cts: require('@acme/' + name)", 'src/main.ts: P[key]'], blocks_packages: ['npm:@acme/pub'], blocked_findings: 2 },
        { blocker_package_id: 'npm:@acme/broken', repo: 'acme/repo-broken', flags: ['index_failed'],
          reasons: ['tsconfig.json: invalid JSON'], blocks_packages: ['npm:@acme/core'], blocked_findings: 1 },
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

  it('omits the closed-world and age warnings when those policies are off, and survives JSON round-trip', () => {
    setPolicy('assumeClosedWorld', false);
    setPolicy('minAgeDays', 180);
    const report = buildReport({ db, now: NOW });
    expect(report.warnings.some((w) => w.includes('assumeClosedWorld'))).toBe(false);
    expect(report.warnings.some((w) => w.includes('minAgeDays'))).toBe(false);
    expect(report.policy).toMatchObject({ assumeClosedWorld: false, minAgeDays: 180 });
    // published-public @acme/pub is open-world without the override.
    expect(report.packages.find((p) => p.package_id === 'npm:@acme/pub')?.closed_world).toBe(false);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('reports a missing policy key as null (the views read it as false)', () => {
    run("DELETE FROM policy WHERE key = 'countDocsAsConsumers'");
    expect(buildReport({ db, now: NOW }).policy.countDocsAsConsumers).toBeNull();
  });

  it('defaults generatedAt to the current time', () => {
    const before = Math.floor(Date.now() / 1000);
    const { generatedAt } = buildReport({ db });
    expect(generatedAt).toBeGreaterThanOrEqual(before);
    expect(generatedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
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

describe('formatSummary', () => {
  it('shouts the warnings first, then packages, top blockers and version skew', () => {
    const text = formatSummary(buildReport({ db, now: NOW }));
    const lines = text.split('\n');
    expect(lines[0]).toBe(`sentei ${VERSION} report, generated 2023-11-14T22:13:20Z`);
    expect(lines[1]).toBe('policy: minAgeDays=0 trustPrivateRegistry=true assumeClosedWorld=true countTestsAsConsumers=false countDocsAsConsumers=false');
    expect(lines[3]).toMatch(/^!{78}$/);
    expect(lines[4]).toBe(`!! WARNING: ${ASSUME_CLOSED_WORLD_WARNING}`);
    expect(lines[8]).toMatch(/^!{78}$/);
    // eslint-disable-next-line no-control-regex
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);

    const header = lines.indexOf('Packages (6), 8 finding(s)');
    expect(header).toBeGreaterThan(8);
    expect(lines[header + 1]).toMatch(/^PACKAGE +VISIBILITY +WORLD +OPAQUE +DELETE +UNEXPORT +DEPRECATE +PRIV-DEAD +REVIEW +BLOCKED +BLOCKED BY$/);
    const util = lines.find((l) => l.startsWith('npm:@acme/util '));
    expect(util).toMatch(/^npm:@acme\/util +private +closed +1 +1 +0 +2 +0 +0$/);
    const pub = lines.find((l) => l.startsWith('npm:@acme/pub '));
    expect(pub).toMatch(/published-public +closed .*npm:@acme\/dyn:dynamic_access, npm:@acme\/dyn:namespace_dynamic$/);
    expect(lines.find((l) => l.startsWith('npm:@acme/broken '))).toMatch(/ +closed +yes +0/);
    expect(lines.find((l) => l.startsWith('TOTAL '))).toMatch(BLOCKED === 'blocked' ? /^TOTAL +1 +1 +0 +2 +1 +3$/ : /^TOTAL +1 +1 +0 +2 +4 +0$/);
    // Every row of the package table has its BLOCKED BY column at the same offset.
    const col = lines[header + 1]!.indexOf('BLOCKED BY');
    expect(pub!.indexOf('npm:@acme/dyn:')).toBe(col);

    const top = lines.indexOf('Top blockers (opaque consumers preventing verdicts; fix these first)');
    expect(top).toBeGreaterThan(header);
    expect(lines[top + 1]).toMatch(/^BLOCKER +REPO +FLAGS +FINDINGS +BLOCKS PACKAGES$/);
    expect(lines[top + 3]).toMatch(/^npm:@acme\/dyn +acme\/app-dyn +dynamic_access,namespace_dynamic +2 +npm:@acme\/pub$/);
    expect(lines[top + 4]).toMatch(/^npm:@acme\/broken +acme\/repo-broken +index_failed +1 +npm:@acme\/core$/);
    expect(text.trimEnd().split('\n').at(-1)).toBe('Version skew: 3 reference(s) from 2 package(s) to symbols missing at HEAD');
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

  it('drops version skew into a package whose index failed, with a warning counting it', () => {
    const app = 'npm:@acme/app';
    const broken = 'npm:@acme/broken';
    addSkew(app, broken, 'scip-typescript npm @acme/broken . src/`index.ts`/anything().', 'src/main.ts', 1, 0);
    addSkew(app, broken, 'brokenName', 'src/main.ts', 2, 0);
    const r = buildReport({ db, now: NOW });
    expect(r.versionSkew.map((v) => v.target_package_id)).not.toContain(broken);
    expect(r.versionSkew).toHaveLength(3); // the seed's rows into healthy packages stay
    expect(r.warnings).toContain(
      '2 unresolved reference(s) into package(s) whose index failed (npm:@acme/broken) not reported as version skew: their definitions are unknown, not missing',
    );
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
});
