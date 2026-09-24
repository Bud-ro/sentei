import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWitness, type WitnessDiscoverInput } from '@sentei/core';
import type { StageContext } from '../context.ts';

/**
 * `witness` stage (PLAN.md §9). Reads <work>/discover.json for consumer checkouts and
 * text-searches them for every witness_pending finding: pass → witness_ok +
 * deletion_candidate, hit → needs_review with witness_mismatch reasons.
 */
export async function witness(ctx: StageContext): Promise<void> {
  const file = join(ctx.work, 'discover.json');
  if (!existsSync(file)) throw new Error(`sentei witness: ${file} not found; run discover first`);
  const discover = JSON.parse(readFileSync(file, 'utf8')) as WitnessDiscoverInput;
  runWitness({ db: ctx.db, discover, log: ctx.log });
}
