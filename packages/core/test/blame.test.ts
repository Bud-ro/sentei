import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ageCoverage, minAgeWarning, parseBlamePorcelain, runBlame, type BlameCache, type BlameDiscoverInput } from '../src/blame.ts';
import { openDb } from '../src/db.ts';

const T1 = 1600000000;
const T2 = 1700000000;

const roots: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmp(): string {
  const root = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-blame-'));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[], when?: number): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  if (when !== undefined) {
    env['GIT_AUTHOR_DATE'] = `@${when} +0000`;
    env['GIT_COMMITTER_DATE'] = `@${when} +0000`;
  }
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Repo whose src/index.ts line 1 comes from commit 1 (T1) and line 3 from commit 2 (T2). */
function makeRepo(dir: string): { c1: string; c2: string } {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'src/index.ts'), 'export const a = 1;\n\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'one'], T1);
  const c1 = git(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, 'src/index.ts'), 'export const a = 1;\n\nexport const b = 2;\n');
  git(dir, ['commit', '-q', '-am', 'two'], T2);
  const c2 = git(dir, ['rev-parse', 'HEAD']).trim();
  return { c1, c2 };
}

interface Sym {
  repo: string;
  name: string;
  file?: string;
  line: number | null;
  exported?: boolean;
}

function makeDb(repos: string[], syms: Sym[]): { db: DatabaseSync; ids: Record<string, number> } {
  const db = openDb(':memory:');
  dbs.push(db);
  const ids: Record<string, number> = {};
  for (const repo of repos) {
    db.prepare("INSERT INTO repos (repo, index_status) VALUES (?, 'ok')").run(repo);
    db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, ?, '.', 'npm', ?, 'private')")
      .run(`npm:${repo}:${repo}`, repo, repo);
  }
  for (const s of syms) {
    const file = s.file ?? 'src/index.ts';
    const r = db
      .prepare('INSERT INTO symbols (symbol_str, package_id, file, line, name, is_exported) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`sym ${s.repo} ${file} ${s.name}`, `npm:${s.repo}:${s.repo}`, file, s.line, s.name, s.exported === false ? 0 : 1);
    ids[`${s.repo}:${s.name}`] = Number(r.lastInsertRowid);
  }
  return { db, ids };
}

function ages(db: DatabaseSync, id: number): { sha: string | null; at: number | null } {
  const r = db.prepare('SELECT first_seen_sha AS sha, first_seen_at AS at FROM symbols WHERE symbol_id = ?').get(id) as {
    sha: string | null;
    at: number | null;
  };
  return { sha: r.sha, at: r.at };
}

describe('parseBlamePorcelain', () => {
  it('maps final lines to sha + author-time, remembering author-time per commit', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const sample = [
      `${A} 1 1 2`,
      'author t',
      'author-mail <t@t>',
      `author-time ${T1}`,
      'author-tz +0000',
      'summary one',
      'filename src/index.ts',
      '\texport const a = 1;',
      `${A} 2 2`,
      '\t',
      `${B} 3 3 1`,
      'author t',
      `author-time ${T2}`,
      'previous ' + A + ' src/index.ts',
      'filename src/index.ts',
      // Content that itself looks like a header / metadata must not be parsed.
      `\t${A} 9 9 9`,
      `${A} 4 5 1`,
      'filename src/index.ts',
      '\tauthor-time 1',
      '',
    ].join('\n');
    const m = parseBlamePorcelain(sample);
    expect([...m.keys()].sort()).toEqual([1, 2, 3, 5]);
    expect(m.get(1)).toEqual({ sha: A, authorTime: T1 });
    expect(m.get(2)).toEqual({ sha: A, authorTime: T1 });
    expect(m.get(3)).toEqual({ sha: B, authorTime: T2 });
    expect(m.get(5)).toEqual({ sha: A, authorTime: T1 });
    expect(m.has(9)).toBe(false);
  });

  it('returns an empty map for empty output', () => {
    expect(parseBlamePorcelain('').size).toBe(0);
  });
});

