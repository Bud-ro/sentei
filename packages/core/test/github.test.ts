import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cloneRepos, discoverGithub, findToken, GithubApi, listRepos, probeManifests, readLockfile, selectGithubRepos, type Clock,
} from '../src/github.ts';
import type { EnsureCloneOptions } from '../src/git.ts';
import { makeBareRepo } from './helpers/gitRepo.ts';

const API = 'https://api.github.com';
const LIST = `${API}/orgs/acme/repos?type=all&per_page=100`;

interface Route { status?: number; body?: unknown; headers?: Record<string, string> }

/** Fake fetch over a URL → response (or response sequence) table; records every request. */
function fakeFetch(routes: Record<string, Route | Route[]>): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const seen = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    let r = routes[url];
    if (Array.isArray(r)) {
      const i = seen.get(url) ?? 0;
      seen.set(url, i + 1);
      r = r[Math.min(i, r.length - 1)];
    }
    if (!r) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Clock whose sleep advances time instantly; records every sleep. */
function fakeClock(start = Date.parse('2026-09-26T00:00:00Z')): Clock & { sleeps: number[]; t: number } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.sleeps.push(ms);
      const until = c.t + ms;
      await new Promise((r) => setTimeout(r, 0)); // let concurrent callers see the same "now"
      c.t = Math.max(c.t, until);
    },
  };
  return c;
}

const repo = (name: string, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  name,
  full_name: `acme/${name}`,
  default_branch: 'main',
  archived: false,
  fork: false,
  clone_url: `https://github.com/acme/${name}.git`,
  pushed_at: '2026-01-01T00:00:00Z',
  size: 100,
  language: 'TypeScript',
  ...extra,
});
const sha = (c: string): string => c.repeat(40);
const branch = (name: string, s: string, b = 'main'): Record<string, Route> => ({
  [`${API}/repos/acme/${name}/branches/${b}`]: { body: { name: b, commit: { sha: s } } },
});
const contents = (name: string, file: string, ref?: string): string => `${API}/repos/acme/${name}/contents/${file}${ref ? `?ref=${ref}` : ''}`;
const api = (fetchImpl: typeof fetch, extra: { clock?: Clock; log?: (l: string) => void } = {}): GithubApi =>
  new GithubApi({ token: 'tok', fetchImpl, ...extra });

