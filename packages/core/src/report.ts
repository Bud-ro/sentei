// `report` stage core (PLAN.md §6.7): read the analysed DB, build work/report.json,
// and format the stdout summary. Read-only: this module never writes to the DB.
//
// Conventions:
//   * Lines/cols in the report are 1-based (the DB stores SCIP's 0-based positions).
//   * Every list is sorted deterministically (plain code-unit order, not locale).
//   * Anything that weakens a verdict's meaning (minAgeDays = 0, a repo that did not
//     index cleanly) is a `warnings` line, printed first.
//   * `findings` are the base verdicts (one per symbol, independent of any view);
//     `views` are filters over them (REPORT_VIEWS). Choosing views never needs
//     re-analysis: the stdout summary and SARIF take a view list (`--view`).
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { requireAnalyzed } from './analyze.ts';
import { excludedReposWarning, ignoredManifestsWarning, shortenExcludedWarning } from './repo-select.ts';
import { parseDescriptors, parseScipSymbol } from './scip/read.ts';

/**
 * The report views, in summary / SARIF order. Every one is a filter over `findings`
 * (version_skew over `versionSkew`); see buildViews for the exact rules.
 *   delete        deletion_candidate: private package, no counted refs, witness passed
 *   deprecate     deprecation_candidate that is not internal-only: published package,
 *                 the same evidence as a deletion (witness passed)
 *   org_dead      the deprecate rows read as deletions under ORG_DEAD_ASSERTION, plus
 *                 the private helpers only they unlock (sub-key private_dead)
 *   unexport      unexport_candidate (private), plus deprecation_candidate
 *                 [internal_refs_only] of published packages (sub-key published)
 *   private_dead  private_dead, minus helpers of a published package that only
 *                 deprecate rows unlock (those need the org_dead assertion)
 *   needs_review, blocked, version_skew: the verdict of the same name
 */
export const REPORT_VIEWS = [
  'delete',
  'deprecate',
  'org_dead',
  'unexport',
  'private_dead',
  'needs_review',
  'blocked',
  'version_skew',
] as const;

export type ReportViewName = (typeof REPORT_VIEWS)[number];

/** Views that assert something about the world beyond the index: never selected by default in SARIF. */
export const ASSERTING_VIEWS: readonly ReportViewName[] = ['org_dead'];

/** The org_dead view's assertion, stated in report.json, the summary and SARIF. */
export const ORG_DEAD_ASSERTION =
  'The org is the only consumer of these packages: nothing outside the org depends on them, although they are published.';

/** Per-package count columns (views with one row per finding of that package; org_dead counts the private helpers it unlocks too). */
export const PACKAGE_COUNT_VIEWS = ['delete', 'deprecate', 'org_dead', 'unexport', 'private_dead', 'needs_review', 'blocked'] as const;

/** Verdicts the report knows how to place in a view; anything else is a bug upstream. */
export const REPORT_VERDICTS = [
  'deletion_candidate',
  'deprecation_candidate',
  'unexport_candidate',
  'private_dead',
  'needs_review',
  'blocked',
] as const;

/**
 * Parse `--view a,b --view c` into view names (deduplicated, REPORT_VIEWS order).
 * `org-dead` is accepted for `org_dead` (hyphens and underscores are the same). Throws
 * on an unknown name, listing the known ones.
 */
export function parseViews(specs: readonly string[]): ReportViewName[] {
  const want = new Set<ReportViewName>();
  for (const spec of specs) {
    for (const raw of spec.split(',')) {
      const name = raw.trim().replaceAll('-', '_');
      if (name === '') continue;
      if (!(REPORT_VIEWS as readonly string[]).includes(name)) {
        throw new Error(`--view: unknown view "${raw.trim()}" (known: ${REPORT_VIEWS.join(', ')})`);
      }
      want.add(name as ReportViewName);
    }
  }
  return REPORT_VIEWS.filter((v) => want.has(v));
}

/** Default SARIF selection: every view except the asserting ones (org_dead). */
export function defaultSarifViews(): ReportViewName[] {
  return REPORT_VIEWS.filter((v) => !ASSERTING_VIEWS.includes(v));
}

/** Policy keys, in report order. */
const POLICY_KEYS = ['minAgeDays', 'trustPrivateRegistry', 'countTestsAsConsumers', 'countDocsAsConsumers'] as const;

export type ReportPolicy = Record<(typeof POLICY_KEYS)[number], unknown>;

export interface ReportFinding {
  /** `<manager>:<repo>:<name>`. */
  package_id: string;
  /** The package name (several repos may publish the same one). */
  name: string;
  repo: string;
  symbol: string;
  file: string;
  line: number | null;
  col: number | null;
  kind: string;
  verdict: string;
  reasons: string[];
  blocked_by: string[];
}

export interface ReportVersionSkew {
  package_id: string;
  repo: string;
  symbol: string;
  file: string;
  line: number | null;
  col: number | null;
  target_package_id: string;
}

/** Unresolved references into one target package that are not version skew (one class). */
export interface ReportUnresolvedTarget {
  target_package_id: string;
  /** Distinct references (consumer, symbol, position). */
  count: number;
  /** Up to 3 symbol names, most referenced first. */
  examples: string[];
}

/**
 * unresolved_refs rows that analyze.sql `unresolved_ref_classes` does not call version
 * skew, per target package (most references first). They stay visible here because each
 * is an indexing gap somewhere, not a finding.
 */
export interface ReportDiagnostics {
  /** Consumer and target in one repo, the dependency admits HEAD: an indexing gap. */
  unresolved_same_repo: ReportUnresolvedTarget[];
  /** Target opaque (index failed / partial, unresolved exports) or exporting nothing. */
  unresolved_opaque_target: ReportUnresolvedTarget[];
  /** Deep dist imports (`*`) and JSON-module members: modules no index defines. */
  unresolved_unindexed_module: ReportUnresolvedTarget[];
  /**
   * The target still defines the name at HEAD in another file, or as a member of a
   * supertype: the consumer's published version declared it elsewhere; not skew.
   */
  unresolved_moved_at_head: ReportUnresolvedTarget[];
}

