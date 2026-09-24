import { analyzeOrg } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `analyze` stage (PLAN.md §6.3 step 6, §6.5). Recomputes reachability and every
 * finding for the whole org from the ingested tables (policy: core/sql/analyze.sql).
 * Would-be deletion candidates are left as needs_review + witness_pending for `witness`.
 */
export async function analyze(ctx: StageContext): Promise<void> {
  analyzeOrg({ db: ctx.db, log: ctx.log });
}