describe('listRepos', () => {
  it('follows Link pagination, keeps every repo with its facts, makes no per-repo calls, sends auth headers', async () => {
    const page2 = `${API}/organizations/1/repos?type=all&per_page=100&page=2`;
    const { fetchImpl, calls } = fakeFetch({
      [LIST]: {
        body: [repo('zed'), repo('old', { archived: true, language: null, size: 5 })],
        headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
      },
      [page2]: { body: [repo('alpha', { fork: true, default_branch: 'trunk', is_template: true, disabled: true })] },
    });
    const repos = await listRepos(api(fetchImpl), 'acme');
    expect(repos).toEqual([
      { name: 'alpha', owner: 'acme', defaultBranch: 'trunk', cloneUrl: 'https://github.com/acme/alpha.git', fork: true, template: true, archived: false, disabled: true, language: 'TypeScript', sizeKb: 100, pushedAt: '2026-01-01T00:00:00Z' },
      { name: 'old', owner: 'acme', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/old.git', fork: false, template: false, archived: true, disabled: false, language: null, sizeKb: 5, pushedAt: '2026-01-01T00:00:00Z' },
      { name: 'zed', owner: 'acme', defaultBranch: 'main', cloneUrl: 'https://github.com/acme/zed.git', fork: false, template: false, archived: false, disabled: false, language: 'TypeScript', sizeKb: 100, pushedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(calls.map((c) => c.url)).toEqual([LIST, page2]);
    for (const c of calls) {
      expect(c.headers).toMatchObject({ Authorization: 'Bearer tok', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
      expect(c.headers['User-Agent']).toBeTruthy();
    }
  });

  it('falls back to the user endpoint when the org 404s', async () => {
    const { fetchImpl, calls } = fakeFetch({ [`${API}/users/acme/repos?per_page=100`]: { body: [repo('solo')] } });
    const logs: string[] = [];
    expect((await listRepos(api(fetchImpl), 'acme', (l) => logs.push(l))).map((r) => r.name)).toEqual(['solo']);
    expect(calls[0]!.url).toBe(LIST);
    expect(logs).toContain('acme is not an organization, listing it as a user');
  });

  it('a missing org and user is a clear error', async () => {
    const { fetchImpl } = fakeFetch({});
    await expect(listRepos(api(fetchImpl), 'nobody')).rejects.toThrow(/org or user "nobody" not found/);
  });

  it('other API errors carry status and message; off-origin pagination links are refused', async () => {
    const a = fakeFetch({ [LIST]: { status: 401, body: { message: 'Bad credentials' } } });
    await expect(listRepos(api(a.fetchImpl), 'acme')).rejects.toThrow(/401.*Bad credentials/);
    const b = fakeFetch({ [LIST]: { body: [], headers: { link: '<https://evil.example/x>; rel="next"' } } });
    await expect(listRepos(api(b.fetchImpl), 'acme')).rejects.toThrow(/link off https:\/\/api.github.com/);
    expect(b.calls.map((c) => c.url)).toEqual([LIST]);
  });
});

describe('GithubApi rate limits (fake clock)', () => {
  const RESET = Date.parse('2026-09-26T00:30:00Z') / 1000;

  it('403 with x-ratelimit-remaining 0: sleeps until the reset, logs once, retries', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const { fetchImpl, calls } = fakeFetch({
      [LIST]: [
        { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(RESET) } },
        { body: [repo('a')] },
      ],
    });
    expect((await listRepos(api(fetchImpl, { clock, log: (l) => logs.push(l) }), 'acme')).map((r) => r.name)).toEqual(['a']);
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([30 * 60_000 + 1000]);
    expect(logs).toEqual(['GitHub API rate limit exhausted (limit 5000/h); waiting until 2026-09-26T00:30:01Z (31 min)']);
  });

  it('a success with remaining 0 pauses the next request (shared by concurrent callers) until the reset', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const { fetchImpl } = fakeFetch({
      [`${API}/a`]: { body: 1, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) } },
      [`${API}/b`]: { body: 2 },
      [`${API}/c`]: { body: 3 },
    });
    const gh = api(fetchImpl, { clock, log: (l) => logs.push(l) });
    await gh.get('/a');
    expect(clock.sleeps).toEqual([]);
    await Promise.all([gh.get('/b'), gh.get('/c')]);
    expect(clock.sleeps).toEqual([30 * 60_000 + 1000, 30 * 60_000 + 1000]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^GitHub API rate limit used up \(limit \?\/h\); waiting until 2026-09-26T00:30:01Z/);
  });

  it('gives up after two primary waits with the reset time', async () => {
    const clock = fakeClock();
    const limited = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1800000000' } };
    const { fetchImpl, calls } = fakeFetch({ [LIST]: limited });
    await expect(listRepos(api(fetchImpl, { clock }), 'acme')).rejects.toThrow(/rate limit exhausted \(limit 60\); resets at 2027-01-15T08:00:00.000Z/);
    expect(calls).toHaveLength(3);
  });

  it('secondary limit: Retry-After is honoured', async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = fakeFetch({
      [`${API}/x`]: [{ status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '7' } }, { body: 'ok' }],
    });
    expect((await api(fetchImpl, { clock }).get('/x')).body).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([7000]);
  });

  it('secondary limit without Retry-After: 60 s, 120 s, 240 s, then gives up', async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    const { fetchImpl, calls } = fakeFetch({ [`${API}/x`]: { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } } });
    await expect(api(fetchImpl, { clock, log: (l) => logs.push(l) }).get('/x')).rejects.toThrow(/secondary rate limit still hit after 3 retries/);
    expect(calls).toHaveLength(4);
    expect(clock.sleeps).toEqual([60_000, 120_000, 240_000]);
    expect(logs[0]).toMatch(/^GitHub API secondary rate limit \(403, retry 1\/3\); waiting until .* \(60 s\)$/);
  });

  it('429 backs off too; a plain 403 (no rate-limit markers) fails at once', async () => {
    const clock = fakeClock();
    const a = fakeFetch({ [`${API}/x`]: [{ status: 429, body: {} }, { body: 'ok' }] });
    expect((await api(a.fetchImpl, { clock }).get('/x')).body).toBe('ok');
    expect(clock.sleeps).toEqual([60_000]);
    const b = fakeFetch({ [`${API}/x`]: { status: 403, body: { message: 'Resource not accessible by integration' } } });
    await expect(api(b.fetchImpl, { clock }).get('/x')).rejects.toThrow(/403.*Resource not accessible/);
    expect(b.calls).toHaveLength(1);
  });
});

