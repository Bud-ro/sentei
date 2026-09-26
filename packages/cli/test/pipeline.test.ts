// M1 acceptance test (PLAN.md §10): the whole pipeline on a temp copy of
// fixtures/org-small must reproduce expected-findings*.json EXACTLY.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@sentei/core/db';
import type { Report, SarifLog } from '@sentei/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { StageContext } from '../src/context.ts';
import { analyze } from '../src/stages/analyze.ts';
import { discover } from '../src/stages/discover.ts';
import { index } from '../src/stages/index.ts';
import { ingest } from '../src/stages/ingest.ts';
import { report } from '../src/stages/report.ts';
import { witness } from '../src/stages/witness.ts';
import { sarifSchemaErrors } from '../../core/test/helpers/sarif.ts';
import { dropFlutterRepos, FLUTTER_REPOS, hasFlutter } from '../../../scripts/update-snapshots.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures');
const NO_NODE_MODULES = { recursive: true, filter: (src: string) => path.basename(src) !== 'node_modules' };

interface ExpectedRow {
  package_id: string;
  symbol: string;
  file: string;
  verdict: string;
  reasons: string[];
  blocked_by?: string[];
}

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

/** Copy fixtures/<name> (minus node_modules) into a fresh temp dir; returns the copy's path. */
function copyFixture(name: string): string {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-pipeline-')));
  tmps.push(tmp);
  const org = path.join(tmp, name);
  cpSync(path.join(FIXTURES, name), org, NO_NODE_MODULES);
  return org;
}

async function withCtx<T>(orgDir: string, fn: (ctx: StageContext, lines: string[]) => Promise<T>): Promise<T> {
  const work = path.join(path.dirname(orgDir), 'work');
  mkdirSync(work, { recursive: true });
  const dbPath = path.join(work, 'sentei.db');
  const db = openDb(dbPath);
  const lines: string[] = [];
  try {
    return await fn({ work, dbPath, db, orgDir, log: (l) => lines.push(l) }, lines);
  } finally {
    db.close();
  }
}

/** Run every stage and return report.json mapped to the expected-findings row shape. */
async function runPipeline(orgDir: string): Promise<{ rows: ExpectedRow[]; report: Report; lines: string[]; work: string }> {
  return withCtx(orgDir, async (ctx, lines) => {
    await discover(ctx);
    await index(ctx, { install: false });
    await ingest(ctx);
    await analyze(ctx);
    await witness(ctx);
    await report(ctx);
    const r = JSON.parse(readFileSync(path.join(ctx.work, 'report.json'), 'utf8')) as Report;
    const rows: ExpectedRow[] = [
      ...r.findings.map((f) => ({
        package_id: f.package_id,
        symbol: f.symbol,
        file: f.file,
        verdict: f.verdict,
        reasons: f.reasons,
        ...(f.blocked_by.length > 0 ? { blocked_by: f.blocked_by } : {}),
      })),
      ...r.versionSkew.map((v) => ({
        package_id: v.package_id,
        symbol: v.symbol,
        file: v.file,
        verdict: 'version_skew',
        reasons: [`target:${v.target_package_id}`],
      })),
    ];
    return { rows: sortRows(rows), report: r, lines, work: ctx.work };
  });
}

function sortRows(rows: ExpectedRow[]): ExpectedRow[] {
  const key = (r: ExpectedRow): string[] => [r.package_id, r.symbol, r.verdict, r.file];
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  });
}

function expected(file: string): ExpectedRow[] {
  return sortRows(JSON.parse(readFileSync(path.join(FIXTURES, 'org-small', file), 'utf8')) as ExpectedRow[]);
}