describe('runBlame', () => {
  it('refuses to run before ingest (no symbols)', async () => {
    const db = openDb(':memory:');
    try {
      await expect(runBlame({ db, discover: { repos: [] }, workDir: tmp(), log: () => {} })).rejects.toThrow(/no symbols; run ingest first/);
    } finally {
      db.close();
    }
  });

  it('dates exported symbols by blame of line+1, caches, and reads the cache back', async () => {
    const root = tmp();
    const dir = join(root, 'lib');
    const { c1, c2 } = makeRepo(dir);
    const { db, ids } = makeDb(['acme/lib'], [
      { repo: 'acme/lib', name: 'a', line: 0 },
      { repo: 'acme/lib', name: 'b', line: 2 },
      { repo: 'acme/lib', name: 'hidden', line: 0, exported: false },
      { repo: 'acme/lib', name: 'beyond', line: 99 },
    ]);
    const discover: BlameDiscoverInput = { repos: [{ repo: 'acme/lib', localPath: dir, headSha: c2 }] };
    const work = join(root, 'work');
    const log: string[] = [];

    const r1 = await runBlame({ db, discover, workDir: work, log: (l) => log.push(l) });
    expect(r1).toEqual({ symbols: 3, blamed: 2, skippedRepos: 0, cached: 0, shallowRepos: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: c1, at: T1 });
    expect(ages(db, ids['acme/lib:b']!)).toEqual({ sha: c2, at: T2 });
    expect(ages(db, ids['acme/lib:hidden']!)).toEqual({ sha: null, at: null });
    expect(ages(db, ids['acme/lib:beyond']!)).toEqual({ sha: null, at: null });
    expect(log.some((l) => l.includes('warning') && l.includes('src/index.ts:100'))).toBe(true);

    const cachePath = join(work, 'blame', 'acme__lib.json');
    expect(existsSync(cachePath)).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as BlameCache;
    expect(cache.sha).toBe(c2);
    expect(cache.files['src/index.ts']).toEqual({ '1': { sha: c1, authorTime: T1 }, '3': { sha: c2, authorTime: T2 } });

    // Drop the out-of-range symbol so the file is fully cached, then tamper with the
    // cache to prove the second run reads it instead of re-blaming.
    db.prepare('DELETE FROM symbols WHERE symbol_id = ?').run(ids['acme/lib:beyond']!);
    cache.files['src/index.ts']!['1'] = { sha: 'f'.repeat(40), authorTime: 42 };
    writeFileSync(cachePath, JSON.stringify(cache));
    const r2 = await runBlame({ db, discover, workDir: work, log: () => {} });
    expect(r2).toEqual({ symbols: 2, blamed: 0, skippedRepos: 0, cached: 2, shallowRepos: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: 'f'.repeat(40), at: 42 });

    // A cache for another sha is ignored: the file is re-blamed.
    cache.sha = c1;
    writeFileSync(cachePath, JSON.stringify(cache));
    const r3 = await runBlame({ db, discover, workDir: work, log: () => {} });
    expect(r3).toEqual({ symbols: 2, blamed: 2, skippedRepos: 0, cached: 0, shallowRepos: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: c1, at: T1 });
  });

  it('blames at discover headSha, not the working tree HEAD', async () => {
    const root = tmp();
    const dir = join(root, 'lib');
    const { c1 } = makeRepo(dir);
    const { db, ids } = makeDb(['acme/lib'], [{ repo: 'acme/lib', name: 'a', line: 0 }]);
    await runBlame({ db, discover: { repos: [{ repo: 'acme/lib', localPath: dir, headSha: c1 }] }, workDir: join(root, 'w'), log: () => {} });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: c1, at: T1 });
  });

  it("only: 'candidates' restricts to symbols with candidate/needs_review findings", async () => {
    const root = tmp();
    const dir = join(root, 'lib');
    const { c2 } = makeRepo(dir);
    const { db, ids } = makeDb(['acme/lib'], [
      { repo: 'acme/lib', name: 'a', line: 0 },
      { repo: 'acme/lib', name: 'b', line: 2 },
    ]);
    db.prepare("INSERT INTO findings (symbol_id, verdict) VALUES (?, 'needs_review')").run(ids['acme/lib:b']!);
    const r = await runBlame({ db, discover: { repos: [{ repo: 'acme/lib', localPath: dir, headSha: c2 }] }, workDir: join(root, 'w'), log: () => {}, only: 'candidates' });
    expect(r.symbols).toBe(1);
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: null, at: null });
    expect(ages(db, ids['acme/lib:b']!)).toEqual({ sha: c2, at: T2 });
  });

  it('skips a repo without .git; its symbols stay NULL', async () => {
    const root = tmp();
    const plain = join(root, 'plain');
    mkdirSync(join(plain, 'src'), { recursive: true });
    writeFileSync(join(plain, 'src/index.ts'), 'export const x = 1;\n');
    const { db, ids } = makeDb(['acme/plain'], [{ repo: 'acme/plain', name: 'x', line: 0 }]);
    const log: string[] = [];
    const r = await runBlame({ db, discover: { repos: [{ repo: 'acme/plain', localPath: plain, headSha: null }] }, workDir: join(root, 'w'), log: (l) => log.push(l) });
    expect(r).toEqual({ symbols: 1, blamed: 0, skippedRepos: 1, cached: 0, shallowRepos: 0 });
    expect(ages(db, ids['acme/plain:x']!)).toEqual({ sha: null, at: null });
    expect(log.filter((l) => l.includes('no git history; ages unknown'))).toHaveLength(1);
  });

  it('never unshallows: a --depth=1 clone is not blamed (even with a complete cache), ages stay NULL, one log line', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    const { c2 } = makeRepo(origin);
    const clone = join(root, 'clone');
    git(root, ['clone', '-q', '--depth=1', `file://${origin}`, clone]);
    expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    const workDir = join(root, 'w');
    mkdirSync(join(workDir, 'blame'), { recursive: true });
    // A cache for the current sha is not used either: a shallow repo is undated, full stop.
    const cache: BlameCache = { sha: c2, files: { 'src/index.ts': { '1': { sha: 'f'.repeat(40), authorTime: 42 } } } };
    writeFileSync(join(workDir, 'blame', 'acme__lib.json'), JSON.stringify(cache));
    const { db, ids } = makeDb(['acme/lib'], [
      { repo: 'acme/lib', name: 'a', line: 0 },
      { repo: 'acme/lib', name: 'b', line: 2 },
    ]);
    db.prepare("UPDATE symbols SET first_seen_sha = 'x', first_seen_at = 1").run();
    const logs: string[] = [];
    const r = await runBlame({ db, discover: { repos: [{ repo: 'acme/lib', localPath: clone, headSha: c2 }] }, workDir, log: (l) => logs.push(l) });
    expect(r).toEqual({ symbols: 2, blamed: 0, skippedRepos: 0, cached: 0, shallowRepos: 1 });
    expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    // Stale ages are reset: unknown, not the old value.
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: null, at: null });
    expect(ages(db, ids['acme/lib:b']!)).toEqual({ sha: null, at: null });
    expect(logs.filter((l) => l.startsWith('[blame] acme/lib: shallow clone, not blamed: 2 symbol age(s) unknown, treated as old enough')))
      .toHaveLength(1);
    expect(logs).toContain('[blame] 2 symbol(s): 0 blamed, 0 cached, 2 undated (2 shallow); 0 repo(s) skipped');
    expect(logs.some((l) => l.startsWith('[blame] 1 of 1 repo(s) are shallow clones: not blamed'))).toBe(true);
    // Default policy (minAgeDays 180): the warning.
    expect(logs.at(-1)).toBe('[blame] warn: minAgeDays=180 has no effect on 1 of 1 repos (shallow clones: symbol ages unknown, '
      + 'treated as old enough); pass --full-clone (repos.clone: "full") to date symbols');
    expect(db.prepare('SELECT repo, history FROM repo_history').all()).toEqual([{ repo: 'acme/lib', history: 'shallow' }]);
  });

  it('a partial clone whose promisor fetch fails: ages stay NULL, one warning per repo, `network?` in the summary', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    makeRepo(origin);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    const clone = join(root, 'clone');
    git(root, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, clone]);
    rmSync(origin, { recursive: true, force: true });
    const { db, ids } = makeDb(['acme/lib'], [{ repo: 'acme/lib', name: 'a', line: 0 }, { repo: 'acme/lib', name: 'b', line: 2 }]);
    const logs: string[] = [];
    const r = await runBlame({ db, discover: { repos: [{ repo: 'acme/lib', localPath: clone, headSha: null }] }, workDir: join(root, 'w'), log: (l) => logs.push(l) });
    expect(r).toEqual({ symbols: 2, blamed: 0, skippedRepos: 0, cached: 0, shallowRepos: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: null, at: null });
    expect(logs.filter((l) => l.startsWith('[blame] warning: acme/lib: 2 symbol(s) undated') && l.includes('network?'))).toHaveLength(1);
    expect(logs.find((l) => l.startsWith('[blame] 2 symbol(s):'))).toMatch(/2 undated \(2 network\?\)/);
  });

  it('blames a full clone; records every repo\'s history (also repos without targets); no warning when all are dated', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    const { c1, c2 } = makeRepo(origin);
    const full = join(root, 'full');
    git(root, ['clone', '-q', `file://${origin}`, full]);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    const { db, ids } = makeDb(['acme/lib', 'acme/empty', 'acme/plain', 'acme/app'], [
      { repo: 'acme/lib', name: 'a', line: 0 },
      { repo: 'acme/lib', name: 'b', line: 2 },
      { repo: 'acme/plain', name: 'p', line: 0 },
    ]);
    const discover: BlameDiscoverInput = {
      repos: [
        { repo: 'acme/lib', localPath: full, headSha: c2 },
        { repo: 'acme/empty', localPath: full, headSha: c2 },
        { repo: 'acme/plain', localPath: plain, headSha: null },
        { repo: 'acme/app', localPath: plain, headSha: null },
      ],
    };
    const logs: string[] = [];
    const r = await runBlame({ db, discover, workDir: join(root, 'w'), log: (l) => logs.push(l) });
    expect(r).toEqual({ symbols: 3, blamed: 2, skippedRepos: 1, cached: 0, shallowRepos: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: c1, at: T1 });
    expect(ages(db, ids['acme/lib:b']!)).toEqual({ sha: c2, at: T2 });
    // acme/app and acme/empty have no targets: no skip line, but their history is recorded.
    expect(logs.some((l) => l.includes('acme/app'))).toBe(false);
    expect(db.prepare('SELECT repo, history FROM repo_history ORDER BY repo').all()).toEqual([
      { repo: 'acme/app', history: 'none' }, { repo: 'acme/empty', history: 'full' }, { repo: 'acme/lib', history: 'full' },
      { repo: 'acme/plain', history: 'none' },
    ]);
    // acme/plain (exports, no git history) keeps minAgeDays from applying everywhere;
    // repos without exports (acme/app, acme/empty) are not counted.
    expect(logs.at(-1)).toBe('[blame] warn: minAgeDays=180 has no effect on 1 of 2 repos (no git history: symbol ages unknown, treated as old enough)');
    db.prepare("DELETE FROM repos WHERE repo = 'acme/plain'").run();
    const again: string[] = [];
    await runBlame({ db, discover, workDir: join(root, 'w'), log: (l) => again.push(l) });
    expect(again.some((l) => l.includes('warn:'))).toBe(false);
  });
});

