// `witness` stage core (PLAN.md §9): a deliberately dumb, independent second opinion
// on every would-be deletion candidate. Plain `node:fs` + regex over the consumers'
// checkouts; shares no code with the indexer/ingest path on purpose.
//
// Input: `findings` rows with verdict 'needs_review' whose reasons contain
// 'witness_pending' (written by analyze). For each such symbol S of package P, every
// manifest-declared consumer C of P (package_deps.resolved_package_id = P) is searched:
//   1. files in C that import/require/re-export P (per-language regex, whole file);
//   2. in those files, S's name as a whole identifier (or, for `default`, a default
//      import of the matching module specifier).
// Any hit (or a consumer checkout we cannot read) → needs_review with
// `witness_mismatch:<consumer>:<file>:<line>` reasons. No hit → witness_ok row and a
// deletion_candidate (the schema triggers still guard that insert).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { matchGlob } from './glob.ts';

/** The part of work/discover.json (DiscoverModel) the witness reads. */
export interface WitnessDiscoverInput {
  repos: Array<{
    repo: string;
    localPath: string;
    packages: Array<{ packageId: string; path: string }>;
  }>;
}

export interface RunWitnessOptions {
  db: DatabaseSync;
  discover: WitnessDiscoverInput;
  /** Epoch seconds for witness_ok.checked_at; defaults to now. */
  now?: number;
  log: (line: string) => void;
}

export interface WitnessCounts {
  checked: number;
  passed: number;
  mismatched: number;
}

/** Max witness_mismatch reasons recorded per symbol. */
const MAX_HITS = 5;

const SKIP_DIRS = new Set(['node_modules', '.git', '.dart_tool', 'build', 'dist', 'vendor', 'third_party']);
const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.dart']);
/** Same globs analyze uses (PLAN.md §6.5), matched against repo-relative paths. */
const TEST_GLOBS = ['**/*.test.*', '**/*_test.dart', '**/test/**', '**/__tests__/**'];
const DOCS_GLOBS = ['**/docs/**'];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Regexes (global, whole-file) that find a module specifier of P; group 1 = `/subpath` or undefined. */
function mentionRegexes(manager: 'npm' | 'pub', name: string): RegExp[] {
  const p = escapeRe(name);
  if (manager === 'pub') return [new RegExp(`\\b(?:import|export)\\s+['"]package:${p}(/[^'"]*)['"]`, 'g')];
  const spec = `['"]${p}(/[^'"]*)?['"]`;
  return [
    new RegExp(`\\b(?:import|export)\\b[^;]*?\\bfrom\\s*${spec}`, 'gs'), // import … from / export … from
    new RegExp(`\\bimport\\s*${spec}`, 'g'), // side-effect import
    new RegExp(`\\brequire\\(\\s*${spec}`, 'g'),
    new RegExp(`\\bimport\\(\\s*${spec}`, 'g'),
  ];
}

/**
 * Regexes that bind P's *default* export; group 1 = `/subpath` or undefined. Default
 * import (optionally `type`, optionally followed by `, {…}`/`, * as x`), `{ default … }`
 * named import/re-export, CJS require, dynamic import.
 */
function defaultRegexes(name: string): RegExp[] {
  const p = escapeRe(name);
  const spec = `['"]${p}(/[^'"]*)?['"]`;
  return [
    new RegExp(`\\bimport\\s+(?:type\\s+)?[A-Za-z_$][\\w$]*\\s*(?:,[^;]*?)?\\bfrom\\s*${spec}`, 'gs'),
    new RegExp(`\\b(?:import|export)\\s*(?:type\\s*)?\\{[^}]*\\bdefault\\b[^}]*\\}\\s*from\\s*${spec}`, 'gs'),
    new RegExp(`\\brequire\\(\\s*${spec}\\s*\\)`, 'g'),
    new RegExp(`\\bimport\\(\\s*${spec}\\s*\\)`, 'g'),
  ];
}

/** 1-based line of a string offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

const stripExt = (f: string): string => basename(f, extname(f));

/**
 * Module names a default-import subpath may use for the file defining a `default`
 * symbol: its basename, plus the parent dir name for `…/index.*` (fail closed).
 */
