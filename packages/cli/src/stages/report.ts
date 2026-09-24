import type { StageContext } from '../context.ts';

/** `report` stage (PLAN.md §6). M0: no-op. */
export async function report(ctx: StageContext): Promise<void> {
  ctx.log(`[report] would write <work>/report.json and SARIF, print the per-package summary (work=${ctx.work}, db=${ctx.dbPath})`);
}
