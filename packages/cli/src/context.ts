import type { DatabaseSync } from 'node:sqlite';

/** Shared inputs every stage receives from the dispatcher. */
export interface StageContext {
  /** Work directory holding all stage outputs (default ./work). */
  work: string;
  /** Path to the SQLite database (default <work>/sentei.db). */
  dbPath: string;
  /** Open database with the schema applied. */
  db: DatabaseSync;
  /** Where stages print progress. */
  log: (line: string) => void;
}

export type Stage = (ctx: StageContext) => Promise<void>;