export interface ReportPackage {
  package_id: string;
  name: string;
  repo: string;
  visibility: string;
  /**
   * Nobody outside the org can depend on it (schema view private_packages: `private`,
   * or `published-private` with trustPrivateRegistry). Decides deletion vs deprecation.
   */
  private: boolean;
  opaque: boolean;
  flags: Array<{ flag: string; reason: string | null; file: string | null }>;
  consumers: string[];
  blocked_by: string[];
  /** Rows per PACKAGE_COUNT_VIEWS view (unexport counts its published sub-list too). */
  counts: Record<string, number>;
  exported: number;
  symbols: number;
}

export interface ReportBlocker {
  blocker_package_id: string;
  repo: string | null;
  flags: string[];
  reasons: string[];
  blocks_packages: string[];
  blocked_findings: number;
  /** What to do about it, per flag (blockerHint): the first error line and index log, an ignoreManifests entry, … */
  hint: string;
}

export interface ReportRepo {
  repo: string;
  head_sha: string | null;
  index_status: string | null;
}

export interface ReportView<T = ReportFinding> {
  description: string;
  /** What the view assumes beyond the index; its rows are wrong if the assertion is. */
  assertion?: string;
  rows: T[];
}

export interface ReportViews {
  delete: ReportView;
  deprecate: ReportView;
  /** rows: the deprecate rows. private_dead: private helpers of those packages that only they unlock. */
  org_dead: ReportView & { private_dead: ReportFinding[] };
  /** rows: private packages (unexport_candidate). published: deprecation_candidate [internal_refs_only]. */
  unexport: ReportView & { published: ReportFinding[] };
  private_dead: ReportView;
  needs_review: ReportView;
  blocked: ReportView;
  version_skew: ReportView<ReportVersionSkew>;
}

export interface Report {
  tool: { name: string; version: string };
  /** Epoch seconds. */
  generatedAt: number;
  /** generatedAt as an ISO 8601 UTC string, for humans (`2026-09-24T10:00:00.000Z`). */
  generatedAtIso: string;
  policy: ReportPolicy;
  warnings: string[];
  /** Base verdicts, one per symbol (and verdict), independent of any view. */
  findings: ReportFinding[];
  versionSkew: ReportVersionSkew[];
  /** Unresolved references that are not version skew (indexing gaps), per class. */
  diagnostics: ReportDiagnostics;
  /** Filters over findings / versionSkew (REPORT_VIEWS). */
  views: ReportViews;
  packages: ReportPackage[];
  blockers: ReportBlocker[];
  repos: ReportRepo[];
}

export interface BuildReportOptions {
  db: DatabaseSync;
  /** The work dir, for index log paths in blocker hints (`<work>/index/…`); default `<work>`. */
  workDir?: string;
  /** Epoch seconds; defaults to now (injectable for tests). */
  now?: number;
}

/** Code-unit string order (locale-independent, so reports are byte-stable). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpBy<T>(...keys: Array<(x: T) => string | number | null>): (a: T, b: T) => number {
  return (a, b) => {
    for (const k of keys) {
      const x = k(a);
      const y = k(b);
      if (x === y) continue;
      if (x === null) return -1;
      if (y === null) return 1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : cmp(String(x), String(y));
      if (c !== 0) return c;
    }
    return 0;
  };
}

const oneBased = (n: number | null): number | null => (n === null ? null : n + 1);

function toolVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
  return pkg.version ?? '0.0.0';
}

/**
 * Display name of an unresolved_refs.symbol_str: a bare name for sidecar-derived
 * rows, the trailing descriptor's name for SCIP symbols (`... removedFn().` -> removedFn).
 */
export function skewSymbolName(symbolStr: string): string {
  if (!symbolStr.includes(' ')) return symbolStr;
  try {
    const p = parseScipSymbol(symbolStr);
    if (p.local) return p.id;
    const ds = parseDescriptors(p.descriptors);
    const last = ds[ds.length - 1];
    return last?.name ?? symbolStr;
  } catch {
    return symbolStr;
  }
}

function parseJsonArray(s: string): string[] {
  const v = JSON.parse(s) as unknown;
  return Array.isArray(v) ? v.map(String) : [];
}

/** `<blocker package_id>:<flag>` -> blocker package id (flags contain no ':'). */
function blockerOf(entry: string): string {
  const i = entry.lastIndexOf(':');
  return i <= 0 ? entry : entry.slice(0, i);
}

function uniqSorted(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort(cmp);
}

/**
 * A deprecation_candidate that is the published form of an unexport: reason
 * internal_refs_only and not a dead island (schema.sql's witness trigger uses the same
 * test to tell it from a would-be deletion).
 */
export function isInternalOnly(f: Pick<ReportFinding, 'reasons'>): boolean {
  return f.reasons.includes('internal_refs_only') && !f.reasons.includes('dead_island');
}

export const VIEW_DESCRIPTIONS: Readonly<Record<ReportViewName, string>> = Object.freeze({
  delete: 'Exports of private packages (nobody outside the org can depend on them) with no counted reference '
    + '(no_refs), only test references (only_test_refs) or only docs / example references (only_docs_refs; '
    + 'countDocsAsConsumers counts those), and a passed text witness: delete them. '
    + 'Reason dead_island: used only by other candidates; delete them together.',
  deprecate: 'Exports of published packages with the same evidence as a deletion (no counted reference in the org, '
    + 'witness passed). External consumers may exist: deprecate, and remove in a later major version.',
  org_dead: 'The deprecate rows read as deletions, plus the private helpers only they unlock (private_dead). '
    + 'Valid only under the assertion.',
  unexport: 'Exports used only inside their own package: remove the export, keep the declaration. '
    + 'rows: private packages; published: published packages, where removing an export is a breaking change '
    + '(deprecate the export first). Never proposed for a private app nothing in the org depends on (its exports '
    + 'are judged as private symbols) nor for a type named in the signature of public API.',
  private_dead: 'Non-exported declarations unreachable from live code: already_unreachable, or unlocked_by:<symbol> '
    + 'once the delete / unexport candidates of their package are gone. Helpers of a published package that only '
    + 'deprecate rows unlock are in org_dead.private_dead instead.',
  needs_review: 'Looks unused, but a second check disagrees (witness_mismatch names the text hit) or could not run: '
    + 'treat as alive until a human decides.',
  blocked: 'Would have had a verdict, but a consumer of the package (or the package itself) is opaque; '
    + 'blocked_by names the blocker to fix first. Reasons keep the base evidence.',
  version_skew: 'References to symbols missing at the target package HEAD (the consumer depends on an older version). '
    + 'Never keeps anything alive.',
});

