// GitHub discovery (PLAN.md §6.1, §13; DESIGN Phase 2 decisions 4 and 5): list an
// org's (or user's) repos over the REST API with plain fetch + Link-header
// pagination, decide which ones to clone (repo-select.ts, manifest probes for the
// undecided), pin head shas in a lockfile, shallow-clone the selected repos in
// parallel, then build the model with discoverRepos.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readOrgConfig, type RepoSelectConfig } from './config.ts';
import { discoverRepos, type DiscoverModel } from './discover.ts';
import { ensureClone, objectStoreKb, type EnsureCloneOptions, type EnsureCloneResult } from './git.ts';
import {
  decideRepo, DEFAULT_CLONE_CONCURRENCY, diffSettings, mergeSelectSettings, PROBE_MANIFESTS,
  type RepoDecision, type RepoFacts, type RepoSelectCli, type RepoSelectSettings,
} from './repo-select.ts';

export const DEFAULT_API_URL = 'https://api.github.com';
/**
 * Parallel REST requests. GitHub asks integrators to avoid concurrent requests where
 * they can and caps concurrency at 100 (secondary limits); 8 read-only GETs stay far
 * below that and finish a 100-repo org in seconds.
 */
export const API_CONCURRENCY = 8;

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

// -------------------------------------------------------------------- pool ---

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

// --------------------------------------------------------------------- api ---

/** Time source for rate-limit waits and clone timings (fake in tests). */
export interface Clock {
  /** Epoch ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
};

export interface GithubApiOptions {
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  clock?: Clock;
}

/** Secondary-limit backoff without a Retry-After header: 60 s, 120 s, 240 s. */
export const SECONDARY_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000];
/** Waits for a primary-limit reset before giving up on one request. */
const MAX_PRIMARY_WAITS = 2;

class NotFound extends Error {}

const clockTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const humanWait = (ms: number): string => (ms >= 90_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`);

/**
 * GitHub REST client: auth headers, same-origin pagination, and polite rate-limit
 * handling shared by every concurrent caller:
 * - a response with `x-ratelimit-remaining: 0` pauses all requests until
 *   `x-ratelimit-reset` (one log line), and a 403/429 with remaining 0 is retried
 *   after that reset (twice at most);
 * - a secondary limit (429, or 403 with `retry-after` or a "secondary rate limit"
 *   message) pauses all requests for `retry-after` seconds, else 60 s, 120 s,
 *   240 s, and gives up after 3 retries.
 */
export class GithubApi {
  readonly apiUrl: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;
  readonly #clock: Clock;
  readonly #headers: Record<string, string>;
  /** Epoch ms before which no request is sent (shared pause). */
  #pausedUntil = 0;
  /** Requests sent (for tests and the summary). */
  requests = 0;

  constructor(opts: GithubApiOptions) {
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.#origin = new URL(this.apiUrl).origin;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#log = opts.log ?? (() => {});
    this.#clock = opts.clock ?? SYSTEM_CLOCK;
    this.#headers = {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sentei',
    };
  }

  #pause(untilMs: number, why: string): void {
    if (untilMs <= this.#pausedUntil) return; // already waiting at least that long: no second log line
    this.#pausedUntil = untilMs;
    this.#log(`${why}; waiting until ${clockTime(untilMs)} (${humanWait(untilMs - this.#clock.now())})`);
  }

  /** GET `url` (absolute, or a path under the API URL); 404 throws NotFound. */
  async get(pathOrUrl: string): Promise<{ body: unknown; next: string | null }> {
    const url = pathOrUrl.startsWith('/') ? `${this.apiUrl}${pathOrUrl}` : pathOrUrl;
    // Pagination links come from the server: only ever send the token to the API origin.
    if (new URL(url).origin !== this.#origin) throw new Error(`sentei: GitHub API returned a link off ${this.#origin}: ${url}`);
    const label = url.startsWith(this.apiUrl) ? url.slice(this.apiUrl.length) : url;
    let secondaryRetries = 0;
    let primaryWaits = 0;
    for (;;) {
      const wait = this.#pausedUntil - this.#clock.now();
      if (wait > 0) await this.#clock.sleep(wait);
      this.requests++;
      const res = await this.#fetch(url, { headers: this.#headers });
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const resetMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
      const limit = res.headers.get('x-ratelimit-limit') ?? '?';
      if (res.ok) {
        if (remaining === '0' && resetMs !== null) {
          this.#pause(Math.max(resetMs + 1000, this.#clock.now()), `GitHub API rate limit used up (limit ${limit}/h)`);
        }
        return { body: await res.json(), next: nextLink(res.headers.get('link')) };
      }
      if (res.status === 404) throw new NotFound(url);
      let message = '';
      try {
        message = String(((await res.json()) as { message?: unknown }).message ?? '');
      } catch {
        /* non-JSON error body */
      }
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        if (resetMs === null || primaryWaits >= MAX_PRIMARY_WAITS) {
          const when = resetMs === null ? 'unknown' : `${new Date(resetMs).toISOString()} (in ${Math.max(0, Math.ceil((resetMs - this.#clock.now()) / 60_000))} min)`;
          throw new Error(`sentei: GitHub API rate limit exhausted (limit ${limit}); resets at ${when}`);
        }
        primaryWaits++;
        this.#pause(Math.max(resetMs + 1000, this.#clock.now() + 1000), `GitHub API rate limit exhausted (limit ${limit}/h)`);
        continue;
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const hasRetryAfter = res.headers.get('retry-after') !== null && Number.isFinite(retryAfter) && retryAfter >= 0;
      const secondary = res.status === 429 || (res.status === 403 && (hasRetryAfter || /secondary rate limit|abuse/i.test(message)));
      if (secondary) {
        if (secondaryRetries >= SECONDARY_BACKOFF_MS.length) {
          throw new Error(`sentei: GitHub API GET ${label}: secondary rate limit still hit after ${secondaryRetries} retries; wait a few minutes and rerun`);
        }
        const delay = hasRetryAfter ? retryAfter * 1000 : SECONDARY_BACKOFF_MS[secondaryRetries]!;
        secondaryRetries++;
        this.#pause(this.#clock.now() + delay, `GitHub API secondary rate limit (${res.status}, retry ${secondaryRetries}/${SECONDARY_BACKOFF_MS.length})`);
        continue;
      }
      throw new Error(`sentei: GitHub API GET ${label}: ${res.status} ${res.statusText}${message ? `: ${message}` : ''}`);
    }
  }

  /** GET, with 404 → null. */
  async getOrNull(pathOrUrl: string): Promise<unknown | null> {
    try {
      return (await this.get(pathOrUrl)).body;
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  /** Every page of a list endpoint. */
  async getAll(first: string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let url: string | null = first; url !== null;) {
      const page = await this.get(url);
      if (!Array.isArray(page.body)) throw new Error(`sentei: GitHub API ${url}: expected an array`);
      all.push(...page.body);
      url = page.next;
    }
    return all;
  }
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

// -------------------------------------------------------------------- list ---

/** One listed repo: selection facts plus what cloning needs (no head sha yet). */
export interface GithubRepo extends RepoFacts {
  owner: string;
  defaultBranch: string;
  cloneUrl: string;
}

interface ApiRepo {
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  disabled?: boolean;
  fork: boolean;
  clone_url: string;
  pushed_at: string | null;
  size?: number;
  language?: string | null;
  /** Template repositories are scaffolds copied into other repos, never consumers. */
  is_template?: boolean;
}

/**
 * List every repo of `org` (falling back to the user endpoint when `org` is not an
 * org), archived, forks and templates included, sorted by name. One request per 100
 * repos; no per-repo calls (head shas and probes come later, only for repos that
 * need them).
 */
export async function listRepos(api: GithubApi, org: string, log: (line: string) => void = () => {}): Promise<GithubRepo[]> {
  const o = encodeURIComponent(org);
  let listed: unknown[];
  try {
    listed = await api.getAll(`/orgs/${o}/repos?type=all&per_page=100`);
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    log(`${org} is not an organization, listing it as a user`);
    try {
      listed = await api.getAll(`/users/${o}/repos?per_page=100`);
    } catch (err2) {
      if (err2 instanceof NotFound) throw new Error(`sentei: GitHub org or user "${org}" not found`);
      throw err2;
    }
  }
  return (listed as ApiRepo[])
    .map((r): GithubRepo => ({
      name: r.name,
      owner: r.full_name.split('/')[0] ?? org,
      defaultBranch: r.default_branch,
      cloneUrl: r.clone_url,
      fork: r.fork === true,
      template: r.is_template === true,
      archived: r.archived === true,
      disabled: r.disabled === true,
      language: typeof r.language === 'string' ? r.language : null,
      sizeKb: typeof r.size === 'number' ? r.size : null,
      pushedAt: r.pushed_at ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Head sha of `branch`, or null when the branch does not exist (empty repo). */
export async function headShaOf(api: GithubApi, owner: string, repo: string, branch: string): Promise<string | null> {
  const body = await api.getOrNull(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`);
  if (body === null) return null;
  const sha = (body as { commit?: { sha?: unknown } }).commit?.sha;
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error(`sentei: GitHub API: ${owner}/${repo} branch ${branch} has no commit sha`);
  return sha;
}

/**
 * Root manifest probe: GET /repos/{o}/{r}/contents/<file> at `ref`, 404 = absent.
 * Stops at the first hit (package.json before pubspec.yaml), so 1-2 requests.
 */
export async function probeManifests(api: GithubApi, owner: string, repo: string, ref: string | null): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const file of PROBE_MANIFESTS) {
    const q = ref === null ? '' : `?ref=${encodeURIComponent(ref)}`;
    const body = await api.getOrNull(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file}${q}`);
    out[file] = body !== null && !Array.isArray(body); // an array is a directory listing
    if (out[file]) break;
  }
  return out;
}

// ---------------------------------------------------------------- lockfile ---

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** One repo in the lockfile: listing facts, pinned sha, and the last selection decision. */
export interface LockRepo {
  name: string;
  defaultBranch: string;
  /** Pinned commit; present for every selected repo (lookups are skipped for the rest). */
  headSha?: string;
  fork?: boolean;
  template?: boolean;
  archived?: boolean;
  disabled?: boolean;
  /** The default branch had no commit when listed. */
  empty?: boolean;
  language?: string | null;
  sizeKb?: number | null;
  pushedAt?: string | null;
  /** Root manifest probe result; absent = not probed. */
  manifests?: Record<string, boolean>;
  selected?: boolean;
  reasons?: string[];
  /** First line of the last clone failure (cleared by a successful clone). */
  cloneError?: string;
  /** Only when it is not https://github.com/<org>/<name>.git (GitHub Enterprise, tests). */
  cloneUrl?: string;
}

/** PLAN §13: pinned listing, committed next to the fixtures. */
export interface Lockfile {
  org: string;
  /** ISO timestamp of the listing. */
  generatedAt: string;
  /**
   * Selection settings the decisions were made with. Absent in lockfiles written
   * before repo selection existed ("legacy"): those hold only non-archived repos
   * with name/branch/sha/fork/template, and only the glob/fork/template rules apply.
   */
  selection?: RepoSelectSettings;
  /** Every listed repo, sorted by name. */
  repos: LockRepo[];
}

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
  let selection: RepoSelectSettings | undefined;
  if (o['selection'] !== undefined) {
    const sel = o['selection'];
    if (typeof sel !== 'object' || sel === null || Array.isArray(sel)) throw bad('"selection" must be an object');
    selection = mergeSelectSettings({}, {});
    const s = sel as Record<string, unknown>;
    const strs = (k: string): string[] => {
      const v = s[k];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(`selection.${k} must be an array of strings`);
      return [...v];
    };
    selection.include = strs('include');
    selection.exclude = strs('exclude');
    selection.cliInclude = strs('cliInclude');
    selection.cliExclude = strs('cliExclude');
    selection.languages = strs('languages');
    for (const k of ['includeForks', 'includeArchived', 'probe'] as const) {
      if (typeof s[k] !== 'boolean') throw bad(`selection.${k} must be a boolean`);
      selection[k] = s[k];
    }
    if (s['maxSizeMb'] !== null && typeof s['maxSizeMb'] !== 'number') throw bad('selection.maxSizeMb must be a number or null');
    selection.maxSizeMb = s['maxSizeMb'] as number | null;
    if (s['minPushed'] !== null && typeof s['minPushed'] !== 'string') throw bad('selection.minPushed must be a string or null');
    selection.minPushed = s['minPushed'] as string | null;
  }
  const legacy = selection === undefined;
  const seen = new Set<string>();
  const repos = o['repos'].map((r: unknown, i): LockRepo => {
    const e = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    const { name, defaultBranch, headSha } = e;
    if (typeof name !== 'string' || !REPO_NAME_RE.test(name) || name === '.' || name === '..') throw bad(`repos[${i}].name must be a plain repo name`);
    if (seen.has(name)) throw bad(`repo "${name}" listed twice`);
    seen.add(name);
    if (typeof defaultBranch !== 'string' || defaultBranch === '') throw bad(`repos[${i}].defaultBranch must be a string`);
    if ((legacy || headSha !== undefined) && (typeof headSha !== 'string' || !SHA_RE.test(headSha))) throw bad(`repos[${i}].headSha must be a commit sha`);
    const out: LockRepo = { name, defaultBranch };
    if (headSha !== undefined) out.headSha = headSha as string;
    for (const k of ['fork', 'template', 'archived', 'disabled', 'empty', 'selected'] as const) {
      const v = e[k];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') throw bad(`repos[${i}].${k} must be a boolean`);
      if (k === 'fork' || k === 'selected' || v) out[k] = v; // fork: false is kept (older lockfiles wrote it)
    }
    if (e['language'] !== undefined) {
      if (e['language'] !== null && typeof e['language'] !== 'string') throw bad(`repos[${i}].language must be a string or null`);
      out.language = e['language'] as string | null;
    }
    if (e['sizeKb'] !== undefined) {
      if (e['sizeKb'] !== null && (typeof e['sizeKb'] !== 'number' || e['sizeKb'] < 0)) throw bad(`repos[${i}].sizeKb must be a number or null`);
      out.sizeKb = e['sizeKb'] as number | null;
    }
    if (e['pushedAt'] !== undefined) {
      if (e['pushedAt'] !== null && typeof e['pushedAt'] !== 'string') throw bad(`repos[${i}].pushedAt must be a string or null`);
      out.pushedAt = e['pushedAt'] as string | null;
    }
    if (e['manifests'] !== undefined) {
      const m = e['manifests'];
      if (typeof m !== 'object' || m === null || Array.isArray(m) || !Object.values(m).every((v) => typeof v === 'boolean')) {
        throw bad(`repos[${i}].manifests must map file names to booleans`);
      }
      out.manifests = { ...(m as Record<string, boolean>) };
    }
    if (e['reasons'] !== undefined) {
      if (!Array.isArray(e['reasons']) || !e['reasons'].every((x) => typeof x === 'string')) throw bad(`repos[${i}].reasons must be an array of strings`);
      out.reasons = [...e['reasons']];
    }
    if (e['cloneUrl'] !== undefined) {
      if (typeof e['cloneUrl'] !== 'string' || !/^(?:https|file):\/\//.test(e['cloneUrl'])) throw bad(`repos[${i}].cloneUrl must be an https:// URL`);
      out.cloneUrl = e['cloneUrl'];
    }
    if (e['cloneError'] !== undefined) {
      if (typeof e['cloneError'] !== 'string') throw bad(`repos[${i}].cloneError must be a string`);
      out.cloneError = e['cloneError'];
    }
    if (out.selected === true && out.headSha === undefined) throw bad(`repos[${i}] is selected but has no headSha`);
    return out;
  });
  return { org: o['org'], generatedAt: o['generatedAt'], ...(selection ? { selection } : {}), repos };
}

export function writeLockfile(file: string, lock: Lockfile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lockfileText(lock));
}

const lockfileText = (lock: Lockfile): string => `${JSON.stringify(lock, null, 2)}\n`;

// ------------------------------------------------------------------ select ---

export interface SelectGithubReposOptions {
  org: string;
  /** undefined → findToken/resolveToken when the API is needed; null → no token at all. */
  token?: string | null;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  /** Pinned listing to read (if it exists) or write (if not). */
  lockfile?: string | null;
  /** Relist even when the lockfile exists, and rewrite it. */
  updateLockfile?: boolean;
  /** Org sentei.json `repos` section (flags below override it). */
  config?: RepoSelectConfig;
  /** CLI flags. */
  cli?: RepoSelectCli;
  log?: (line: string) => void;
  clock?: Clock;
  /** Epoch seconds for generatedAt; defaults to the clock. */
  now?: number;
}

/** One repo with its facts and decision. */
export interface SelectedRepo {
  entry: LockRepo;
  decision: RepoDecision;
  cloneUrl: string;
}

export interface RepoSelection {
  org: string;
  settings: RepoSelectSettings;
  /** The lockfile read or written (null without --lockfile). */
  lockfile: string | null;
  lock: Lockfile;
  /** Lockfile written before selection metadata existed: size/push/language rules skipped. */
  legacy: boolean;
  /** Every listed repo, sorted by name. */
  repos: SelectedRepo[];
  /** REST requests made (0 when everything came from the lockfile). */
  apiRequests: number;
}

const factsOf = (r: LockRepo): RepoFacts => ({
  name: r.name,
  fork: r.fork ?? false,
  template: r.template ?? false,
  archived: r.archived ?? false,
  disabled: r.disabled ?? false,
  ...(r.empty ? { empty: true } : {}),
  language: r.language ?? null,
  sizeKb: r.sizeKb ?? null,
  pushedAt: r.pushedAt ?? null,
  ...(r.manifests ? { manifests: r.manifests } : {}),
});

/**
 * Listing (API, or the lockfile when it exists) → decisions (repo-select.ts) →
 * manifest probes for repos only the probe can decide → head shas for selected
 * repos that lack one → lockfile (written when anything changed). A lockfile whose
 * recorded settings differ is re-decided from its recorded facts (pins kept); the
 * API is only called for probes or shas it does not hold yet.
 */
export async function selectGithubRepos(opts: SelectGithubReposOptions): Promise<RepoSelection> {
  const log = opts.log ?? (() => {});
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const lockfile = opts.lockfile ? resolve(opts.lockfile) : null;
  const settings = mergeSelectSettings(opts.config ?? {}, opts.cli ?? {});
  const nowMs = clock.now();

  let api: GithubApi | null = null;
  const needApi = async (why: string): Promise<GithubApi> => {
    if (api !== null) return api;
    let token = opts.token;
    if (token === undefined) {
      token = await findToken();
      if (token === null) {
        throw new Error(`sentei: ${why} needs a GitHub token: set GITHUB_TOKEN (or GH_TOKEN), or log in with \`gh auth login\``);
      }
    }
    if (token === null) throw new Error(`sentei: ${why} needs a GitHub token`);
    api = new GithubApi({ token, clock, log, ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    return api;
  };

  let lock: Lockfile;
  let before: string | null = null; // lockfile text as read, to skip no-op rewrites
  const owners = new Map<string, string>();
  const defaultCloneUrl = (name: string): string => `https://github.com/${opts.org}/${name}.git`;
  if (lockfile !== null && existsSync(lockfile) && !opts.updateLockfile) {
    lock = readLockfile(lockfile);
    before = lockfileText(lock);
    if (lock.org !== opts.org) throw new Error(`sentei: lockfile ${lockfile} is for "${lock.org}", not "${opts.org}"`);
    log(`using lockfile ${lockfile} (${lock.repos.length} repo(s), listed ${lock.generatedAt})`);
    if (lock.selection === undefined) {
      log('lockfile has no selection metadata (older sentei): only include/exclude/fork/template rules apply; '
        + 'rerun with --update-lockfile to record languages, sizes and push dates');
    } else {
      const changes = diffSettings(lock.selection, settings);
      if (changes.length > 0) log(`selection settings changed since the lockfile was written (${changes.join('; ')}): re-deciding from its recorded facts, pins kept`);
    }
  } else {
    const a = await needApi(`listing ${opts.org}'s repos`);
    const listed = await listRepos(a, opts.org, log);
    log(`listed ${listed.length} repo(s) for ${opts.org}`);
    for (const r of listed) owners.set(r.name, r.owner);
    lock = {
      org: opts.org,
      generatedAt: new Date(opts.now !== undefined ? opts.now * 1000 : nowMs).toISOString(),
      repos: listed.map((r) => ({
        name: r.name, defaultBranch: r.defaultBranch, fork: r.fork,
        ...(r.template ? { template: true } : {}), ...(r.archived ? { archived: true } : {}), ...(r.disabled ? { disabled: true } : {}),
        language: r.language, sizeKb: r.sizeKb, pushedAt: r.pushedAt,
        ...(r.cloneUrl !== defaultCloneUrl(r.name) ? { cloneUrl: r.cloneUrl } : {}),
      })),
    };
  }
  const legacy = lock.selection === undefined && before !== null;

  const decideAll = (): RepoDecision[] => lock.repos.map((r) => decideRepo(factsOf(r), settings, nowMs, legacy));
  let decisions = decideAll();

  // Probes, only for repos every other rule lets through.
  const toProbe = lock.repos.filter((_, i) => decisions[i]!.needsProbe === true);
  if (toProbe.length > 0) {
    const a = await needApi(`probing ${toProbe.length} repo(s) for package.json/pubspec.yaml`);
    log(`probing ${toProbe.length} repo(s) whose language is not in repos.languages for ${PROBE_MANIFESTS.join('/')}`);
    await mapPool(toProbe, API_CONCURRENCY, async (r) => {
      r.manifests = await probeManifests(a, owners.get(r.name) ?? opts.org, r.name, r.headSha ?? null);
    });
    decisions = decideAll();
  }
  // Head shas for selected repos that have none (fresh listing, or newly selected).
  const toPin = lock.repos.filter((r, i) => decisions[i]!.include && r.headSha === undefined);
  if (toPin.length > 0) {
    const a = await needApi(`pinning ${toPin.length} repo(s) to their head sha`);
    await mapPool(toPin, API_CONCURRENCY, async (r) => {
      const sha = await headShaOf(a, owners.get(r.name) ?? opts.org, r.name, r.defaultBranch);
      if (sha === null) {
        log(`${opts.org}/${r.name}: default branch ${r.defaultBranch} not found (empty repo?), skipped`);
        r.empty = true;
      } else {
        r.headSha = sha;
      }
    });
    decisions = decideAll();
  }

  if (!legacy) {
    lock.selection = settings;
    lock.repos.forEach((r, i) => {
      r.selected = decisions[i]!.include;
      r.reasons = decisions[i]!.reasons;
    });
  }
  const selectedCount = decisions.filter((d) => d.include).length;
  log(`selected ${selectedCount} of ${lock.repos.length} repo(s)${summarizeSkips(decisions)}`);
  if (selectedCount === 0) log('warning: no repos selected');

  if (lockfile !== null && !legacy && lockfileText(lock) !== before) {
    writeLockfile(lockfile, lock);
    log(`wrote lockfile ${lockfile}`);
  }
  return {
    org: opts.org,
    settings,
    lockfile,
    lock,
    legacy,
    repos: lock.repos.map((entry, i) => ({
      entry,
      decision: decisions[i]!,
      cloneUrl: entry.cloneUrl ?? defaultCloneUrl(entry.name),
    })),
    apiRequests: (api as GithubApi | null)?.requests ?? 0,
  };
}

/** ", skipped: 12 archived, 3 fork, ..." grouped by the first word of each skip reason. */
function summarizeSkips(decisions: readonly RepoDecision[]): string {
  const counts = new Map<string, number>();
  for (const d of decisions) {
    if (d.include) continue;
    const r = d.reasons[d.reasons.length - 1] ?? '';
    const key = /^excluded by/.test(r) ? 'excluded by include/exclude'
      : /^size /.test(r) ? 'too large'
        : /^(last push|never pushed)/.test(r) ? 'stale'
          : /^(language|no language)/.test(r) ? 'language'
            : r.split(/[ (]/)[0]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  return `; skipped ${[...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${n} ${k}`).join(', ')} (\`sentei repos\` lists every reason)`;
}

// ------------------------------------------------------------------- clone ---

export interface CloneJob {
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  headSha: string;
}

export interface CloneOutcome {
  name: string;
  status: EnsureCloneResult['status'] | 'failed';
  /** Wall time of this clone. */
  seconds: number;
  /** Object-store size after a fresh clone or update (KB); null when cached or failed. */
  sizeKb: number | null;
  /** First line of the error (status 'failed'). */
  error?: string;
}

export interface CloneReposOptions {
  org: string;
  jobs: readonly CloneJob[];
  clonesDir: string;
  /** Parallel clones (default 8). */
  concurrency?: number;
  token?: string | null;
  log?: (line: string) => void;
  clock?: Clock;
  /** Injectable for tests. */
  ensureCloneImpl?: (opts: EnsureCloneOptions) => Promise<EnsureCloneResult>;
  sizeOf?: (dir: string) => Promise<number>;
}

const fmtMb = (kb: number): string => `${(kb / 1024).toFixed(1)} MB`;

/**
 * Clone (or update) every job with `concurrency` in flight. Never throws for a clone
 * failure: every repo gets an outcome. Prints a progress line every ~5% (or 10 s)
 * and, at the end, the ten slowest clones with their sizes.
 */
export async function cloneRepos(opts: CloneReposOptions): Promise<CloneOutcome[]> {
  const log = opts.log ?? (() => {});
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const clone = opts.ensureCloneImpl ?? ensureClone;
  const sizeOf = opts.sizeOf ?? objectStoreKb;
  const total = opts.jobs.length;
  const step = Math.max(1, Math.ceil(total / 20));
  const t0 = clock.now();
  let lastPrint = t0;
  const done: CloneOutcome[] = [];

  const progress = (force: boolean): void => {
    const now = clock.now();
    if (!force && done.length % step !== 0 && now - lastPrint < 10_000) return;
    lastPrint = now;
    const cached = done.filter((o) => o.status === 'cached').length;
    const failed = done.filter((o) => o.status === 'failed').length;
    const kb = done.reduce((a, o) => a + (o.sizeKb ?? 0), 0);
    const secs = Math.max(0.001, (now - t0) / 1000);
    const slowest = done.filter((o) => o.status !== 'cached').sort((a, b) => b.seconds - a.seconds)[0];
    log(`cloned ${done.length}/${total} (${cached} cached${failed > 0 ? `, ${failed} failed` : ''}) ${(kb / 1024 / secs).toFixed(1)} MB/s avg`
      + `${slowest ? `, slowest: ${slowest.name} ${slowest.seconds.toFixed(0)} s` : ''}`);
  };

  mkdirSync(opts.clonesDir, { recursive: true });
  const outcomes = await mapPool(opts.jobs, opts.concurrency ?? DEFAULT_CLONE_CONCURRENCY, async (job): Promise<CloneOutcome> => {
    const dir = join(opts.clonesDir, job.name);
    const start = clock.now();
    let outcome: CloneOutcome;
    try {
      const { status } = await clone({ dir, cloneUrl: job.cloneUrl, defaultBranch: job.defaultBranch, sha: job.headSha, token: opts.token ?? null, log });
      const seconds = (clock.now() - start) / 1000;
      const sizeKb = status === 'cached' ? null : await sizeOf(dir).catch(() => null);
      outcome = { name: job.name, status, seconds, sizeKb };
      if (status !== 'cached') {
        log(`${opts.org}/${job.name}: ${status} ${job.headSha.slice(0, 12)} in ${seconds.toFixed(1)} s${sizeKb !== null ? ` (${fmtMb(sizeKb)})` : ''}`);
      }
    } catch (err) {
      const error = ((err as Error).message ?? String(err)).split('\n')[0]!;
      outcome = { name: job.name, status: 'failed', seconds: (clock.now() - start) / 1000, sizeKb: null, error };
      log(`warning: ${opts.org}/${job.name}: clone failed: ${error}`);
    }
    done.push(outcome);
    progress(done.length === total);
    return outcome;
  });

  const slow = outcomes.filter((o) => o.status === 'cloned' || o.status === 'updated').sort((a, b) => b.seconds - a.seconds).slice(0, 10);
  if (slow.length > 0) {
    log(`${slow.length === 1 ? 'slowest clone' : `${slow.length} slowest clones`} (skip unneeded ones with repos.exclude in sentei.json):`);
    const width = Math.max(...slow.map((o) => o.name.length));
    for (const o of slow) log(`  ${o.name.padEnd(width)}  ${o.seconds.toFixed(1).padStart(6)} s  ${o.sizeKb === null ? '?' : fmtMb(o.sizeKb).padStart(9)}`);
  }
  return outcomes;
}

// ---------------------------------------------------------------- discover ---

export interface DiscoverGithubOptions extends Omit<SelectGithubReposOptions, 'config'> {
  /** Clones live at <clonesDir>/<name>. */
  clonesDir: string;
  /** Directory holding the org-level sentei.json (also its `repos` section), or null for defaults. */
  orgConfigDir: string | null;
  /** Parallel clones; overrides repos.cloneConcurrency (default 8). */
  cloneConcurrency?: number;
  /** Skip repos that fail to clone (with a warning) instead of failing discover. */
  allowCloneFailures?: boolean;
  ensureCloneImpl?: CloneReposOptions['ensureCloneImpl'];
  sizeOf?: CloneReposOptions['sizeOf'];
}

/**
 * GitHub source for `discover`: selectGithubRepos → parallel shallow clones pinned
 * to each head sha → discoverRepos. A clone failure is recorded per repo
 * (`cloneError` in the lockfile) and every other repo still clones; discover then
 * fails listing them (a missing consumer repo would make live code look dead)
 * unless `allowCloneFailures`, which skips them with a warning.
 */
export async function discoverGithub(opts: DiscoverGithubOptions): Promise<DiscoverModel> {
  const log = opts.log ?? (() => {});
  const orgConfig = opts.orgConfigDir === null ? null : readOrgConfig(opts.orgConfigDir);
  const repoConfig = orgConfig?.repos ?? {};
  const sel = await selectGithubRepos({ ...opts, config: repoConfig });
  const clonesDir = resolve(opts.clonesDir);

  // Public repos clone without a token; use one if we happen to have it (private orgs).
  let token = opts.token;
  if (token === undefined) token = await findToken();

  const selected = sel.repos.filter((r) => r.decision.include);
  const outcomes = await cloneRepos({
    org: opts.org,
    jobs: selected.map((r) => ({ name: r.entry.name, cloneUrl: r.cloneUrl, defaultBranch: r.entry.defaultBranch, headSha: r.entry.headSha! })),
    clonesDir,
    concurrency: opts.cloneConcurrency ?? repoConfig.cloneConcurrency ?? DEFAULT_CLONE_CONCURRENCY,
    token,
    log,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.ensureCloneImpl ? { ensureCloneImpl: opts.ensureCloneImpl } : {}),
    ...(opts.sizeOf ? { sizeOf: opts.sizeOf } : {}),
  });

  // Record failures (and clear old ones) in the lockfile so `sentei repos` shows them.
  const failed = outcomes.filter((o) => o.status === 'failed');
  if (sel.lockfile !== null && !sel.legacy) {
    const byName = new Map(outcomes.map((o) => [o.name, o]));
    let changed = false;
    for (const r of sel.lock.repos) {
      const o = byName.get(r.name);
      if (o === undefined) continue;
      if (o.status === 'failed' && r.cloneError !== o.error) {
        r.cloneError = o.error!;
        changed = true;
      } else if (o.status !== 'failed' && r.cloneError !== undefined) {
        delete r.cloneError;
        changed = true;
      }
    }
    if (changed) writeLockfile(sel.lockfile, sel.lock);
  }
  if (failed.length > 0) {
    const list = failed.map((o) => `${o.name} (${o.error})`).join('; ');
    if (!opts.allowCloneFailures) {
      throw new Error(`sentei: ${failed.length} of ${outcomes.length} repo(s) could not be cloned: ${list}. `
        + 'Rerun to retry them (finished clones are reused), exclude them (--exclude or repos.exclude), or pass --allow-clone-failures to skip them');
    }
    log(`warning: skipping ${failed.length} repo(s) that could not be cloned (--allow-clone-failures): ${failed.map((o) => o.name).join(', ')}. `
      + 'Every org package they contain is unknown to this run: their uses of other org packages are not counted, '
      + 'so exports only they use can be reported as dead');
  }
  const failedNames = new Set(failed.map((o) => o.name));
  const cloned = selected.filter((r) => !failedNames.has(r.entry.name));

  return discoverRepos({
    org: opts.org,
    source: {
      kind: 'github', org: opts.org, apiUrl: (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ''), lockfile: sel.lockfile, clonesDir,
      ...(failed.length > 0 ? { cloneFailures: failed.map((o) => ({ repo: `${opts.org}/${o.name}`, error: o.error! })) } : {}),
    },
    repos: cloned.map((r) => ({ name: r.entry.name, defaultBranch: r.entry.defaultBranch, localPath: join(clonesDir, r.entry.name), headSha: r.entry.headSha! })),
    orgConfigDir: opts.orgConfigDir,
    log,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
