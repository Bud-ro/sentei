import type { StageContext } from '../context.ts';

/** `discover` stage (PLAN.md §6). M0: no-op. */
export async function discover(ctx: StageContext): Promise<void> {
  ctx.log(`[discover] would list org repos, clone them, and record packages + package_deps (writes <work>/discover.json) (work=${ctx.work}, db=${ctx.dbPath})`);
}