describe('M1 acceptance: full pipeline on fixtures/org-small', () => {
  it('closed world (sentei.json as checked in) matches expected-findings.json exactly', async () => {
    const org = copyFixture('org-small');
    const { rows, report: r, lines, work } = await runPipeline(org);
    expect(r.policy.assumeClosedWorld).toBe(true);
    expect(r.warnings[0]).toMatch(/^assumeClosedWorld is ON/);
    expect(lines.some((l) => l.includes('WARNING: assumeClosedWorld is ON'))).toBe(true);
    expect(rows).toEqual(expected('expected-findings.json'));

    // M5: one SARIF log per repo, schema-valid, carrying the deletion candidate.
    for (const { repo } of r.repos) {
      expect(existsSync(path.join(work, 'sarif', `${repo.replaceAll('/', '__')}.sarif`)), repo).toBe(true);
    }
    const sarif = JSON.parse(readFileSync(path.join(work, 'sarif', 'acme__lib-core.sarif'), 'utf8')) as SarifLog;
    expect(sarifSchemaErrors(sarif)).toEqual([]);
    expect(sarif.runs[0]!.properties.warnings[0]).toMatch(/^assumeClosedWorld is ON/);
    expect(sarif.runs[0]!.results.some((x) => x.ruleId === 'sentei/deletion' && x.properties.symbol === 'unusedFn'
      && x.locations[0]!.physicalLocation.artifactLocation.uri === 'src/fns.ts')).toBe(true);
  }, 180_000);

  it('open world (assumeClosedWorld: false) matches expected-findings.open-world.json exactly', async () => {
    const org = copyFixture('org-small');
    const cfgPath = path.join(org, 'sentei.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, assumeClosedWorld: false }, null, 2));
    const { rows, report: r } = await runPipeline(org);
    expect(r.policy.assumeClosedWorld).toBe(false);
    expect(r.warnings.some((w) => w.includes('assumeClosedWorld'))).toBe(false);
    expect(rows).toEqual(expected('expected-findings.open-world.json'));
  }, 180_000);
});

// Package identity is <manager>:<repo>:<name>: repos `one` and `two` both have
// `@acme/dup` (two's is private), consumer `three` depends on `@acme/dup` and uses a
// symbol only `one` defines. Resolution must pick `one` (the only published candidate),
// the report must say so, and `two` is a package of its own with no consumer.
describe('full pipeline on fixtures/org-dup (same package name in two repos)', () => {
  it('resolves the consumer to the published package and matches expected-findings.json exactly', async () => {
    const org = copyFixture('org-dup');
    const { rows, report: r, lines } = await runPipeline(org);
    const want = sortRows(JSON.parse(readFileSync(path.join(FIXTURES, 'org-dup', 'expected-findings.json'), 'utf8')) as ExpectedRow[]);
    expect(rows).toEqual(want);
    expect(r.packages.map((p) => [p.package_id, p.name, p.repo, p.consumers])).toEqual([
      ['npm:acme/one:@acme/dup', '@acme/dup', 'acme/one', ['npm:acme/three:@acme/three']],
      ['npm:acme/three:@acme/three', '@acme/three', 'acme/three', []],
      ['npm:acme/two:@acme/dup', '@acme/dup', 'acme/two', []],
    ]);
    expect(r.warnings).toContain(
      'npm:acme/three:@acme/three depends on @acme/dup, which names several org packages; resolved to npm:acme/one:@acme/dup (published)');
    expect(lines).toContain('[discover] note: 2 org packages are named npm:@acme/dup: npm:acme/one:@acme/dup, npm:acme/two:@acme/dup');
    expect(lines).toContain(
      '[discover] acme/three: npm:acme/three:@acme/three dep @acme/dup matches 2 org packages; resolved to npm:acme/one:@acme/dup (published)');
    expect(r.versionSkew).toEqual([]);
  }, 180_000);
});

// M3 acceptance (PLAN.md §10): the same pipeline on fixtures/org-dart (scip-dart).
const HAS_DART = spawnSync('dart', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!HAS_DART) console.warn('[pipeline.test] SKIPPING M3 acceptance: `dart` is not on PATH');
const HAS_FLUTTER = hasFlutter();
if (HAS_DART && !HAS_FLUTTER) console.warn('[pipeline.test] M3 acceptance WITHOUT the Flutter repos of fixtures/org-dart: `flutter` is not on PATH');
const DART_FLUTTER = FLUTTER_REPOS['org-dart']!;

/** Copy fixtures/org-dart; without `flutter`, minus its Flutter repos. */
function copyDartFixture(): string {
  const org = copyFixture('org-dart');
  if (!HAS_FLUTTER) dropFlutterRepos('org-dart', org);
  return org;
}

function expectedDart(file: string): ExpectedRow[] {
  const rows = JSON.parse(readFileSync(path.join(FIXTURES, 'org-dart', file), 'utf8')) as ExpectedRow[];
  const flutterPkgs = new Set(Object.values(DART_FLUTTER));
  // A package id ends in its pub name (`pub:<name>` or `pub:<repo>:<name>`).
  return sortRows(HAS_FLUTTER ? rows : rows.filter((r) => !flutterPkgs.has(r.package_id.slice(r.package_id.lastIndexOf(':') + 1))));
}

describe('M3 acceptance: full pipeline on fixtures/org-dart', () => {
  it.skipIf(!HAS_DART)('closed world (sentei.json as checked in) matches expected-findings.json exactly', async () => {
    const org = copyDartFixture();
    const { rows, report: r } = await runPipeline(org);
    expect(r.policy.assumeClosedWorld).toBe(true);
    expect(r.repos.map((x) => [x.repo, x.index_status]).sort()).toEqual([
      ['acme/dart-app', 'ok'],
      ['acme/dart-lib-pub', 'ok'],
      ['acme/dart-lib-x', 'ok'],
      ...(HAS_FLUTTER ? Object.keys(DART_FLUTTER).sort().map((n) => [`acme/${n}`, 'ok']) : []),
    ]);
    expect(rows).toEqual(expectedDart('expected-findings.json'));
  }, 600_000);

  it.skipIf(!HAS_DART)('open world (assumeClosedWorld: false) matches expected-findings.open-world.json exactly', async () => {
    const org = copyDartFixture();
    const cfgPath = path.join(org, 'sentei.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, assumeClosedWorld: false }, null, 2));
    const { rows, report: r } = await runPipeline(org);
    expect(r.policy.assumeClosedWorld).toBe(false);
    expect(rows).toEqual(expectedDart('expected-findings.open-world.json'));
  }, 600_000);
});
