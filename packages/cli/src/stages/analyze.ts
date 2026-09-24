import type { StageContext } from '../context.ts';

/** `analyze` stage (PLAN.md §6). M0: no-op. */
export async function analyze(ctx: StageContext): Promise<void> {
  ctx.log(`[analyze] would compute reachability and insert findings per the verdict rules (work=${ctx.work}, db=${ctx.dbPath})`);
}
