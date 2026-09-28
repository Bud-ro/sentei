import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

  it('fails clearly for an unknown sha', async () => {
    await expect(ensureClone({ dir: join(tmp, 'c5'), cloneUrl: url, defaultBranch: 'main', sha: 'f'.repeat(40) }))
      .rejects.toThrow(/git fetch/);
  });
});
