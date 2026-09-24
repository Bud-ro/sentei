// `analyze` stage core (PLAN.md §6.3 step 6, §6.5): reachability + verdicts.
//
// All policy is SQL in packages/core/sql/analyze.sql (views, loaded verbatim); this
// module only sets the run parameters and copies the views into `findings` inside one
// transaction. The findings triggers in schema.sql guard every insert; analyze never
// inserts `deletion_candidate` (that needs witness_ok, which the witness stage writes):
// a would-be deletion is `needs_review` with reason `witness_pending`.
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

const ANALYZE_URL = new URL('../sql/analyze.sql', import.meta.url);

/** The analysis views, verbatim from packages/core/sql/analyze.sql. */
export function analyzeSql(): string {
  return readFileSync(ANALYZE_URL, 'utf8');
}

export interface AnalyzeOptions {
  db: DatabaseSync;
  /** "Now" for the minAgeDays rule, epoch seconds. Default: the current time. */
  now?: number;
  log: (line: string) => void;
}

export interface AnalyzeCounts {
  /** Findings inserted, by verdict (verdicts with no rows are absent). */
  byVerdict: Record<string, number>;
  /** Symbols reachable from exports / entry files (symbols.is_entry_reachable = 1). */
  reachable: number;
  total: number;
}

/**
 * Recompute every finding for the whole org in one transaction: delete findings and
 * witness_ok, set symbols.is_entry_reachable, insert the `verdicts` rows, then the
 * `private_dead` rows. A trigger firing here is a bug in the views and is not caught.
 */
export function analyzeOrg(opts: AnalyzeOptions): AnalyzeCounts {
  const { db, log } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now)) throw new Error(`sentei: analyze: now must be integer epoch seconds, got ${now}`);

  const counts: AnalyzeCounts = { byVerdict: {}, reachable: 0, total: 0 };
  db.exec('BEGIN');
  try {
    db.exec(analyzeSql());
    db.exec('DELETE FROM run_params');
    db.prepare("INSERT INTO run_params (key, value) VALUES ('now', ?)").run(String(now));

    db.exec('DELETE FROM findings');
    db.exec('DELETE FROM witness_ok');

    db.exec('UPDATE symbols SET is_entry_reachable = (symbol_id IN (SELECT symbol_id FROM reachable))');
    db.exec(`INSERT INTO findings (symbol_id, verdict, reasons, blocked_by)
      SELECT symbol_id, verdict, reasons, blocked_by FROM verdicts`);
    db.exec(`INSERT INTO findings (symbol_id, verdict, reasons, blocked_by)
      SELECT symbol_id, verdict, reasons, blocked_by FROM private_dead`);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error(`sentei: foreign_key_check failed after analyze: ${JSON.stringify(violations)}`);

    for (const r of db.prepare('SELECT verdict, count(*) AS n FROM findings GROUP BY verdict ORDER BY verdict').all() as Array<{ verdict: string; n: number }>) {
      counts.byVerdict[r.verdict] = r.n;
      counts.total += r.n;
    }
    counts.reachable = (db.prepare('SELECT count(*) AS n FROM symbols WHERE is_entry_reachable = 1').get() as { n: number }).n;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const parts = Object.entries(counts.byVerdict).map(([v, n]) => `${v}=${n}`);
  log(`[analyze] findings=${counts.total}${parts.length > 0 ? ` ${parts.join(' ')}` : ''} reachable=${counts.reachable}`);
  return counts;
}
