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

/** Throws unless ingest has produced symbols (a stage run on an un-ingested DB would silently report nothing). */
export function requireIngested(db: DatabaseSync, stage: string): void {
  const row = db.prepare('SELECT EXISTS (SELECT 1 FROM symbols) AS n').get() as { n: number };
  if (row.n === 0) throw new Error(`sentei ${stage}: the database has no symbols; run ingest first`);
}

/**
 * Throws unless analyze has run on this DB since the last ingest (run_params
 * `analyzed_at`; ingest clears it). Zero findings after analyze is fine.
 */
export function requireAnalyzed(db: DatabaseSync, stage: string): void {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_params'").get();
  const marker = hasTable ? db.prepare("SELECT 1 FROM run_params WHERE key = 'analyzed_at'").get() : undefined;
  if (!marker) throw new Error(`sentei ${stage}: the database has not been analyzed; run analyze first`);
}

/**
 * The private-dead cascade (analyze.sql `private_dead`), recomputed from the CURRENT
 * `findings`: refill mat_reachable_after from `reachable_after` (its seeds exclude
 * candidate_symbols, which reads `findings`), delete every `private_dead` row and
 * re-insert from the view. analyzeOrg calls it after inserting the verdicts; runWitness
 * calls it after its updates, so a candidate the witness downgrades no longer unlocks
 * its helpers. The caller owns the transaction and must have loaded analyzeSql().
 * mat_reachable is filled by analyzeOrg; if it is empty (a DB analyzed before it
 * existed) it is filled here, so private_dead never reads an empty reachable set by
 * accident (fail closed).
 */
export function insertPrivateDead(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM mat_reachable LIMIT 1').get()) fillReachable(db);
  db.exec("DELETE FROM findings WHERE verdict = 'private_dead'");
  fillReachableAfter(db);
  db.exec(`INSERT INTO findings (symbol_id, verdict, reasons, blocked_by)
    SELECT symbol_id, verdict, reasons, blocked_by FROM private_dead`);
}

/** Max passes of reconcileDeadIslands (each pass is one reachable_after walk). */
const MAX_ISLAND_PASSES = 10;

/**
 * Dead islands that are no longer islands revert to unexport_candidate. A dead island
 * (reason `dead_island`) is an unexport_candidate whose internal users were all
 * candidates when analyze ran. When the witness downgrades such a user to needs_review
 * (witness_mismatch: it is not a candidate any more, so it is a seed again), the island
 * becomes reachable in the recomputed mat_reachable_after and is really an unexport:
 * pdfjs `DocumentInitParameters`, used only by `PDFJS`, stayed a deletion after `PDFJS`
 * was downgraded. Per pass: refill mat_reachable_after from the current `findings`;
 * every candidate finding (deletion_candidate, or needs_review + witness_pending) with
 * reason dead_island whose symbol is now in it is replaced by unexport_candidate with
 * reasons minus dead_island / witness_pending; a witness-mismatched dead island
 * (needs_review without witness_pending) stays needs_review and only loses the
 * dead_island reason (the witness saw the name somewhere: fail closed). Repeats until a
 * pass changes nothing, at most MAX_ISLAND_PASSES passes (a revert keeps the symbol a
 * candidate, so in practice one pass decides). A no-op right after analyze. The caller
 * owns the transaction, has loaded analyzeSql(), and must call insertPrivateDead after
 * (mat_reachable_after is left filled but the private_dead rows are stale).
 * Returns the number of findings changed.
 */
