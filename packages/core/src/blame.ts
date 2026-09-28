// `blame` stage core (PLAN.md §6.4): sets symbols.first_seen_sha / first_seen_at for
// exported symbols from `git blame` of the definition line, which feeds the §6.5 age
// rule (analyze.sql `symbol_age_ok`). A symbol we cannot date keeps NULL.
//
// Budro's decision of 2026-09-27 (DESIGN.md Phase 3): blame runs ONLY on checkouts
// with full history, and never unshallows (that fetch cost dart-lang most of 1280 s).
// A shallow repo is skipped with one log line; its symbols stay NULL, and symbol_age_ok
// treats an unknown age as old enough. Full history is opt-in at clone time
// (`repos.clone: "full"`, `--full-clone`). Every repo's history ('full' | 'shallow' |
// 'none') goes to the repo_history table, from which ageCoverage / minAgeWarning say
// how many repos minAgeDays actually applies to (blame, analyze and report print it).
//
// CAVEAT (§6.4): blame gives the commit that LAST EDITED the definition line, not the
// commit that created the symbol. A rename or reformat of that line makes the symbol
// look younger than it is — the safe direction for the age rule (younger ⇒ less likely
// a candidate), but the report should say "last touched", not "created". Follow-up:
// `git log -S<name> --reverse` for a creation estimate on candidates only.
//
// Per repo (discover.json `localPath` with a `.git`):
//   1. `git rev-parse --is-shallow-repository`: anything but `false` → not blamed
//      (`true`: shallow; an error or odd output: history 'none');
//   2. if the cache is for `git rev-parse <headSha|HEAD>` and already holds every target
//      line, use it and stop: no blame, no network;
//   3. `git rev-parse --verify <headSha|HEAD>^{commit}` → the sha everything is keyed by.
//   4. per file holding a target symbol: ONE `git blame --porcelain <sha> -- <file>`.
// Cache: <workDir>/blame/<repo slug>.json = { sha, files: { file: { line: { sha, authorTime } } } }
// (line = 1-based blame line). Entries are only trusted when the cache sha equals the
// repo's current sha; a file is re-blamed when any of its target lines is missing.
// All git runs go through execFile (never a shell) with GIT_TERMINAL_PROMPT=0.
// Repos run in parallel (`repoConcurrency`, default 8: --clone-concurrency), and the
// `git blame` processes of all repos share one pool of `concurrency` (default 8).
// Results do not depend on the order: every repo writes its own cache and its own
// symbols. Log lines of different repos may interleave.
// An https origin gets the clone token (git.ts authEnv: an Authorization header in
// GIT_CONFIG_* env vars, never argv, logs or .git/config) for the promisor blob
// fetches of `git blame` in a partial clone, so private repos work like clones.
// A partial (`--filter=blob:none`) clone fetches blobs from its promisor remote during
// `git blame`; when that fetch fails (no network) the file's symbols stay NULL, and the
// repo gets one `warning:` line with the count at the end (NETWORK_ERROR_RE), counted
// as `(N network?)` in the summary line.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { requireIngested } from './analyze.ts';
import { authEnv } from './git.ts';
import { findToken } from './github.ts';

/** The part of work/discover.json (DiscoverModel) blame reads. */
export interface BlameDiscoverInput {
  repos: Array<{ repo: string; localPath: string; headSha: string | null }>;
}

export interface RunBlameOptions {
  db: DatabaseSync;
  discover: BlameDiscoverInput;
  /** Work dir; the cache lives in <workDir>/blame/. */
  workDir: string;
  log: (line: string) => void;
  /**
   * 'candidates': only exported symbols with a needs_review / unexport_candidate /
   * deletion_candidate finding (a cheap re-run). Default: every exported symbol.
   */
  only?: 'all' | 'candidates';
  /** Parallel `git blame` processes, all repos together (default 8). */
  concurrency?: number;
  /** Repos blamed at once (default 8; the CLI passes --clone-concurrency). */
  repoConcurrency?: number;
  /**
   * The GitHub token for fetches from an https origin (a partial clone's blob fetches
   * during `git blame`); called at most once, and only when a full repo needs blaming.
   * Default: findToken (GITHUB_TOKEN, GH_TOKEN, `gh auth token`). Never logged.
   */
  token?: () => Promise<string | null>;
  /** Tests only: runs `git <args>` in `cwd` with extra env; resolves with stdout. */
  runGit?: BlameGitRunner;
}

/** How blame runs git (execFile by default). Rejects with git's stderr in the message. */
export type BlameGitRunner = (cwd: string, args: string[], env: Record<string, string>) => Promise<string>;

