// `blame` stage core (PLAN.md §6.4): sets symbols.first_seen_sha / first_seen_at for
// exported symbols from `git blame` of the definition line, which feeds the §6.5 age
// rule (analyze.sql `symbol_age_ok`). A symbol we cannot date keeps NULL, and NULL
// fails closed: it never passes the age rule.
//
// CAVEAT (§6.4): blame gives the commit that LAST EDITED the definition line, not the
// commit that created the symbol. A rename or reformat of that line makes the symbol
// look younger than it is — the safe direction for the age rule (younger ⇒ less likely
// a candidate), but the report should say "last touched", not "created". Follow-up:
// `git log -S<name> --reverse` for a creation estimate on candidates only.
//
// Per repo (discover.json `localPath` with a `.git`):
//   1. `git rev-parse --is-shallow-repository`; if `true`,
//      `git fetch --unshallow --filter=blob:none` (fallback: `git fetch --unshallow`;
//      if both fail the repo is skipped and its symbols stay NULL).
//   2. `git rev-parse --verify <headSha|HEAD>^{commit}` → the sha everything is keyed by.
//   3. per file holding a target symbol: ONE `git blame --porcelain <sha> -- <file>`.
// Cache: <workDir>/blame/<repo slug>.json = { sha, files: { file: { line: { sha, authorTime } } } }
// (line = 1-based blame line). Entries are only trusted when the cache sha equals the
// repo's current sha; a file is re-blamed when any of its target lines is missing.
// All git runs go through execFile (never a shell) with GIT_TERMINAL_PROMPT=0.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { requireIngested } from './analyze.ts';

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
  /** Parallel `git blame` processes per repo (default 8). */
  concurrency?: number;
}

export interface BlameCounts {
  /** Target symbols (exported, or candidates with only='candidates'). */
  symbols: number;
  /** Symbols dated from a fresh `git blame` run this time. */
  blamed: number;
  /** Repos skipped (no .git, unshallow failed, sha unresolvable, not in discover.json). */
  skippedRepos: number;
  /** Symbols dated from the cache. */
  cached: number;
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

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(`git ${args.join(' ')}: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

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

/** Make the checkout non-shallow; false (after logging) if that is impossible. */
async function ensureFullHistory(dir: string, repo: string, log: (l: string) => void): Promise<boolean> {
  let shallow: string;
  try {
    shallow = (await git(dir, ['rev-parse', '--is-shallow-repository'])).trim();
  } catch (e) {
    log(`[blame] ${repo}: ${(e as Error).message}; skipping`);
    return false;
  }
  if (shallow !== 'true') return true;
  log(`[blame] ${repo}: shallow clone; fetching history`);
  try {
    await git(dir, ['fetch', '--unshallow', '--filter=blob:none']);
    return true;
  } catch (e) {
    log(`[blame] ${repo}: ${(e as Error).message}; retrying without --filter`);
  }
  try {
    await git(dir, ['fetch', '--unshallow']);
    return true;
  } catch (e) {
    log(`[blame] ${repo}: ${(e as Error).message}; skipping (ages unknown)`);
    return false;
  }
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
  const counts: BlameCounts = { symbols: targets.length, blamed: 0, skippedRepos: 0, cached: 0 };
  let noLine = 0;
  let undated = 0;

  for (const [repo, files] of byRepo) {
    const d = discoverByRepo.get(repo);
    if (!d) {
      log(`[blame] ${repo}: not in discover.json; ages unknown`);
      counts.skippedRepos++;
      continue;
    }
    const dir = d.localPath;
    if (!existsSync(join(dir, '.git'))) {
      log(`[blame] ${repo}: no git history; ages unknown`);
      counts.skippedRepos++;
      continue;
    }
    if (!(await ensureFullHistory(dir, repo, log))) {
      counts.skippedRepos++;
      continue;
    }
    let sha: string;
    try {
      sha = (await git(dir, ['rev-parse', '--verify', `${d.headSha ?? 'HEAD'}^{commit}`])).trim();
    } catch (e) {
      log(`[blame] ${repo}: ${(e as Error).message}; skipping (ages unknown)`);
      counts.skippedRepos++;
      continue;
    }

    const cachePath = join(cacheDir, `${repoSlug(repo)}.json`);
    const old = readCache(cachePath);
    const cache: BlameCache = { sha, files: old && old.sha === sha ? old.files : {} };

    const toBlame: Array<[string, Target[]]> = [];
    for (const [file, list] of files) {
      const withLine = list.filter((t) => t.line !== null);
      noLine += list.length - withLine.length;
      if (withLine.length === 0) continue;
      const entry = cache.files[file];
      if (entry && withLine.every((t) => entry[String(t.line! + 1)])) {
        for (const t of withLine) results.set(t.symbolId, entry[String(t.line! + 1)]!);
        counts.cached += withLine.length;
      } else {
        toBlame.push([file, withLine]);
      }
    }

    await pool(toBlame, concurrency, async ([file, list]) => {
      let lines: Map<number, BlameLine>;
      try {
        lines = parseBlamePorcelain(await git(dir, ['blame', '--porcelain', sha, '--', file]));
      } catch (e) {
        log(`[blame] ${repo}: ${(e as Error).message}; ages unknown for ${list.length} symbol(s)`);
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
  }

  // Every target is reset first so a symbol we could not date this run is NULL (fails
  // closed) rather than keeping a stale age from an earlier sha.
  const reset = db.prepare('UPDATE symbols SET first_seen_sha = NULL, first_seen_at = NULL WHERE symbol_id = ?');
  const set = db.prepare('UPDATE symbols SET first_seen_sha = ?, first_seen_at = ? WHERE symbol_id = ?');
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  log(
    `[blame] ${counts.symbols} symbol(s): ${counts.blamed} blamed, ${counts.cached} cached, ` +
      `${undated} undated${noLine ? ` (${noLine} without a line)` : ''}; ${counts.skippedRepos} repo(s) skipped`,
  );
  return counts;
}
