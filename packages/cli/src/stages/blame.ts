import type { StageContext } from '../context.ts';

/** `blame` stage (PLAN.md §6). M0: no-op. */
export async function blame(ctx: StageContext): Promise<void> {
  ctx.log(`[blame] would git blame exported symbol definitions to set first_seen_at (work=${ctx.work}, db=${ctx.dbPath})`);
}
