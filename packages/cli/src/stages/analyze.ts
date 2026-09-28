import { ageCoverage, analyzeOrg, minAgeWarning, policyMinAgeDays } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `analyze` stage (PLAN.md §6.3 step 6, §6.5). Recomputes reachability and every
 * finding for the whole org from the ingested tables (policy: core/sql/analyze.sql).
 * Would-be deletion candidates are left as needs_review + witness_pending for `witness`.
 * Ends with a `warn:` line when minAgeDays > 0 cannot apply to every repo (shallow
 * clones and other unblamed repos: unknown ages count as old enough there; an undated line in a full clone stays young).
 */
export async function analyze(ctx: StageContext): Promise<void> {
  analyzeOrg({ db: ctx.db, log: ctx.log });
  const warning = minAgeWarning(ageCoverage(ctx.db), policyMinAgeDays(ctx.db));
  if (warning !== null) ctx.log(`[analyze] warn: ${warning}`);
}