describe('probeManifests', () => {
  it('package.json hit: one request; else pubspec.yaml; 404 = absent', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [contents('js', 'package.json', sha('a'))]: { body: { type: 'file' } },
      [contents('dart', 'pubspec.yaml')]: { body: { type: 'file' } },
    });
    const gh = api(fetchImpl);
    expect(await probeManifests(gh, 'acme', 'js', sha('a'))).toEqual({ 'package.json': true });
    expect(calls).toHaveLength(1);
    expect(await probeManifests(gh, 'acme', 'dart', null)).toEqual({ 'package.json': false, 'pubspec.yaml': true });
    expect(await probeManifests(gh, 'acme', 'hw', null)).toEqual({ 'package.json': false, 'pubspec.yaml': false });
    expect(calls).toHaveLength(5);
  });

  it('a rate-limited probe waits and retries instead of failing', async () => {
    const clock = fakeClock();
    const { fetchImpl } = fakeFetch({
      [contents('js', 'package.json')]: [{ status: 429, body: {}, headers: { 'retry-after': '2' } }, { body: { type: 'file' } }],
    });
    expect(await probeManifests(api(fetchImpl, { clock }), 'acme', 'js', null)).toEqual({ 'package.json': true });
    expect(clock.sleeps).toEqual([2000]);
  });
});

