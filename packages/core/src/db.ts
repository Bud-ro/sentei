import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Bump when schema.sql changes incompatibly; old work DBs are rebuilt, not migrated. */
export const SCHEMA_VERSION = 5;

const SCHEMA_URL = new URL('../sql/schema.sql', import.meta.url);

/** The schema SQL, verbatim from packages/core/sql/schema.sql. */
export function schemaSql(): string {
  return readFileSync(SCHEMA_URL, 'utf8');
}

/**
 * Open (or create) a sentei database: foreign keys on, WAL, schema applied.
 * Applying the schema is idempotent. A DB stamped with a different
 * SCHEMA_VERSION is refused rather than silently mixed.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const current = row?.user_version ?? 0;
    if (current !== 0 && current !== SCHEMA_VERSION) {
      throw new Error(
        `sentei: ${path} has schema version ${current}, expected ${SCHEMA_VERSION}; delete it and re-run`,
      );
    }
    db.exec('BEGIN');
    try {
      db.exec(schemaSql());
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
