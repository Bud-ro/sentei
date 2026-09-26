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
 * Where a report run writes its SARIF logs: `<work>/sarif/` for the default set (no
 * `--view`), `<work>/sarif-<view>[,<view>...]/` (views in REPORT_VIEWS order, as
 * parseViews returns them) for a `--view` run. A view run never touches the default
 * set, and its directory is a sibling, not a subdirectory, so uploading
 * `<work>/sarif/` (recursively) never picks up a view's logs.
 */
export function sarifDirFor(work: string, views: readonly ReportViewName[] | undefined): string {
  return views === undefined ? join(work, 'sarif') : join(work, `sarif-${views.join(',')}`);
}

/**
 * `report` stage (PLAN.md §6.7): write <work>/report.json (base findings + every
 * view; the same whatever `--view` says), one SARIF 2.1.0 log per repo at
 * <sarif dir>/<owner>__<repo>.sarif (every repo, even with zero results, so an
 * upload of a clean repo closes its old alerts; sarifDirFor), and print the summary
 * (warnings, per-package view counts, view totals, top blockers, version skew) of
 * the selected views. Views are filters over the findings: choosing them never
 * needs analyze again.
 */
export async function report(ctx: StageContext, opts: ReportStageOptions = {}): Promise<void> {
  const r = buildReport({ db: ctx.db, workDir: ctx.work });
  const out = join(ctx.work, 'report.json');
  writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);

  const sarifDir = sarifDirFor(ctx.work, opts.views);
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
  ctx.log(`[report] wrote ${out} (full report: every view)`);
  ctx.log(`[report] wrote ${logs.size} SARIF log(s) (${results} result(s), views: ${sarifViews.join(', ')}) to ${sarifDir}`);
  if (opts.views !== undefined) {
    ctx.log(`[report] --view: the default SARIF set in ${sarifDirFor(ctx.work, undefined)} was left as it was`);
  }
}
