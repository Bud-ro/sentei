import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBlamePorcelain, runBlame, type BlameCache, type BlameDiscoverInput } from '../src/blame.ts';
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
    expect(r1).toEqual({ symbols: 3, blamed: 2, skippedRepos: 0, cached: 0 });
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
    expect(r2).toEqual({ symbols: 2, blamed: 0, skippedRepos: 0, cached: 2 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: 'f'.repeat(40), at: 42 });

    // A cache for another sha is ignored: the file is re-blamed.
    cache.sha = c1;
    writeFileSync(cachePath, JSON.stringify(cache));
    const r3 = await runBlame({ db, discover, workDir: work, log: () => {} });
    expect(r3).toEqual({ symbols: 2, blamed: 2, skippedRepos: 0, cached: 0 });
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
    expect(r).toEqual({ symbols: 1, blamed: 0, skippedRepos: 1, cached: 0 });
    expect(ages(db, ids['acme/plain:x']!)).toEqual({ sha: null, at: null });
    expect(log.filter((l) => l.includes('no git history; ages unknown'))).toHaveLength(1);
  });

  it('unshallows a --depth=1 clone and blames it with full history', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    const { c1, c2 } = makeRepo(origin);
    const clone = join(root, 'clone');
    git(root, ['clone', '-q', '--depth=1', `file://${origin}`, clone]);
    expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    const { db, ids } = makeDb(['acme/lib'], [
      { repo: 'acme/lib', name: 'a', line: 0 },
      { repo: 'acme/lib', name: 'b', line: 2 },
    ]);
    const r = await runBlame({ db, discover: { repos: [{ repo: 'acme/lib', localPath: clone, headSha: null }] }, workDir: join(root, 'w'), log: () => {} });
    expect(r).toEqual({ symbols: 2, blamed: 2, skippedRepos: 0, cached: 0 });
    expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('false');
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: c1, at: T1 });
    expect(ages(db, ids['acme/lib:b']!)).toEqual({ sha: c2, at: T2 });
  });

  it('uses a complete cache for the current sha without unshallowing (no fetch); a miss still unshallows', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    const { c2 } = makeRepo(origin);
    const clone = join(root, 'clone');
    git(root, ['clone', '-q', '--depth=1', `file://${origin}`, clone]);
    const workDir = join(root, 'w');
    mkdirSync(join(workDir, 'blame'), { recursive: true });
    const cache: BlameCache = { sha: c2, files: { 'src/index.ts': { '1': { sha: 'f'.repeat(40), authorTime: 42 } } } };
    writeFileSync(join(workDir, 'blame', 'acme__lib.json'), JSON.stringify(cache));
    // The origin is gone: any unshallow would fail, so success proves no fetch happened.
    rmSync(origin, { recursive: true, force: true });
    const { db, ids } = makeDb(['acme/lib'], [{ repo: 'acme/lib', name: 'a', line: 0 }]);
    const logs: string[] = [];
    const discover = { repos: [{ repo: 'acme/lib', localPath: clone, headSha: c2 }] };
    const r = await runBlame({ db, discover, workDir, log: (l) => logs.push(l) });
    expect(r).toEqual({ symbols: 1, blamed: 0, skippedRepos: 0, cached: 1 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: 'f'.repeat(40), at: 42 });
    expect(git(clone, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    expect(logs.some((l) => l.includes('shallow clone; fetching history'))).toBe(false);

    // A target line missing from the cache needs blame, hence the unshallow (which fails here).
    const more = makeDb(['acme/lib'], [{ repo: 'acme/lib', name: 'a', line: 0 }, { repo: 'acme/lib', name: 'b', line: 2 }]);
    const r2 = await runBlame({ db: more.db, discover, workDir, log: (l) => logs.push(l) });
    expect(r2).toEqual({ symbols: 2, blamed: 0, skippedRepos: 1, cached: 0 });
    expect(logs.some((l) => l.includes('shallow clone; fetching history'))).toBe(true);
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
    expect(r).toEqual({ symbols: 2, blamed: 0, skippedRepos: 0, cached: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: null, at: null });
    expect(logs.filter((l) => l.startsWith('[blame] warning: acme/lib: 2 symbol(s) undated') && l.includes('network?'))).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/2 undated \(2 network\?\)/);
  });

  it('skips a shallow repo whose history cannot be fetched (ages stay NULL)', async () => {
    const root = tmp();
    const origin = join(root, 'origin');
    makeRepo(origin);
    const clone = join(root, 'clone');
    git(root, ['clone', '-q', '--depth=1', `file://${origin}`, clone]);
    rmSync(origin, { recursive: true, force: true });
    const { db, ids } = makeDb(['acme/lib'], [{ repo: 'acme/lib', name: 'a', line: 0 }]);
    const r = await runBlame({ db, discover: { repos: [{ repo: 'acme/lib', localPath: clone, headSha: null }] }, workDir: join(root, 'w'), log: () => {} });
    expect(r).toEqual({ symbols: 1, blamed: 0, skippedRepos: 1, cached: 0 });
    expect(ages(db, ids['acme/lib:a']!)).toEqual({ sha: null, at: null });
  });
});
