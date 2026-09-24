import type { DatabaseSync } from 'node:sqlite';

/** Shared inputs every stage receives from the dispatcher. */
export interface StageContext {
  /** Work directory holding all stage outputs (default ./work). */
  work: string;
  /** Path to the SQLite database (default <work>/sentei.db). */
  dbPath: string;
  /** Open database with the schema applied. */
  db: DatabaseSync;
  /** `--org-dir`: local org directory (org.json + repos/<name>/) for `discover`. */
  orgDir?: string;
  /** `--org`: GitHub org (or user) login for `discover`. */
  org?: string;
  /** GitHub discover options (only read when `org` is set). */
  github?: GithubDiscoverOptions;
  /** Where stages print progress. */
  log: (line: string) => void;
}

/** `discover --org` options (see main.ts USAGE). */
export interface GithubDiscoverOptions {
  lockfile?: string;
  updateLockfile: boolean;
  include: string[];
  exclude: string[];
  includeForks: boolean;
  /** Default <work>/repos. */
  clonesDir?: string;
  /** Holds the org-level sentei.json; default cwd if it has one. */
  configDir?: string;
}

export type Stage = (ctx: StageContext) => Promise<void>;
