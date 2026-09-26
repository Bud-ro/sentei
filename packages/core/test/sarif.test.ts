import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildViews, ORG_DEAD_ASSERTION, REPORT_VIEWS } from '../src/report.ts';
import type { Report, ReportFinding } from '../src/report.ts';
import { buildSarif, SARIF_FINGERPRINT_KEY, SARIF_SCHEMA_URI, sarifRepoSlug, sarifRules } from '../src/sarif.ts';
import type { SarifLog, SarifResult } from '../src/sarif.ts';
import { sarifSchemaErrors } from './helpers/sarif.ts';

function finding(o: Partial<ReportFinding> & Pick<ReportFinding, 'symbol' | 'verdict'>): ReportFinding {
  return {
    package_id: 'npm:acme/lib-core:@acme/util', name: '@acme/util', repo: 'acme/lib-core', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
    reasons: ['no_refs'], blocked_by: [], ...o,
  };
}

const PUB = { package_id: 'npm:acme/lib-pub:@acme/pub', name: '@acme/pub', repo: 'acme/lib-pub' };
const WARNING = 'minAgeDays is 0: age policy disabled';

/** Every verdict/view/rule, a null position, a skew row, and a repo with nothing to report. */
function report(): Report {
  const findings = [
    finding({ symbol: 'unusedFn', verdict: 'deletion_candidate', file: 'src/fns.ts', line: 9, col: 17 }),
    finding({ symbol: 'internalOnly', verdict: 'unexport_candidate', reasons: ['internal_refs_only'], line: 3, col: 17 }),
    finding({ ...PUB, symbol: 'oldApi', verdict: 'deprecation_candidate' }),
    finding({ ...PUB, symbol: 'pubInternal', verdict: 'deprecation_candidate', reasons: ['internal_refs_only'], line: 7 }),
    finding({ ...PUB, symbol: 'pubHelper', verdict: 'private_dead', reasons: ['unlocked_by:oldApi'], line: 12 }),
    finding({ symbol: 'helper', verdict: 'private_dead', file: 'src/fns.ts', line: 21, col: 10, reasons: ['unlocked_by:unusedFn'] }),
    finding({ symbol: '_island', verdict: 'private_dead', file: 'src/fns.ts', line: null, col: null, reasons: ['already_unreachable'] }),
    finding({ symbol: 'mentioned', verdict: 'needs_review', reasons: ['no_refs', 'witness_mismatch:npm:acme/app:@acme/app:src/main.ts:3'] }),
    finding({ ...PUB, symbol: 'pubB', verdict: 'blocked', line: 5, col: null,
      blocked_by: ['npm:acme/dyn:@acme/dyn:dynamic_access', 'npm:acme/dyn:@acme/dyn:namespace_dynamic'] }),
    finding({ symbol: 'weird name', verdict: 'deletion_candidate', file: 'src/a dir/x#y.ts', line: 2, col: 1 }),
  ];
  const versionSkew = [
    { package_id: 'npm:acme/app:@acme/app', repo: 'acme/app', symbol: 'removedFn', file: 'src/main.ts', line: 4, col: 10, target_package_id: 'npm:acme/lib-core:@acme/util' },
    { package_id: 'npm:acme/app:@acme/app', repo: 'acme/app', symbol: 'removedFn', file: 'src/main.ts', line: 9, col: 3, target_package_id: 'npm:acme/lib-core:@acme/util' },
  ];
  return {
    tool: { name: 'sentei', version: '0.0.0' },
    generatedAt: 1_700_000_000,
    generatedAtIso: '2023-11-14T22:13:20.000Z',
    policy: { minAgeDays: 180, trustPrivateRegistry: true, countTestsAsConsumers: false, countDocsAsConsumers: false },
    warnings: [WARNING],
    findings,
    versionSkew,
    views: buildViews(findings, versionSkew, new Set(['npm:acme/lib-core:@acme/util', 'npm:acme/app:@acme/app'])),
    packages: [],
    blockers: [],
    repos: [
      { repo: 'acme/app', head_sha: 'sha-app', index_status: 'ok' },
      { repo: 'acme/clean', head_sha: 'sha-clean', index_status: 'ok' },
      { repo: 'acme/lib-core', head_sha: 'sha-core', index_status: 'ok' },
      { repo: 'acme/lib-pub', head_sha: 'sha-pub', index_status: 'ok' },
    ],
  };
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const results = (log: SarifLog | undefined): SarifResult[] => log!.runs[0]!.results;
const bySymbol = (log: SarifLog | undefined, symbol: string): SarifResult =>
  results(log).find((r) => r.properties.symbol === symbol)!;

describe('buildSarif', () => {
  const logs = buildSarif(report());

  it('emits one log per repo, including a repo with zero results', () => {
    expect([...logs.keys()]).toEqual(['acme/app', 'acme/clean', 'acme/lib-core', 'acme/lib-pub']);
    expect(results(logs.get('acme/clean'))).toEqual([]);
    expect(logs.get('acme/clean')!.runs[0]!.properties.headSha).toBe('sha-clean');
  });

  it('every log validates against the vendored SARIF 2.1.0 schema', () => {
    for (const [repo, log] of logs) {
      expect({ repo, errors: sarifSchemaErrors(JSON.parse(JSON.stringify(log))) }).toEqual({ repo, errors: [] });
      // The OASIS schema (not the vendored draft-07 copy) requires this of every region.
      for (const r of results(log)) {
        const region = r.locations[0]!.physicalLocation.region;
        if (region !== undefined) expect(region.startLine).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('the validator rejects an invalid log (negative control)', () => {
    const bad = structuredClone(logs.get('acme/lib-core')!) as unknown as { runs: Array<{ results: Array<Record<string, unknown>> }> };
    bad.runs[0]!.results[0]!.level = 'fatal';
    expect(sarifSchemaErrors(bad).length).toBeGreaterThan(0);
  });

  it('has the SARIF envelope, driver, rules, base id and run properties', () => {
    const log = logs.get('acme/lib-core')!;
    expect(log.$schema).toBe(SARIF_SCHEMA_URI);
    expect(log.version).toBe('2.1.0');
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0]!;
    expect(run.tool.driver.name).toBe('sentei');
    expect(run.tool.driver.version).toBe('0.0.0');
    expect(run.tool.driver.rules.map((r) => [r.id, r.defaultConfiguration.level])).toEqual([
      ['sentei/delete', 'warning'],
      ['sentei/deprecate', 'note'],
      ['sentei/org-dead', 'warning'],
      ['sentei/unexport', 'note'],
      ['sentei/private-dead', 'note'],
      ['sentei/needs-review', 'note'],
      ['sentei/blocked', 'note'],
      ['sentei/version-skew', 'note'],
    ]);
    for (const r of run.tool.driver.rules) {
      expect(r.shortDescription.text).not.toBe('');
      expect(r.fullDescription.text).not.toBe('');
      expect(r.help.text).not.toBe('');
      expect(r.properties.tags).toContain('dead-code');
    }
    expect(Object.keys(run.originalUriBaseIds)).toEqual(['%SRCROOT%']);
    expect(run.properties.policy).toEqual(report().policy);
    expect(run.properties.warnings).toEqual([WARNING]);
    expect(run.properties.views).toEqual(REPORT_VIEWS.filter((v) => v !== 'org_dead'));
    expect(run.properties.assertions).toEqual([]);
  });

  it('by default covers every rule but org-dead, which asserts something about the world', () => {
    const used = new Set([...logs.values()].flatMap((l) => results(l).map((r) => r.ruleId)));
    expect([...used].sort()).toEqual(sarifRules().map((r) => r.id).filter((id) => id !== 'sentei/org-dead').sort());
  });

  it('puts published deprecations under deprecate, internal-only ones under unexport, and their helpers nowhere by default', () => {
    const pub = results(logs.get('acme/lib-pub'));
    expect(pub.map((r) => [r.ruleId, r.properties.symbol])).toEqual([
      ['sentei/blocked', 'pubB'],
      ['sentei/deprecate', 'oldApi'],
      ['sentei/unexport', 'pubInternal'],
    ]);
    expect(bySymbol(logs.get('acme/lib-pub'), 'pubInternal').message.text)
      .toBe('`pubInternal` in npm:acme/lib-pub:@acme/pub is an unexport candidate (published package: deprecate the export first) (reasons: internal_refs_only).');
  });

  it('--view org_dead: org-dead results only, with the assertion in the run and in every message', () => {
    const only = buildSarif(report(), { views: ['org_dead'] });
    for (const [repo, log] of only) expect({ repo, errors: sarifSchemaErrors(JSON.parse(JSON.stringify(log))) }).toEqual({ repo, errors: [] });
    const pub = only.get('acme/lib-pub')!;
    expect(pub.runs[0]!.properties.views).toEqual(['org_dead']);
    expect(pub.runs[0]!.properties.assertions).toEqual([{ view: 'org_dead', text: ORG_DEAD_ASSERTION }]);
    expect(results(pub).map((r) => [r.ruleId, r.level, r.properties.symbol, r.properties.verdict, r.properties.view])).toEqual([
      ['sentei/org-dead', 'warning', 'oldApi', 'deprecation_candidate', 'org_dead'],
      ['sentei/org-dead', 'warning', 'pubHelper', 'private_dead', 'org_dead'],
    ]);
    expect(bySymbol(pub, 'oldApi').message.text).toBe(
      `\`oldApi\` in npm:acme/lib-pub:@acme/pub is dead code as far as the org can see (reasons: no_refs). Assertion: ${ORG_DEAD_ASSERTION}`);
    expect(results(only.get('acme/lib-core'))).toEqual([]);
    expect(results(only.get('acme/app'))).toEqual([]);
    // ruleIndex is stable whatever the selection.
    expect(results(pub)[0]!.ruleIndex).toBe(2);
  });

  it('org-dead next to deprecate: the same fingerprint under each rule (collisions counted per rule)', () => {
    const both = results(buildSarif(report(), { views: ['deprecate', 'org_dead'] }).get('acme/lib-pub'));
    const fp = (rule: string): string | undefined =>
      both.find((r) => r.ruleId === rule && r.properties.symbol === 'oldApi')?.partialFingerprints[SARIF_FINGERPRINT_KEY];
    expect(fp('sentei/deprecate')).toBe(sha('npm:acme/lib-pub:@acme/pub#oldApi#src/index.ts'));
    expect(fp('sentei/org-dead')).toBe(fp('sentei/deprecate'));
  });

  it('builds a deletion result with location, message, fingerprint and properties', () => {
    const lib = logs.get('acme/lib-core');
    const r = bySymbol(lib, 'unusedFn');
    const rules = lib!.runs[0]!.tool.driver.rules;
    expect(r).toEqual({
      ruleId: 'sentei/delete',
      ruleIndex: 0,
      level: 'warning',
      message: { text: '`unusedFn` in npm:acme/lib-core:@acme/util is a deletion candidate (reasons: no_refs).' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/fns.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 9, startColumn: 17 } } }],
      partialFingerprints: { [SARIF_FINGERPRINT_KEY]: sha('npm:acme/lib-core:@acme/util#unusedFn#src/fns.ts') },
      properties: { packageId: 'npm:acme/lib-core:@acme/util', symbol: 'unusedFn', kind: 'Function', verdict: 'deletion_candidate', view: 'delete', reasons: ['no_refs'], blockedBy: [] },
    });
    for (const x of results(lib)) expect(rules[x.ruleIndex]!.id).toBe(x.ruleId);
  });

  it('names blockers in the message and omits unknown positions', () => {
    const b = bySymbol(logs.get('acme/lib-pub'), 'pubB');
    expect(b.message.text).toBe('`pubB` in npm:acme/lib-pub:@acme/pub is blocked from a verdict (reasons: no_refs); blocked by npm:acme/dyn:@acme/dyn:dynamic_access, npm:acme/dyn:@acme/dyn:namespace_dynamic.');
    expect(b.locations[0]!.physicalLocation.region).toEqual({ startLine: 5 });
    expect(b.properties.blockedBy).toEqual(['npm:acme/dyn:@acme/dyn:dynamic_access', 'npm:acme/dyn:@acme/dyn:namespace_dynamic']);
    const island = bySymbol(logs.get('acme/lib-core'), '_island');
    expect(island.locations[0]!.physicalLocation).toEqual({ artifactLocation: { uri: 'src/fns.ts', uriBaseId: '%SRCROOT%' } });
  });

  it('percent-encodes artifact URIs', () => {
    expect(bySymbol(logs.get('acme/lib-core'), 'weird name').locations[0]!.physicalLocation.artifactLocation.uri).toBe('src/a%20dir/x%23y.ts');
  });

  it('puts version skew in the consumer repo with distinct fingerprints per reference', () => {
    const skew = results(logs.get('acme/app'));
    expect(skew.map((r) => [r.ruleId, r.locations[0]!.physicalLocation.region?.startLine])).toEqual([
      ['sentei/version-skew', 4], ['sentei/version-skew', 9],
    ]);
    expect(skew[0]!.message.text).toContain('npm:acme/lib-core:@acme/util');
    const fps = skew.map((r) => r.partialFingerprints[SARIF_FINGERPRINT_KEY]);
    expect(new Set(fps).size).toBe(2);
    expect(fps[0]).toBe(sha('npm:acme/app:@acme/app#removedFn#src/main.ts#npm:acme/lib-core:@acme/util'));
  });

  it('sorts results by ruleId, uri, line, symbol', () => {
    // 'src/a%20dir/x%23y.ts' < 'src/fns.ts' < 'src/index.ts'; then line; then symbol.
    expect(results(logs.get('acme/lib-core')).map((r) => [r.ruleId, r.properties.symbol])).toEqual([
      ['sentei/delete', 'weird name'],
      ['sentei/delete', 'unusedFn'],
      ['sentei/needs-review', 'mentioned'],
      ['sentei/private-dead', '_island'],
      ['sentei/private-dead', 'helper'],
      ['sentei/unexport', 'internalOnly'],
    ]);
  });

  it('fingerprints ignore the line, so moved code keeps its identity', () => {
    const moved = report();
    moved.findings[0] = { ...moved.findings[0]!, line: 400, col: 3 };
    const a = bySymbol(logs.get('acme/lib-core'), 'unusedFn').partialFingerprints;
    const b = bySymbol(buildSarif(moved).get('acme/lib-core'), 'unusedFn').partialFingerprints;
    expect(b).toEqual(a);
  });

  it('is deterministic', () => {
    expect(JSON.stringify([...buildSarif(report())])).toBe(JSON.stringify([...logs]));
  });

  it('fails loudly on a verdict without a rule', () => {
    const r = report();
    r.findings.push(finding({ symbol: 'x', verdict: 'something_new' }));
    expect(() => buildSarif(r)).toThrow(/something_new/);
  });

  it('slugs repo names for file names', () => {
    expect(sarifRepoSlug('acme/lib-core')).toBe('acme__lib-core');
  });
});
