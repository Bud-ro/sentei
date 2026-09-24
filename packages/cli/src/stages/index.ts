import type { StageContext } from '../context.ts';

/** `index` stage (PLAN.md §6). M0: no-op. */
export async function index(ctx: StageContext): Promise<void> {
  ctx.log(`[index] would run the pinned SCIP indexers per package (writes <work>/index/<repo>/*.scip) (work=${ctx.work}, db=${ctx.dbPath})`);
}
