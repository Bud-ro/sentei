import { readOrgConfigRepos, selectGithubRepos, type RepoSelection } from '@sentei/core';
import type { StageContext } from '../context.ts';
import { githubCoreOptions, orgConfigDir } from './discover.ts';

/** What `sentei repos` needs: no database, a separate channel for the table. */
export interface ReposContext extends Pick<StageContext, 'work' | 'org' | 'orgDir' | 'github'> {
  /** Machine output (--json) instead of the table. */
  json: boolean;
  /** The table / JSON (stdout). */
  out: (text: string) => void;
  /** Progress lines (stderr, so --json stays parseable). */
  log: (line: string) => void;
}

/** One row of `sentei repos --json`. */
export interface RepoRow {
  name: string;
  selected: boolean;
  reasons: string[];
  language: string | null;
  /** API `size` (KB, whole history). */
  sizeKb: number | null;
  /** HEAD tree size (KB); null when the tree was not read in full or not probed. */
  headTreeKb: number | null;
  /** Which size repos.maxSizeMb used: 'head' (the git tree) or 'api' (full history). */
  sizeSource: 'head' | 'api';
  pushedAt: string | null;
  fork: boolean;
  archived: boolean;
  template: boolean;
  headSha: string | null;
  /** How manifests were found ('tree', 'truncated', 'root'); null = not probed. */
  probe: string | null;
  /** package.json / pubspec.yaml paths; null = not probed. */
  manifests: string[] | null;
  cloneError: string | null;
}

export function repoRows(sel: RepoSelection): RepoRow[] {
  return sel.repos.map(({ entry: e, decision: d }) => ({
    name: e.name,
    selected: d.include,
    reasons: d.reasons,
    language: e.language ?? null,
    sizeKb: e.sizeKb ?? null,
    headTreeKb: e.headTreeKb ?? null,
    sizeSource: e.headTreeKb != null ? 'head' : 'api',
    pushedAt: e.pushedAt ?? null,
    fork: e.fork ?? false,
    archived: e.archived ?? false,
    template: e.template ?? false,
    headSha: e.headSha ?? null,
    probe: e.probe ?? null,
    manifests: e.manifests ?? null,
    cloneError: e.cloneError ?? null,
  }));
}

const size = (kb: number | null): string => (kb === null ? '?' : kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`);

/**
 * Two fixed-width tables, selected repos then excluded ones: repo, language, size
 * (HEAD tree, or `api` = full-history API size when the tree was not read),
 * manifests found (`-` = not probed), pushed, reasons; then the totals and the
 * excluded repos that carry manifests.
 */
export function formatRepoTable(rows: readonly RepoRow[]): string {
  const header = ['REPO', 'LANGUAGE', 'SIZE', 'MANIFESTS', 'PUSHED', 'REASONS'];
  const right = new Set([2, 3]);
  const cellsOf = (r: RepoRow): string[] => [
    r.name,
    r.language ?? '-',
    r.sizeSource === 'head' ? size(r.headTreeKb) : `${size(r.sizeKb)} api`,
    r.manifests === null ? '-' : String(r.manifests.length),
    r.pushedAt?.slice(0, 10) ?? '-',
    [...r.reasons, ...(r.cloneError !== null ? [`last clone failed: ${r.cloneError}`] : [])].join('; '),
  ];
  const all = rows.map(cellsOf);
  const widths = header.map((h, i) => Math.max(h.length, ...all.map((c) => c[i]!.length)));
  const line = (c: readonly string[]): string =>
    c.map((v, i) => (i === c.length - 1 ? v : right.has(i) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join('  ').trimEnd();
  const selected = rows.filter((r) => r.selected);
  const excluded = rows.filter((r) => !r.selected);
  const out: string[] = [];
  for (const [title, group] of [['Selected', selected], ['Excluded', excluded]] as const) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(`${title} (${group.length}):`, line(header), ...group.map((r) => line(cellsOf(r))));
  }
  out.push('', `${selected.length} of ${rows.length} repo(s) selected`);
  const withManifests = excluded.filter((r) => (r.manifests?.length ?? 0) > 0);
  if (withManifests.length > 0) {
    out.push(`${withManifests.length} excluded repo(s) have package manifests and may consume org packages `
      + `(their references are invisible): ${withManifests.map((r) => r.name).join(', ')}`);
  }
  if (rows.some((r) => r.sizeSource === 'api')) {
    out.push('SIZE is the HEAD tree; "api" marks GitHub\'s full-history size (git tree not fetched, truncated or unavailable)');
  }
  return `${out.join('\n')}\n`;
}

/**
 * `sentei repos --org <name>`: which repos `discover` would clone and why, from the
 * lockfile when it exists (no API calls) else from a fresh listing (writes the
 * lockfile). Never clones.
 */
export async function repos(ctx: ReposContext): Promise<void> {
  if (ctx.org === undefined) {
    throw new Error(`sentei repos: --org <name> is required${ctx.orgDir !== undefined ? ' (repos lists GitHub repos; --org-dir takes every repo in org.json)' : ''}`);
  }
  const log = (line: string): void => ctx.log(`[repos] ${line}`);
  const gh = ctx.github ?? { updateLockfile: false, include: [], exclude: [] };
  const configDir = orgConfigDir(gh, log);
  const sel = await selectGithubRepos({
    ...githubCoreOptions(ctx, ctx.org, log),
    config: configDir === null ? {} : readOrgConfigRepos(configDir),
  });
  const rows = repoRows(sel);
  ctx.out(ctx.json ? `${JSON.stringify(rows, null, 2)}\n` : formatRepoTable(rows));
}