describe('selectGithubRepos', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-sel-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const listing = [
    repo('lib'),
    repo('app', { language: 'Dart' }),
    repo('hw-board', { language: 'C' }), // probe: nothing
    repo('tools', { language: 'Shell' }), // probe: package.json
    repo('site', { language: null }), // probe: pubspec.yaml
    repo('old', { archived: true, language: 'C' }),
    repo('forked', { fork: true }),
    repo('huge', { size: 900 * 1024, language: 'C++' }),
    repo('empty'),
  ];
  const routes = (): Record<string, Route | Route[]> => ({
    [LIST]: { body: listing },
    ...branch('lib', sha('1')),
    ...branch('app', sha('2')),
    ...branch('tools', sha('3')),
    ...branch('site', sha('4')),
    [contents('tools', 'package.json')]: { body: { type: 'file' } },
    [contents('site', 'pubspec.yaml')]: { body: { type: 'file' } },
  });

  it('decides every repo, probes only the undecided, pins only the selected, records everything in the lockfile', async () => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const lockfile = join(tmp, 'acme.lock.json');
    const logs: string[] = [];
    const clock = fakeClock();
    const sel = await selectGithubRepos({ org: 'acme', token: 'tok', fetchImpl, lockfile, clock, log: (l) => logs.push(l) });
    const summary = Object.fromEntries(sel.repos.map((r) => [r.entry.name, [r.decision.include, r.decision.reasons.join('; ')]]));
    expect(summary).toEqual({
      app: [true, 'language Dart'],
      empty: [false, 'empty repository (no commit on the default branch)'],
      forked: [false, 'fork (--include-forks to keep)'],
      'hw-board': [false, 'language C not in repos.languages; no package.json or pubspec.yaml at the root'],
      huge: [false, 'size 900 MB over repos.maxSizeMb 500'],
      lib: [true, 'language TypeScript'],
      old: [false, 'archived (--include-archived to keep)'],
      site: [true, 'no language detected, but pubspec.yaml at the root'],
      tools: [true, 'language Shell, but package.json at the root'],
    });
    // No probe for archived/fork/too-large repos, no sha lookup for unselected ones.
    const urls = calls.map((c) => c.url.slice(API.length));
    for (const skipped of ['old', 'forked', 'huge']) expect(urls.some((u) => u.includes(`/${skipped}/`))).toBe(false);
    expect(urls.filter((u) => u.includes('/contents/')).sort()).toEqual([
      '/repos/acme/hw-board/contents/package.json', '/repos/acme/hw-board/contents/pubspec.yaml',
      '/repos/acme/site/contents/package.json', '/repos/acme/site/contents/pubspec.yaml',
      '/repos/acme/tools/contents/package.json',
    ]);
    expect(urls.filter((u) => u.includes('/branches/')).sort()).toEqual([
      '/repos/acme/app/branches/main', '/repos/acme/empty/branches/main', '/repos/acme/lib/branches/main',
      '/repos/acme/site/branches/main', '/repos/acme/tools/branches/main',
    ]);
    expect(sel.apiRequests).toBe(calls.length);
    expect(logs).toContain('selected 4 of 9 repo(s); skipped 1 archived, 1 empty, 1 fork, 1 language, 1 too large (`sentei repos` lists every reason)');

    const lock = readLockfile(lockfile);
    expect(lock.selection).toEqual(sel.settings);
    expect(lock.generatedAt).toBe('2026-09-26T00:00:00.000Z');
    expect(lock.repos.find((r) => r.name === 'tools')).toEqual({
      name: 'tools', defaultBranch: 'main', headSha: sha('3'), fork: false, language: 'Shell', sizeKb: 100, pushedAt: '2026-01-01T00:00:00Z',
      manifests: { 'package.json': true }, selected: true, reasons: ['language Shell, but package.json at the root'],
    });
    expect(lock.repos.find((r) => r.name === 'old')).toEqual({
      name: 'old', defaultBranch: 'main', fork: false, archived: true, language: 'C', sizeKb: 100, pushedAt: '2026-01-01T00:00:00Z',
      selected: false, reasons: ['archived (--include-archived to keep)'],
    });
    expect(lock.repos.find((r) => r.name === 'empty')).toMatchObject({ empty: true, selected: false });

    // Rerun from the lockfile: same decisions, zero API calls, file untouched.
    const noApi = fakeFetch({});
    const before = readFileSync(lockfile, 'utf8');
    const again = await selectGithubRepos({ org: 'acme', token: null, fetchImpl: noApi.fetchImpl, lockfile, clock });
    expect(noApi.calls).toEqual([]);
    expect(again.repos.map((r) => r.decision)).toEqual(sel.repos.map((r) => r.decision));
    expect(readFileSync(lockfile, 'utf8')).toBe(before);

    // Changed settings are re-decided from recorded facts; only what is missing is fetched.
    const more = fakeFetch({ ...branch('old', sha('5')) });
    const logs3: string[] = [];
    const third = await selectGithubRepos({
      org: 'acme', token: 'tok', fetchImpl: more.fetchImpl, lockfile, clock, log: (l) => logs3.push(l),
      config: { exclude: ['app'] }, cli: { include: ['old'] },
    });
    expect(more.calls.map((c) => c.url)).toEqual([`${API}/repos/acme/old/branches/main`]);
    expect(third.repos.filter((r) => r.decision.include).map((r) => r.entry.name)).toEqual(['lib', 'old', 'site', 'tools']);
    expect(logs3).toContain('selection settings changed since the lockfile was written (exclude [] → ["app"]; cliInclude [] → ["old"]): re-deciding from its recorded facts, pins kept');
    const lock3 = readLockfile(lockfile);
    expect(lock3.selection?.exclude).toEqual(['app']);
    expect(lock3.repos.find((r) => r.name === 'lib')!.headSha).toBe(sha('1')); // pins kept
    expect(lock3.repos.find((r) => r.name === 'app')).toMatchObject({ headSha: sha('2'), selected: false, reasons: ['excluded by repos.exclude "app"'] });

    // Without a token, a lockfile missing data is a clear error.
    await expect(selectGithubRepos({ org: 'acme', token: null, lockfile, clock, cli: { include: ['huge'] } }))
      .rejects.toThrow(/pinning 1 repo\(s\) to their head sha needs a GitHub token/);
  });

  it('a legacy lockfile (no selection metadata) needs no API and is never rewritten', async () => {
    const lockfile = join(tmp, 'old.lock.json');
    const text = JSON.stringify({ org: 'acme', generatedAt: 'x', repos: [
      { name: 'a', defaultBranch: 'main', headSha: sha('a'), fork: false },
      { name: 'f', defaultBranch: 'main', headSha: sha('b'), fork: true },
      { name: 't', defaultBranch: 'main', headSha: sha('c'), template: true },
    ] });
    writeFileSync(lockfile, text);
    const logs: string[] = [];
    const sel = await selectGithubRepos({ org: 'acme', token: null, lockfile, log: (l) => logs.push(l) });
    expect(sel.legacy).toBe(true);
    expect(sel.repos.map((r) => [r.entry.name, r.decision.include])).toEqual([['a', true], ['f', false], ['t', false]]);
    expect(logs.some((l) => l.startsWith('lockfile has no selection metadata'))).toBe(true);
    expect(readFileSync(lockfile, 'utf8')).toBe(text);
  });
});