describe('ageCoverage / minAgeWarning', () => {
  function cov(db: DatabaseSync) {
    return ageCoverage(db);
  }

  it('counts repos by history and symbols by dated / undated-in-shallow / other', () => {
    const { db, ids } = makeDb(['acme/full', 'acme/shallow', 'acme/none', 'acme/unblamed', 'acme/reingested', 'acme/app'], [
      { repo: 'acme/full', name: 'a', line: 0 }, { repo: 'acme/full', name: 'b', line: 1 },
      { repo: 'acme/shallow', name: 'c', line: 0 }, { repo: 'acme/shallow', name: 'd', line: 0 },
      { repo: 'acme/none', name: 'e', line: 0 },
      { repo: 'acme/unblamed', name: 'f', line: 0 },
      { repo: 'acme/reingested', name: 'g', line: 0 },
      { repo: 'acme/full', name: 'hidden', line: 0, exported: false },
    ]);
    db.prepare('UPDATE symbols SET first_seen_at = 1 WHERE symbol_id = ?').run(ids['acme/full:a']!);
    const ins = db.prepare('INSERT INTO repo_history (repo, history) VALUES (?, ?)');
    ins.run('acme/full', 'full');
    ins.run('acme/shallow', 'shallow');
    ins.run('acme/none', 'none');
    ins.run('acme/reingested', 'full'); // full, but no symbol dated: ingest ran after blame
    const c = cov(db);
    expect(c).toEqual({
      repos: 5, full: 1, shallow: 1, noHistory: 1, notBlamed: 2,
      symbols: { exported: 7, dated: 1, undatedShallow: 2, undatedOther: 4 },
    });
    expect(minAgeWarning(c, 180)).toBe('minAgeDays=180 has no effect on 4 of 5 repos (1 shallow clone(s), 1 without git history, '
      + '2 not blamed since the last discover/ingest: run blame: symbol ages unknown, treated as old enough); '
      + 'pass --full-clone (repos.clone: "full") to date symbols');
    expect(minAgeWarning(c, 0)).toBeNull();
    expect(minAgeWarning(c, null)).toBeNull();
  });

  it('warns about shallow clones only with minAgeDays > 0 and only while some repo is undated', () => {
    const { db } = makeDb(['acme/a', 'acme/b'], [{ repo: 'acme/a', name: 'x', line: 0 }, { repo: 'acme/b', name: 'y', line: 0 }]);
    db.prepare("INSERT INTO repo_history (repo, history) VALUES ('acme/a', 'shallow'), ('acme/b', 'shallow')").run();
    expect(minAgeWarning(cov(db), 30)).toBe('minAgeDays=30 has no effect on 2 of 2 repos (shallow clones: symbol ages unknown, '
      + 'treated as old enough); pass --full-clone (repos.clone: "full") to date symbols');
    db.prepare("UPDATE repo_history SET history = 'full'").run();
    db.prepare('UPDATE symbols SET first_seen_at = 1').run();
    expect(cov(db)).toMatchObject({ repos: 2, full: 2 });
    expect(minAgeWarning(cov(db), 30)).toBeNull();
  });
});