/**
 * The views over the base findings (REPORT_VIEWS). `privateIds`: packages in the schema
 * view private_packages. Throws on a verdict no view places (a new verdict must get a
 * view, not vanish from the report).
 */
export function buildViews(findings: ReportFinding[], versionSkew: ReportVersionSkew[], privateIds: ReadonlySet<string>): ReportViews {
  const v: ReportViews = {
    delete: { description: VIEW_DESCRIPTIONS.delete, rows: [] },
    deprecate: { description: VIEW_DESCRIPTIONS.deprecate, rows: [] },
    org_dead: { description: VIEW_DESCRIPTIONS.org_dead, assertion: ORG_DEAD_ASSERTION, rows: [], private_dead: [] },
    unexport: { description: VIEW_DESCRIPTIONS.unexport, rows: [], published: [] },
    private_dead: { description: VIEW_DESCRIPTIONS.private_dead, rows: [] },
    needs_review: { description: VIEW_DESCRIPTIONS.needs_review, rows: [] },
    blocked: { description: VIEW_DESCRIPTIONS.blocked, rows: [] },
    version_skew: { description: VIEW_DESCRIPTIONS.version_skew, rows: versionSkew },
  };
  for (const f of findings) {
    switch (f.verdict) {
      case 'deletion_candidate':
        v.delete.rows.push(f);
        break;
      case 'deprecation_candidate':
        if (isInternalOnly(f)) {
          v.unexport.published.push(f);
        } else {
          v.deprecate.rows.push(f);
          v.org_dead.rows.push(f);
        }
        break;
      case 'unexport_candidate':
        v.unexport.rows.push(f);
        break;
      case 'private_dead':
        // In a published package, an unlocked_by row is dead only once the deprecation
        // candidates that unlock it are deleted: true under the org_dead assertion only.
        // (Candidates unlock only their own package's code: reach_edges are package-local.)
        if (!privateIds.has(f.package_id) && !f.reasons.includes('already_unreachable')) v.org_dead.private_dead.push(f);
        else v.private_dead.rows.push(f);
        break;
      case 'needs_review':
        v.needs_review.rows.push(f);
        break;
      case 'blocked':
        v.blocked.rows.push(f);
        break;
      default:
        throw new Error(`sentei report: no view for verdict ${JSON.stringify(f.verdict)} (${f.package_id}#${f.symbol})`);
    }
  }
  return v;
}

/** A package as blockerHint needs it. */
interface HintPackage {
  package_id: string;
  repo: string;
  path: string;
  manager: string;
  name: string;
}

/**
 * The per-package index log the index stage writes: `<work>/index/<repo slug>/<package
 * slug>.log`, slugs as the cli's repoSlug / packageSlug (`pub:acme/x:acme_x` ->
 * `index/acme__x/pub__x__acme_x.log`; packages/cli/test/report-hints.test.ts checks they agree).
 */
export function indexLogPath(workDir: string, p: Pick<HintPackage, 'repo' | 'manager' | 'name'>): string {
  const clean = (x: string): string => x.replace(/^@/, '').replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_');
  const repoName = p.repo.slice(p.repo.indexOf('/') + 1);
  return `${workDir}/index/${p.repo.replaceAll('/', '__')}/${[p.manager, repoName, p.name].map(clean).join('__')}.log`;
}

/** The org sentei.json `ignoreManifests` entry that excludes package p: `<repo name>/<manifest path>`. */
export function ignoreManifestEntry(p: Pick<HintPackage, 'repo' | 'path' | 'manager'>): string {
  const file = p.manager === 'pub' ? 'pubspec.yaml' : 'package.json';
  return `${p.repo.slice(p.repo.indexOf('/') + 1)}/${p.path === '.' || p.path === '' ? '' : `${p.path}/`}${file}`;
}