describe('cloneRepos', () => {
  const jobs = Array.from({ length: 20 }, (_, i) => ({ name: `r${String(i).padStart(2, '0')}`, cloneUrl: 'x', defaultBranch: 'main', headSha: sha('a') }));

  it('runs with the given concurrency, reports progress and the ten slowest clones', async () => {
    const clock = fakeClock();
    let inFlight = 0;
    let maxInFlight = 0;
    const ensureCloneImpl = async (o: EnsureCloneOptions) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      const i = Number(o.dir.slice(-2));
      clock.t += i * 1000; // repo i "takes" i seconds
      inFlight--;
      return { status: i < 5 ? 'cached' as const : 'cloned' as const };
    };
    const logs: string[] = [];
    const out = await cloneRepos({
      org: 'acme', jobs, clonesDir: join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-clone-fake'), concurrency: 3, clock,
      ensureCloneImpl, sizeOf: async () => 2048, log: (l) => logs.push(l),
    });
    expect(maxInFlight).toBe(3);
    expect(out.map((o) => o.status).filter((s) => s === 'cached')).toHaveLength(5);
    expect(out.every((o) => o.status !== 'failed')).toBe(true);
    const progress = logs.filter((l) => l.startsWith('cloned '));
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatch(/^cloned 20\/20 \(5 cached\) \d+\.\d MB\/s avg, slowest: r\d\d \d+ s$/);
    const i = logs.indexOf('10 slowest clones (skip unneeded ones with repos.exclude in sentei.json):');
    expect(i).toBeGreaterThan(0);
    expect(logs.slice(i + 1, i + 11).every((l) => /^ {2}r\d\d +\d+\.\d s +2\.0 MB$/.test(l))).toBe(true);
    expect(logs.filter((l) => / cloned a{12} in /.test(l))).toHaveLength(15);
  });

  it('a failure does not stop the others; every repo gets an outcome', async () => {
    const logs: string[] = [];
    const out = await cloneRepos({
      org: 'acme', jobs: jobs.slice(0, 4), clonesDir: join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-clone-fake'), concurrency: 2,
      ensureCloneImpl: async (o) => {
        if (o.dir.endsWith('r01')) throw new Error('git clone failed: remote hung up\ndetails');
        return { status: 'cloned' };
      },
      sizeOf: async () => 0,
      log: (l) => logs.push(l),
    });
    expect(out.map((o) => [o.name, o.status, o.error])).toEqual([
      ['r00', 'cloned', undefined], ['r01', 'failed', 'git clone failed: remote hung up'], ['r02', 'cloned', undefined], ['r03', 'cloned', undefined],
    ]);
    expect(logs).toContain('warning: acme/r01: clone failed: git clone failed: remote hung up');
    expect(logs.some((l) => l.startsWith('cloned 4/4 (0 cached, 1 failed)'))).toBe(true);
  });
});

