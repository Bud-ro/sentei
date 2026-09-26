// `report` stage core (PLAN.md §6.7): read the analysed DB, build work/report.json,
// and format the stdout summary. Read-only: this module never writes to the DB.
//
// Conventions:
//   * Lines/cols in the report are 1-based (the DB stores SCIP's 0-based positions).
//   * Every list is sorted deterministically (plain code-unit order, not locale).
//   * Anything that weakens a verdict's meaning (assumeClosedWorld, minAgeDays = 0,
//     a repo that did not index cleanly) is a `warnings` line, printed first.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { requireAnalyzed } from './analyze.ts';
import { parseDescriptors, parseScipSymbol } from './scip/read.ts';

/**
 * What every package row counts, in summary column order: the verdicts, with
 * deletion_candidate split in two. `deletion_candidate` counts plain deletions (reason
 * no_refs / only_test_refs) and `dead_island` the deletion candidates with reason
 * dead_island (exports used only by other candidates). report.json `findings` keeps the
 * real verdict (deletion_candidate + reason dead_island).
 */
export const REPORT_VERDICTS = [
  'deletion_candidate',
  'dead_island',
  'unexport_candidate',
  'deprecation_candidate',
  'private_dead',
  'needs_review',
  'blocked',
] as const;

/** Policy keys, in report order. */
const POLICY_KEYS = ['minAgeDays', 'trustPrivateRegistry', 'assumeClosedWorld', 'countTestsAsConsumers', 'countDocsAsConsumers'] as const;

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

export interface ReportPackage {
  package_id: string;
  name: string;
  repo: string;
  visibility: string;
  closed_world: boolean;
  opaque: boolean;
  flags: Array<{ flag: string; reason: string | null; file: string | null }>;
  consumers: string[];
  blocked_by: string[];
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
}

export interface ReportRepo {
  repo: string;
  head_sha: string | null;
  index_status: string | null;
}

export interface Report {
  tool: { name: string; version: string };
  /** Epoch seconds. */
  generatedAt: number;
  /** generatedAt as an ISO 8601 UTC string, for humans (`2026-09-24T10:00:00.000Z`). */
  generatedAtIso: string;
  policy: ReportPolicy;
  warnings: string[];
  findings: ReportFinding[];
  versionSkew: ReportVersionSkew[];
  packages: ReportPackage[];
  blockers: ReportBlocker[];
  repos: ReportRepo[];
}

export interface BuildReportOptions {
  db: DatabaseSync;
  /** Epoch seconds; defaults to now (injectable for tests). */
  now?: number;
}