/** First meaningful line of a flag reason: `error:` / `warn:` / `discover:` prefix dropped, at most 240 characters. */
function firstLine(reason: string | null): string {
  const line = (reason ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const bare = line.replace(/^(?:error|warn|warning|discover):\s*/i, '');
  return bare.length > 240 ? `${bare.slice(0, 237)}...` : bare;
}

/**
 * What to do about one blocker (report.json `hint`, one summary line), from its own
 * package_flags rows, in flag order:
 *   index_failed / opaque_consumer from the index: the first error line and the index
 *     log; a pre-2.12 Dart SDK constraint is named as such; and when no org package
 *     depends on the blocker (an example app, a repo-internal demo) the
 *     `ignoreManifests` entry that removes it (the text witness still reads its code);
 *   opaque_consumer from discover: the entry point that resolves to no file;
 *   opaque_consumer targeted at another package (a deep dist import with no source):
 *     that reason and the consumer, not "index partial" (the index may be ok);
 *   ambiguous_dep: the candidates, and the `ignoreManifests` entries to drop the ones
 *     the dependency does not mean (sentei.json has no way to pin a dependency);
 *   unindexed_consumer, dynamic_access, namespace_dynamic: what was seen, and where.
 */
export function blockerHint(
  id: string,
  flags: ReadonlyArray<{ flag: string; reason: string | null; file: string | null; target_package_id: string | null }>,
  pkgOf: ReadonlyMap<string, HintPackage>,
  hasDependents: boolean,
  workDir = '<work>',
): string {
  const p = pkgOf.get(id);
  const parts: string[] = [];
  const log = p ? ` (log: ${indexLogPath(workDir, p)})` : '';
  // A TARGETED opaque_consumer (the TS adapter's deep dist import with no source) says
  // nothing about the index, which may be ok: it gets its own line below.
  const indexRows = flags.filter((f) => f.flag === 'index_failed'
    || (f.flag === 'opaque_consumer' && f.target_package_id === null && !(f.reason ?? '').startsWith('discover: ')));
  const failed = indexRows.find((f) => f.flag === 'index_failed');
  const indexRow = failed ?? indexRows[0];
  if (indexRow) {
    const line = firstLine(indexRow.reason);
    const preNullSafety = /lower bound of "sdk: [^"]*" must be 2\.12\.0/.test(indexRow.reason ?? '');
    parts.push(`${failed ? 'index failed' : 'index partial'}: ${preNullSafety ? 'pre-null-safety SDK constraint, the current Dart SDK cannot resolve it: ' : ''}${line}${log}`);
    if (!hasDependents && p) {
      parts.push(`nothing in the org depends on it; if it is an example or demo, exclude it in the org sentei.json: "ignoreManifests": [${JSON.stringify(ignoreManifestEntry(p))}]`);
    }
  }
  const targeted = flags.filter((f) => f.flag === 'opaque_consumer' && f.target_package_id !== null);
  const targetedReasons = uniqSorted(targeted.map((f) => firstLine(f.reason)));
  if (targetedReasons.length > 0) {
    const r = targeted.find((f) => firstLine(f.reason) === targetedReasons[0])!;
    parts.push(`${targetedReasons[0]} (from ${id}${r.file ? `, ${r.file}` : ''})`
      + `${targetedReasons.length > 1 ? ` (+${targetedReasons.length - 1} more)` : ''}`);
  }
  const unresolved = flags.filter((f) => f.flag === 'opaque_consumer' && (f.reason ?? '').startsWith('discover: '));
  if (unresolved.length > 0) {
    const what = unresolved.map((f) => firstLine(f.reason).replace(/^unresolved entry point /, '')).join(', ');
    parts.push(`manifest entry point(s) resolve to no file: ${what}${unresolved[0]!.file ? ` (${unresolved[0]!.file})` : ''}; `
      + 'build output missing from the checkout? The package surface is unknown until it resolves');
  }
  const ambiguous = flags.filter((f) => f.flag === 'ambiguous_dep' && f.target_package_id !== null);
  for (const reason of uniqSorted(ambiguous.map((f) => f.reason ?? ''))) {
    const m = /^dep (\S+) matches \d+ org packages: (.*)$/.exec(reason);
    const cands = m ? m[2]!.split(', ') : uniqSorted(ambiguous.map((f) => f.target_package_id!));
    const entries = cands.flatMap((c) => (pkgOf.has(c) ? [JSON.stringify(ignoreManifestEntry(pkgOf.get(c)!))] : []));
    parts.push(`dependency ${m ? m[1] : '?'} names several org packages (${cands.join(', ')}); sentei.json cannot pin a dependency, `
      + `so exclude the ones it does not mean: "ignoreManifests": [${entries.join(', ')}] minus the real one`);
  }
  const unindexed = flags.find((f) => f.flag === 'unindexed_consumer');
  if (unindexed) parts.push(`code in a language sentei cannot index: ${firstLine(unindexed.reason)}; its uses of org packages are invisible`);
  for (const flag of ['dynamic_access', 'namespace_dynamic']) {
    const rows = flags.filter((f) => f.flag === flag);
    if (rows.length === 0) continue;
    const r = rows[0]!;
    parts.push(`${flag === 'dynamic_access' ? 'dynamic import / require' : 'dynamic namespace access'}: ${r.file ? `${r.file}: ` : ''}${firstLine(r.reason)}`
      + `${rows.length > 1 ? ` (+${rows.length - 1} more)` : ''}`);
  }
  return parts.join('; ');
}

