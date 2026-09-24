import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverGithub, findToken, listRepos, readLockfile, selectRepo } from '../src/github.ts';
import { makeBareRepo } from './helpers/gitRepo.ts';

const API = 'https://api.github.com';

interface Route { status?: number; body?: unknown; headers?: Record<string, string> }

/** Fake fetch over a URL → response table; records every request. */
function fakeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const r = routes[url];
    if (!r) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const repo = (name: string, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  name,
  full_name: `acme/${name}`,
  default_branch: 'main',
  archived: false,
  fork: false,
  clone_url: `https://github.com/acme/${name}.git`,
  pushed_at: '2026-01-01T00:00:00Z',
  ...extra,
});
const sha = (c: string): string => c.repeat(40);
const branch = (name: string, s: string, b = 'main'): Record<string, Route> => ({
  [`${API}/repos/acme/${name}/branches/${b}`]: { body: { name: b, commit: { sha: s } } },
});

describe('listRepos', () => {
  it('follows Link pagination, drops archived repos, fetches each head sha, sends auth headers', async () => {
    const page2 = `${API}/organizations/1/repos?type=all&per_page=100&page=2`;
    const { fetchImpl, calls } = fakeFetch({
      [`${API}/orgs/acme/repos?type=all&per_page=100`]: {
        body: [repo('zed'), repo('old', { archived: true })],
        headers: { link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
      },
      [page2]: { body: [repo('alpha', { fork: true, default_branch: 'trunk' })] },
      ...branch('zed', sha('a')),
      ...branch('alpha', sha('b'), 'trunk'),
    });
    const logs: string[] = [];
    const repos = await listRepos({ org: 'acme', token: 'tok', fetchImpl, log: (l) => logs.push(l) });
    expect(repos).toEqual([
      { name: 'alpha', defaultBranch: 'trunk', headSha: sha('b'), archived: false, fork: true, cloneUrl: 'https://github.com/acme/alpha.git', pushedAt: '2026-01-01T00:00:00Z' },
      { name: 'zed', defaultBranch: 'main', headSha: sha('a'), archived: false, fork: false, cloneUrl: 'https://github.com/acme/zed.git', pushedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(calls.some((c) => c.url.includes('/old/'))).toBe(false);
    expect(logs).toContain('skipping 1 archived repo(s)');
    for (const c of calls) {
      expect(c.headers).toMatchObject({ Authorization: 'Bearer tok', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
      expect(c.headers['User-Agent']).toBeTruthy();
    }
  });

  it('falls back to the user endpoint when the org 404s', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`${API}/users/acme/repos?per_page=100`]: { body: [repo('solo')] },
      ...branch('solo', sha('c')),
    });
    const repos = await listRepos({ org: 'acme', token: 't', fetchImpl });
    expect(repos.map((r) => [r.name, r.headSha])).toEqual([['solo', sha('c')]]);
    expect(calls[0]!.url).toBe(`${API}/orgs/acme/repos?type=all&per_page=100`);
  });

  it('a missing org and user is a clear error', async () => {
    const { fetchImpl } = fakeFetch({});
    await expect(listRepos({ org: 'nobody', token: 't', fetchImpl })).rejects.toThrow(/org or user "nobody" not found/);
  });

  it('skips empty repos whose default branch 404s', async () => {
    const logs: string[] = [];
    const { fetchImpl } = fakeFetch({ [`${API}/orgs/acme/repos?type=all&per_page=100`]: { body: [repo('empty')] } });
    expect(await listRepos({ org: 'acme', token: 't', fetchImpl, log: (l) => logs.push(l) })).toEqual([]);
    expect(logs.some((l) => l.includes('acme/empty: default branch main not found'))).toBe(true);
  });

  it('rate-limit exhaustion is a clear error with the reset time', async () => {
    const { fetchImpl } = fakeFetch({
      [`${API}/orgs/acme/repos?type=all&per_page=100`]: {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1800000000' },
      },
    });
    await expect(listRepos({ org: 'acme', token: 't', fetchImpl })).rejects.toThrow(
      /rate limit exhausted \(limit 60\); resets at 2027-01-15T08:00:00.000Z/);
  });

  it('other API errors carry status and message; off-origin pagination links are refused', async () => {
    const a = fakeFetch({ [`${API}/orgs/acme/repos?type=all&per_page=100`]: { status: 401, body: { message: 'Bad credentials' } } });
    await expect(listRepos({ org: 'acme', token: 't', fetchImpl: a.fetchImpl })).rejects.toThrow(/401.*Bad credentials/);
    const b = fakeFetch({
      [`${API}/orgs/acme/repos?type=all&per_page=100`]: { body: [], headers: { link: '<https://evil.example/x>; rel="next"' } },
    });
    await expect(listRepos({ org: 'acme', token: 't', fetchImpl: b.fetchImpl })).rejects.toThrow(/link off https:\/\/api.github.com/);
    expect(b.calls.map((c) => c.url)).toEqual([`${API}/orgs/acme/repos?type=all&per_page=100`]);
  });
});

describe('selectRepo / findToken', () => {
  it('skips forks by default; include/exclude globs on the repo name', () => {
    expect(selectRepo({ name: 'a', fork: true }, {})).toBe(false);
    expect(selectRepo({ name: 'a', fork: true }, { includeForks: true })).toBe(true);
    expect(selectRepo({ name: 'lib-x' }, { include: ['lib-*'] })).toBe(true);
    expect(selectRepo({ name: 'app' }, { include: ['lib-*'] })).toBe(false);
    expect(selectRepo({ name: 'lib-x' }, { include: ['lib-*'], exclude: ['*-x'] })).toBe(false);
  });

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
      [`${API}/orgs/acme/repos?type=all&per_page=100`]: {
        body: [
          repo('lib', { clone_url: lib.url }),
          repo('app', { clone_url: app.url }),
          repo('forked', { clone_url: fork.url, fork: true }),
          repo('skipme', { clone_url: 'file:///nonexistent' }),
        ],
      },
      ...branch('lib', lib.shas[0]), // pinned behind the branch head
      ...branch('app', app.shas[1]),
      ...branch('forked', fork.shas[1]),
      ...branch('skipme', sha('d')),
    });
    writeFileSync(join(tmp, 'sentei.json'), JSON.stringify({ assumeClosedWorld: true }));
    const lockfile = join(tmp, 'acme.lock.json');
    const clonesDir = join(tmp, 'clones');
    const logs: string[] = [];
    const model = await discoverGithub({
      org: 'acme', token: 'tok', fetchImpl, lockfile, clonesDir, exclude: ['skip*'],
      orgConfigDir: tmp, log: (l) => logs.push(l), now: 1_800_000_000,
    });
    expect(model.source).toEqual({ kind: 'github', org: 'acme', apiUrl: API, lockfile, clonesDir });
    expect(model.policy.assumeClosedWorld).toBe(true);
    expect(model.repos.map((r) => [r.repo, r.headSha, r.localPath, r.defaultBranch])).toEqual([
      ['acme/app', app.shas[1], join(clonesDir, 'app'), 'main'],
      ['acme/lib', lib.shas[0], join(clonesDir, 'lib'), 'main'],
    ]);
    // lib was pinned to its first commit: no index.ts yet.
    expect(model.repos[1]!.packages.map((p) => [p.packageId, p.entryPoints])).toEqual([['npm:@t/lib', []]]);
    expect(logs).toContain('skipping 1 fork(s) (use --include-forks to keep them)');
    expect(logs).toContain('skipping 1 repo(s) by --include/--exclude');
    expect(logs.filter((l) => / cloned /.test(l)).length).toBe(2);

    const lock = readLockfile(lockfile);
    expect(lock).toEqual({
      org: 'acme',
      generatedAt: '2027-01-15T08:00:00.000Z',
      repos: [
        { name: 'app', defaultBranch: 'main', headSha: app.shas[1], fork: false },
        { name: 'forked', defaultBranch: 'main', headSha: fork.shas[1], fork: true },
        { name: 'lib', defaultBranch: 'main', headSha: lib.shas[0], fork: false },
        { name: 'skipme', defaultBranch: 'main', headSha: sha('d'), fork: false },
      ],
    });

    // Rerun from the lockfile: no API calls, no token, clones are cached.
    const noApi = fakeFetch({});
    const logs2: string[] = [];
    const again = await discoverGithub({
      org: 'acme', token: null, fetchImpl: noApi.fetchImpl, lockfile, clonesDir, exclude: ['skip*'],
      orgConfigDir: null, log: (l) => logs2.push(l),
    });
    expect(noApi.calls).toEqual([]);
    expect(again.repos.map((r) => r.headSha)).toEqual([app.shas[1], lib.shas[0]]);
    expect(logs2.filter((l) => / cached /.test(l)).length).toBe(2);
    expect(again.policy.assumeClosedWorld).toBe(false);

    // A lockfile for another org is refused.
    await expect(discoverGithub({ org: 'other', token: null, lockfile, clonesDir, orgConfigDir: null }))
      .rejects.toThrow(/is for "acme", not "other"/);

    // --update-lockfile relists (lib moves to its head) and rewrites.
    const moved = fakeFetch({
      [`${API}/orgs/acme/repos?type=all&per_page=100`]: { body: [repo('lib', { clone_url: lib.url })] },
      ...branch('lib', lib.shas[1]),
    });
    const logs3: string[] = [];
    const updated = await discoverGithub({
      org: 'acme', token: 'tok', fetchImpl: moved.fetchImpl, lockfile, updateLockfile: true, clonesDir,
      orgConfigDir: null, log: (l) => logs3.push(l),
    });
    expect(updated.repos.map((r) => [r.repo, r.headSha])).toEqual([['acme/lib', lib.shas[1]]]);
    expect(logs3.some((l) => l.startsWith(`acme/lib: updated ${lib.shas[1].slice(0, 12)}`))).toBe(true);
    expect(JSON.parse(readFileSync(lockfile, 'utf8')).repos).toEqual([{ name: 'lib', defaultBranch: 'main', headSha: lib.shas[1], fork: false }]);
  });

  it('rejects a lockfile with an unsafe repo name or sha', async () => {
    const lockfile = join(tmp, 'bad.lock.json');
    writeFileSync(lockfile, JSON.stringify({ org: 'acme', generatedAt: 'x', repos: [{ name: '../x', defaultBranch: 'main', headSha: sha('a') }] }));
    expect(() => readLockfile(lockfile)).toThrow(/plain repo name/);
    writeFileSync(lockfile, JSON.stringify({ org: 'acme', generatedAt: 'x', repos: [{ name: 'x', defaultBranch: 'main', headSha: 'HEAD' }] }));
    expect(() => readLockfile(lockfile)).toThrow(/headSha must be a commit sha/);
  });
});
