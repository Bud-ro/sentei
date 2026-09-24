// SARIF 2.1.0 output (PLAN.md §6.7, M5): one log per repo, built from the Report.
// Pure: no I/O, no DB. The CLI `report` stage writes <work>/sarif/<repo slug>.sarif.
//
// Conventions:
//   * One log per repo, because GitHub Code Scanning uploads are per repo (and per
//     commit). Every repo gets a log, even with zero results, so that uploading a
//     clean log closes the alerts of an earlier upload.
//   * Locations are repo-relative POSIX URIs under uriBaseId %SRCROOT% (the value
//     GitHub and CodeQL use for "the checkout root"). The base itself is left
//     undefined (description only): sentei does not know where the consumer of the
//     log checked the repo out, and a made-up absolute base would be wrong.
//   * Regions are 1-based (Report is already 1-based); columns are UTF-16 code units
//     (SCIP's TypeScript positions). A null line drops the region; a null col drops
//     startColumn.
//   * partialFingerprints["senteiSymbol/v1"] is sha256 of `<package_id>#<symbol>#<file>`
//     (never the line), so moving code within a file keeps the alert's identity.
//   * Results are sorted by ruleId, uri, line, symbol: byte-stable output.
import { createHash } from 'node:crypto';
import type { Report, ReportFinding, ReportVersionSkew } from './report.ts';

export const SARIF_SCHEMA_URI = 'https://json.schemastore.org/sarif-2.1.0.json';
export const SARIF_SRCROOT = '%SRCROOT%';
export const SARIF_FINGERPRINT_KEY = 'senteiSymbol/v1';

// ---- minimal SARIF types (only what sentei emits) ---------------------------------

export type SarifLevel = 'none' | 'note' | 'warning' | 'error';

export interface SarifMessage {
  text: string;
}

export interface SarifRule {
  id: string;
  name: string;
  shortDescription: SarifMessage;
  fullDescription: SarifMessage;
  defaultConfiguration: { level: SarifLevel };
  help: SarifMessage;
  properties: { tags: string[] };
}

export interface SarifRegion {
  startLine: number;
  startColumn?: number;
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region?: SarifRegion;
  };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: SarifMessage;
  locations: SarifLocation[];
  partialFingerprints: Record<string, string>;
  properties: Record<string, unknown>;
}