export const ASSUME_CLOSED_WORLD_WARNING =
  'assumeClosedWorld is ON: every package is treated as closed-world; deletion verdicts for published packages are only valid if no external consumers exist';

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
  if (policy.assumeClosedWorld === true) warnings.push(ASSUME_CLOSED_WORLD_WARNING);
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
    WHERE d.ambiguous = 1 OR d.resolution IN ('same-repo', 'published')
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
  const skewRows = db.prepare(`
    SELECT u.consumer_package_id AS package_id, p.repo, u.symbol_str, u.file, u.line, u.col, u.target_package_id
    FROM unresolved_refs u JOIN packages p ON p.package_id = u.consumer_package_id`).all() as Array<{
    package_id: string; repo: string; symbol_str: string; file: string; line: number | null; col: number | null; target_package_id: string;
  }>;
  // A sidecar row and a SCIP row can name the same reference; keep one. A reference into
  // a package whose own index failed is not skew: that package has no definitions at
  // all, so "missing at HEAD" means nothing there (counted in a warning instead).
  const indexFailed = new Set((db.prepare("SELECT DISTINCT package_id FROM package_flags WHERE flag = 'index_failed'").all() as Array<{
    package_id: string;
  }>).map((r) => r.package_id));
  const skewSeen = new Set<string>();
  const versionSkew: ReportVersionSkew[] = [];
  const skewDropped = new Map<string, number>();
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
    if (indexFailed.has(row.target_package_id)) {
      skewDropped.set(row.target_package_id, (skewDropped.get(row.target_package_id) ?? 0) + 1);
      continue;
    }
    versionSkew.push(row);
  }
  if (skewDropped.size > 0) {
    const n = [...skewDropped.values()].reduce((a, b) => a + b, 0);
    const targets = [...skewDropped.keys()].sort(cmp).join(', ');
    warnings.push(`${n} unresolved reference(s) into package(s) whose index failed (${targets}) not reported as version skew: `
      + 'their definitions are unknown, not missing');
  }
  versionSkew.sort(cmpBy((v) => v.package_id, (v) => v.symbol, (v) => v.file, (v) => v.line, (v) => v.col, (v) => v.target_package_id));

  // ---- packages ------------------------------------------------------------------
  const pkgRows = db.prepare(`
    SELECT p.package_id, p.name, p.repo, p.visibility,
           EXISTS (SELECT 1 FROM closed_world_packages c WHERE c.package_id = p.package_id) AS closed_world,
           EXISTS (SELECT 1 FROM opaque_packages o WHERE o.package_id = p.package_id) AS opaque,
           (SELECT count(*) FROM symbols s WHERE s.package_id = p.package_id AND s.is_exported = 1) AS exported,
           (SELECT count(*) FROM symbols s WHERE s.package_id = p.package_id
              AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.module_symbol_id = s.symbol_id)) AS symbols
    FROM packages p`).all() as Array<{
    package_id: string; name: string; repo: string; visibility: string; closed_world: number; opaque: number; exported: number; symbols: number;
  }>;
  const flagRows = db.prepare('SELECT package_id, flag, reason, file FROM package_flags').all() as Array<{
    package_id: string; flag: string; reason: string | null; file: string | null;
  }>;
  const consumerRows = db.prepare(
    'SELECT DISTINCT resolved_package_id AS package_id, consumer_package_id FROM package_deps WHERE resolved_package_id IS NOT NULL',
  ).all() as Array<{ package_id: string; consumer_package_id: string }>;
  const blockedRows = db.prepare('SELECT package_id, blocker_package_id, flag FROM blocked_packages').all() as Array<{
    package_id: string; blocker_package_id: string; flag: string;
  }>;

  const repoOf = new Map(pkgRows.map((p) => [p.package_id, p.repo]));
  const packages: ReportPackage[] = pkgRows
    .map((p) => {
      const counts: Record<string, number> = Object.fromEntries(REPORT_VERDICTS.map((v) => [v, 0]));
      const mine = findings.filter((f) => f.package_id === p.package_id);
      for (const f of mine) {
        const key = f.verdict === 'deletion_candidate' && f.reasons.includes('dead_island') ? 'dead_island' : f.verdict;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return {
        package_id: p.package_id,
        name: p.name,
        repo: p.repo,
        visibility: p.visibility,
        closed_world: p.closed_world === 1,
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
    packages,
    blockers,
    repos,
  };
}

// ---- summary ----------------------------------------------------------------------

type Align = 'l' | 'r';

/** Plain ASCII table: header, dashed rule, rows; columns padded to the widest cell. */
export function formatTable(headers: string[], rows: string[][], align: Align[]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (align[i] === 'r' ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

const SHORT: Record<string, string> = {
  deletion_candidate: 'DELETE',
  dead_island: 'ISLAND',
  unexport_candidate: 'UNEXPORT',
  deprecation_candidate: 'DEPRECATE',
  private_dead: 'PRIV-DEAD',
  needs_review: 'REVIEW',
  blocked: 'BLOCKED',
};

/** Maximum rows printed under "Top blockers" (report.json has them all). */
const TOP_BLOCKERS = 10;

/** The stdout summary (PLAN.md §6.7): warnings, per-package counts, top blockers, skew. */
export function formatSummary(report: Report): string {
  const out: string[] = [];
  const when = new Date(report.generatedAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  out.push(`sentei ${report.tool.version} report, generated ${when}`);
  out.push(`policy: ${POLICY_KEYS.map((k) => `${k}=${JSON.stringify(report.policy[k])}`).join(' ')}`);

  if (report.warnings.length > 0) {
    const bar = '!'.repeat(78);
    out.push('', bar);
    for (const w of report.warnings) out.push(`!! WARNING: ${w}`);
    out.push(bar);
  }

  // Per-package table.
  const extra = [...new Set(report.packages.flatMap((p) => Object.keys(p.counts)))]
    .filter((v) => !(REPORT_VERDICTS as readonly string[]).includes(v))
    .sort(cmp);
  const verdicts = [...REPORT_VERDICTS, ...extra];
  const totals = Object.fromEntries(verdicts.map((v) => [v, 0])) as Record<string, number>;
  const pkgRows = report.packages.map((p) => {
    for (const v of verdicts) totals[v]! += p.counts[v] ?? 0;
    return [
      p.name,
      p.repo,
      p.visibility,
      p.closed_world ? 'closed' : 'open',
      p.opaque ? 'yes' : '',
      ...verdicts.map((v) => String(p.counts[v] ?? 0)),
      p.blocked_by.join(', '),
    ];
  });
  pkgRows.push(['TOTAL', '', '', '', '', ...verdicts.map((v) => String(totals[v])), '']);
  out.push('', `Packages (${report.packages.length}), ${report.findings.length} finding(s)`);
  out.push(...formatTable(
    ['PACKAGE', 'REPO', 'VISIBILITY', 'WORLD', 'OPAQUE', ...verdicts.map((v) => SHORT[v] ?? v.toUpperCase()), 'BLOCKED BY'],
    pkgRows,
    ['l', 'l', 'l', 'l', 'l', ...verdicts.map((): Align => 'r'), 'l'],
  ));
  out.push('DELETE: exports with no counted use; ISLAND: exports used only by other candidates (delete them together).');

  // Top blockers.
  out.push('', 'Top blockers (opaque consumers preventing verdicts; fix these first)');
  if (report.blockers.length === 0) {
    out.push('  none');
  } else {
    const shown = report.blockers.slice(0, TOP_BLOCKERS);
    out.push(...formatTable(
      ['BLOCKER', 'REPO', 'FLAGS', 'FINDINGS', 'BLOCKS PACKAGES'],
      shown.map((b) => [b.blocker_package_id, b.repo ?? '', b.flags.join(','), String(b.blocked_findings), b.blocks_packages.join(', ')]),
      ['l', 'l', 'l', 'r', 'l'],
    ));
    if (report.blockers.length > shown.length) out.push(`... and ${report.blockers.length - shown.length} more (see report.json)`);
  }

  // Version skew.
  const skewPkgs = new Set(report.versionSkew.map((v) => v.package_id)).size;
  out.push('', `Version skew: ${report.versionSkew.length} reference(s) from ${skewPkgs} package(s) to symbols missing at HEAD`);
  return `${out.join('\n')}\n`;
}
