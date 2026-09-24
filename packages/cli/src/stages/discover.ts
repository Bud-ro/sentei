import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverLocal, writeDiscoverToDb } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `discover` stage (PLAN.md §6.1). M1: local org directory only (`--org-dir`).
 * Rebuilds repos/packages/package_deps/policy/keep_rules and writes <work>/discover.json.
 */
export async function discover(ctx: StageContext): Promise<void> {
  if (ctx.orgDir === undefined) {
    throw new Error('sentei discover: --org-dir <dir> is required (GitHub discovery is not implemented yet)');
  }
  const log = (line: string): void => ctx.log(`[discover] ${line}`);
  const model = discoverLocal({ orgDir: ctx.orgDir, log });
  writeDiscoverToDb(ctx.db, model, (m) => log(`warning: ${m}`));
  const out = join(ctx.work, 'discover.json');
  writeFileSync(out, `${JSON.stringify(model, null, 2)}\n`);
  for (const r of model.repos) {
    const deps = r.packages.flatMap((p) => p.deps);
    const external = deps.filter((d) => d.resolvedPackageId === null).length;
    log(`${r.repo}: ${r.packages.length} package(s), ${deps.length} dep(s), ${deps.length - external} org-resolved, ${external} external`);
  }
  log(`wrote ${out}`);
}
