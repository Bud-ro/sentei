import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverGithub, discoverLocal, writeDiscoverToDb, type DiscoverModel } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `discover` stage (PLAN.md §6.1). Source: `--org <name>` (GitHub listing + shallow
 * clones at <clonesDir>/<name>) or `--org-dir <dir>` (local org directory).
 * Rebuilds repos/packages/package_deps/policy/keep_rules and writes <work>/discover.json.
 */
export async function discover(ctx: StageContext): Promise<void> {
  if ((ctx.org === undefined) === (ctx.orgDir === undefined)) {
    throw new Error('sentei discover: exactly one of --org <name> (GitHub) or --org-dir <dir> (local) is required');
  }
  const log = (line: string): void => ctx.log(`[discover] ${line}`);
  let model: DiscoverModel;
  if (ctx.org !== undefined) {
    const gh = ctx.github ?? { updateLockfile: false, include: [], exclude: [], includeForks: false };
    const configDir = gh.configDir ?? (existsSync(join(process.cwd(), 'sentei.json')) ? process.cwd() : null);
    if (configDir !== null && gh.configDir === undefined) log(`using org config ${join(configDir, 'sentei.json')}`);
    model = await discoverGithub({
      org: ctx.org,
      lockfile: gh.lockfile ?? null,
      updateLockfile: gh.updateLockfile,
      include: gh.include,
      exclude: gh.exclude,
      includeForks: gh.includeForks,
      clonesDir: gh.clonesDir ?? join(ctx.work, 'repos'),
      orgConfigDir: configDir === null ? null : resolve(configDir),
      log,
    });
  } else {
    model = discoverLocal({ orgDir: ctx.orgDir!, log });
  }
  for (const [key, value] of Object.entries(ctx.policyOverrides ?? {})) {
    log(`policy override ${key}=${JSON.stringify(value)} (was ${JSON.stringify(model.policy[key as keyof typeof model.policy])})`);
  }
  model.policy = { ...model.policy, ...ctx.policyOverrides };
  writeDiscoverToDb(ctx.db, model, (m) => log(`warning: ${m}`));
  const out = join(ctx.work, 'discover.json');
  writeFileSync(out, `${JSON.stringify(model, null, 2)}\n`);
  for (const r of model.repos) {
    const deps = r.packages.flatMap((p) => p.deps);
    const ambiguous = deps.filter((d) => d.ambiguous === true).length;
    const external = deps.filter((d) => d.resolvedPackageId === null).length - ambiguous;
    log(`${r.repo}: ${r.packages.length} package(s), ${deps.length} dep(s), ${deps.length - external - ambiguous} org-resolved, `
      + `${external} external${ambiguous > 0 ? `, ${ambiguous} ambiguous` : ''}`);
  }
  log(`wrote ${out}`);
}