describe('runBlame across repos (dart-lang: 31 repos one at a time, 1280 s)', () => {
  const SHA = (i: number): string => String(i).padStart(40, 'a');
  const porcelain = (sha: string, lines: number, time: number): string =>
    Array.from({ length: lines }, (_, i) => `${sha} ${i + 1} ${i + 1} 1\n${i === 0 ? `author-time ${time}\n` : ''}\tline\n`).join('');

  /** N fake repos (a `.git` dir each), one exported symbol on line 1 of src/index.ts. */
  function fakeOrg(n: number): { root: string; repos: string[]; discover: BlameDiscoverInput } {
    const root = tmp();
    const repos = Array.from({ length: n }, (_, i) => `acme/r${i}`);
    for (const r of repos) mkdirSync(join(root, r, '.git'), { recursive: true });
    return { root, repos, discover: { repos: repos.map((r) => ({ repo: r, localPath: join(root, r), headSha: null })) } };
  }

  /**
   * A fake git: https clones, full unless `shallow(i)`; each history check and blame
   * takes a few ms, and their concurrency is measured. A fetch is an error: blame never
   * fetches history.
   */
  function fakeGit(root: string, shallow: (i: number) => boolean = () => false) {
    const calls: Array<{ repo: string; args: string[]; env: Record<string, string> }> = [];
    let activeChecks = 0;
    let activeBlames = 0;
    let maxActiveChecks = 0;
    let maxActiveBlames = 0;
    const run = async (cwd: string, args: string[], env: Record<string, string>): Promise<string> => {
      const repo = cwd.slice(root.length + 1);
      const i = Number(repo.replace(/^acme\/r/, ''));
      calls.push({ repo, args, env });
      const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 5 + ((i * 7) % 11)));
      if (args[0] === 'remote') return `https://github.com/${repo}.git\n`;
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
        maxActiveChecks = Math.max(maxActiveChecks, ++activeChecks);
        await pause();
        activeChecks--;
        return shallow(i) ? 'true\n' : 'false\n';
      }
      if (args[0] === 'rev-parse') return `${SHA(i)}\n`;
      if (args[0] === 'blame') {
        maxActiveBlames = Math.max(maxActiveBlames, ++activeBlames);
        await pause();
        activeBlames--;
        return porcelain(SHA(i), 2, 1_600_000_000 + i);
      }
      throw new Error(`unexpected: ${args.join(' ')}`);
    };
    return { run, calls, stats: () => ({ maxActiveChecks, maxActiveBlames }) };
  }

  const runOrg = async (n: number, repoConcurrency: number, token: string | null = 'ghs_secretsecretsecret', shallow?: (i: number) => boolean) => {
    const { root, repos, discover } = fakeOrg(n);
    const { db, ids } = makeDb(repos, repos.map((r) => ({ repo: r, name: 'x', line: 0 })));
    const fake = fakeGit(root, shallow);
    let tokenCalls = 0;
    const logs: string[] = [];
    const counts = await runBlame({
      db, discover, workDir: join(root, 'w'), log: (l) => logs.push(l), repoConcurrency, runGit: fake.run,
      token: async () => {
        tokenCalls++;
        return token;
      },
    });
    const dated = repos.map((r) => ages(db, ids[`${r}:x`]!));
    return { counts, dated, fake, tokenCalls, logs, root, db };
  };

  it('blames full repos in parallel (repoConcurrency), with identical results', async () => {
    const serial = await runOrg(12, 1);
    const parallel = await runOrg(12, 8);
    expect(serial.fake.stats()).toEqual({ maxActiveChecks: 1, maxActiveBlames: 1 });
    expect(parallel.fake.stats().maxActiveChecks).toBe(8);
    expect(parallel.fake.stats().maxActiveBlames).toBeGreaterThan(1);
    expect(parallel.counts).toEqual(serial.counts);
    expect(parallel.counts).toEqual({ symbols: 12, blamed: 12, skippedRepos: 0, cached: 0, shallowRepos: 0 });
    expect(parallel.dated).toEqual(serial.dated);
    expect(parallel.dated[3]).toEqual({ sha: SHA(3), at: 1_600_000_003 });
    for (const w of [serial, parallel]) {
      for (let i = 0; i < 12; i++) {
        const cache = JSON.parse(readFileSync(join(w.root, 'w', 'blame', `acme__r${i}.json`), 'utf8')) as BlameCache;
        expect(cache).toEqual({ sha: SHA(i), files: { 'src/index.ts': { '1': { sha: SHA(i), authorTime: 1_600_000_000 + i } } } });
      }
    }
  });

  it('blame processes of all repos share one pool of `concurrency`', async () => {
    const r = await runOrg(20, 20);
    expect(r.fake.stats().maxActiveChecks).toBe(20);
    expect(r.fake.stats().maxActiveBlames).toBeLessThanOrEqual(8);
  });

  it('shallow repos: no blame, no fetch, one log line each and one summary line; full repos are blamed', async () => {
    const r = await runOrg(6, 8, 'ghs_secretsecretsecret', (i) => i % 2 === 0);
    expect(r.counts).toEqual({ symbols: 6, blamed: 3, skippedRepos: 0, cached: 0, shallowRepos: 3 });
    const byRepo = (i: number) => r.fake.calls.filter((c) => c.repo === `acme/r${i}`).map((c) => c.args.slice(0, 2).join(' '));
    for (const i of [0, 2, 4]) {
      expect(byRepo(i)).toEqual(['rev-parse --is-shallow-repository']);
      expect(r.logs.filter((l) => l.startsWith(`[blame] acme/r${i}: shallow clone, not blamed: 1 symbol age(s) unknown`))).toHaveLength(1);
      expect(r.dated[i]).toEqual({ sha: null, at: null });
    }
    for (const i of [1, 3, 5]) {
      expect(byRepo(i)).toContain('blame --porcelain');
      expect(r.dated[i]).toEqual({ sha: SHA(i), at: 1_600_000_000 + i });
    }
    expect(r.fake.calls.some((c) => c.args[0] === 'fetch')).toBe(false);
    expect(r.logs.filter((l) => l.includes('are shallow clones'))).toEqual([
      '[blame] 3 of 6 repo(s) are shallow clones: not blamed (never unshallowed), their 3 symbol(s) have unknown ages, '
        + 'treated as old enough; pass --full-clone (repos.clone: "full") to date symbols',
    ]);
    expect(r.logs).toContain('[blame] 6 symbol(s): 3 blamed, 0 cached, 3 undated (3 shallow); 0 repo(s) skipped');
    expect(r.logs.at(-1)).toBe('[blame] warn: minAgeDays=180 has no effect on 3 of 6 repos (shallow clones: symbol ages unknown, '
      + 'treated as old enough); pass --full-clone (repos.clone: "full") to date symbols');
    expect(r.db.prepare("SELECT count(*) AS n FROM repo_history WHERE history = 'shallow'").get()).toEqual({ n: 3 });

    // minAgeDays 0: the ages are not used, so no warning.
    const zero = await runOrg(2, 8, null, () => true);
    zero.db.prepare("UPDATE policy SET value = '0' WHERE key = 'minAgeDays'").run();
    const again: string[] = [];
    await runBlame({ db: zero.db, discover: fakeOrgDiscover(zero.root, 2), workDir: join(zero.root, 'w'), log: (l) => again.push(l), runGit: fakeGit(zero.root, () => true).run });
    expect(again.some((l) => l.includes('warn:'))).toBe(false);
  });

  function fakeOrgDiscover(root: string, n: number): BlameDiscoverInput {
    return { repos: Array.from({ length: n }, (_, i) => ({ repo: `acme/r${i}`, localPath: join(root, `acme/r${i}`), headSha: null })) };
  }

  it('blames of an https origin carry the token in env only, never in argv or logs; the token is looked up once', async () => {
    const r = await runOrg(5, 8);
    expect(r.tokenCalls).toBe(1);
    const remote = r.fake.calls.filter((c) => c.args[0] === 'blame');
    expect(remote.length).toBe(5);
    for (const c of remote) {
      expect(c.env['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
      expect(c.env['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secretsecretsecret').toString('base64')}`);
    }
    for (const c of r.fake.calls) expect(c.args.join(' ')).not.toContain('secret');
    expect(r.logs.join('\n')).not.toMatch(/secret|AUTHORIZATION|basic /i);
  });

  it('no token: blames run without auth env (public repos); an all-shallow org never looks the token up', async () => {
    const r = await runOrg(2, 8, null);
    for (const c of r.fake.calls) expect(c.env).toEqual({});
    expect(r.counts.blamed).toBe(2);
    const shallow = await runOrg(3, 8, 'ghs_secretsecretsecret', () => true);
    expect(shallow.tokenCalls).toBe(0);
  });

  it('real full clones blamed in parallel date exactly as one at a time', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    const { c1, c2 } = makeRepo(origin);
    const repos = ['acme/a', 'acme/b', 'acme/c'];
    const results: Array<Array<{ sha: string | null; at: number | null }>> = [];
    for (const repoConcurrency of [1, 3]) {
      const clones = repos.map((r) => join(root, `${repoConcurrency}`, r));
      for (const c of clones) git(root, ['clone', '-q', `file://${origin}`, c]);
      const { db, ids } = makeDb(repos, repos.flatMap((r) => [{ repo: r, name: 'a', line: 0 }, { repo: r, name: 'b', line: 2 }]));
      const r = await runBlame({
        db, discover: { repos: repos.map((repo, i) => ({ repo, localPath: clones[i]!, headSha: null })) },
        workDir: join(root, `w${repoConcurrency}`), log: () => {}, repoConcurrency,
      });
      expect(r).toEqual({ symbols: 6, blamed: 6, skippedRepos: 0, cached: 0, shallowRepos: 0 });
      results.push(repos.flatMap((repo) => [ages(db, ids[`${repo}:a`]!), ages(db, ids[`${repo}:b`]!)]));
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toEqual(repos.flatMap(() => [{ sha: c1, at: T1 }, { sha: c2, at: T2 }]));
  });
});
