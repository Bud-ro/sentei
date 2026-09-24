import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, buildSarif, formatSummary, sarifRepoSlug } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `report` stage (PLAN.md §6.7): write <work>/report.json, one SARIF 2.1.0 log per
 * repo at <work>/sarif/<owner>__<repo>.sarif (every repo, even with zero results,
 * so an upload of a clean repo closes its old alerts), and print the summary
 * (warnings, per-package verdict counts, top blockers, version skew).
 */
export async function report(ctx: StageContext): Promise<void> {
  const r = buildReport({ db: ctx.db });
  const out = join(ctx.work, 'report.json');
  writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);

  const sarifDir = join(ctx.work, 'sarif');
  mkdirSync(sarifDir, { recursive: true });
  const logs = buildSarif(r);
  let results = 0;
  for (const [repo, log] of logs) {
    writeFileSync(join(sarifDir, `${sarifRepoSlug(repo)}.sarif`), `${JSON.stringify(log, null, 2)}\n`);
    results += log.runs[0]?.results.length ?? 0;
  }

  for (const line of formatSummary(r).trimEnd().split('\n')) ctx.log(line);
  ctx.log(`[report] wrote ${out}`);
  ctx.log(`[report] wrote ${logs.size} SARIF log(s) (${results} result(s)) to ${sarifDir}`);
}
