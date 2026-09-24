// GitHub discovery (PLAN.md §6.1, §13): list an org's (or user's) repos over the
// REST API with plain fetch + Link-header pagination, pin head shas (optionally
// via a lockfile), shallow-clone each repo, then build the model with discoverRepos.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { discoverRepos, type DiscoverModel } from './discover.ts';
import { ensureClone } from './git.ts';
import { matchGlob } from './glob.ts';

export const DEFAULT_API_URL = 'https://api.github.com';

// ------------------------------------------------------------------- token ---

/**
 * GitHub token: $GITHUB_TOKEN, else $GH_TOKEN, else `gh auth token`; null if none.
 * Never logged.
 */
export async function findToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = env[key]?.trim();
    if (v) return v;
  }
  return new Promise((res) => {
    execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => {
      res(err ? null : stdout.trim() || null);
    });
  });
}

/** Like findToken but throws a clear error when no token is available. */
export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const token = await findToken(env);
  if (token === null) {
    throw new Error('sentei: no GitHub token: set GITHUB_TOKEN (or GH_TOKEN), or log in with `gh auth login`');
  }
  return token;
}

// -------------------------------------------------------------------- list ---

export interface GithubRepo {
  name: string;
  defaultBranch: string;
  headSha: string;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  pushedAt: string | null;
}

export interface ListReposOptions {
  /** Org or user login. */
  org: string;
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Archived repos are dropped unless this is set (PLAN §6.1). */
  includeArchived?: boolean;
  /** Parallel branch lookups (default 8). */
  concurrency?: number;
}

interface ApiRepo {
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  fork: boolean;
  clone_url: string;
  pushed_at: string | null;
  /** Template repositories are scaffolds copied into other repos, never consumers. */
  is_template?: boolean;
}

class NotFound extends Error {}

/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true; // stop handing out work; in-flight items finish on their own
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * List `org`'s repos (falling back to the user endpoint when `org` is not an
 * org) with each default branch's head sha. Sorted by name. Empty repos (no
 * default branch commit) and template repos (`is_template`: a scaffold whose copies are
 * the real repos; its own `package.json` usually reuses a real package's name) are
 * skipped with a log line.
 */
export async function listRepos(opts: ListReposOptions): Promise<GithubRepo[]> {
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const origin = new URL(apiUrl).origin;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sentei',
  };

  const get = async (url: string): Promise<{ body: unknown; next: string | null }> => {
    // Pagination links come from the server: only ever send the token to the API origin.
    if (new URL(url).origin !== origin) throw new Error(`sentei: GitHub API returned a link off ${origin}: ${url}`);
    const res = await fetchImpl(url, { headers });
    if (res.status === 404) throw new NotFound(url);
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const when = Number.isFinite(reset) && reset > 0
          ? `${new Date(reset * 1000).toISOString()} (in ${Math.max(0, Math.ceil((reset * 1000 - Date.now()) / 60_000))} min)`
          : 'unknown';
        throw new Error(`sentei: GitHub API rate limit exhausted (limit ${res.headers.get('x-ratelimit-limit') ?? '?'}); resets at ${when}`);
      }
      let message = '';
      try {
        message = String(((await res.json()) as { message?: unknown }).message ?? '');
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`sentei: GitHub API GET ${url.slice(apiUrl.length) || url}: ${res.status} ${res.statusText}${message ? `: ${message}` : ''}`);
    }
    return { body: await res.json(), next: nextLink(res.headers.get('link')) };
  };

  const getAll = async (first: string): Promise<ApiRepo[]> => {
    const all: ApiRepo[] = [];
    for (let url: string | null = first; url !== null;) {
      const page = await get(url);
      if (!Array.isArray(page.body)) throw new Error(`sentei: GitHub API ${url}: expected an array`);
      all.push(...(page.body as ApiRepo[]));
      url = page.next;
    }
    return all;
  };

  const org = encodeURIComponent(opts.org);
  let listed: ApiRepo[];
  try {
    listed = await getAll(`${apiUrl}/orgs/${org}/repos?type=all&per_page=100`);
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    log(`${opts.org} is not an organization, listing it as a user`);
    try {
      listed = await getAll(`${apiUrl}/users/${org}/repos?per_page=100`);
    } catch (err2) {
      if (err2 instanceof NotFound) throw new Error(`sentei: GitHub org or user "${opts.org}" not found`);
      throw err2;
    }
  }

  const archived = listed.filter((r) => r.archived);
  if (archived.length > 0 && !opts.includeArchived) log(`skipping ${archived.length} archived repo(s)`);
  const templates = listed.filter((r) => r.is_template === true && (opts.includeArchived || !r.archived));
  if (templates.length > 0) {
    log(`skipping ${templates.length} template repo(s): ${templates.map((r) => r.name).sort().join(', ')}`);
  }
  const wanted = listed.filter((r) => (opts.includeArchived || !r.archived) && r.is_template !== true).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const withSha = await mapPool(wanted, opts.concurrency ?? 8, async (r): Promise<GithubRepo | null> => {
    const [owner, name] = r.full_name.split('/').map(encodeURIComponent);
    let body: unknown;
    try {
      ({ body } = await get(`${apiUrl}/repos/${owner}/${name}/branches/${encodeURIComponent(r.default_branch)}`));
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
      log(`${r.full_name}: default branch ${r.default_branch} not found (empty repo?), skipped`);
      return null;
    }
    const sha = (body as { commit?: { sha?: unknown } }).commit?.sha;
    if (typeof sha !== 'string') throw new Error(`sentei: GitHub API: ${r.full_name} branch ${r.default_branch} has no commit sha`);
    return {
      name: r.name,
      defaultBranch: r.default_branch,
      headSha: sha,
      archived: r.archived,
      fork: r.fork,
      cloneUrl: r.clone_url,
      pushedAt: r.pushed_at ?? null,
    };
  });
  return withSha.filter((r): r is GithubRepo => r !== null);
}