export interface BlameCounts {
  /** Target symbols (exported, or candidates with only='candidates'). */
  symbols: number;
  /** Symbols dated from a fresh `git blame` run this time. */
  blamed: number;
  /** Repos with target symbols skipped (no .git, git failed, sha unresolvable, not in discover.json). */
  skippedRepos: number;
  /** Symbols dated from the cache. */
  cached: number;
  /** Repos not blamed because the checkout is shallow (every analysed repo, with or without targets). */
  shallowRepos: number;
}

export interface BlameLine {
  sha: string;
  /** Epoch seconds (author-time). */
  authorTime: number;
}

export interface BlameCache {
  sha: string;
  files: Record<string, Record<string, BlameLine>>;
}

/** git stderr of a blob / history fetch that failed for lack of a remote (network). */
const NETWORK_ERROR_RE = /promisor remote|could not read from remote|unable to access|could not resolve host|connection (?:refused|timed out)|network is unreachable/i;

const HEADER_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;

/**
 * Parse `git blame --porcelain` output into final (1-based) line → { sha, authorTime }.
 * Every line gets a header `<sha> <orig> <final> [<count>]`; the metadata block
 * (author-time etc.) only follows the FIRST header of each commit, so author-time is
 * remembered per sha. The content line starts with a TAB and ends a record.
 */
export function parseBlamePorcelain(out: string): Map<number, BlameLine> {
  const timeBySha = new Map<string, number>();
  const shaByLine = new Map<number, string>();
  let cur: string | null = null;
  for (const line of out.split('\n')) {
    if (cur === null) {
      const m = HEADER_RE.exec(line);
      if (m) {
        cur = m[1]!;
        shaByLine.set(Number(m[3]), cur);
      }
      continue;
    }
    if (line.startsWith('\t')) {
      cur = null;
      continue;
    }
    if (line.startsWith('author-time ')) timeBySha.set(cur, Number(line.slice('author-time '.length)));
  }
  const res = new Map<number, BlameLine>();
  for (const [n, sha] of shaByLine) {
    const t = timeBySha.get(sha);
    if (t !== undefined && Number.isFinite(t)) res.set(n, { sha, authorTime: t });
  }
  return res;
}

class GitError extends Error {}

const execGit: BlameGitRunner = (cwd, args, extraEnv) => {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        // Never echo env (it may carry an auth header); argv never carries secrets.
        if (err) reject(new GitError(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
};

function repoSlug(repo: string): string {
  return repo.replaceAll('/', '__');
}

function readCache(path: string): BlameCache | null {
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as BlameCache;
    if (typeof c?.sha === 'string' && c.files && typeof c.files === 'object') return c;
  } catch {
    // corrupt cache: ignore, re-blame
  }
  return null;
}

function writeCache(path: string, cache: BlameCache): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(tmp, path);
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) await fn(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

/** At most `n` calls of the returned function run at once; the rest wait in order. */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= Math.max(1, n)) await new Promise<void>((res) => waiting.push(res));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

type Git = (dir: string, args: string[]) => Promise<string>;

/** What `blame` found in a repo's checkout (the repo_history table). */
export type RepoHistory = 'full' | 'shallow' | 'none';

/** The --full-clone hint of every shallow-repo message. */
export const FULL_CLONE_HINT = 'pass --full-clone (repos.clone: "full") to date symbols';

/**
 * How much of the org the age rule applies to: per analysed repo that exports symbols
 * (a repo without exports, e.g. an app, has nothing for minAgeDays to gate), whether
 * blame dated it. A repo counts as `full` only when repo_history says so AND at least
 * one of its exported symbols is dated: a full repo whose symbols are all undated was
 * re-ingested without re-running blame (ingest resets every age), which is
 * `notBlamed`, like a repo with no repo_history row.
 */
export interface AgeCoverage {
  /** Analysed repos with at least one exported symbol. */
  repos: number;
  /** Blamed on full history: minAgeDays applies. */
  full: number;
  /** Shallow clones: never blamed, ages unknown. */
  shallow: number;
  /** No git history (plain directory, not in discover.json, git failed). */
  noHistory: number;
  /** Blame has not run since discover / ingest. */
  notBlamed: number;
  /** Exported symbols: dated, and undated in shallow repos / elsewhere. */
  symbols: { exported: number; dated: number; undatedShallow: number; undatedOther: number };
}

