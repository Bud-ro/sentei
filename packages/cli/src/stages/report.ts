import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, formatSummary } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `report` stage (PLAN.md §6.7): write <work>/report.json and print the summary
 * (warnings, per-package verdict counts, top blockers, version skew). SARIF: TODO.
 */
export async function report(ctx: StageContext): Promise<void> {
  const r = buildReport({ db: ctx.db });
  const out = join(ctx.work, 'report.json');
  writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
  for (const line of formatSummary(r).trimEnd().split('\n')) ctx.log(line);
  ctx.log(`[report] wrote ${out}`);
}