// ---------------------------------------------------------------- lockfile ---

/** PLAN §13: pinned listing, committed next to the fixtures. */
export interface Lockfile {
  org: string;
  /** ISO timestamp of the listing. */
  generatedAt: string;
  /** Every non-archived repo (include/exclude/fork filters are applied at run time). */
  repos: Array<{ name: string; defaultBranch: string; headSha: string; fork?: boolean }>;
}

const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function readLockfile(file: string): Lockfile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`sentei: cannot read lockfile ${file}: ${(err as Error).message}`);
  }
  const bad = (why: string): Error => new Error(`sentei: lockfile ${file}: ${why}`);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw bad('must be a JSON object');
  const o = json as Record<string, unknown>;
  if (typeof o['org'] !== 'string' || o['org'] === '') throw bad('"org" must be a non-empty string');
  if (typeof o['generatedAt'] !== 'string') throw bad('"generatedAt" must be a string');
  if (!Array.isArray(o['repos'])) throw bad('"repos" must be an array');
  const seen = new Set<string>();
  const repos = o['repos'].map((r: unknown, i) => {
    const e = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    const { name, defaultBranch, headSha, fork } = e;
    if (typeof name !== 'string' || !REPO_NAME_RE.test(name) || name === '.' || name === '..') throw bad(`repos[${i}].name must be a plain repo name`);
    if (seen.has(name)) throw bad(`repo "${name}" listed twice`);
    seen.add(name);
    if (typeof defaultBranch !== 'string' || defaultBranch === '') throw bad(`repos[${i}].defaultBranch must be a string`);
    if (typeof headSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(headSha)) throw bad(`repos[${i}].headSha must be a commit sha`);
    if (fork !== undefined && typeof fork !== 'boolean') throw bad(`repos[${i}].fork must be a boolean`);
    return { name, defaultBranch, headSha, ...(fork !== undefined ? { fork } : {}) };
  });
  return { org: o['org'], generatedAt: o['generatedAt'], repos };
}

export function writeLockfile(file: string, lock: Lockfile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
}

// ------------------------------------------------------------------ select ---

export interface RepoFilter {
  /** Repo-name globs; when non-empty a repo must match at least one. */
  include?: readonly string[];
  /** Repo-name globs; a repo matching any is dropped. */
  exclude?: readonly string[];
  /** Forks are skipped unless set. */
  includeForks?: boolean;
}

export function selectRepo(r: { name: string; fork?: boolean }, f: RepoFilter): boolean {
  if (r.fork && !f.includeForks) return false;
  if (f.include && f.include.length > 0 && !f.include.some((g) => matchGlob(g, r.name))) return false;
  if (f.exclude?.some((g) => matchGlob(g, r.name))) return false;
  return true;
}

// ---------------------------------------------------------------- discover ---