describe('findToken', () => {
  it('prefers GITHUB_TOKEN, then GH_TOKEN', async () => {
    expect(await findToken({ GITHUB_TOKEN: 'a', GH_TOKEN: 'b' })).toBe('a');
    expect(await findToken({ GITHUB_TOKEN: ' ', GH_TOKEN: 'b' })).toBe('b');
  });
});

describe('discoverGithub (file:// clones, fake API)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-gh-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('lists, writes the lockfile, clones pinned shas, builds the model; then reruns from the lockfile', async () => {
    const lib = makeBareRepo(tmp, 'lib');
    const app = makeBareRepo(tmp, 'app');
    const fork = makeBareRepo(tmp, 'forked');
    const { fetchImpl } = fakeFetch({
      [LIST]: {
        body: [
          repo('lib', { clone_url: lib.url }),
          repo('app', { clone_url: app.url }),
          repo('forked', { clone_url: fork.url, fork: true }),
          repo('skipme', { clone_url: 'file:///nonexistent' }),
        ],
      },
      ...branch('lib', lib.shas[0]), // pinned behind the branch head
      ...branch('app', app.shas[1]),
    });
    writeFileSync(join(tmp, 'sentei.json'), JSON.stringify({ minAgeDays: 7, repos: { exclude: ['skip*'], cloneConcurrency: 2 } }));
    const lockfile = join(tmp, 'acme.lock.json');
    const clonesDir = join(tmp, 'clones');
    const logs: string[] = [];
    const model = await discoverGithub({
      org: 'acme', token: 'tok', fetchImpl, lockfile, clonesDir, orgConfigDir: tmp, log: (l) => logs.push(l), now: 1_800_000_000,
    });
    expect(model.source).toEqual({ kind: 'github', org: 'acme', apiUrl: API, lockfile, clonesDir });
    expect(model.policy.minAgeDays).toBe(7);
    expect(model.repos.map((r) => [r.repo, r.headSha, r.localPath, r.defaultBranch])).toEqual([
      ['acme/app', app.shas[1], join(clonesDir, 'app'), 'main'],
      ['acme/lib', lib.shas[0], join(clonesDir, 'lib'), 'main'],
    ]);
    // lib was pinned to its first commit: no index.ts yet.
    expect(model.repos[1]!.packages.map((p) => [p.packageId, p.entryPoints])).toEqual([['npm:acme/lib:@t/lib', []]]);
    expect(logs).toContain('selected 2 of 4 repo(s); skipped 1 excluded by include/exclude, 1 fork (`sentei repos` lists every reason)');
    expect(logs.filter((l) => / cloned [0-9a-f]{12} in /.test(l)).length).toBe(2);
    expect(logs.some((l) => l.startsWith('cloned 2/2 (0 cached)'))).toBe(true);

    const lock = readLockfile(lockfile);
    expect(lock.generatedAt).toBe('2027-01-15T08:00:00.000Z');
    expect(lock.repos.map((r) => [r.name, r.headSha ?? null, r.selected, r.reasons])).toEqual([
      ['app', app.shas[1], true, ['language TypeScript']],
      ['forked', null, false, ['fork (--include-forks to keep)']],
      ['lib', lib.shas[0], true, ['language TypeScript']],
      ['skipme', null, false, ['excluded by repos.exclude "skip*"']],
    ]);

    // Rerun from the lockfile: no API calls, no token, clones are cached.
    const noApi = fakeFetch({});
    const logs2: string[] = [];
    const again = await discoverGithub({
      org: 'acme', token: null, fetchImpl: noApi.fetchImpl, lockfile, clonesDir, orgConfigDir: tmp, log: (l) => logs2.push(l),
    });
    expect(noApi.calls).toEqual([]);
    expect(again.repos.map((r) => r.headSha)).toEqual([app.shas[1], lib.shas[0]]);
    expect(logs2.some((l) => l.startsWith('cloned 2/2 (2 cached)'))).toBe(true);
    expect(again.policy.minAgeDays).toBe(7);

    // A lockfile for another org is refused.
    await expect(discoverGithub({ org: 'other', token: null, lockfile, clonesDir, orgConfigDir: null }))
      .rejects.toThrow(/is for "acme", not "other"/);

    // --update-lockfile relists (lib moves to its head) and rewrites.
    const moved = fakeFetch({ [LIST]: { body: [repo('lib', { clone_url: lib.url })] }, ...branch('lib', lib.shas[1]) });
    const logs3: string[] = [];
    const updated = await discoverGithub({
      org: 'acme', token: 'tok', fetchImpl: moved.fetchImpl, lockfile, updateLockfile: true, clonesDir, orgConfigDir: null, log: (l) => logs3.push(l),
    });
    expect(updated.repos.map((r) => [r.repo, r.headSha])).toEqual([['acme/lib', lib.shas[1]]]);
    expect(logs3.some((l) => l.startsWith(`acme/lib: updated ${lib.shas[1].slice(0, 12)}`))).toBe(true);
    expect(readLockfile(lockfile).repos.map((r) => [r.name, r.headSha])).toEqual([['lib', lib.shas[1]]]);
  });

  it('a clone failure is recorded, the others clone, and discover fails listing it unless --allow-clone-failures', async () => {
    const lib = makeBareRepo(tmp, 'lib');
    const { fetchImpl } = fakeFetch({
      [LIST]: { body: [repo('lib', { clone_url: lib.url }), repo('gone', { clone_url: `${lib.url.replace(/lib\.git$/, 'gone.git')}` })] },
      ...branch('lib', lib.shas[1]),
      ...branch('gone', sha('e')),
    });
    const lockfile = join(tmp, 'acme.lock.json');
    const clonesDir = join(tmp, 'clones');
    await expect(discoverGithub({ org: 'acme', token: 'tok', fetchImpl, lockfile, clonesDir, orgConfigDir: null }))
      .rejects.toThrow(/1 of 2 repo\(s\) could not be cloned: gone \(git clone .*\)\. Rerun to retry them .*--allow-clone-failures/);
    const lock = readLockfile(lockfile);
    expect(lock.repos.find((r) => r.name === 'gone')!.cloneError).toMatch(/^git clone/);
    expect(lock.repos.find((r) => r.name === 'lib')!.cloneError).toBeUndefined();

    const logs: string[] = [];
    const model = await discoverGithub({ org: 'acme', token: null, lockfile, clonesDir, orgConfigDir: null, allowCloneFailures: true, log: (l) => logs.push(l) });
    expect(model.repos.map((r) => r.repo)).toEqual(['acme/lib']);
    expect(model.source).toMatchObject({ kind: 'github', cloneFailures: [{ repo: 'acme/gone', error: expect.stringMatching(/^git clone/) }] });
    expect(logs.some((l) => /^warning: skipping 1 repo\(s\) that could not be cloned \(--allow-clone-failures\): gone\. Every org package they contain is unknown/.test(l))).toBe(true);
    expect(logs.some((l) => l.startsWith('cloned 2/2 (1 cached, 1 failed)'))).toBe(true);
  });

  it('rejects a lockfile with an unsafe repo name or sha, or malformed selection metadata', async () => {
    const lockfile = join(tmp, 'bad.lock.json');
    const write = (o: unknown): void => writeFileSync(lockfile, JSON.stringify(o));
    write({ org: 'acme', generatedAt: 'x', repos: [{ name: '../x', defaultBranch: 'main', headSha: sha('a') }] });
    expect(() => readLockfile(lockfile)).toThrow(/plain repo name/);
    write({ org: 'acme', generatedAt: 'x', repos: [{ name: 'x', defaultBranch: 'main', headSha: 'HEAD' }] });
    expect(() => readLockfile(lockfile)).toThrow(/headSha must be a commit sha/);
    write({ org: 'acme', generatedAt: 'x', repos: [{ name: 'x', defaultBranch: 'main', headSha: sha('e'), template: 'yes' }] });
    expect(() => readLockfile(lockfile)).toThrow(/template must be a boolean/);
    write({ org: 'acme', generatedAt: 'x', selection: { include: 'x' }, repos: [] });
    expect(() => readLockfile(lockfile)).toThrow(/selection.include must be an array of strings/);
  });
});