export interface SarifRun {
  tool: {
    driver: { name: string; version: string; semanticVersion?: string; informationUri?: string; rules: SarifRule[] };
  };
  originalUriBaseIds: Record<string, { uri?: string; description?: SarifMessage }>;
  columnKind: 'utf16CodeUnits' | 'unicodeCodePoints';
  results: SarifResult[];
  properties: { repo: string; headSha: string | null; indexStatus: string | null; policy: Report['policy']; warnings: string[] };
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

export interface BuildSarifOptions {
  /** tool.driver.informationUri; omitted when unset (sentei has no canonical URL yet). */
  informationUri?: string;
}

// ---- rules ---------------------------------------------------------------------------

interface RuleSpec {
  rule: SarifRule;
  /** Report verdict this rule reports; null for version skew (not a finding). */
  verdict: string | null;
  /** Human phrase for the message: "<symbol> ... is <phrase>". */
  phrase: string;
}

function rule(id: string, name: string, level: SarifLevel, short: string, full: string, help: string, tags: string[]): SarifRule {
  return {
    id,
    name,
    shortDescription: { text: short },
    fullDescription: { text: full },
    defaultConfiguration: { level },
    help: { text: help },
    properties: { tags: ['dead-code', ...tags] },
  };
}

const RULE_SPECS: readonly RuleSpec[] = [
  {
    verdict: 'deletion_candidate',
    phrase: 'a deletion candidate',
    rule: rule('sentei/deletion', 'DeletionCandidate', 'warning',
      'Exported symbol is unused across the whole org',
      'No precise-indexer reference to this exported symbol exists anywhere in the org (or only test references, per policy), the package is closed-world, no consumer is opaque, and a text witness search found no mention. It can be deleted.',
      'Delete the symbol. sentei only emits this when every consumer of the package was indexed cleanly and the package is closed-world; if the package is published to a public registry, confirm there are no external consumers first (see run.properties.warnings for assumeClosedWorld).',
      ['maintainability']),
  },
  {
    verdict: 'unexport_candidate',
    phrase: 'an unexport candidate',
    rule: rule('sentei/unexport', 'UnexportCandidate', 'note',
      'Exported symbol is only used inside its own package',
      'This exported symbol has references only from within its own package; no other org package uses it. It can stay but does not need to be part of the public surface.',
      'Remove the export (keep the declaration). This shrinks the package API; it is a breaking change for any consumer outside the org.',
      ['maintainability', 'api-surface']),
  },
  {
    verdict: 'deprecation_candidate',
    phrase: 'a deprecation candidate',
    rule: rule('sentei/deprecation', 'DeprecationCandidate', 'note',
      'Exported symbol of an open-world package has no org consumers',
      'No org package references this exported symbol, but the package is published publicly (open world), so external consumers may exist. Deprecate before deleting.',
      'Mark the symbol deprecated and remove it in a later major version.',
      ['maintainability', 'api-surface']),
  },
  {
    verdict: 'private_dead',
    phrase: 'dead private code',
    rule: rule('sentei/private-dead', 'PrivateDead', 'note',
      'Non-exported symbol is unreachable from any live code',
      'This non-exported symbol is not reachable from any live export or entry point of its package (already unreachable, or only reachable from deletion candidates).',
      'Delete the symbol together with the candidates that unlock it (see reasons: unlocked_by:<symbol>).',
      ['maintainability']),
  },
  {
    verdict: 'needs_review',
    phrase: 'in need of human review',
    rule: rule('sentei/needs-review', 'NeedsReview', 'note',
      'Symbol looks unused but the evidence is inconclusive',
      'The index shows no references, but a secondary check (e.g. the text witness search) disagrees or could not run. sentei fails closed: treat the symbol as alive until a human checks the reasons.',
      'Read the reasons (e.g. witness_mismatch:<consumer>:<file>:<line> names the text hit) and decide by hand.',
      ['review']),
  },
  {
    verdict: 'blocked',
    phrase: 'blocked from a verdict',
    rule: rule('sentei/blocked', 'Blocked', 'note',
      'No verdict: an opaque consumer prevents analysis',
      'This symbol has no references in the indexed code, but at least one consumer of its package is opaque (failed/partial index, dynamic access, namespace dynamic access). sentei makes no verdict until the blocker is fixed.',
      'Fix the blocking consumer listed in blockedBy (e.g. its tsconfig or its dynamic import), then re-run sentei.',
      ['blocked']),
  },
  {
    verdict: null,
    phrase: 'version skew',
    rule: rule('sentei/version-skew', 'VersionSkew', 'note',
      'Reference to a symbol that no longer exists at the target package HEAD',
      'This package references a symbol of another org package that is not present at that package\'s HEAD: it depends on an older published version. The reference keeps nothing alive at HEAD and will break on upgrade.',
      'Upgrade the dependency and migrate off the removed symbol, or restore it in the target package.',
      ['version-skew']),
  },
];

const RULES: readonly SarifRule[] = RULE_SPECS.map((s) => s.rule);
const SPEC_BY_VERDICT = new Map(RULE_SPECS.filter((s) => s.verdict !== null).map((s) => [s.verdict!, s]));
const SKEW_SPEC = RULE_SPECS.find((s) => s.verdict === null)!;
const RULE_INDEX = new Map(RULES.map((r, i) => [r.id, i]));

/** The rules every sentei SARIF run declares, in ruleIndex order. */
export function sarifRules(): SarifRule[] {
  return structuredClone([...RULES]);
}

// ---- helpers -------------------------------------------------------------------------

/** Code-unit order (locale-independent, byte-stable). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `acme/lib-core` -> `acme__lib-core` (file name of the repo's SARIF log). */
export function sarifRepoSlug(repo: string): string {
  return repo.replaceAll('/', '__');
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Repo-relative POSIX path -> URI reference (percent-encode per segment; keep '/'). */
function toUri(file: string): string {
  return file
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function location(file: string, line: number | null, col: number | null): SarifLocation {
  const physicalLocation: SarifLocation['physicalLocation'] = {
    artifactLocation: { uri: toUri(file), uriBaseId: SARIF_SRCROOT },
  };
  if (line !== null && line >= 1) {
    physicalLocation.region = col !== null && col >= 1 ? { startLine: line, startColumn: col } : { startLine: line };
  }
  return { physicalLocation };
}

function list(xs: string[]): string {
  return xs.join(', ');
}

function findingMessage(f: ReportFinding, spec: RuleSpec): string {
  let s = `\`${f.symbol}\` in ${f.package_id} is ${spec.phrase}`;
  s += f.reasons.length > 0 ? ` (reasons: ${list(f.reasons)})` : '';
  s += f.blocked_by.length > 0 ? `; blocked by ${list(f.blocked_by)}` : '';
  return `${s}.`;
}

function skewMessage(v: ReportVersionSkew): string {
  return `\`${v.symbol}\` is referenced here by ${v.package_id} but no longer exists in ${v.target_package_id} at HEAD (version skew: this package depends on an older version of ${v.target_package_id}).`;
}

interface Pending {
  result: SarifResult;
  symbol: string;
  line: number;
  fingerprintKey: string;
}

function findingResult(f: ReportFinding): Pending {
  const spec = SPEC_BY_VERDICT.get(f.verdict);
  if (spec === undefined) throw new Error(`sarif: no SARIF rule for verdict ${JSON.stringify(f.verdict)} (${f.package_id}#${f.symbol})`);
  return {
    symbol: f.symbol,
    line: f.line ?? 0,
    fingerprintKey: `${f.package_id}#${f.symbol}#${f.file}`,
    result: {
      ruleId: spec.rule.id,
      ruleIndex: RULE_INDEX.get(spec.rule.id)!,
      level: spec.rule.defaultConfiguration.level,
      message: { text: findingMessage(f, spec) },
      locations: [location(f.file, f.line, f.col)],
      partialFingerprints: {},
      properties: {
        packageId: f.package_id,
        symbol: f.symbol,
        kind: f.kind,
        verdict: f.verdict,
        reasons: f.reasons,
        blockedBy: f.blocked_by,
      },
    },
  };
}

function skewResult(v: ReportVersionSkew): Pending {
  const r = SKEW_SPEC.rule;
  return {
    symbol: v.symbol,
    line: v.line ?? 0,
    // The consumer can reference the same missing symbol from one file many times;
    // the target is part of identity (the same name can be missing from two targets).
    fingerprintKey: `${v.package_id}#${v.symbol}#${v.file}#${v.target_package_id}`,
    result: {
      ruleId: r.id,
      ruleIndex: RULE_INDEX.get(r.id)!,
      level: r.defaultConfiguration.level,
      message: { text: skewMessage(v) },
      locations: [location(v.file, v.line, v.col)],
      partialFingerprints: {},
      properties: {
        packageId: v.package_id,
        symbol: v.symbol,
        verdict: 'version_skew',
        reasons: [`target:${v.target_package_id}`],
        blockedBy: [],
        targetPackageId: v.target_package_id,
      },
    },
  };
}

function uriOf(p: Pending): string {
  return p.result.locations[0]!.physicalLocation.artifactLocation.uri;
}

/** Sort by ruleId, uri, line, symbol, then assign fingerprints (occurrence-suffixed on collision). */
function finish(pending: Pending[]): SarifResult[] {
  pending.sort((a, b) =>
    cmp(a.result.ruleId, b.result.ruleId)
    || cmp(uriOf(a), uriOf(b))
    || a.line - b.line
    || cmp(a.symbol, b.symbol)
    || cmp(a.result.message.text, b.result.message.text));
  const seen = new Map<string, number>();
  return pending.map((p) => {
    // Same key twice (e.g. overloads, or a skewed symbol referenced on several lines):
    // the first keeps the plain hash, later ones get `#<n>` in sort order.
    const n = seen.get(p.fingerprintKey) ?? 0;
    seen.set(p.fingerprintKey, n + 1);
    p.result.partialFingerprints[SARIF_FINGERPRINT_KEY] = sha256(n === 0 ? p.fingerprintKey : `${p.fingerprintKey}#${n}`);
    return p.result;
  });
}

// ---- build ---------------------------------------------------------------------------

/**
 * One SARIF 2.1.0 log per repo (keys sorted). Covers every repo in report.repos plus
 * any repo that only appears on a finding/skew row. Throws on a verdict with no rule
 * (a new verdict must get a rule, not vanish from the upload).
 */
export function buildSarif(report: Report, opts: BuildSarifOptions = {}): Map<string, SarifLog> {
  const repoInfo = new Map(report.repos.map((r) => [r.repo, r]));
  const byRepo = new Map<string, Pending[]>();
  const add = (repo: string, p: Pending): void => {
    const xs = byRepo.get(repo);
    if (xs) xs.push(p);
    else byRepo.set(repo, [p]);
  };
  for (const f of report.findings) add(f.repo, findingResult(f));
  for (const v of report.versionSkew) add(v.repo, skewResult(v));

  const repos = [...new Set([...repoInfo.keys(), ...byRepo.keys()])].sort(cmp);
  const out = new Map<string, SarifLog>();
  for (const repo of repos) {
    const info = repoInfo.get(repo);
    const driver: SarifRun['tool']['driver'] = {
      name: report.tool.name,
      version: report.tool.version,
      ...(/^\d+\.\d+\.\d+/.test(report.tool.version) ? { semanticVersion: report.tool.version } : {}),
      ...(opts.informationUri !== undefined ? { informationUri: opts.informationUri } : {}),
      rules: sarifRules(),
    };
    out.set(repo, {
      $schema: SARIF_SCHEMA_URI,
      version: '2.1.0',
      runs: [
        {
          tool: { driver },
          originalUriBaseIds: {
            [SARIF_SRCROOT]: { description: { text: `Root of the ${repo} checkout; every artifact URI is repo-relative.` } },
          },
          columnKind: 'utf16CodeUnits',
          results: finish(byRepo.get(repo) ?? []),
          properties: {
            repo,
            headSha: info?.head_sha ?? null,
            indexStatus: info?.index_status ?? null,
            policy: report.policy,
            warnings: report.warnings,
          },
        },
      ],
    });
  }
  return out;
}
