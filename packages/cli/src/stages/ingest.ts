import type { StageContext } from '../context.ts';

/** `ingest` stage (PLAN.md §6). M0: no-op. */
export async function ingest(ctx: StageContext): Promise<void> {
  ctx.log(`[ingest] would decode .scip files into symbols/occurrences/edges and compute entry points (work=${ctx.work}, db=${ctx.dbPath})`);
}
