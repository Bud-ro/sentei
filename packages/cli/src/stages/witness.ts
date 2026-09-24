import type { StageContext } from '../context.ts';

/** `witness` stage (PLAN.md §6). M0: no-op. */
export async function witness(ctx: StageContext): Promise<void> {
  ctx.log(`[witness] would text-search consumers for would-be deletion candidates and fill witness_ok (work=${ctx.work}, db=${ctx.dbPath})`);
}