export function buildReport(opts: BuildReportOptions): Report {
  const { db } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  requireAnalyzed(db, 'report');

  // ---- policy ----------------------------------------------------------------
  const policyRows = db.prepare('SELECT key, value FROM policy').all() as Array<{ key: string; value: string }>;
  const policyMap = new Map(policyRows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  const policy = Object.fromEntries(POLICY_KEYS.map((k) => [k, policyMap.has(k) ? policyMap.get(k) : null])) as ReportPolicy;

  // ---- repos -------------------------------------------------------------------
  const repos = (db.prepare('SELECT repo, head_sha, index_status FROM repos').all() as unknown as ReportRepo[])
    .map((r) => ({ repo: r.repo, head_sha: r.head_sha, index_status: r.index_status }))
    .sort(cmpBy((r) => r.repo));

  // ---- warnings ------------------------------------------------------------------
  const warnings: string[] = [];
  if (policy.minAgeDays === 0) {
    warnings.push('minAgeDays is 0: age policy disabled; symbols of any age (including ones added yesterday) can be candidates');
  }
  // Name the packages behind a failed / partial repo (untargeted index_failed /
  // opaque_consumer flags of the repo's packages): usually one tooling package, not the
  // whole repo. Each is named for what happened to IT (a repo is `failed` when any
  // package failed; its other packages may only be partial, e.g. unifont):
  // index_failed → "index failed", an ingest opaque_consumer (partial index) → "index
  // partial", a discover opaque_consumer (unresolved entry points) → "opaque".
  const failedPkgRows = db.prepare(`
    SELECT DISTINCT p.repo, f.package_id, f.flag, coalesce(f.reason, '') LIKE 'discover: %' AS from_discover
    FROM package_flags f JOIN packages p ON p.package_id = f.package_id
    WHERE f.target_package_id IS NULL AND f.flag IN ('index_failed', 'opaque_consumer')`).all() as Array<{
    repo: string; package_id: string; flag: string; from_discover: number;
  }>;
  for (const r of repos) {
    if (r.index_status !== 'failed' && r.index_status !== 'partial') continue;
    const rows = failedPkgRows.filter((f) => f.repo === r.repo);
    const failed = uniqSorted(rows.filter((f) => f.flag === 'index_failed').map((f) => f.package_id));
    const partial = uniqSorted(rows.filter((f) => f.flag === 'opaque_consumer' && f.from_discover === 0 && !failed.includes(f.package_id))
      .map((f) => f.package_id));
    const opaque = uniqSorted(rows.filter((f) => f.flag === 'opaque_consumer' && f.from_discover === 1
      && !failed.includes(f.package_id) && !partial.includes(f.package_id)).map((f) => f.package_id));
    const n = failed.length + partial.length + opaque.length;
    const parts = [
      failed.length > 0 ? `index failed for ${failed.join(', ')}` : '',
      partial.length > 0 ? `index partial for ${partial.join(', ')}` : '',
      opaque.length > 0 ? `opaque (discover) for ${opaque.join(', ')}` : '',
    ].filter(Boolean);
    warnings.push(n === 0
      ? `repo ${r.repo}: index ${r.index_status}; its packages are opaque and block verdicts for every org package they depend on`
      : `repo ${r.repo}: ${parts.join('; ')}; ${n === 1 ? 'it is' : 'they are'} opaque and ${
        n === 1 ? 'blocks' : 'block'} verdicts for every org package ${n === 1 ? 'it depends' : 'they depend'} on`);
  }

  // Listed repos discover skipped (excluded, or not cloned) that carry manifests:
  // whatever they use of org packages is invisible, so exports only they use can
  // look dead. Every repo is named here; the stdout summary shows the first ten.
  const excludedRows = (db.prepare(`
    SELECT repo, reason, manifests FROM excluded_repos
    WHERE manifests IS NOT NULL AND json_array_length(manifests) > 0 ORDER BY repo`).all() as Array<{
    repo: string; reason: string; manifests: string;
  }>).map((r) => ({ repo: r.repo, reason: r.reason, manifests: JSON.parse(r.manifests) as string[] }));
  if (excludedRows.length > 0) warnings.push(excludedReposWarning(excludedRows));
  // Manifests the org sentei.json `ignoreManifests` excluded from analysed repos: said as
  // loudly, since whatever they would have blocked or kept alive by reference is gone.
  const ignoredRows = db.prepare('SELECT repo, manifest, glob FROM ignored_manifests ORDER BY repo, manifest').all() as Array<{
    repo: string; manifest: string; glob: string;
  }>;
  if (ignoredRows.length > 0) warnings.push(ignoredManifestsWarning(ignoredRows));

  // Dependencies whose name several org packages share (package ids are
  // <manager>:<repo>:<name>): say which one discover picked, or that it could not.
  const multiRows = db.prepare(`
    SELECT d.consumer_package_id AS consumer, d.dep_name, d.resolved_package_id AS resolved, d.resolution,
           (SELECT group_concat(target_package_id, ', ') FROM (
              SELECT DISTINCT f.target_package_id FROM package_flags f
              WHERE f.package_id = d.consumer_package_id AND f.flag = 'ambiguous_dep'
                AND substr(f.reason, 1, length(d.dep_name) + 13) = 'dep ' || d.dep_name || ' matches '
              ORDER BY f.target_package_id)) AS candidates
    FROM package_deps d
    WHERE d.ambiguous = 1 OR d.resolution IN ('same-repo', 'published', 'constraint')
    ORDER BY d.consumer_package_id, d.dep_name`).all() as Array<{
    consumer: string; dep_name: string; resolved: string | null; resolution: string | null; candidates: string | null;
  }>;
  for (const r of multiRows) {
    warnings.push(r.resolved === null
      ? `ambiguous dependency: ${r.consumer} depends on ${r.dep_name}, which names several org packages (${r.candidates ?? '?'}); `
        + 'none could be preferred, so their verdicts are blocked (ambiguous_dep); exclude the wrong ones with ignoreManifests'
      : `${r.consumer} depends on ${r.dep_name}, which names several org packages; resolved to ${r.resolved} (${r.resolution})`);
  }

  // ---- findings -----------------------------------------------------------------
  const findingRows = db.prepare(`
    SELECT s.package_id, p.name AS pkg_name, p.repo, s.name AS symbol, s.file, s.line, s.col, s.kind,
           f.verdict, f.reasons, f.blocked_by
    FROM findings f
    JOIN symbols s ON s.symbol_id = f.symbol_id
    JOIN packages p ON p.package_id = s.package_id`).all() as Array<{
    package_id: string; pkg_name: string; repo: string; symbol: string; file: string; line: number | null; col: number | null;
    kind: string | null; verdict: string; reasons: string; blocked_by: string;
  }>;
  const findings: ReportFinding[] = findingRows
    .map((r) => ({
      package_id: r.package_id,
      name: r.pkg_name,
      repo: r.repo,
      symbol: r.symbol,
      file: r.file,
      line: oneBased(r.line),
      col: oneBased(r.col),
      kind: r.kind ?? '',
      verdict: r.verdict,
      reasons: parseJsonArray(r.reasons),
      blocked_by: parseJsonArray(r.blocked_by),
    }))
    .sort(cmpBy((f) => f.package_id, (f) => f.symbol, (f) => f.verdict, (f) => f.file, (f) => f.line, (f) => f.col));

  // ---- version skew ------------------------------------------------------------------
  // analyze.sql `unresolved_ref_classes` decides which unresolved references are skew;
  // the others (same-repo indexing gaps, opaque targets, unindexed modules) go to
  // `diagnostics`, counted per target package. A sidecar row and a SCIP row can name
  // the same reference; keep one.
  const skewRows = db.prepare(`
    SELECT u.consumer_package_id AS package_id, p.repo, u.symbol_str, u.file, u.line, u.col, u.target_package_id, u.class
    FROM unresolved_ref_classes u JOIN packages p ON p.package_id = u.consumer_package_id`).all() as Array<{
    package_id: string; repo: string; symbol_str: string; file: string; line: number | null; col: number | null; target_package_id: string;
    class: string;
  }>;
  const skewSeen = new Set<string>();
  const versionSkew: ReportVersionSkew[] = [];
  /** class -> target -> symbol name -> references */
  const gaps = new Map<string, Map<string, Map<string, number>>>();
  for (const r of skewRows) {
    const row: ReportVersionSkew = {
      package_id: r.package_id,
      repo: r.repo,
      symbol: skewSymbolName(r.symbol_str),
      file: r.file,
      line: oneBased(r.line),
      col: oneBased(r.col),
      target_package_id: r.target_package_id,
    };
    const key = JSON.stringify([row.package_id, row.symbol, row.file, row.line, row.col, row.target_package_id]);
    if (skewSeen.has(key)) continue;
    skewSeen.add(key);
    if (r.class === 'version_skew') {
      versionSkew.push(row);
      continue;
    }
    if (!['same_repo', 'opaque_target', 'unindexed_module', 'moved_at_head'].includes(r.class)) {
      throw new Error(`sentei report: unknown unresolved_ref_classes class ${JSON.stringify(r.class)}`);
    }
    const byTarget = gaps.get(r.class) ?? new Map<string, Map<string, number>>();
    gaps.set(r.class, byTarget);
    const names = byTarget.get(row.target_package_id) ?? new Map<string, number>();
    byTarget.set(row.target_package_id, names);
    names.set(row.symbol, (names.get(row.symbol) ?? 0) + 1);
  }
  const gapList = (cls: string): ReportUnresolvedTarget[] => [...(gaps.get(cls) ?? new Map<string, Map<string, number>>())]
    .map(([target, names]) => ({
      target_package_id: target,
      count: [...names.values()].reduce((a, b) => a + b, 0),
      examples: [...names].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 3).map(([n]) => n),
    }))
    .sort(cmpBy((g) => -g.count, (g) => g.target_package_id));
  const diagnostics: ReportDiagnostics = {
    unresolved_same_repo: gapList('same_repo'),
    unresolved_opaque_target: gapList('opaque_target'),
    unresolved_unindexed_module: gapList('unindexed_module'),
    unresolved_moved_at_head: gapList('moved_at_head'),
  };
  versionSkew.sort(cmpBy((v) => v.package_id, (v) => v.symbol, (v) => v.file, (v) => v.line, (v) => v.col, (v) => v.target_package_id));

  // ---- packages ------------------------------------------------------------------
  const pkgRows = db.prepare(`
    SELECT p.package_id, p.name, p.repo, p.visibility, p.path, p.manager,
           EXISTS (SELECT 1 FROM private_packages c WHERE c.package_id = p.package_id) AS private,
           EXISTS (SELECT 1 FROM opaque_packages o WHERE o.package_id = p.package_id) AS opaque,
           (SELECT count(*) FROM symbols s WHERE s.package_id = p.package_id AND s.is_exported = 1) AS exported,
           (SELECT count(*) FROM symbols s WHERE s.package_id = p.package_id
              AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.module_symbol_id = s.symbol_id)) AS symbols
    FROM packages p`).all() as Array<{
    package_id: string; name: string; repo: string; visibility: string; path: string; manager: string;
    private: number; opaque: number; exported: number; symbols: number;
  }>;
  const flagRows = db.prepare('SELECT package_id, flag, reason, file, target_package_id FROM package_flags').all() as Array<{
    package_id: string; flag: string; reason: string | null; file: string | null; target_package_id: string | null;
  }>;
  const consumerRows = db.prepare(
    'SELECT DISTINCT resolved_package_id AS package_id, consumer_package_id FROM package_deps WHERE resolved_package_id IS NOT NULL',
  ).all() as Array<{ package_id: string; consumer_package_id: string }>;
  const blockedRows = db.prepare('SELECT package_id, blocker_package_id, flag FROM blocked_packages').all() as Array<{
    package_id: string; blocker_package_id: string; flag: string;
  }>;

  const repoOf = new Map(pkgRows.map((p) => [p.package_id, p.repo]));
  const pkgOf = new Map(pkgRows.map((p) => [p.package_id, p]));
  const privateIds = new Set(pkgRows.filter((p) => p.private === 1).map((p) => p.package_id));
  const views = buildViews(findings, versionSkew, privateIds);
  const packages: ReportPackage[] = pkgRows
    .map((p) => {
      const mine = findings.filter((f) => f.package_id === p.package_id);
      const counts: Record<string, number> = Object.fromEntries(PACKAGE_COUNT_VIEWS.map((v) => {
        const view = views[v];
        const rows = v === 'unexport' ? [...view.rows, ...views.unexport.published]
          : v === 'org_dead' ? [...view.rows, ...views.org_dead.private_dead]
          : view.rows;
        return [v, rows.filter((f) => f.package_id === p.package_id).length];
      }));
      return {
        package_id: p.package_id,
        name: p.name,
        repo: p.repo,
        visibility: p.visibility,
        private: p.private === 1,
        opaque: p.opaque === 1,
        flags: flagRows
          .filter((f) => f.package_id === p.package_id)
          .map((f) => ({ flag: f.flag, reason: f.reason, file: f.file }))
          .sort(cmpBy((f) => f.flag, (f) => f.file, (f) => f.reason)),
        consumers: uniqSorted(consumerRows.filter((c) => c.package_id === p.package_id).map((c) => c.consumer_package_id)),
        blocked_by: uniqSorted([
          ...blockedRows.filter((b) => b.package_id === p.package_id).map((b) => `${b.blocker_package_id}:${b.flag}`),
          ...mine.flatMap((f) => f.blocked_by),
        ]),
        counts,
        exported: p.exported,
        symbols: p.symbols,
      };
    })
    .sort(cmpBy((p) => p.package_id));

  // ---- blockers ------------------------------------------------------------------
  // Opaque packages that block verdicts: from the blocked_packages view (manifest deps)
  // and from findings.blocked_by (whatever analyze attributed), unioned.
  const blockerIds = uniqSorted([
    ...blockedRows.map((b) => b.blocker_package_id),
    ...findings.flatMap((f) => f.blocked_by.map(blockerOf)),
  ]);
  const blockers: ReportBlocker[] = blockerIds
    .map((id) => {
      const own = flagRows.filter((f) => f.package_id === id);
      const blockedFindings = findings.filter((f) => f.blocked_by.some((e) => blockerOf(e) === id));
      return {
        blocker_package_id: id,
        repo: repoOf.get(id) ?? null,
        flags: uniqSorted([
          ...own.map((f) => f.flag),
          ...blockedRows.filter((b) => b.blocker_package_id === id).map((b) => b.flag),
        ]),
        reasons: uniqSorted(own.flatMap((f) => (f.reason === null ? [] : [f.file === null ? f.reason : `${f.file}: ${f.reason}`]))),
        blocks_packages: uniqSorted([
          ...blockedRows.filter((b) => b.blocker_package_id === id).map((b) => b.package_id),
          ...blockedFindings.map((f) => f.package_id),
        ]),
        blocked_findings: blockedFindings.length,
        hint: blockerHint(id, own, pkgOf, consumerRows.some((c) => c.package_id === id), opts.workDir),
      };
    })
    .sort(cmpBy((b) => -b.blocked_findings, (b) => b.blocker_package_id));

  return {
    tool: { name: 'sentei', version: toolVersion() },
    generatedAt: now,
    generatedAtIso: new Date(now * 1000).toISOString(),
    policy,
    warnings,
    findings,
    versionSkew,
    diagnostics,
    views,
    packages,
    blockers,
    repos,
  };
}