export function ageCoverage(db: DatabaseSync): AgeCoverage {
  const rows = db.prepare(`
    SELECT r.repo, h.history, count(s.symbol_id) AS exported, count(s.first_seen_at) AS dated
    FROM repos r
    LEFT JOIN repo_history h ON h.repo = r.repo
    LEFT JOIN packages p ON p.repo = r.repo
    LEFT JOIN symbols s ON s.package_id = p.package_id AND s.is_exported = 1
    GROUP BY r.repo`).all() as Array<{ repo: string; history: RepoHistory | null; exported: number; dated: number }>;
  const cov: AgeCoverage = {
    repos: 0, full: 0, shallow: 0, noHistory: 0, notBlamed: 0,
    symbols: { exported: 0, dated: 0, undatedShallow: 0, undatedOther: 0 },
  };
  for (const r of rows) {
    if (r.exported === 0) continue;
    cov.repos++;
    cov.symbols.exported += r.exported;
    cov.symbols.dated += r.dated;
    if (r.history === 'shallow') {
      cov.shallow++;
      cov.symbols.undatedShallow += r.exported - r.dated;
      continue;
    }
    cov.symbols.undatedOther += r.exported - r.dated;
    if (r.history === 'none') cov.noHistory++;
    else if (r.history === 'full' && r.dated > 0) cov.full++;
    else cov.notBlamed++;
  }
  return cov;
}

/**
 * The warning when minAgeDays > 0 cannot apply to every repo (DESIGN.md Phase 3), e.g.
 * `minAgeDays=180 has no effect on 30 of 33 repos (shallow clones: symbol ages unknown,
 * treated as old enough); pass --full-clone (repos.clone: "full") to date symbols`.
 * null when minAgeDays is 0 / missing or every repo is dated.
 */
export function minAgeWarning(cov: AgeCoverage, minAgeDays: number | null): string | null {
  if (minAgeDays === null || !(minAgeDays > 0)) return null;
  const undated = cov.repos - cov.full;
  if (undated === 0) return null;
  const kinds: string[] = [];
  if (cov.shallow > 0) kinds.push(cov.shallow === undated ? 'shallow clones' : `${cov.shallow} shallow clone(s)`);
  if (cov.noHistory > 0) kinds.push(cov.noHistory === undated ? 'no git history' : `${cov.noHistory} without git history`);
  if (cov.notBlamed > 0) kinds.push(cov.notBlamed === undated ? 'not blamed since the last discover/ingest: run blame' : `${cov.notBlamed} not blamed since the last discover/ingest: run blame`);
  return `minAgeDays=${minAgeDays} has no effect on ${undated} of ${cov.repos} repos (${kinds.join(', ')}: symbol ages unknown, treated as old enough)`
    + (cov.shallow > 0 ? `; ${FULL_CLONE_HINT}` : '');
}

/** The policy's minAgeDays (null when missing or not a number). */
export function policyMinAgeDays(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM policy WHERE key = 'minAgeDays'").get() as { value: string } | undefined;
  if (row === undefined) return null;
  const v = JSON.parse(row.value) as unknown;
  return typeof v === 'number' ? v : null;
}

interface Target {
  symbolId: number;
  repo: string;
  file: string;
  /** 0-based, as stored in the DB. */
  line: number | null;
}

