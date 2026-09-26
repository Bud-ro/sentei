import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { discoverGithub, discoverLocal, writeDiscoverToDb, type DiscoverModel } from '@sentei/core';
import type { GithubDiscoverOptions, StageContext } from '../context.ts';

const NO_GITHUB_OPTIONS: GithubDiscoverOptions = { updateLockfile: false, include: [], exclude: [] };

/** `--config-dir`, else the cwd when it holds a sentei.json, else null (defaults). */
export function orgConfigDir(gh: GithubDiscoverOptions, log: (line: string) => void): string | null {
  const dir = gh.configDir ?? (existsSync(join(process.cwd(), 'sentei.json')) ? process.cwd() : null);
  if (dir !== null && gh.configDir === undefined) log(`using org config ${join(dir, 'sentei.json')}`);
  return dir === null ? null : resolve(dir);
}

/** `--lockfile`, else <work>/<org>.lock.json (so `sentei repos` and `discover` share one listing). */
export function lockfileFor(ctx: Pick<StageContext, 'work' | 'github'>, org: string): string {
  return ctx.github?.lockfile ?? join(ctx.work, `${org}.lock.json`);
}

/** The GitHub options every GitHub-backed command passes to core. */
export function githubCoreOptions(ctx: Pick<StageContext, 'work' | 'github'>, org: string, log: (line: string) => void) {
  const gh = ctx.github ?? NO_GITHUB_OPTIONS;
  return {
    org,
    lockfile: lockfileFor(ctx, org),
    updateLockfile: gh.updateLockfile,
    cli: {
      ...(gh.include.length > 0 ? { include: gh.include } : {}),
      ...(gh.exclude.length > 0 ? { exclude: gh.exclude } : {}),
      ...(gh.includeForks !== undefined ? { includeForks: gh.includeForks } : {}),
      ...(gh.includeArchived !== undefined ? { includeArchived: gh.includeArchived } : {}),
    },
    ...(gh.fetchImpl ? { fetchImpl: gh.fetchImpl } : {}),
    ...(gh.token !== undefined ? { token: gh.token } : {}),
    log,
  };
}

/**
 * `discover` stage (PLAN.md §6.1). Source: `--org <name>` (GitHub listing, repo
 * selection, parallel shallow clones at <clonesDir>/<name>) or `--org-dir <dir>`
 * (local org directory). Rebuilds repos/packages/package_deps/policy/keep_rules and
 * writes <work>/discover.json.
 */
export async function discover(ctx: StageContext): Promise<void> {
  if ((ctx.org === undefined) === (ctx.orgDir === undefined)) {
    throw new Error('sentei discover: exactly one of --org <name> (GitHub) or --org-dir <dir> (local) is required');
  }
  const log = (line: string): void => ctx.log(`[discover] ${line}`);
  let model: DiscoverModel;
  if (ctx.org !== undefined) {
    const gh = ctx.github ?? NO_GITHUB_OPTIONS;
    model = await discoverGithub({
      ...githubCoreOptions(ctx, ctx.org, log),
      clonesDir: gh.clonesDir ?? join(ctx.work, 'repos'),
      orgConfigDir: orgConfigDir(gh, log),
      ...(gh.cloneConcurrency !== undefined ? { cloneConcurrency: gh.cloneConcurrency } : {}),
      ...(gh.allowCloneFailures ? { allowCloneFailures: true } : {}),
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