// ---- summary ----------------------------------------------------------------------

type Align = 'l' | 'r';

/** Widest cell `formatTable` prints; longer cells end in `…` (report.json has the full value). */
export const MAX_CELL = 80;
/** Items `capList` names before `… +N more (report.json)`. */
export const MAX_LIST_ITEMS = 3;

/** A cell of at most `max` characters: longer ones are cut and end in `…`. */
export function capCell(text: string, max = MAX_CELL): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * `a, b … +N more (report.json)`: a list cell of at most `max` items that fits in
 * `width` characters (as many leading items as fit, at least one; a lone item too
 * long for the cell is cut by capCell). The dart-lang run listed every blocker id
 * of a package in one cell: table lines up to 2517 characters.
 */
export function capList(items: readonly string[], max = MAX_LIST_ITEMS, width = MAX_CELL): string {
  const all = items.join(', ');
  if (items.length <= max && all.length <= width) return all;
  const suffix = (shown: number): string => ` … +${items.length - shown} more (report.json)`;
  const fits = (k: number): boolean =>
    items.slice(0, k).join(', ').length + (k === items.length ? 0 : suffix(k).length) <= width;
  let shown = 1;
  while (shown < Math.min(max, items.length) && fits(shown + 1)) shown++;
  if (shown === items.length) return capCell(all, width);
  const tail = suffix(shown);
  return `${capCell(items.slice(0, shown).join(', '), Math.max(1, width - tail.length))}${tail}`;
}

