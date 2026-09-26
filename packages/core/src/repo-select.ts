// Repo selection before cloning (DESIGN Phase 2, decision 4). Pure: no I/O.
//
// Every listed repo gets a decision { include, reasons } from its listing facts
// (GitHub REST fields recorded in the lockfile) and the merged selection settings
// (org sentei.json `repos` + CLI flags). Rules, first decisive one wins:
//   1. --include, --exclude, repos.include, repos.exclude (in that precedence;
//      an include match forces the repo in past every later rule)
//   2. empty (no default-branch commit) and disabled repos (cannot be cloned)
//   3. archived (unless includeArchived), forks (unless includeForks), templates
//   4. size over maxSizeMb: the HEAD tree size (sum of blob sizes from the git
//      tree), else, when the tree was truncated or unavailable, the API `size`
//      (KB, full history: an upper bound)
//   5. pushed_at older than minPushed
//   6. language: listing language in `languages`, or a package.json /
//      pubspec.yaml anywhere in the HEAD tree (outside installed / vendored
//      dirs); `languages: []` disables it.
// With `probe` on, a repo that reaches rule 4 unprobed, or that an explicit glob
// decided, gets `needsProbe`: the caller fetches its git tree (one request) and
// decides again. Explicitly matched repos are probed only for the record (the
// lockfile, `sentei repos` and the report's excluded-repo warning); repos that
// cannot be cloned or that rule 3 skips are never probed.
import type { RepoSelectConfig } from './config.ts';
import { matchGlob } from './glob.ts';

export const DEFAULT_LANGUAGES: readonly string[] = Object.freeze(['TypeScript', 'JavaScript', 'Dart']);
export const DEFAULT_MAX_SIZE_MB = 500;
export const DEFAULT_CLONE_CONCURRENCY = 8;
/**
 * Manifest file names the probe looks for; also the root fallback's probe order (a
 * hit stops it) when the git tree is truncated or unavailable.
 */
export const PROBE_MANIFESTS: readonly string[] = Object.freeze(['package.json', 'pubspec.yaml']);

/** Merged selection settings (recorded in the lockfile header). */
export interface RepoSelectSettings {
  /** repos.include (org sentei.json): repo-name globs forced in. */
  include: string[];
  /** repos.exclude (org sentei.json). */
  exclude: string[];
  /** --include (beats every config rule). */
  cliInclude: string[];
  /** --exclude (beats config include). */
  cliExclude: string[];
  /** GitHub primary languages that select a repo; [] disables the language rule. */
  languages: string[];
  /** null disables the size rule. */
  maxSizeMb: number | null;
  /** ISO date or `<n>d`; null disables the rule. */
  minPushed: string | null;
  includeForks: boolean;
  includeArchived: boolean;
  /** Fetch each candidate's git tree (manifests anywhere, HEAD size); off: API size and language only. */
  probe: boolean;
}

export function defaultSelectSettings(): RepoSelectSettings {
  return {
    include: [], exclude: [], cliInclude: [], cliExclude: [],
    languages: [...DEFAULT_LANGUAGES], maxSizeMb: DEFAULT_MAX_SIZE_MB, minPushed: null,
    includeForks: false, includeArchived: false, probe: true,
  };
}

/** What the listing (or lockfile) knows about one repo. */
export interface RepoFacts {
  name: string;
  fork: boolean;
  template: boolean;
  archived: boolean;
  disabled: boolean;
  /** No default-branch commit (branch lookup 404). */
  empty?: boolean;
  /** GitHub's primary language; null when GitHub detected none. */
  language: string | null;
  /** API `size` in KB (the whole history, packed). */
  sizeKb: number | null;
  pushedAt: string | null;
  /** Repo-relative package.json / pubspec.yaml paths the probe found; undefined = not probed. */
  manifests?: string[];
  /** Sum of the HEAD tree's blob sizes (KB); null when the tree was truncated or unavailable. */
  headTreeKb?: number | null;
  /**
   * How `manifests` was found: 'tree' (the full recursive git tree), 'truncated'
   * (GitHub cut the tree short: its partial entries plus a root probe), 'root'
   * (tree unavailable: root probe only).
   */
  probe?: ProbeKind;
}

export type ProbeKind = 'tree' | 'truncated' | 'root';

export interface RepoDecision {
  include: boolean;
  reasons: string[];
  /** Fetch the git tree, record `manifests` / `headTreeKb` / `probe`, decide again. */
  needsProbe?: boolean;
}

const DAY_MS = 86_400_000;

/** Parse `minPushed` (ISO date/time or `<n>d`) into a cutoff (epoch ms); null when malformed. */
export function minPushedCutoff(minPushed: string, nowMs: number): number | null {
  const rel = /^(\d+)d$/.exec(minPushed);
  if (rel) return nowMs - Number(rel[1]) * DAY_MS;
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(minPushed)) return null;
  const t = Date.parse(minPushed);
  return Number.isNaN(t) ? null : t;
}