export async function runBlame(opts: RunBlameOptions): Promise<BlameCounts> {
  const { db, discover, workDir, log } = opts;
  const concurrency = opts.concurrency ?? 8;
  const repoConcurrency = opts.repoConcurrency ?? 8;
  const runGit = opts.runGit ?? execGit;
  const blameSlot = limiter(concurrency);
  let tokenOnce: Promise<string | null> | undefined;
  const token = (): Promise<string | null> => (tokenOnce ??= (opts.token ?? (() => findToken()))().catch(() => null));
  /** The auth env for fetches of the repo at `dir`: only for an https origin, and only with a token. */
  const fetchEnv = async (dir: string): Promise<Record<string, string>> => {
    let url: string;
    try {
      url = (await runGit(dir, ['remote', 'get-url', 'origin'], {})).trim();
    } catch {
      return {};
    }
    if (!url.startsWith('https://')) return {};
    return authEnv(url, await token());
  };
  const candidatesOnly = opts.only === 'candidates';
  requireIngested(db, 'blame');

  const targets = db
    .prepare(
      `SELECT s.symbol_id AS symbolId, p.repo AS repo, s.file AS file, s.line AS line
       FROM symbols s JOIN packages p ON p.package_id = s.package_id
       WHERE s.is_exported = 1
         AND (? = 0 OR EXISTS (SELECT 1 FROM findings f WHERE f.symbol_id = s.symbol_id
               AND f.verdict IN ('needs_review', 'unexport_candidate', 'deletion_candidate')))
       ORDER BY p.repo, s.file, s.line, s.symbol_id`,
    )
    .all(candidatesOnly ? 1 : 0) as unknown as Target[];

  const byRepo = new Map<string, Map<string, Target[]>>();
  for (const t of targets) {
    let files = byRepo.get(t.repo);
    if (!files) byRepo.set(t.repo, (files = new Map()));
    let list = files.get(t.file);
    if (!list) files.set(t.file, (list = []));
    list.push(t);
  }

  const discoverByRepo = new Map(discover.repos.map((r) => [r.repo, r]));
  const cacheDir = join(workDir, 'blame');
  const results = new Map<number, BlameLine>();
  const counts: BlameCounts = { symbols: targets.length, blamed: 0, skippedRepos: 0, cached: 0, shallowRepos: 0 };
  let noLine = 0;
  let undated = 0;
  let shallowUndated = 0;
  /** Per repo: symbols left undated because a blame's promisor fetch failed. */
  const networkUndated = new Map<string, number>();
  /** Every analysed repo's history, for repo_history. */
  const history = new Map<string, RepoHistory>();
  const allRepos = [...new Set([
    ...(db.prepare('SELECT repo FROM repos ORDER BY repo').all() as Array<{ repo: string }>).map((r) => r.repo),
    ...byRepo.keys(),
  ])];

  await pool(allRepos, repoConcurrency, async (repo) => {
    const files = byRepo.get(repo) ?? new Map<string, Target[]>();
    const nTargets = [...files.values()].reduce((n, l) => n + l.length, 0);
    const skip = (why: string): void => {
      history.set(repo, 'none');
      if (nTargets === 0) return;
      log(`[blame] ${repo}: ${why}`);
      counts.skippedRepos++;
    };
    const d = discoverByRepo.get(repo);
    if (!d) return skip('not in discover.json; ages unknown');
    const dir = d.localPath;
    if (!existsSync(join(dir, '.git'))) return skip('no git history; ages unknown');
    // Local git (rev-parse) runs without auth; the env is set up when a fetch may happen.
    let env: Record<string, string> = {};
    const git: Git = (cwd, args) => runGit(cwd, args, env);
    // Only a checkout with full history is blamed; a shallow one is never unshallowed
    // (Budro, 2026-09-27): full history is opt-in at clone time.
    let shallowOut: string;
    try {
      shallowOut = (await git(dir, ['rev-parse', '--is-shallow-repository'])).trim();
    } catch (e) {
      return skip(`${(e as Error).message}; ages unknown`);
    }
    if (shallowOut === 'true') {
      history.set(repo, 'shallow');
      counts.shallowRepos++;
      shallowUndated += nTargets;
      log(`[blame] ${repo}: shallow clone, not blamed: ${nTargets} symbol age(s) unknown, treated as old enough (${FULL_CLONE_HINT})`);
      return;
    }
    if (shallowOut !== 'false') return skip(`git rev-parse --is-shallow-repository printed ${JSON.stringify(shallowOut)}; ages unknown`);
    history.set(repo, 'full');
    if (nTargets === 0) return;
    const revParse = async (): Promise<string> =>
      (await git(dir, ['rev-parse', '--verify', `${d.headSha ?? 'HEAD'}^{commit}`])).trim();
    const cachePath = join(cacheDir, `${repoSlug(repo)}.json`);
    const old = readCache(cachePath);
    /** Split this repo's targets into cache hits (recorded) and files to blame, for `cache`. */
    const plan = (cache: BlameCache): { toBlame: Array<[string, Target[]]>; hits: Array<[Target, BlameLine]>; noLine: number } => {
      const toBlame: Array<[string, Target[]]> = [];
      const hits: Array<[Target, BlameLine]> = [];
      let missingLine = 0;
      for (const [file, list] of files) {
        const withLine = list.filter((t) => t.line !== null);
        missingLine += list.length - withLine.length;
        if (withLine.length === 0) continue;
        const entry = cache.files[file];
        if (entry && withLine.every((t) => entry[String(t.line! + 1)])) {
          for (const t of withLine) hits.push([t, entry[String(t.line! + 1)]!]);
        } else {
          toBlame.push([file, withLine]);
        }
      }
      return { toBlame, hits, noLine: missingLine };
    };

    // Cache first: when the cache is for the current sha and holds every target line,
    // nothing is blamed (and no token is looked up).
    let sha: string | null = null;
    if (old !== null) {
      try {
        sha = await revParse();
      } catch {
        sha = null;
      }
    }
    let cache: BlameCache;
    let work = sha !== null && old!.sha === sha ? plan(old!) : null;
    if (work !== null && work.toBlame.length === 0) {
      cache = old!;
    } else {
      try {
        sha = await revParse();
      } catch (e) {
        return skip(`${(e as Error).message}; skipping (ages unknown)`);
      }
      // Blame of a partial (blobless) clone fetches blobs from its promisor remote.
      env = await fetchEnv(dir);
      cache = { sha, files: old && old.sha === sha ? old.files : {} };
      work = plan(cache);
    }
    noLine += work.noLine;
    for (const [t, b] of work.hits) results.set(t.symbolId, b);
    counts.cached += work.hits.length;
    const toBlame = work.toBlame;

    await pool(toBlame, concurrency, async ([file, list]) => {
      let lines: Map<number, BlameLine>;
      try {
        lines = parseBlamePorcelain(await blameSlot(() => git(dir, ['blame', '--porcelain', cache.sha, '--', file])));
      } catch (e) {
        const msg = (e as Error).message;
        log(`[blame] ${repo}: ${msg}; ages unknown for ${list.length} symbol(s)`);
        if (NETWORK_ERROR_RE.test(msg)) networkUndated.set(repo, (networkUndated.get(repo) ?? 0) + list.length);
        return;
      }
      const entry: Record<string, BlameLine> = { ...(cache.files[file] ?? {}) };
      for (const t of list) {
        const key = t.line! + 1;
        const b = lines.get(key);
        if (!b) {
          log(`[blame] warning: ${repo}:${file}:${key} is beyond the blamed file; age unknown (symbol ${t.symbolId})`);
          continue;
        }
        entry[String(key)] = b;
        results.set(t.symbolId, b);
        counts.blamed++;
      }
      cache.files[file] = entry;
    });

    mkdirSync(cacheDir, { recursive: true });
    writeCache(cachePath, cache);
  });

  // Every target is reset first so a symbol we could not date this run is NULL (age
  // unknown) rather than keeping a stale age from an earlier sha.
  const reset = db.prepare('UPDATE symbols SET first_seen_sha = NULL, first_seen_at = NULL WHERE symbol_id = ?');
  const set = db.prepare('UPDATE symbols SET first_seen_sha = ?, first_seen_at = ? WHERE symbol_id = ?');
  const knownRepos = new Set((db.prepare('SELECT repo FROM repos').all() as Array<{ repo: string }>).map((r) => r.repo));
  db.exec('BEGIN');
  try {
    for (const t of targets) {
      const b = results.get(t.symbolId);
      if (b) set.run(b.sha, b.authorTime, t.symbolId);
      else {
        reset.run(t.symbolId);
        undated++;
      }
    }
    db.exec('DELETE FROM repo_history');
    const insHistory = db.prepare('INSERT INTO repo_history (repo, history) VALUES (?, ?)');
    for (const [repo, h] of [...history].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (knownRepos.has(repo)) insHistory.run(repo, h);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  let network = 0;
  for (const [repo, n] of networkUndated) {
    network += n;
    log(`[blame] warning: ${repo}: ${n} symbol(s) undated: git could not fetch file contents from the promisor remote (network?); ages unknown`);
  }
  const notes = [
    shallowUndated ? `${shallowUndated} shallow` : '', noLine ? `${noLine} without a line` : '', network ? `${network} network?` : '',
  ].filter(Boolean);
  // Shallow repos are skipped too (never blamed): counted here, named in the parenthesis
  // (batch B printed "0 repo(s) skipped" while every repo was a skipped shallow clone).
  const skipped = counts.skippedRepos + counts.shallowRepos;
  log(
    `[blame] ${counts.symbols} symbol(s): ${counts.blamed} blamed, ${counts.cached} cached, ` +
      `${undated} undated${notes.length ? ` (${notes.join(', ')})` : ''}; ${skipped} repo(s) skipped` +
      (counts.shallowRepos > 0 ? ` (${counts.shallowRepos} shallow)` : ''),
  );
  if (counts.shallowRepos > 0) {
    log(`[blame] ${counts.shallowRepos} of ${allRepos.length} repo(s) are shallow clones: not blamed (never unshallowed), `
      + `their ${shallowUndated} symbol(s) have unknown ages, treated as old enough; ${FULL_CLONE_HINT}`);
  }
  const warning = minAgeWarning(ageCoverage(db), policyMinAgeDays(db));
  if (warning !== null) log(`[blame] warn: ${warning}`);
  return counts;
}