function defaultModuleNames(file: string): Set<string> {
  const names = new Set([stripExt(file)]);
  if (stripExt(file) === 'index') {
    const parent = basename(dirname(file));
    if (parent && parent !== '.') names.add(parent);
  }
  return names;
}

interface Hit {
  consumer: string;
  /** Repo-relative POSIX path, or null when the checkout is missing. */
  file: string | null;
  line: number;
}

interface ConsumerLoc {
  repoDir: string;
  /** Package dir, repo-relative POSIX; '.' for the root. */
  pkgPath: string;
  /** Other org package dirs in the same repo (repo-relative), skipped during the walk. */
  nestedPaths: Set<string>;
}

interface PendingRow {
  symbol_id: number;
  reasons: string;
  blocked_by: string;
  name: string;
  file: string;
  package_id: string;
  manager: 'npm' | 'pub';
  pkg_name: string;
}

function policyBool(db: DatabaseSync, key: string): boolean {
  const row = db.prepare("SELECT json_extract(value, '$') AS v FROM policy WHERE key = ?").get(key) as
    | { v: unknown }
    | undefined;
  return row?.v === 1 || row?.v === true;
}

/** Run the text witness over every witness_pending finding, in one transaction. */
export function runWitness(opts: RunWitnessOptions): WitnessCounts {
  const { db, discover, log } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const locs = new Map<string, ConsumerLoc>();
  for (const r of discover.repos) {
    for (const p of r.packages) {
      locs.set(p.packageId, {
        repoDir: r.localPath,
        pkgPath: p.path,
        nestedPaths: new Set(r.packages.filter((q) => q.packageId !== p.packageId).map((q) => q.path)),
      });
    }
  }

  const countTests = policyBool(db, 'countTestsAsConsumers');
  const countDocs = policyBool(db, 'countDocsAsConsumers');
  const excluded = (relFile: string): boolean =>
    (!countTests && TEST_GLOBS.some((g) => matchGlob(g, relFile))) ||
    (!countDocs && DOCS_GLOBS.some((g) => matchGlob(g, relFile)));

  /** Candidate code files of a consumer (repo-relative), or null if its checkout is missing. */
  const fileCache = new Map<string, string[] | null>();
  const consumerFiles = (consumer: string): string[] | null => {
    if (fileCache.has(consumer)) return fileCache.get(consumer)!;
    const loc = locs.get(consumer);
    let files: string[] | null = null;
    if (loc) {
      const root = loc.pkgPath === '.' ? loc.repoDir : join(loc.repoDir, loc.pkgPath);
      if (existsSync(root) && statSync(root).isDirectory()) {
        files = [];
        const walk = (rel: string): void => {
          const abs = rel === '.' ? loc.repoDir : join(loc.repoDir, rel);
          for (const e of readdirSync(abs, { withFileTypes: true })) {
            const childRel = rel === '.' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
              if (SKIP_DIRS.has(e.name) || loc.nestedPaths.has(childRel)) continue;
              walk(childRel);
            } else if (e.isFile() && CODE_EXTS.has(extname(e.name)) && !excluded(childRel)) {
              files!.push(childRel);
            }
          }
        };
        walk(loc.pkgPath);
        files.sort(cmp);
      }
    }
    fileCache.set(consumer, files);
    return files;
  };

  const textCache = new Map<string, string>();
  const readText = (consumer: string, rel: string): string => {
    const key = `${consumer}\0${rel}`;
    let t = textCache.get(key);
    if (t === undefined) {
      t = readFileSync(join(locs.get(consumer)!.repoDir, rel), 'utf8');
      textCache.set(key, t);
    }
    return t;
  };

  /** Files of C mentioning P (keyed C\0P). */
  const mentionCache = new Map<string, string[]>();
  const mentioning = (consumer: string, files: string[], manager: 'npm' | 'pub', pkgName: string): string[] => {
    const key = `${consumer}\0${manager}:${pkgName}`;
    let out = mentionCache.get(key);
    if (!out) {
      const res = mentionRegexes(manager, pkgName);
      out = files.filter((f) => {
        const text = readText(consumer, f);
        return res.some((re) => {
          re.lastIndex = 0;
          return re.test(text);
        });
      });
      mentionCache.set(key, out);
    }
    return out;
  };

  const findHits = (row: PendingRow, consumer: string): Hit[] => {
    const files = consumerFiles(consumer);
    if (files === null) return [{ consumer, file: null, line: 0 }];
    const hits: Hit[] = [];
    for (const f of mentioning(consumer, files, row.manager, row.pkg_name)) {
      const text = readText(consumer, f);
      if (row.name === 'default' && row.manager === 'npm') {
        const wanted = defaultModuleNames(row.file);
        const lines = new Set<number>();
        for (const re of defaultRegexes(row.pkg_name)) {
          re.lastIndex = 0;
          for (let m = re.exec(text); m; m = re.exec(text)) {
            const sub = m[1];
            const seg = sub === undefined ? undefined : stripExt(sub.split('/').filter(Boolean).pop() ?? '');
            if (sub === undefined || seg === '' || wanted.has(seg!)) lines.add(lineAt(text, m.index));
          }
        }
        for (const line of lines) hits.push({ consumer, file: f, line });
      } else {
        // `$` is an identifier char on the right; on the left only \w blocks a match, so a
        // Dart `'$name'` interpolation (and a JS `$name`, a harmless false positive) still hits.
        const lineRe = new RegExp(`(?<!\\w)${escapeRe(row.name)}(?![\\w$])`);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) if (lineRe.test(lines[i]!)) hits.push({ consumer, file: f, line: i + 1 });
      }
    }
    return hits;
  };

  const pending = db
    .prepare(
      `SELECT f.symbol_id, f.reasons, f.blocked_by, s.name, s.file, s.package_id,
              p.manager, p.name AS pkg_name
       FROM findings f
       JOIN symbols s ON s.symbol_id = f.symbol_id
       JOIN packages p ON p.package_id = s.package_id
       WHERE f.verdict = 'needs_review'
         AND EXISTS (SELECT 1 FROM json_each(f.reasons) WHERE value = 'witness_pending')
       ORDER BY f.symbol_id`,
    )
    .all() as unknown as PendingRow[];
  const consumersOf = db.prepare(
    `SELECT DISTINCT consumer_package_id AS c FROM package_deps
     WHERE resolved_package_id = ? ORDER BY consumer_package_id`,
  );
  const del = db.prepare("DELETE FROM findings WHERE symbol_id = ? AND verdict = 'needs_review'");
  const insFinding = db.prepare('INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, ?)');
  const insOk = db.prepare('INSERT OR REPLACE INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)');

  const counts: WitnessCounts = { checked: 0, passed: 0, mismatched: 0 };
  db.exec('BEGIN');
  try {
    for (const row of pending) {
      counts.checked += 1;
      const base = (JSON.parse(row.reasons) as string[]).filter((r) => r !== 'witness_pending');
      const consumers = (consumersOf.all(row.package_id) as Array<{ c: string }>).map((r) => r.c);
      const hits = consumers.flatMap((c) => findHits(row, c));
      del.run(row.symbol_id);
      if (hits.length > 0) {
        hits.sort((a, b) => cmp(a.consumer, b.consumer) || cmp(a.file ?? '', b.file ?? '') || a.line - b.line);
        const reasons = hits
          .slice(0, MAX_HITS)
          .map((h) => `witness_mismatch:${h.consumer}:${h.file === null ? 'checkout missing' : `${h.file}:${h.line}`}`);
        insFinding.run(row.symbol_id, 'needs_review', JSON.stringify([...base, ...reasons]), row.blocked_by);
        counts.mismatched += 1;
        log(`[witness] mismatch ${row.package_id}#${row.name} (${row.file}): ${reasons.join(', ')}${hits.length > MAX_HITS ? ` (+${hits.length - MAX_HITS} more)` : ''}`);
      } else {
        insOk.run(row.symbol_id, now);
        insFinding.run(row.symbol_id, 'deletion_candidate', JSON.stringify(base), row.blocked_by);
        counts.passed += 1;
      }
    }
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0) throw new Error(`sentei witness: foreign_key_check failed: ${JSON.stringify(fk.slice(0, 5))}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log(`[witness] checked ${counts.checked}: ${counts.passed} passed, ${counts.mismatched} mismatched`);
  return counts;
}