const q = JSON.stringify;
const mb = (kb: number): string => `${(kb / 1024).toFixed(kb < 10 * 1024 ? 1 : 0)} MB`;

/**
 * Decide one repo. `legacy` facts (from a lockfile written before selection
 * metadata existed) skip the size, push-date and language rules: the data is unknown.
 */
export function decideRepo(f: RepoFacts, s: RepoSelectSettings, nowMs: number, legacy = false): RepoDecision {
  const hit = (globs: readonly string[]): string | undefined => globs.find((g) => matchGlob(g, f.name));
  // 1. explicit globs: CLI before config, include before exclude within a source.
  const explicit: Array<[readonly string[], boolean, string]> = [
    [s.cliInclude, true, '--include'],
    [s.cliExclude, false, '--exclude'],
    [s.include, true, 'repos.include'],
    [s.exclude, false, 'repos.exclude'],
  ];
  // Explicitly matched repos are probed for the record only (their decision stands).
  const record = !legacy && s.probe && f.manifests === undefined && !f.empty && !f.disabled ? { needsProbe: true } : {};
  for (const [globs, include, source] of explicit) {
    const g = hit(globs);
    if (g === undefined) continue;
    if (!include) return { include: false, reasons: [`excluded by ${source} ${q(g)}`], ...record };
    // Forced, but a repo that cannot be cloned still cannot be cloned.
    if (f.empty) return { include: false, reasons: [`included by ${source} ${q(g)}`, 'empty repository (no commit on the default branch)'] };
    if (f.disabled) return { include: false, reasons: [`included by ${source} ${q(g)}`, 'disabled by GitHub'] };
    return { include: true, reasons: [`included by ${source} ${q(g)}`], ...record };
  }
  // 2. cannot be cloned.
  if (f.empty) return { include: false, reasons: ['empty repository (no commit on the default branch)'] };
  if (f.disabled) return { include: false, reasons: ['disabled by GitHub'] };
  // 3. kinds of repo that are rarely org code.
  if (f.archived && !s.includeArchived) return { include: false, reasons: ['archived (--include-archived to keep)'] };
  if (f.fork && !s.includeForks) return { include: false, reasons: ['fork (--include-forks to keep)'] };
  if (f.template) return { include: false, reasons: ['template repository'] };
  if (legacy) return { include: true, reasons: ['listed (lockfile without selection metadata)'] };
  // Rules 4 and 6 read the git tree: fetch it first.
  if (s.probe && f.manifests === undefined) return { include: false, reasons: ['git tree probe pending'], needsProbe: true };
  // 4. size: the HEAD tree when known, else the API size (full history).
  if (s.maxSizeMb !== null) {
    const head = f.headTreeKb ?? null;
    if (head !== null && head > s.maxSizeMb * 1024) {
      return { include: false, reasons: [`HEAD size ${mb(head)} over repos.maxSizeMb ${s.maxSizeMb}`] };
    }
    if (head === null && f.sizeKb !== null && f.sizeKb > s.maxSizeMb * 1024) {
      const why = !s.probe ? 'probe off' : f.probe === 'truncated' ? 'git tree truncated' : 'git tree unavailable';
      return { include: false, reasons: [`size ${mb(f.sizeKb)} (API size, full history; ${why}) over repos.maxSizeMb ${s.maxSizeMb}`] };
    }
  }
  // 5. last push.
  if (s.minPushed !== null) {
    const cutoff = minPushedCutoff(s.minPushed, nowMs);
    if (cutoff === null) throw new Error(`sentei: repos.minPushed ${q(s.minPushed)} must be an ISO date or "<n>d"`);
    const pushed = f.pushedAt === null ? NaN : Date.parse(f.pushedAt);
    if (Number.isNaN(pushed)) return { include: false, reasons: [`never pushed (repos.minPushed ${s.minPushed})`] };
    if (pushed < cutoff) return { include: false, reasons: [`last push ${f.pushedAt!.slice(0, 10)} before repos.minPushed ${s.minPushed}`] };
  }
  // 6. language, else manifest probe.
  if (s.languages.length === 0) return { include: true, reasons: ['language rule disabled (repos.languages: [])'] };
  const lang = f.language;
  if (lang !== null && s.languages.some((l) => l.toLowerCase() === lang.toLowerCase())) {
    return { include: true, reasons: [`language ${lang}`] };
  }
  const label = lang === null ? 'no language detected' : `language ${lang}`;
  const miss = lang === null ? label : `${label} not in repos.languages`;
  if (!s.probe || f.manifests === undefined) return { include: false, reasons: [`${miss} (probe off)`] };
  if (f.manifests.length > 0) return { include: true, reasons: [`${label}, but ${manifestSummary(f.manifests)}`] };
  const where = f.probe === 'truncated' ? 'at the root or in the truncated git tree'
    : f.probe === 'root' ? 'at the root (git tree unavailable)' : 'in the HEAD tree';
  return { include: false, reasons: [`${miss}; no ${PROBE_MANIFESTS.join(' or ')} ${where}`] };
}