export function reconcileDeadIslands(db: DatabaseSync): number {
  const select = db.prepare(
    `SELECT f.symbol_id, f.verdict, f.reasons, f.blocked_by
     FROM findings f
     WHERE f.verdict IN ('deletion_candidate', 'needs_review')
       AND EXISTS (SELECT 1 FROM json_each(f.reasons) j WHERE j.value = 'dead_island')
       AND f.symbol_id IN (SELECT symbol_id FROM mat_reachable_after)
     ORDER BY f.symbol_id`,
  );
  const del = db.prepare('DELETE FROM findings WHERE symbol_id = ? AND verdict = ?');
  const ins = db.prepare('INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, ?)');
  let changed = 0;
  for (let pass = 0; pass < MAX_ISLAND_PASSES; pass += 1) {
    fillReachableAfter(db);
    const rows = select.all() as Array<{ symbol_id: number; verdict: string; reasons: string; blocked_by: string }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      const reasons = JSON.parse(r.reasons) as string[];
      const candidate = r.verdict === 'deletion_candidate' || reasons.includes('witness_pending');
      const kept = reasons.filter((x) => x !== 'dead_island' && (!candidate || x !== 'witness_pending'));
      del.run(r.symbol_id, r.verdict);
      ins.run(r.symbol_id, candidate ? 'unexport_candidate' : r.verdict, JSON.stringify(kept), r.blocked_by);
    }
    changed += rows.length;
  }
  return changed;
}

/** mat_reachable := the `reachable` view (seeds do not depend on findings). */
function fillReachable(db: DatabaseSync): void {
  db.exec('DELETE FROM mat_reachable');
  db.exec('INSERT INTO mat_reachable (symbol_id) SELECT symbol_id FROM reachable');
}

/** mat_reachable_after := the `reachable_after` view (seeds: before minus candidate_symbols, i.e. current findings). */
function fillReachableAfter(db: DatabaseSync): void {
  db.exec('DELETE FROM mat_reachable_after');
  db.exec('INSERT INTO mat_reachable_after (symbol_id) SELECT symbol_id FROM reachable_after');
}

/**
 * Recompute every finding for the whole org in one transaction: delete findings and
 * witness_ok, materialize `reachable` and set symbols.is_entry_reachable, materialize
 * `base_verdicts`, insert the `verdicts` rows, then the `private_dead` rows
 * (insertPrivateDead). The dead-island rule in `verdicts` reads mat_reachable_after,
 * whose seeds come from the candidates in `findings`: the base verdicts are staged in
 * `findings` first (same candidate set as the
 * final verdicts: a dead island is needs_review + witness_pending, a candidate too),
 * mat_reachable_after filled, and the staged rows replaced by `verdicts`.
 * A trigger firing here is a bug in the views and is not caught.
 */
export function analyzeOrg(opts: AnalyzeOptions): AnalyzeCounts {
  const { db, log } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now)) throw new Error(`sentei: analyze: now must be integer epoch seconds, got ${now}`);

  requireIngested(db, 'analyze');

  const counts: AnalyzeCounts = { byVerdict: {}, reachable: 0, total: 0 };
  db.exec('BEGIN');
  try {
    db.exec(analyzeSql());
    db.exec('DELETE FROM run_params');
    db.prepare("INSERT INTO run_params (key, value) VALUES ('now', ?)").run(String(now));

    db.exec('DELETE FROM findings');
    db.exec('DELETE FROM witness_ok');

    fillReachable(db);
    db.exec('UPDATE symbols SET is_entry_reachable = (symbol_id IN (SELECT symbol_id FROM mat_reachable))');
    db.exec('DELETE FROM mat_base_verdicts');
    db.exec(`INSERT INTO mat_base_verdicts (symbol_id, verdict, reasons, blocked_by)
      SELECT symbol_id, verdict, reasons, blocked_by FROM base_verdicts`);
    // Stage the base verdicts so candidate_symbols (hence reachable_after) sees them.
    db.exec(`INSERT INTO findings (symbol_id, verdict, reasons, blocked_by)
      SELECT symbol_id, verdict, reasons, blocked_by FROM mat_base_verdicts`);
    fillReachableAfter(db);
    db.exec('DELETE FROM findings');
    db.exec(`INSERT INTO findings (symbol_id, verdict, reasons, blocked_by)
      SELECT symbol_id, verdict, reasons, blocked_by FROM verdicts`);
    reconcileDeadIslands(db); // no-op here (same candidate set); shared with runWitness
    insertPrivateDead(db);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error(`sentei: foreign_key_check failed after analyze: ${JSON.stringify(violations)}`);
    // Written last: witness and report refuse a DB without it (requireAnalyzed).
    db.prepare("INSERT INTO run_params (key, value) VALUES ('analyzed_at', ?)").run(String(Math.floor(Date.now() / 1000)));

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
