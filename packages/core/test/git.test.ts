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
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'cloned' });
    expect(await headSha(dir)).toBe(sha2);
    expect(await isShallow(dir)).toBe(true);
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'cached' });
  });

  it('pins an older sha when the branch moved since listing, and updates an existing clone', async () => {
    const dir = join(tmp, 'c2');
    const logs: string[] = [];
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1, log: (l) => logs.push(l) })).toEqual({ status: 'cloned' });
    expect(await headSha(dir)).toBe(sha1);
    expect(logs.some((l) => l.includes('moved since listing'))).toBe(true);
    expect(await isShallow(dir)).toBe(true);

    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha2 })).toEqual({ status: 'updated' });
    expect(await headSha(dir)).toBe(sha2);
    // …and back again.
    expect(await ensureClone({ dir, cloneUrl: url, defaultBranch: 'main', sha: sha1 })).toEqual({ status: 'updated' });
    expect(await headSha(dir)).toBe(sha1);
  });

  it('refuses a malformed sha and an existing non-git directory', async () => {
    await expect(ensureClone({ dir: join(tmp, 'c3'), cloneUrl: url, defaultBranch: 'main', sha: '--upload-pack=touch x' }))
      .rejects.toThrow(/invalid commit sha/);
    mkdirSync(join(tmp, 'c4'));
    await expect(ensureClone({ dir: join(tmp, 'c4'), cloneUrl: url, defaultBranch: 'main', sha: sha1 }))
      .rejects.toThrow(/exists but is not a git checkout/);
  });

  it('fails clearly for an unknown sha', async () => {
    await expect(ensureClone({ dir: join(tmp, 'c5'), cloneUrl: url, defaultBranch: 'main', sha: 'f'.repeat(40) }))
      .rejects.toThrow(/git fetch/);
  });
});
