import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ASSUME_CLOSED_WORLD_WARNING } from '../src/report.ts';
import type { Report, ReportFinding } from '../src/report.ts';
import { buildSarif, SARIF_FINGERPRINT_KEY, SARIF_SCHEMA_URI, sarifRepoSlug, sarifRules } from '../src/sarif.ts';
import type { SarifLog, SarifResult } from '../src/sarif.ts';
import { sarifSchemaErrors } from './helpers/sarif.ts';

function finding(o: Partial<ReportFinding> & Pick<ReportFinding, 'symbol' | 'verdict'>): ReportFinding {
  return {
    package_id: 'npm:@acme/util', repo: 'acme/lib-core', file: 'src/index.ts', line: 1, col: 1, kind: 'Function',
    reasons: ['no_refs'], blocked_by: [], ...o,
  };
}

/** Every verdict/rule, a null position, a skew row, and a repo with nothing to report. */
function report(): Report {
  return {
    tool: { name: 'sentei', version: '0.0.0' },
    generatedAt: 1_700_000_000,
    policy: { minAgeDays: 180, trustPrivateRegistry: true, assumeClosedWorld: true, countTestsAsConsumers: false, countDocsAsConsumers: false },
    warnings: [ASSUME_CLOSED_WORLD_WARNING],
    findings: [
      finding({ symbol: 'unusedFn', verdict: 'deletion_candidate', file: 'src/fns.ts', line: 9, col: 17 }),
      finding({ symbol: 'internalOnly', verdict: 'unexport_candidate', reasons: ['internal_refs_only'], line: 3, col: 17 }),
      finding({ package_id: 'npm:@acme/pub', repo: 'acme/lib-pub', symbol: 'oldApi', verdict: 'deprecation_candidate' }),
      finding({ symbol: 'helper', verdict: 'private_dead', file: 'src/fns.ts', line: 21, col: 10, reasons: ['unlocked_by:unusedFn'] }),
      finding({ symbol: '_island', verdict: 'private_dead', file: 'src/fns.ts', line: null, col: null, reasons: ['already_unreachable'] }),
      finding({ symbol: 'mentioned', verdict: 'needs_review', reasons: ['no_refs', 'witness_mismatch:npm:@acme/app:src/main.ts:3'] }),
      finding({ package_id: 'npm:@acme/pub', repo: 'acme/lib-pub', symbol: 'pubB', verdict: 'blocked', line: 5, col: null,
        blocked_by: ['npm:@acme/dyn:dynamic_access', 'npm:@acme/dyn:namespace_dynamic'] }),
      finding({ symbol: 'weird name', verdict: 'deletion_candidate', file: 'src/a dir/x#y.ts', line: 2, col: 1 }),
    ],
    versionSkew: [
      { package_id: 'npm:@acme/app', repo: 'acme/app', symbol: 'removedFn', file: 'src/main.ts', line: 4, col: 10, target_package_id: 'npm:@acme/util' },
      { package_id: 'npm:@acme/app', repo: 'acme/app', symbol: 'removedFn', file: 'src/main.ts', line: 9, col: 3, target_package_id: 'npm:@acme/util' },
    ],
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
      ['sentei/deletion', 'warning'],
      ['sentei/unexport', 'note'],
      ['sentei/deprecation', 'note'],
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
    expect(run.properties.policy.assumeClosedWorld).toBe(true);
    expect(run.properties.warnings).toEqual([ASSUME_CLOSED_WORLD_WARNING]);
  });

  it('covers every rule across the org', () => {
    const used = new Set([...logs.values()].flatMap((l) => results(l).map((r) => r.ruleId)));
    expect([...used].sort()).toEqual(sarifRules().map((r) => r.id).sort());
  });

  it('builds a deletion result with location, message, fingerprint and properties', () => {
    const lib = logs.get('acme/lib-core');
    const r = bySymbol(lib, 'unusedFn');
    const rules = lib!.runs[0]!.tool.driver.rules;
    expect(r).toEqual({
      ruleId: 'sentei/deletion',
      ruleIndex: 0,
      level: 'warning',
      message: { text: '`unusedFn` in npm:@acme/util is a deletion candidate (reasons: no_refs).' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/fns.ts', uriBaseId: '%SRCROOT%' }, region: { startLine: 9, startColumn: 17 } } }],
      partialFingerprints: { [SARIF_FINGERPRINT_KEY]: sha('npm:@acme/util#unusedFn#src/fns.ts') },
      properties: { packageId: 'npm:@acme/util', symbol: 'unusedFn', kind: 'Function', verdict: 'deletion_candidate', reasons: ['no_refs'], blockedBy: [] },
    });
    for (const x of results(lib)) expect(rules[x.ruleIndex]!.id).toBe(x.ruleId);
  });

  it('names blockers in the message and omits unknown positions', () => {
    const b = bySymbol(logs.get('acme/lib-pub'), 'pubB');
    expect(b.message.text).toBe('`pubB` in npm:@acme/pub is blocked from a verdict (reasons: no_refs); blocked by npm:@acme/dyn:dynamic_access, npm:@acme/dyn:namespace_dynamic.');
    expect(b.locations[0]!.physicalLocation.region).toEqual({ startLine: 5 });
    expect(b.properties.blockedBy).toEqual(['npm:@acme/dyn:dynamic_access', 'npm:@acme/dyn:namespace_dynamic']);
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
    expect(skew[0]!.message.text).toContain('npm:@acme/util');
    const fps = skew.map((r) => r.partialFingerprints[SARIF_FINGERPRINT_KEY]);
    expect(new Set(fps).size).toBe(2);
    expect(fps[0]).toBe(sha('npm:@acme/app#removedFn#src/main.ts#npm:@acme/util'));
  });

  it('sorts results by ruleId, uri, line, symbol', () => {
    // 'src/a%20dir/x%23y.ts' < 'src/fns.ts' < 'src/index.ts'; then line; then symbol.
    expect(results(logs.get('acme/lib-core')).map((r) => [r.ruleId, r.properties.symbol])).toEqual([
      ['sentei/deletion', 'weird name'],
      ['sentei/deletion', 'unusedFn'],
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
