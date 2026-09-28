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
  /**
   * Full history (`repos.clone: "full"`, `--full-clone`): clone without `--depth`, and
   * upgrade an existing shallow checkout with `git fetch --unshallow`. Default false
   * (shallow). A checkout that is already full stays full for a shallow request.
   */
  full?: boolean;
  log?: (line: string) => void;
  /** Tests only: runs `git <args>` (default: git()). */
  runGit?: (args: readonly string[], opts: GitOptions) => Promise<string>;
}

export interface EnsureCloneResult {
  status: 'cached' | 'updated' | 'cloned';
  /** The checkout has full history (`git rev-parse --is-shallow-repository` is false). */
  full: boolean;
}

/**
 * Environment that makes git send `Authorization: Basic x-access-token:<token>`
 * to the clone URL's origin only (GitHub's documented form for git over https).
 * Used by clones (ensureClone) and by blame (unshallow fetch, promisor blob fetches).
 */
export function authEnv(cloneUrl: string, token: string | null | undefined): Record<string, string> {
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
 * Make `dir` a checkout of `sha` (detached when it had to fetch by sha): shallow
 * (`--depth=1`) by default, full history with `full`.
 * - `dir/.git` exists at `sha`            → cached (no network); with `full` and a shallow
 *                                           checkout: fetch --unshallow → updated
 * - `dir/.git` exists at another commit   → (with `full`: fetch --unshallow first), fetch <sha>
 *                                           (--depth=1 only while the checkout is shallow),
 *                                           checkout --force --detach → updated
 * - otherwise                             → clone [--depth=1] --branch <defaultBranch>; if the
 *                                           branch moved past `sha`, fetch + checkout `sha` → cloned
 * An existing full checkout is never made shallow (it is a superset of a shallow
 * request), and nothing is unshallowed unless `full` is set. Throws if `dir` exists
 * but is not a git checkout (never deletes it).
 */
export async function ensureClone(opts: EnsureCloneOptions): Promise<EnsureCloneResult> {
  // The sha may come from a lockfile: never let it reach argv as an option.
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(opts.sha)) throw new Error(`sentei: ${opts.dir}: invalid commit sha ${JSON.stringify(opts.sha)}`);
  const run = opts.runGit ?? git;
  const cwd = opts.dir;
  // LFS: a smudge filter (if git-lfs is installed) would download every LFS object
  // at checkout; analysis never needs them, and hardware repos can hold gigabytes.
  const env = { ...authEnv(opts.cloneUrl, opts.token), GIT_LFS_SKIP_SMUDGE: '1' };
  const head = async (): Promise<string> => (await run(['rev-parse', 'HEAD'], { cwd })).trim();
  const shallowNow = async (): Promise<boolean> => (await run(['rev-parse', '--is-shallow-repository'], { cwd })).trim() === 'true';
  /** Fetch `sha` (whole history when the checkout is full; skipped when a full checkout has it) and check it out. */
  const pin = async (full: boolean): Promise<void> => {
    let present = false;
    if (full) {
      try {
        await run(['cat-file', '-e', `${opts.sha}^{commit}`], { cwd });
        present = true;
      } catch {
        present = false;
      }
    }
    if (!present) await run(['fetch', ...(full ? [] : ['--depth=1']), '--no-tags', 'origin', opts.sha], { cwd, env });
    await run(['checkout', '--force', '--detach', opts.sha], { cwd, env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  };
  const verify = async (): Promise<void> => {
    const h = await head();
    if (h !== opts.sha) throw new Error(`sentei: ${opts.dir}: HEAD is ${h} after checkout, expected ${opts.sha}`);
  };

  if (existsSync(join(opts.dir, '.git'))) {
    let full = !(await shallowNow());
    const atSha = (await head()) === opts.sha;
    if (opts.full === true && !full) {
      opts.log?.(`${opts.dir}: shallow checkout, fetching full history (clone mode full)`);
      await run(['fetch', '--unshallow', '--no-tags', 'origin'], { cwd, env });
      full = true;
      if (atSha) return { status: 'updated', full };
    } else if (atSha) {
      return { status: 'cached', full };
    }
    opts.log?.(`${opts.dir}: fetching ${opts.sha}`);
    await pin(full);
    await verify();
    return { status: 'updated', full };
  }
  if (existsSync(opts.dir)) throw new Error(`sentei: ${opts.dir} exists but is not a git checkout; move it away and rerun`);

  const full = opts.full === true;
  await run(['clone', ...(full ? [] : ['--depth=1']), '--single-branch', '--branch', opts.defaultBranch, '--no-tags', '--', opts.cloneUrl, opts.dir], { env });
  if ((await head()) !== opts.sha) {
    opts.log?.(`${opts.dir}: ${opts.defaultBranch} moved since listing, fetching pinned ${opts.sha}`);
    await pin(full);
  }
  await verify();
  return { status: 'cloned', full };
}