export interface DiscoverGithubOptions extends RepoFilter {
  org: string;
  /** undefined → findToken/resolveToken; null → no token at all. */
  token?: string | null;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Pinned listing to read (if it exists) or write (if not). */
  lockfile?: string | null;
  /** Relist even when the lockfile exists, and rewrite it. */
  updateLockfile?: boolean;
  /** Clones live at <clonesDir>/<name>. */
  clonesDir: string;
  /** Directory holding the org-level sentei.json, or null for defaults. */
  orgConfigDir: string | null;
  /** Parallel clones (default 4). */
  concurrency?: number;
  log?: (line: string) => void;
  /** Epoch seconds; defaults to now (injectable for tests). */
  now?: number;
}

interface Pinned {
  name: string;
  defaultBranch: string;
  headSha: string;
  fork: boolean;
  cloneUrl: string;
}

/**
 * GitHub source for `discover`: listing (API or lockfile) → filters → shallow
 * clones pinned to each head sha → discoverRepos. Any clone failure aborts:
 * a missing consumer repo would make live code look dead (fail closed).
 */
export async function discoverGithub(opts: DiscoverGithubOptions): Promise<DiscoverModel> {
  const log = opts.log ?? (() => {});
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const lockfile = opts.lockfile ? resolve(opts.lockfile) : null;
  const clonesDir = resolve(opts.clonesDir);

  let token: string | null | undefined = opts.token;
  let pinned: Pinned[];
  if (lockfile !== null && existsSync(lockfile) && !opts.updateLockfile) {
    const lock = readLockfile(lockfile);
    if (lock.org !== opts.org) throw new Error(`sentei: lockfile ${lockfile} is for "${lock.org}", not "${opts.org}"`);
    log(`using lockfile ${lockfile} (${lock.repos.length} repo(s), listed ${lock.generatedAt})`);
    pinned = lock.repos.map((r) => ({
      ...r,
      fork: r.fork ?? false,
      cloneUrl: `https://github.com/${opts.org}/${r.name}.git`,
    }));
    // Public repos clone without a token; use one if we happen to have it (private orgs).
    if (token === undefined) token = await findToken();
  } else {
    if (token === undefined) token = await resolveToken();
    if (token === null) throw new Error('sentei: listing GitHub repos needs a token (or an existing --lockfile)');
    const listed = await listRepos({
      org: opts.org, token, apiUrl, log,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    log(`listed ${listed.length} non-archived repo(s) for ${opts.org}`);
    pinned = listed.map((r) => ({ name: r.name, defaultBranch: r.defaultBranch, headSha: r.headSha, fork: r.fork, cloneUrl: r.cloneUrl }));
    if (lockfile !== null) {
      writeLockfile(lockfile, {
        org: opts.org,
        generatedAt: new Date((opts.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        repos: pinned.map((r) => ({ name: r.name, defaultBranch: r.defaultBranch, headSha: r.headSha, fork: r.fork })),
      });
      log(`wrote lockfile ${lockfile}`);
    }
  }

  const forks = pinned.filter((r) => r.fork && !opts.includeForks).length;
  if (forks > 0) log(`skipping ${forks} fork(s) (use --include-forks to keep them)`);
  const selected = pinned.filter((r) => selectRepo(r, opts));
  const filtered = pinned.length - forks - selected.length;
  if (filtered > 0) log(`skipping ${filtered} repo(s) by --include/--exclude`);
  if (selected.length === 0) log('warning: no repos selected');

  mkdirSync(clonesDir, { recursive: true });
  await mapPool(selected, opts.concurrency ?? 4, async (r) => {
    const dir = join(clonesDir, r.name);
    const t0 = Date.now();
    const { status } = await ensureClone({ dir, cloneUrl: r.cloneUrl, defaultBranch: r.defaultBranch, sha: r.headSha, token, log });
    log(`${opts.org}/${r.name}: ${status} ${r.headSha.slice(0, 12)}${status === 'cached' ? '' : ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`}`);
  });

  return discoverRepos({
    org: opts.org,
    source: { kind: 'github', org: opts.org, apiUrl, lockfile, clonesDir },
    repos: selected.map((r) => ({ name: r.name, defaultBranch: r.defaultBranch, localPath: join(clonesDir, r.name), headSha: r.headSha })),
    orgConfigDir: opts.orgConfigDir,
    log,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
