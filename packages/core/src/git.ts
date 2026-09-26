// Raw `git` subprocess helpers (PLAN.md §11: prefer raw subprocess over simple-git).
// Always execFile (argv array, no shell). Sections are owned by the stage that uses them.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- process ---

export interface GitOptions {
  cwd?: string;
  /** Extra environment on top of process.env (GIT_TERMINAL_PROMPT=0 is always set). */
  env?: Record<string, string>;
}

/** Run `git <args>` and resolve with trimmed stdout; rejects with git's stderr in the message. */
export function git(args: readonly string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        // Never echo env (it may carry an auth header); argv never carries secrets.
        reject(new Error(`git ${args.join(' ')} failed${opts.cwd ? ` in ${opts.cwd}` : ''}: ${stderr.trim() || err.message}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

// ------------------------------------------------------------------ clone ---

/** HEAD commit sha of the checkout at `dir`. */
export function headSha(dir: string): Promise<string> {
  return git(['rev-parse', 'HEAD'], { cwd: dir });
}

/**
 * Size of the object store at `dir` in KB (`git count-objects -v`: packs plus
 * loose objects): for a fresh shallow clone, about what was downloaded.
 */
export async function objectStoreKb(dir: string): Promise<number> {
  const out = await git(['count-objects', '-v'], { cwd: dir });
  let kb = 0;
  for (const line of out.split('\n')) {
    const m = /^(size|size-pack): (\d+)$/.exec(line.trim());
    if (m) kb += Number(m[2]);
  }
  return kb;
}

/** True if the checkout at `dir` is shallow. */
export async function isShallow(dir: string): Promise<boolean> {
  return (await git(['rev-parse', '--is-shallow-repository'], { cwd: dir })) === 'true';
}

export interface EnsureCloneOptions {
  dir: string;
  cloneUrl: string;
  defaultBranch: string;
  sha: string;
  /**
   * Token for https clones. Sent as an Authorization header scoped to the clone
   * URL's origin via GIT_CONFIG_* env vars: never in the URL, argv, logs, or .git/config.
   */
  token?: string | null;
  log?: (line: string) => void;
}

export interface EnsureCloneResult {
  status: 'cached' | 'updated' | 'cloned';
}

/**
 * Environment that makes git send `Authorization: Basic x-access-token:<token>`
 * to the clone URL's origin only (GitHub's documented form for git over https).
 */
function authEnv(cloneUrl: string, token: string | null | undefined): Record<string, string> {
  if (!token || !cloneUrl.startsWith('https://')) return {};
  const origin = new URL(cloneUrl).origin;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/**
 * Make `dir` a shallow checkout of `sha` (detached when it had to fetch by sha).
 * - `dir/.git` exists at `sha`            → cached (no network)
 * - `dir/.git` exists at another commit   → fetch --depth=1 <sha>, checkout --force --detach → updated
 * - otherwise                             → clone --depth=1 --branch <defaultBranch>; if the branch
 *                                           moved past `sha`, fetch + checkout `sha` → cloned
 * Throws if `dir` exists but is not a git checkout (never deletes it).
 */
export async function ensureClone(opts: EnsureCloneOptions): Promise<EnsureCloneResult> {
  // The sha may come from a lockfile: never let it reach argv as an option.
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(opts.sha)) throw new Error(`sentei: ${opts.dir}: invalid commit sha ${JSON.stringify(opts.sha)}`);
  // LFS: a smudge filter (if git-lfs is installed) would download every LFS object
  // at checkout; analysis never needs them, and hardware repos can hold gigabytes.
  const env = { ...authEnv(opts.cloneUrl, opts.token), GIT_LFS_SKIP_SMUDGE: '1' };
  const pin = async (): Promise<void> => {
    await git(['fetch', '--depth=1', '--no-tags', 'origin', opts.sha], { cwd: opts.dir, env });
    await git(['checkout', '--force', '--detach', opts.sha], { cwd: opts.dir, env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  };
  const verify = async (): Promise<void> => {
    const head = await headSha(opts.dir);
    if (head !== opts.sha) throw new Error(`sentei: ${opts.dir}: HEAD is ${head} after checkout, expected ${opts.sha}`);
  };

  if (existsSync(join(opts.dir, '.git'))) {
    if ((await headSha(opts.dir)) === opts.sha) return { status: 'cached' };
    opts.log?.(`${opts.dir}: fetching ${opts.sha}`);
    await pin();
    await verify();
    return { status: 'updated' };
  }
  if (existsSync(opts.dir)) throw new Error(`sentei: ${opts.dir} exists but is not a git checkout; move it away and rerun`);

  await git(['clone', '--depth=1', '--single-branch', '--branch', opts.defaultBranch, '--no-tags', '--', opts.cloneUrl, opts.dir], { env });
  if ((await headSha(opts.dir)) !== opts.sha) {
    opts.log?.(`${opts.dir}: ${opts.defaultBranch} moved since listing, fetching pinned ${opts.sha}`);
    await pin();
  }
  await verify();
  return { status: 'cloned' };
}
