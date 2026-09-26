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
  sizeKb: number | null;
  pushedAt: string | null;
  fork: boolean;
  archived: boolean;
  template: boolean;
  headSha: string | null;
  manifests: Record<string, boolean> | null;
  cloneError: string | null;
}

export function repoRows(sel: RepoSelection): RepoRow[] {
  return sel.repos.map(({ entry: e, decision: d }) => ({
    name: e.name,
    selected: d.include,
    reasons: d.reasons,
    language: e.language ?? null,
    sizeKb: e.sizeKb ?? null,
    pushedAt: e.pushedAt ?? null,
    fork: e.fork ?? false,
    archived: e.archived ?? false,
    template: e.template ?? false,
    headSha: e.headSha ?? null,
    manifests: e.manifests ?? null,
    cloneError: e.cloneError ?? null,
  }));
}

const size = (kb: number | null): string => (kb === null ? '?' : kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`);

/** Fixed-width table: repo, language, size, pushed, selected, reasons. */
export function formatRepoTable(rows: readonly RepoRow[]): string {
  const cells = rows.map((r) => [
    r.name,
    r.language ?? '-',
    size(r.sizeKb),
    r.pushedAt?.slice(0, 10) ?? '-',
    r.selected ? 'yes' : 'no',
    [...r.reasons, ...(r.cloneError !== null ? [`last clone failed: ${r.cloneError}`] : [])].join('; '),
  ]);
  const header = ['REPO', 'LANGUAGE', 'SIZE', 'PUSHED', 'SELECTED', 'REASONS'];
  const right = new Set([2]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: readonly string[]): string =>
    c.map((v, i) => (i === c.length - 1 ? v : right.has(i) ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join('  ').trimEnd();
  const selected = rows.filter((r) => r.selected).length;
  return `${[line(header), ...cells.map(line)].join('\n')}\n\n${selected} of ${rows.length} repo(s) selected\n`;
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
