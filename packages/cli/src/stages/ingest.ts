import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestOrg, type IngestDiscoverInput } from '@sentei/core/ingest';
import type { StageContext } from '../context.ts';

/**
 * `ingest` stage (PLAN.md §6.3). Reads <work>/discover.json and <work>/index/<repo>/,
 * and rebuilds symbols/documents/occurrences/edges/unresolved_refs in one transaction.
 */
export async function ingest(ctx: StageContext): Promise<void> {
  const file = join(ctx.work, 'discover.json');
  if (!existsSync(file)) throw new Error(`sentei ingest: ${file} not found; run discover first`);
  const discover = JSON.parse(readFileSync(file, 'utf8')) as IngestDiscoverInput;
  ingestOrg({ db: ctx.db, workDir: ctx.work, discover, log: ctx.log });
}
