import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureClone, headSha, isShallow } from '../src/git.ts';
import { makeBareRepo } from './helpers/gitRepo.ts';

let tmp: string;
let url: string;
let sha1: string;
let sha2: string;

beforeAll(() => {
  tmp = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-git-'));
  ({ url, shas: [sha1, sha2] } = makeBareRepo(tmp, 'lib'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('ensureClone', () => {
  it('clones shallow at the branch head, then reports cached', async () => {
    const dir = join(tmp, 'c1');
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'cloned', full: false });
    expect(await headSha(dir)).toBe(sha2);
    expect(await isShallow(dir)).toBe(true);
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'cached', full: false });
  });

  it('pins an older sha when the branch moved since listing, and updates an existing clone', async () => {
    const dir = join(tmp, 'c2');
    const logs: string[] = [];
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1, log: (l) => logs.push(l) })).toEqual({ status: 'cloned', full: false });
    expect(await headSha(dir)).toBe(sha1);
    expect(logs.some((l) => l.includes('moved since listing'))).toBe(true);
    expect(await isShallow(dir)).toBe(true);

    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'updated', full: false });
    expect(await headSha(dir)).toBe(sha2);
    // …and back again.
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1 })).toEqual({ status: 'updated', full: false });
    expect(await headSha(dir)).toBe(sha1);
  });

  it('refuses a malformed sha and an existing non-git directory', async () => {
    await expect(ensureClone({ dir: join(tmp, 'c3'), cloneUrl: url, defaultBranch: 'main', sha: '--upload-pack=touch x' }))
      .rejects.toThrow(/invalid commit sha/);
    mkdirSync(join(tmp, 'c4'));
    await expect(ensureClone({ dir: join(tmp, 'c4'), cloneUrl: url, defaultBranch: 'main', sha: sha1 }))
      .rejects.toThrow(/exists but is not a git checkout/);
  });

  /** A fake git: records argv, answers rev-parse from `state`. */
  function fakeGit(state: { shallow: boolean; head: string }) {
    const calls: string[][] = [];
    const runGit = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return state.shallow ? 'true' : 'false';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return state.head;
      if (args[0] === 'fetch' && args.includes('--unshallow')) state.shallow = false;
      if (args[0] === 'checkout') state.head = args.at(-1)!;
      return '';
    };
    return { calls, runGit };
  }

  it('full: clones without --depth; shallow (default) clones with --depth=1 (fake git)', async () => {
    const full = fakeGit({ shallow: false, head: sha2 });
    expect(await ensureClone({ dir: join(tmp, 'f1'), cloneUrl: url, defaultBranch: 'main', sha: sha2, full: true, runGit: full.runGit }))
      .toEqual({ status: 'cloned', full: true });
    expect(full.calls[0]).toEqual(['clone', '--single-branch', '--branch', 'main', '--no-tags', '--', url, join(tmp, 'f1')]);
    expect(full.calls.flat()).not.toContain('--depth=1');

    const shallow = fakeGit({ shallow: true, head: sha2 });
    expect(await ensureClone({ dir: join(tmp, 'f2'), cloneUrl: url, defaultBranch: 'main', sha: sha2, runGit: shallow.runGit }))
      .toEqual({ status: 'cloned', full: false });
    expect(shallow.calls[0]).toEqual(['clone', '--depth=1', '--single-branch', '--branch', 'main', '--no-tags', '--', url, join(tmp, 'f2')]);
  });

  it('full: upgrades an existing shallow checkout with fetch --unshallow; never unshallows without it (fake git)', async () => {
    const dir = join(tmp, 'f3');
    mkdirSync(join(dir, '.git'), { recursive: true });
    const plain = fakeGit({ shallow: true, head: sha2 });
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2, runGit: plain.runGit })).toEqual({ status: 'cached', full: false });
    expect(plain.calls.some((c) => c[0] === 'fetch')).toBe(false);

    const up = fakeGit({ shallow: true, head: sha2 });
    const logs: string[] = [];
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2, full: true, runGit: up.runGit, log: (l) => logs.push(l) }))
      .toEqual({ status: 'updated', full: true });
    expect(up.calls.filter((c) => c[0] === 'fetch')).toEqual([['fetch', '--unshallow', '--no-tags', 'origin']]);
    expect(logs.some((l) => l.includes('fetching full history'))).toBe(true);

    // At another sha: unshallow, then fetch the sha without --depth (the checkout is full now).
    const moved = fakeGit({ shallow: true, head: sha1 });
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2, full: true, runGit: moved.runGit }))
      .toEqual({ status: 'updated', full: true });
    expect(moved.calls.filter((c) => c[0] === 'fetch' || c[0] === 'checkout')).toEqual([
      ['fetch', '--unshallow', '--no-tags', 'origin'],
      ['checkout', '--force', '--detach', sha2],
    ]);
  });

  it('full, real git: clone, pin an older sha, upgrade a shallow clone; a full checkout stays full for a shallow request', async () => {
    const dir = join(tmp, 'r1');
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1, full: true })).toEqual({ status: 'cloned', full: true });
    expect(await headSha(dir)).toBe(sha1);
    expect(await isShallow(dir)).toBe(false);
    // Shallow request, other sha: fetched without --depth, still full.
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'updated', full: true });
    expect(await headSha(dir)).toBe(sha2);
    expect(await isShallow(dir)).toBe(false);

    const up = join(tmp, 'r2');
    expect(await ensureClone({ dir: up, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'cloned', full: false });
    expect(await ensureClone({ dir: up, cloneUrl: url, defaultBranch: 'main', sha: sha2, full: true })).toEqual({ status: 'updated', full: true });
    expect(await isShallow(up)).toBe(false);
    expect(await ensureClone({ dir: up, cloneUrl: url, defaultBranch: 'main', sha: sha1, full: true })).toEqual({ status: 'updated', full: true });
    expect(await headSha(up)).toBe(sha1);
  });

  it('re-clones an interrupted clone: .git without a commit, nothing checked out (fake git)', async () => {
    const dir = join(tmp, 'i1');
    mkdirSync(join(dir, '.git'), { recursive: true });
    const calls: string[][] = [];
    let cloned = false;
    const runGit = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        if (!cloned) throw new Error("git rev-parse --verify HEAD^{commit} failed: fatal: ambiguous argument 'HEAD'");
        return sha2;
      }
      if (args[0] === 'config') return url;
      if (args[0] === 'clone') {
        cloned = true;
        expect(existsSync(dir)).toBe(false); // removed before cloning
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return sha2;
      return '';
    };
    const logs: string[] = [];
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2, runGit, log: (l) => logs.push(l) }))
      .toEqual({ status: 'cloned', full: false });
    expect(calls.map((c) => c[0])).toEqual(['rev-parse', 'config', 'clone', 'rev-parse', 'rev-parse']);
    expect(logs.some((l) => l.includes('interrupted clone'))).toBe(true);
  });

  it('never removes a commitless .git next to other files, or one with another origin (fake git)', async () => {
    const noCommit = async (args: readonly string[]): Promise<string> => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('unborn');
      if (args[0] === 'config') return 'https://example.com/other.git';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const withFiles = join(tmp, 'i2');
    mkdirSync(join(withFiles, '.git'), { recursive: true });
    writeFileSync(join(withFiles, 'notes.txt'), 'mine');
    await expect(ensureClone({ dir: withFiles, cloneUrl: url, defaultBranch: 'main', sha: sha2, runGit: noCommit }))
      .rejects.toThrow(/holds other files \(notes\.txt\); not an interrupted clone/);
    expect(existsSync(join(withFiles, 'notes.txt'))).toBe(true);

    const otherOrigin = join(tmp, 'i3');
    mkdirSync(join(otherOrigin, '.git'), { recursive: true });
    await expect(ensureClone({ dir: otherOrigin, cloneUrl: url, defaultBranch: 'main', sha: sha2, runGit: noCommit }))
      .rejects.toThrow(/its origin is https:\/\/example\.com\/other\.git/);
    expect(existsSync(join(otherOrigin, '.git'))).toBe(true);
  });

  it('real git: an interrupted file:// clone (unborn HEAD, no objects) or an empty .git is cloned again', async () => {
    // What `git clone` leaves when killed before its fetch finishes: an initialised
    // repository with the origin configured, no commit, no checkout.
    const dir = join(tmp, 'i4');
    execFileSync('git', ['init', '--quiet', dir]);
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
    await expect(headSha(dir)).rejects.toThrow(); // what every rerun used to fail on
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1 })).toEqual({ status: 'cloned', full: false });
    expect(await headSha(dir)).toBe(sha1);
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1 })).toEqual({ status: 'cached', full: false });

    // A bare `.git` directory git does not recognise (and must not climb out of).
    const empty = join(tmp, 'i5');
    mkdirSync(join(empty, '.git'), { recursive: true });
    expect(await ensureClone({ dir: empty, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'cloned', full: false });
    expect(await headSha(empty)).toBe(sha2);
  });

  it('fails clearly for an unknown sha', async () => {
    await expect(ensureClone({ dir: join(tmp, 'c5'), cloneUrl: url, defaultBranch: 'main', sha: 'f'.repeat(40) }))
      .rejects.toThrow(/git fetch/);
  });
});
