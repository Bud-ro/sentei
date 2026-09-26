// CLI argument parsing and exit codes: main() driven directly with captured output.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@sentei/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { formatError, main, parsePolicyOverrides, redactSecrets } from '../src/main.ts';
import { makeBareRepo } from '../../core/test/helpers/gitRepo.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures');
const tmpRoot = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-main-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshWork = (): string => path.join(tmpRoot, `work${n++}`);

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t) });
  return { code, out, err };
}

describe('usage', () => {
  it('--help and help print usage and exit 0', async () => {
    for (const argv of [['--help'], ['-h'], ['help'], ['discover', '--help']]) {
      const r = await run(...argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Usage: sentei <command>');
      expect(r.err).toBe('');
    }
  });

  it('no command exits 2 with usage on stderr', async () => {
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.err).toContain('Usage: sentei');
    expect(r.out).toBe('');
  });

  it('unknown command exits 2', async () => {
    const r = await run('frobnicate', '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^unknown command: frobnicate/);
  });

  it('extra positionals exit 2', async () => {
    const r = await run('analyze', 'extra');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^unexpected arguments: extra/);
  });

  it('unknown option exits 2', async () => {
    const r = await run('analyze', '--no-such-flag');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--no-such-flag');
  });

  it.each(['0', '-5', '1.5', 'lots'])('--max-old-space-mb %s exits 2', async (v) => {
    const r = await run('index', `--max-old-space-mb=${v}`, '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^--max-old-space-mb must be a positive integer/);
  });

  it('usage errors do not create the work dir', async () => {
    const work = freshWork();
    await run('frobnicate', '--work', work);
    await run('discover', '--policy', 'bogus=1', '--work', work);
    expect(() => readFileSync(path.join(work, 'sentei.db'))).toThrow();
  });
});

describe('--policy', () => {
  it('unknown key exits 2', async () => {
    const r = await run('discover', '--policy', 'bogus=1', '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^--policy: unknown key "bogus" \(known: minAgeDays, /);
  });

  it.each([
    ['minAgeDays=-1', /"minAgeDays" must be a non-negative integer/],
    ['minAgeDays="7"', /"minAgeDays" must be a non-negative integer/],
    ['countTestsAsConsumers=yes', /is not JSON/],
    ['countTestsAsConsumers=1', /"countTestsAsConsumers" must be a boolean/],
    ['countTestsAsConsumers', /expected <key>=<json value>/],
    ['=true', /expected <key>=<json value>/],
  ])('%s exits 2', async (spec, msg) => {
    const r = await run('run', '--policy', spec, '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(msg);
  });

  it('is rejected for stages other than discover/run', async () => {
    const r = await run('analyze', '--policy', 'minAgeDays=0', '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/only applies to discover/);
  });

  it('parses JSON values, last one wins', () => {
    expect(parsePolicyOverrides(['countTestsAsConsumers=false', 'minAgeDays=0', 'minAgeDays=30']))
      .toEqual({ countTestsAsConsumers: false, minAgeDays: 30 });
    expect(parsePolicyOverrides([])).toEqual({});
  });

  it('discover applies overrides on top of the org sentei.json', async () => {
    const orgDir = path.join(tmpRoot, 'org-policy');
    mkdirSync(path.join(orgDir, 'repos', 'lib'), { recursive: true });
    writeFileSync(path.join(orgDir, 'org.json'), JSON.stringify({ org: 'acme', repos: [{ name: 'lib' }] }));
    writeFileSync(path.join(orgDir, 'sentei.json'), JSON.stringify({ countTestsAsConsumers: true, minAgeDays: 90 }));
    writeFileSync(path.join(orgDir, 'repos', 'lib', 'package.json'), JSON.stringify({ name: '@acme/lib', version: '1.0.0' }));
    const work = freshWork();
    const r = await run('discover', '--org-dir', orgDir, '--work', work, '--policy', 'minAgeDays=0');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[discover] policy override minAgeDays=0 (was 90)');
    const model = JSON.parse(readFileSync(path.join(work, 'discover.json'), 'utf8'));
    expect(model.policy).toMatchObject({ countTestsAsConsumers: true, minAgeDays: 0 });
    const db = openDb(path.join(work, 'sentei.db'));
    try {
      const rows = db.prepare("SELECT key, value FROM policy WHERE key IN ('countTestsAsConsumers', 'minAgeDays') ORDER BY key").all();
      expect(rows).toEqual([{ key: 'countTestsAsConsumers', value: 'true' }, { key: 'minAgeDays', value: '0' }]);
    } finally {
      db.close();
    }
  });
});

describe('stage errors', () => {
  it('a stage that throws exits 1 with "sentei <stage>: <message>" on stderr', async () => {
    const r = await run('discover', '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toBe('sentei discover: exactly one of --org <name> (GitHub) or --org-dir <dir> (local) is required\n');
    expect(r.out).not.toContain('done in');
  });

  it('--verbose adds the stack', async () => {
    const r = await run('discover', '--work', freshWork(), '--verbose');
    expect(r.code).toBe(1);
    expect(r.err.split('\n')[0]).toBe('sentei discover: exactly one of --org <name> (GitHub) or --org-dir <dir> (local) is required');
    expect(r.err).toMatch(/\n\s+at /);
  });

  it('run names the failing stage', async () => {
    const r = await run('run', '--org-dir', path.join(tmpRoot, 'missing-org'), '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei discover: cannot read .*org\.json/);
    expect(r.err.trimEnd().split('\n')).toHaveLength(1);
  });

  it('an error before the DB opens exits 1 too', async () => {
    const file = path.join(tmpRoot, 'not-a-dir');
    writeFileSync(file, '');
    const r = await run('analyze', '--work', path.join(file, 'work'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei analyze: /);
  });

  it('formatError keeps the first line and strips a duplicate prefix', () => {
    expect(formatError('ingest', new Error('sentei: bad thing\nmore detail'), false, {})).toBe('sentei ingest: bad thing\n');
    expect(formatError('index', 'plain string', false, {})).toBe('sentei index: plain string\n');
  });

  it('never prints a token', () => {
    const env = { GITHUB_TOKEN: 'sekrit-token-value' };
    const err = new Error('clone failed: sekrit-token-value / ghp_FAKE0FAKE0FAKE0FAKE / https://x-access-token:abc123@github.com');
    const text = formatError('discover', err, true, env);
    expect(text).not.toContain('sekrit-token-value');
    expect(text).not.toContain('ghp_FAKE');
    expect(text).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer xyz.789', {})).toBe('Authorization: Bearer ***');
  });
});

describe('timings and --quiet', () => {
  it('prints "[stage] done in Ns" after each stage', async () => {
    const r = await run('discover', '--org-dir', path.join(FIXTURES, 'org-small'), '--work', freshWork());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\[discover\] done in \d+\.\ds$/m);
  });

  it('a later stage on a DB its predecessor never filled fails with what to run first', async () => {
    const r = await run('analyze', '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei analyze: .*run ingest first/);
  });

  it('run prints per-stage timings and a total line; --quiet keeps the summary only', async () => {
    const work = freshWork();
    // Copy the fixture: index writes node_modules source links into the org checkouts.
    const orgDir = path.join(tmpRoot, 'org-small');
    cpSync(path.join(FIXTURES, 'org-small'), orgDir, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes('node_modules'),
    });
    const loud = await run('run', '--org-dir', orgDir, '--work', work, '--no-install');
    expect(loud.err).toBe('');
    expect(loud.code).toBe(0);
    for (const s of ['discover', 'index', 'ingest', 'blame', 'analyze', 'witness', 'report']) {
      expect(loud.out).toMatch(new RegExp(`^\\[${s}\\] done in \\d+\\.\\ds$`, 'm'));
    }
    expect(loud.out).toMatch(/^\[run\] done in \d+\.\ds \(discover \d+\.\ds, index .*, report \d+\.\ds\)$/m);

    const quiet = await run('run', '--org-dir', orgDir, '--work', work, '--no-install', '--quiet');
    expect(quiet.code).toBe(0);
    expect(quiet.out).not.toContain('done in');
    expect(quiet.out).not.toMatch(/^\[discover\]/m);
    expect(quiet.out).toContain('Top blockers');
    expect(quiet.out).toMatch(/^sentei .* report, generated/m);
  }, 300_000);
});

describe('repos and GitHub discover (fake API)', () => {
  const API = 'https://api.github.com';
  const LIST = `${API}/orgs/acme/repos?type=all&per_page=100`;
  const apiRepo = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name, full_name: `acme/${name}`, default_branch: 'main', archived: false, fork: false,
    clone_url: `https://github.com/acme/${name}.git`, pushed_at: '2026-08-01T00:00:00Z', size: 2048, language: 'TypeScript', ...extra,
  });
  function fakeFetch(routes: Record<string, unknown>): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return url in routes
        ? new Response(JSON.stringify(routes[url]), { status: 200 })
        : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, urls };
  }
  async function runGh(fetchImpl: typeof fetch, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    const code = await main(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), github: { fetchImpl, token: 'tok' } });
    return { code, out, err };
  }
  const sha = (c: string): string => c.repeat(40);

  it('repos lists every repo with its decision (fresh listing → lockfile), then reads the lockfile with no API calls', async () => {
    const tree = (name: string, files: Record<string, number>): Record<string, unknown> => ({
      [`${API}/repos/acme/${name}/git/trees/main?recursive=1`]: {
        truncated: false, tree: Object.entries(files).map(([p, size]) => ({ path: p, type: 'blob', size })),
      },
    });
    const { fetchImpl, urls } = fakeFetch({
      [LIST]: [apiRepo('lib'), apiRepo('hw', { language: 'C' }), apiRepo('old', { archived: true }), apiRepo('tools', { language: 'Shell' }),
        apiRepo('cli', { size: 900 * 1024 })],
      ...tree('lib', { 'package.json': 1024, 'src/index.ts': 1024 }),
      ...tree('hw', { 'main.c': 512 }),
      ...tree('tools', { 'cli/package.json': 3 * 1024 * 1024 }),
      ...tree('cli', { 'package.json': 1024, 'apps/web/package.json': 1024 }),
      [`${API}/repos/acme/lib/branches/main`]: { commit: { sha: sha('a') } },
      [`${API}/repos/acme/tools/branches/main`]: { commit: { sha: sha('b') } },
      [`${API}/repos/acme/cli/branches/main`]: { commit: { sha: sha('c') } },
    });
    const work = freshWork();
    const r = await runGh(fetchImpl, 'repos', '--org', 'acme', '--work', work, '--config-dir', work);
    expect(r.err).toContain('[repos] listed 5 repo(s) for acme');
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toEqual([
      'Selected (3):',
      'REPO   LANGUAGE          SIZE  MANIFESTS  PUSHED      REASONS',
      'cli    TypeScript        2 KB          2  2026-08-01  language TypeScript',
      'lib    TypeScript        2 KB          1  2026-08-01  language TypeScript',
      'tools  Shell           3.0 MB          1  2026-08-01  language Shell, but cli/package.json',
      '',
      'Excluded (2):',
      'REPO   LANGUAGE          SIZE  MANIFESTS  PUSHED      REASONS',
      'hw     C                 1 KB          0  2026-08-01  language C not in repos.languages; no package.json or pubspec.yaml in the HEAD tree',
      'old    TypeScript  2.0 MB api          -  2026-08-01  archived (--include-archived to keep)',
      '',
      '3 of 5 repo(s) selected',
      'SIZE is the HEAD tree; "api" marks GitHub\'s full-history size (git tree not fetched, truncated or unavailable)',
      '',
    ]);
    const lock = JSON.parse(readFileSync(path.join(work, 'acme.lock.json'), 'utf8'));
    expect(lock.repos.map((x: { name: string; selected: boolean }) => [x.name, x.selected]))
      .toEqual([['cli', true], ['hw', false], ['lib', true], ['old', false], ['tools', true]]);
    const calls = urls.length;

    // --json, from the lockfile; flags override config and re-decide without API calls.
    const j = await runGh(fetchImpl, 'repos', '--org', 'acme', '--work', work, '--config-dir', work, '--json', '--exclude', 'tools');
    expect(j.code).toBe(0);
    expect(urls).toHaveLength(calls);
    const rows = JSON.parse(j.out);
    expect(rows.find((x: { name: string }) => x.name === 'tools')).toMatchObject({
      selected: false, reasons: ['excluded by --exclude "tools"'], language: 'Shell', sizeKb: 2048, headTreeKb: 3072, sizeSource: 'head',
      probe: 'tree', manifests: ['cli/package.json'], headSha: sha('b'),
    });
    const t = await runGh(fetchImpl, 'repos', '--org', 'acme', '--work', work, '--config-dir', work, '--exclude', 'tools');
    expect(t.out).toContain('\n1 excluded repo(s) have package manifests and may consume org packages (their references are invisible): tools\n');
    expect(t.err).toContain('[repos] warning: 1 excluded repo(s) have package manifests and may consume org packages (their references are invisible): acme/tools (--exclude, 1 manifest)');
    expect(j.err).toMatch(/selection settings changed since the lockfile was written \(cliExclude \[\] → \["tools"\]\)/);
  });

  it('repos needs --org; --json and --clone-concurrency are validated', async () => {
    const r = await run('repos', '--org-dir', 'x', '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei repos: --org <name> is required \(repos lists GitHub repos/);
    expect((await run('discover', '--json', '--work', freshWork())).err).toMatch(/^--json only applies to repos/);
    for (const v of ['0', '33', 'x']) {
      const c = await run('discover', '--clone-concurrency', v, '--work', freshWork());
      expect(c.code).toBe(2);
      expect(c.err).toMatch(/^--clone-concurrency must be an integer from 1 to 32/);
    }
  });

  it('discover fails listing uncloneable repos (exit 1) unless --allow-clone-failures', async () => {
    const root = path.join(tmpRoot, 'gh-bare');
    mkdirSync(root, { recursive: true });
    const lib = makeBareRepo(root, 'lib');
    const { fetchImpl } = fakeFetch({
      [LIST]: [apiRepo('lib', { clone_url: lib.url }), apiRepo('gone', { clone_url: lib.url.replace(/lib\.git$/, 'gone.git') })],
      [`${API}/repos/acme/lib/branches/main`]: { commit: { sha: lib.shas[1] } },
      [`${API}/repos/acme/gone/branches/main`]: { commit: { sha: sha('c') } },
    });
    const work = freshWork();
    const r = await runGh(fetchImpl, 'discover', '--org', 'acme', '--work', work, '--config-dir', work, '--clone-concurrency', '2');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei discover: 1 of 2 repo\(s\) could not be cloned: gone \(/);
    expect(r.out).toMatch(/^\[discover\] cloned 2\/2 \(0 cached, 1 failed\)/m);

    const ok = await runGh(fetchImpl, 'discover', '--org', 'acme', '--work', work, '--config-dir', work, '--allow-clone-failures');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^\[discover\] warning: skipping 1 repo\(s\) that could not be cloned .*: gone\. Every org package they contain is unknown/m);
    const model = JSON.parse(readFileSync(path.join(work, 'discover.json'), 'utf8'));
    expect(model.repos.map((x: { repo: string }) => x.repo)).toEqual(['acme/lib']);
    expect(model.source.cloneFailures).toEqual([{ repo: 'acme/gone', error: expect.stringMatching(/^git clone/) }]);

    const listed = await runGh(fetchImpl, 'repos', '--org', 'acme', '--work', work, '--config-dir', work);
    expect(listed.out).toMatch(/^gone .* language TypeScript; last clone failed: git clone/m);
  });
});
