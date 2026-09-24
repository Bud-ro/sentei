import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBlame, type BlameDiscoverInput } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `blame` stage (PLAN.md §6.4). Reads <work>/discover.json for repo checkouts and sets
 * first_seen_sha / first_seen_at on exported symbols from `git blame` of the definition
 * line (cached in <work>/blame/). Repos without git history keep NULL ages (fail closed).
 */
export async function blame(ctx: StageContext): Promise<void> {
  const file = join(ctx.work, 'discover.json');
  if (!existsSync(file)) throw new Error(`sentei blame: ${file} not found; run discover first`);
  const discover = JSON.parse(readFileSync(file, 'utf8')) as BlameDiscoverInput;
  await runBlame({ db: ctx.db, discover, workDir: ctx.work, log: ctx.log });
}
