import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBlame, type BlameDiscoverInput } from '@sentei/core';
import type { StageContext } from '../context.ts';

/** Repos blamed at once when --clone-concurrency is not given (the clone default). */
export const DEFAULT_BLAME_REPO_CONCURRENCY = 8;

/**
 * `blame` stage (PLAN.md §6.4). Reads <work>/discover.json for repo checkouts and sets
 * first_seen_sha / first_seen_at on exported symbols from `git blame` of the definition
 * line (cached in <work>/blame/). Repos without git history keep NULL ages (fail closed).
 * Repos are unshallowed and blamed `--clone-concurrency` at a time (default 8), with the
 * clone token (the injected one, else core's GITHUB_TOKEN / GH_TOKEN / `gh auth token`)
 * for fetches from an https origin.
 */
export async function blame(ctx: StageContext): Promise<void> {
  const file = join(ctx.work, 'discover.json');
  if (!existsSync(file)) throw new Error(`sentei blame: ${file} not found; run discover first`);
  const discover = JSON.parse(readFileSync(file, 'utf8')) as BlameDiscoverInput;
  const injected = ctx.github?.token;
  await runBlame({
    db: ctx.db,
    discover,
    workDir: ctx.work,
    log: ctx.log,
    repoConcurrency: ctx.github?.cloneConcurrency ?? DEFAULT_BLAME_REPO_CONCURRENCY,
    ...(injected !== undefined ? { token: async () => injected } : {}),
  });
}
