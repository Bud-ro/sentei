import type { DatabaseSync } from 'node:sqlite';
import type { Policy } from '@sentei/core';

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
  /** `--policy key=value` (validated): applied by `discover` on top of the org sentei.json. */
  policyOverrides?: Partial<Policy>;
  /** Where stages print progress. */
  log: (line: string) => void;
}

/** `discover --org` / `repos` options (see main.ts USAGE). */
export interface GithubDiscoverOptions {
  /** Default <work>/<org>.lock.json. */
  lockfile?: string;
  updateLockfile: boolean;
  /** --include / --exclude (override the org sentei.json repos.include/exclude). */
  include: string[];
  exclude: string[];
  /** undefined = not given (the org sentei.json or the default decides). */
  includeForks?: boolean;
  includeArchived?: boolean;
  /** --clone-concurrency (validated); undefined = repos.cloneConcurrency or 8. */
  cloneConcurrency?: number;
  /** Skip repos that fail to clone instead of failing discover. */
  allowCloneFailures?: boolean;
  /** Default <work>/repos. */
  clonesDir?: string;
  /** Holds the org-level sentei.json; default cwd if it has one. */
  configDir?: string;
  /** Injectable for tests (GitHub REST calls). */
  fetchImpl?: typeof fetch;
  /** Injectable for tests: undefined = GITHUB_TOKEN / GH_TOKEN / `gh auth token`. */
  token?: string | null;
}

export type Stage = (ctx: StageContext) => Promise<void>;