/**
 * Plain ASCII table: header, dashed rule, rows; columns padded to the widest cell.
 * A cell longer than MAX_CELL is cut (capCell), so no column runs off the screen.
 */
export function formatTable(headers: string[], rawRows: string[][], align: Align[]): string[] {
  const rows = rawRows.map((r) => r.map((c) => capCell(c)));
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

/** Summary column / line labels per view. */
export const VIEW_LABELS: Readonly<Record<ReportViewName, string>> = Object.freeze({
  delete: 'DELETE',
  deprecate: 'DEPRECATE',
  org_dead: 'ORG-DEAD',
  unexport: 'UNEXPORT',
  private_dead: 'PRIV-DEAD',
  needs_review: 'REVIEW',
  blocked: 'BLOCKED',
  version_skew: 'VERSION-SKEW',
});

/** Maximum rows printed under "Top blockers" (report.json has them all). */
const TOP_BLOCKERS = 10;
/** Target packages named per unresolved-reference diagnostic line (report.json has them all). */
const TOP_GAP_TARGETS = 5;

export interface FormatSummaryOptions {
  /** Views to print (default: every view). report.json always has them all. */
  views?: readonly ReportViewName[];
}

/**
 * `no_refs 3, only_test_refs 1, only_docs_refs 1, dead_island 2`: each candidate row
 * counted once, under its most specific reason (dead_island, else only_test_refs, else
 * only_docs_refs, else no_refs; a row with both test and docs uses counts as
 * only_test_refs, report.json and SARIF carry both); zeros dropped.
 */
function reasonBreakdown(rows: ReportFinding[]): string {
  const keys = ['no_refs', 'only_test_refs', 'only_docs_refs', 'dead_island'] as const;
  const n: Record<string, number> = {};
  for (const f of rows) {
    const k = f.reasons.includes('dead_island') ? 'dead_island'
      : f.reasons.includes('only_test_refs') ? 'only_test_refs'
        : f.reasons.includes('only_docs_refs') ? 'only_docs_refs' : 'no_refs';
    n[k] = (n[k] ?? 0) + 1;
  }
  return keys.filter((k) => (n[k] ?? 0) > 0).map((k) => `${k} ${n[k]}`).join(', ');
}

/**
 * The stdout summary (PLAN.md §6.7): warnings, per-package counts of the selected
 * views, the view totals with a reason breakdown (dead islands are a reason, not a
 * column), the org_dead assertion as a footnote, top blockers, version skew.
 */
export function formatSummary(report: Report, opts: FormatSummaryOptions = {}): string {
  const selected = new Set<ReportViewName>(opts.views ?? REPORT_VIEWS);
  const out: string[] = [];
  const when = new Date(report.generatedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  out.push(`sentei ${report.tool.version} report, generated ${when}`);
  out.push(`policy: ${POLICY_KEYS.map((k) => `${k}=${JSON.stringify(report.policy[k])}`).join(' ')}`);
  if (opts.views !== undefined) out.push(`views: ${REPORT_VIEWS.filter((v) => selected.has(v)).join(', ')}`);

  if (report.warnings.length > 0) {
    const bar = '!'.repeat(78);
    out.push('', bar);
    for (const w of report.warnings) out.push(`!! WARNING: ${shortenExcludedWarning(w)}`);
    out.push(bar);
  }

  // Per-package table: one column per selected countable view.
  const cols = PACKAGE_COUNT_VIEWS.filter((v) => selected.has(v));
  const totals = Object.fromEntries(cols.map((v) => [v, 0])) as Record<string, number>;
  const pkgRows = report.packages.map((p) => {
    for (const v of cols) totals[v]! += p.counts[v] ?? 0;
    return [
      p.name,
      p.repo,
      p.visibility,
      p.private ? 'yes' : '',
      p.opaque ? 'yes' : '',
      ...cols.map((v) => String(p.counts[v] ?? 0)),
      capList(p.blocked_by),
    ];
  });
  pkgRows.push(['TOTAL', '', '', '', '', ...cols.map((v) => String(totals[v])), '']);
  out.push('', `Packages (${report.packages.length}), ${report.findings.length} finding(s)`);
  out.push(...formatTable(
    ['PACKAGE', 'REPO', 'VISIBILITY', 'PRIVATE', 'OPAQUE', ...cols.map((v) => VIEW_LABELS[v]), 'BLOCKED BY'],
    pkgRows,
    ['l', 'l', 'l', 'l', 'l', ...cols.map((): Align => 'r'), 'l'],
  ));
  out.push('PRIVATE: nobody outside the org can depend on the package (private, or published-private with '
    + 'trustPrivateRegistry): unused exports are DELETE there, DEPRECATE elsewhere.');

  // View totals, with the reason breakdown of the candidate views.
  const v = report.views;
  const lines: string[] = [];
  const line = (name: ReportViewName, n: number, extra = ''): void => {
    if (selected.has(name)) lines.push(`  ${VIEW_LABELS[name].padEnd(12)} ${String(n).padStart(6)}${extra}`);
  };
  const why = (rows: ReportFinding[]): string => (rows.length > 0 ? `  (${reasonBreakdown(rows)})` : '');
  line('delete', v.delete.rows.length, why(v.delete.rows));
  line('deprecate', v.deprecate.rows.length, why(v.deprecate.rows));
  line('org_dead', v.org_dead.rows.length,
    `*  (= DEPRECATE${v.org_dead.private_dead.length > 0 ? `, + ${v.org_dead.private_dead.length} private helper(s) they unlock` : ''})`);
  line('unexport', v.unexport.rows.length + v.unexport.published.length,
    v.unexport.published.length > 0 ? `  (${v.unexport.published.length} in published packages: deprecate the export first)` : '');
  line('private_dead', v.private_dead.rows.length);
  line('needs_review', v.needs_review.rows.length);
  line('blocked', v.blocked.rows.length);
  line('version_skew', v.version_skew.rows.length);
  if (lines.length > 0) {
    out.push('', 'Views', ...lines);
    if ([v.delete.rows, v.deprecate.rows].some((rows) => rows.some((f) => f.reasons.includes('dead_island')))
      && (selected.has('delete') || selected.has('deprecate') || selected.has('org_dead'))) {
      out.push('dead_island: exports used only by other candidates (delete / deprecate them together).');
    }
    if (selected.has('org_dead')) {
      out.push(`* ORG-DEAD lists the DEPRECATE rows as deletions, asserting: ${ORG_DEAD_ASSERTION}`);
    }
  }

  // Top blockers.
  if (selected.has('blocked')) {
    out.push('', 'Top blockers (opaque consumers preventing verdicts; fix these first)');
    if (report.blockers.length === 0) {
      out.push('  none');
    } else {
      const shown = report.blockers.slice(0, TOP_BLOCKERS);
      out.push(...formatTable(
        ['BLOCKER', 'REPO', 'FLAGS', 'FINDINGS', 'BLOCKS PACKAGES'],
        shown.map((b) => [b.blocker_package_id, b.repo ?? '', b.flags.join(','), String(b.blocked_findings), capList(b.blocks_packages)]),
        ['l', 'l', 'l', 'r', 'l'],
      ));
      if (report.blockers.length > shown.length) out.push(`... and ${report.blockers.length - shown.length} more (see report.json)`);
      const hinted = shown.filter((b) => b.hint !== '');
      if (hinted.length > 0) {
        out.push('What to do:');
        for (const b of hinted) out.push(`  ${b.blocker_package_id}: ${b.hint}`);
      }
    }
  }

  // Version skew.
  if (selected.has('version_skew')) {
    const skewPkgs = new Set(report.versionSkew.map((x) => x.package_id)).size;
    out.push('', `Version skew: ${report.versionSkew.length} reference(s) from ${skewPkgs} package(s) to symbols missing at HEAD`);
    const d = report.diagnostics;
    const gapLine = (rows: ReportUnresolvedTarget[], what: string, tag = 'indexing gaps, not skew'): void => {
      if (rows.length === 0) return;
      const n = rows.reduce((a, g) => a + g.count, 0);
      const shown = rows.slice(0, TOP_GAP_TARGETS).map((g) => `${g.target_package_id} ${g.count}`);
      const more = rows.length > TOP_GAP_TARGETS ? `, ... and ${rows.length - TOP_GAP_TARGETS} more (see report.json diagnostics)` : '';
      out.push(`${n} ${what} (${tag}): ${shown.join(', ')}${more}`);
    };
    gapLine(d.unresolved_same_repo, 'unresolved same-repo reference(s)');
    gapLine(d.unresolved_opaque_target, 'unresolved reference(s) into opaque or empty packages');
    gapLine(d.unresolved_unindexed_module, 'unresolved reference(s) into unindexed modules (deep dist imports, JSON)');
    gapLine(d.unresolved_moved_at_head, 'reference(s) to names HEAD defines elsewhere (moved file, accessor, inherited member)',
      'the consumer\'s version declared them there; not skew');
  }
  return `${out.join('\n')}\n`;
}