/** "package.json" for one manifest, "3 manifests (a/package.json, b/package.json, c/pubspec.yaml)" (first 3, then "…"). */
export function manifestSummary(manifests: readonly string[]): string {
  if (manifests.length === 1) return manifests[0]!;
  return `${manifests.length} manifests (${manifests.slice(0, 3).join(', ')}${manifests.length > 3 ? ', …' : ''})`;
}

/** An excluded repo as the excluded-repo warning names it. */
export interface ExcludedRepoInfo {
  /** "org/name" (the bare name in the lockfile). */
  repo: string;
  /** The decision's reasons joined with "; " (or "clone failed: …"). */
  reason: string;
  /** Manifest paths found by the probe; null = not probed. */
  manifests: string[] | null;
}

/** Short label of an exclusion reason for the warning ("repos.exclude", "size", "archived", …). */
export function exclusionKind(reason: string): string {
  const m = /^excluded by (\S+)/.exec(reason);
  if (m) return m[1]!;
  if (/^(HEAD )?size /.test(reason)) return 'size';
  if (/^(last push|never pushed)/.test(reason)) return 'minPushed';
  if (/^clone failed/.test(reason)) return 'clone failed';
  if (/^(language|no language)/.test(reason)) return 'language';
  return reason.split(/[ (;]/)[0] || 'excluded';
}

const EXCLUDED_WARNING_HEAD = ' excluded repo(s) have package manifests and may consume org packages (their references are invisible): ';

/**
 * "N excluded repo(s) have package manifests and may consume org packages (their
 * references are invisible): acme/app (repos.exclude, 12 manifests), …" with every
 * repo listed (report.json keeps it whole; shortenExcludedWarning cuts it for
 * stdout). Only repos with at least one manifest belong in `items`.
 */
export function excludedReposWarning(items: readonly ExcludedRepoInfo[]): string {
  const list = items.map((x) => {
    const n = x.manifests?.length ?? 0;
    return `${x.repo} (${exclusionKind(x.reason)}, ${n} manifest${n === 1 ? '' : 's'})`;
  });
  return `${items.length}${EXCLUDED_WARNING_HEAD}${list.join(', ')}`;
}

/** The excluded-repo warning cut to its first `limit` repos ("… and 5 more (report.json)"); other warnings unchanged. */
export function shortenExcludedWarning(warning: string, limit = 10, where = 'all in report.json warnings'): string {
  const at = warning.indexOf(EXCLUDED_WARNING_HEAD);
  if (at < 0 || !/^\d+$/.test(warning.slice(0, at))) return warning;
  const head = warning.slice(0, at + EXCLUDED_WARNING_HEAD.length);
  const items = warning.slice(head.length).split(/(?<=\)), /);
  if (items.length <= limit) return warning;
  return `${head}${items.slice(0, limit).join(', ')} … and ${items.length - limit} more (${where})`;
}

/** Human summary of how two settings differ (for "settings changed" log lines); [] when equal. */
export function diffSettings(before: RepoSelectSettings, after: RepoSelectSettings): string[] {
  const out: string[] = [];
  for (const key of Object.keys(after) as Array<keyof RepoSelectSettings>) {
    const a = JSON.stringify(before[key] ?? null);
    const b = JSON.stringify(after[key]);
    if (a !== b) out.push(`${key} ${a} → ${b}`);
  }
  return out;
}

/** CLI flags that override the org sentei.json `repos` section (undefined = not given). */
export interface RepoSelectCli {
  include?: readonly string[];
  exclude?: readonly string[];
  includeForks?: boolean;
  includeArchived?: boolean;
}

/**
 * Merge the org sentei.json `repos` section (already validated, see config.ts) and
 * CLI flags over the defaults. CLI globs are kept apart from config globs because
 * they take precedence over them (see decideRepo).
 */
export function mergeSelectSettings(config: RepoSelectConfig, cli: RepoSelectCli): RepoSelectSettings {
  const d = defaultSelectSettings();
  return {
    include: [...(config.include ?? d.include)],
    exclude: [...(config.exclude ?? d.exclude)],
    cliInclude: [...(cli.include ?? [])],
    cliExclude: [...(cli.exclude ?? [])],
    languages: [...(config.languages ?? d.languages)],
    maxSizeMb: config.maxSizeMb !== undefined ? config.maxSizeMb : d.maxSizeMb,
    minPushed: config.minPushed !== undefined ? config.minPushed : d.minPushed,
    includeForks: cli.includeForks ?? config.includeForks ?? d.includeForks,
    includeArchived: cli.includeArchived ?? config.includeArchived ?? d.includeArchived,
    probe: config.probe ?? d.probe,
  };
}
