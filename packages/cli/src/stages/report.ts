import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReport, buildSarif, defaultSarifViews, formatSummary, sarifRepoSlug, type ReportViewName } from '@sentei/core';
import type { StageContext } from '../context.ts';

export interface ReportStageOptions {
  /**
   * `--view <name>[,name]` (core parseViews): the views printed on stdout and emitted
   * in SARIF. Default: every view on stdout, every view but org_dead in SARIF (it
   * asserts that the org is the only consumer of its packages). report.json always
   * carries every view.
   */
  views?: readonly ReportViewName[];
}

/**
 * `report` stage (PLAN.md §6.7): write <work>/report.json (base findings + every
 * view), one SARIF 2.1.0 log per repo at <work>/sarif/<owner>__<repo>.sarif (every
 * repo, even with zero results, so an upload of a clean repo closes its old alerts),
 * and print the summary (warnings, per-package view counts, view totals, top
 * blockers, version skew). Views are filters over the findings: choosing them never
 * needs analyze again.
 */
export async function report(ctx: StageContext, opts: ReportStageOptions = {}): Promise<void> {
  const r = buildReport({ db: ctx.db, workDir: ctx.work });
  const out = join(ctx.work, 'report.json');
  writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);

  const sarifDir = join(ctx.work, 'sarif');
  mkdirSync(sarifDir, { recursive: true });
  const sarifViews = opts.views ?? defaultSarifViews();
  const logs = buildSarif(r, { views: sarifViews });
  let results = 0;
  for (const [repo, log] of logs) {
    writeFileSync(join(sarifDir, `${sarifRepoSlug(repo)}.sarif`), `${JSON.stringify(log, null, 2)}\n`);
    results += log.runs[0]?.results.length ?? 0;
  }

  const summary = formatSummary(r, opts.views !== undefined ? { views: opts.views } : {});
  for (const line of summary.trimEnd().split('\n')) ctx.log(line);
  ctx.log(`[report] wrote ${out}`);
  ctx.log(`[report] wrote ${logs.size} SARIF log(s) (${results} result(s), views: ${sarifViews.join(', ')}) to ${sarifDir}`);
}
