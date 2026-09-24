-- sentei schema (PLAN.md §5, §5.1). Loaded verbatim by packages/core/src/db.ts.
--
-- Conventions:
--   * Every table is STRICT; PRAGMA foreign_keys = ON is set by openDb().
--   * Timestamps are INTEGER Unix epoch seconds (UTC).
--   * PLAN.md's TEXT[] columns are TEXT holding a JSON array, enforced by CHECK.
--   * Paths are POSIX, relative to the repo root.
--   * Structural invariants are constraints/triggers here; anything that reads a
--     policy value is a VIEW (PLAN.md §3 rule of thumb).
--   * Every statement is idempotent (IF NOT EXISTS / INSERT OR IGNORE on policy
--     defaults only), so applying this file to an existing DB is a no-op.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Cascade root: one row per repository; deleting a repo removes every derived row.
CREATE TABLE IF NOT EXISTS repos (
  repo           TEXT PRIMARY KEY,               -- "org/name"
  default_branch TEXT,
  head_sha       TEXT,
  indexed_at     INTEGER,                        -- epoch seconds
  index_status   TEXT CHECK (index_status IN ('ok', 'partial', 'failed'))
) STRICT;

-- Org-owned packages (npm package.json / pub pubspec.yaml), one per manifest.
CREATE TABLE IF NOT EXISTS packages (
  package_id   TEXT PRIMARY KEY,                 -- "<manager>:<name>"
  repo         TEXT NOT NULL REFERENCES repos (repo) ON DELETE CASCADE,
  path         TEXT NOT NULL,                    -- dir of the manifest, POSIX, repo-relative
  manager      TEXT NOT NULL CHECK (manager IN ('npm', 'pub')),
  name         TEXT NOT NULL,
  version      TEXT,
  visibility   TEXT NOT NULL CHECK (visibility IN ('private', 'published-private', 'published-public')),
  entry_points TEXT NOT NULL DEFAULT '[]'
               CHECK (json_valid(entry_points) AND json_type(entry_points) = 'array'),
  UNIQUE (manager, name),
  CHECK (package_id = manager || ':' || name)
) STRICT;

-- Manifest-declared dependencies (not code references); resolved to org packages when possible.
CREATE TABLE IF NOT EXISTS package_deps (
  consumer_package_id TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  dep_name            TEXT NOT NULL,
  dep_manager         TEXT NOT NULL CHECK (dep_manager IN ('npm', 'pub')),
  dep_constraint      TEXT,                      -- "constraint" is reserved in SQL
  resolved_package_id TEXT REFERENCES packages (package_id) ON DELETE SET NULL,
  PRIMARY KEY (consumer_package_id, dep_manager, dep_name)
) STRICT;
CREATE INDEX IF NOT EXISTS package_deps_resolved ON package_deps (resolved_package_id);

-- Interned SCIP symbols (definitions); symbol_str is the verbatim SCIP symbol string.
CREATE TABLE IF NOT EXISTS symbols (
  symbol_id          INTEGER PRIMARY KEY,
  symbol_str         TEXT NOT NULL UNIQUE,
  package_id         TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  file               TEXT NOT NULL,
  line               INTEGER,
  col                INTEGER,
  kind               TEXT,
  name               TEXT NOT NULL,
  -- Enclosing declaration by descriptor (Foo#bar(). -> Foo#), so members are reachable
  -- when their owner is. NULL for top-level declarations (the file is not a parent).
  parent_symbol_id   INTEGER REFERENCES symbols (symbol_id) ON DELETE CASCADE
                     CHECK (parent_symbol_id IS NOT symbol_id),
  is_exported        INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0, 1)),
  is_entry_reachable INTEGER NOT NULL DEFAULT 0 CHECK (is_entry_reachable IN (0, 1)),
  first_seen_sha     TEXT,
  first_seen_at      INTEGER                     -- epoch seconds (git blame author-time)
) STRICT;
CREATE INDEX IF NOT EXISTS symbols_package ON symbols (package_id);
CREATE INDEX IF NOT EXISTS symbols_parent ON symbols (parent_symbol_id);

-- One row per indexed document. module_symbol_id is the file pseudo-symbol (the
-- indexer's module symbol, or a synthetic 'sentei file <package_id> <file>' one):
-- the enclosing symbol of top-level code and the seed for entry files.
CREATE TABLE IF NOT EXISTS documents (
  package_id       TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  file             TEXT NOT NULL,
  module_symbol_id INTEGER REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  is_entry         INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0, 1)),
  PRIMARY KEY (package_id, file)
) STRICT;
CREATE INDEX IF NOT EXISTS documents_module ON documents (module_symbol_id);

-- Every SCIP occurrence; is_external is the single definition of "cross-package reference".
-- def_package_id denormalizes symbols.package_id because SQLite forbids subqueries in
-- generated columns; trigger occurrences_def_package_matches keeps it honest.
CREATE TABLE IF NOT EXISTS occurrences (
  symbol_id           INTEGER NOT NULL REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  package_id          TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE, -- package of the file
  def_package_id      TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE, -- package of the symbol
  file                TEXT NOT NULL,
  line                INTEGER,
  col                 INTEGER,
  role                INTEGER NOT NULL,          -- SCIP SymbolRole bitmask
  enclosing_symbol_id INTEGER REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  -- 1 = the identifier in an `export { a }` / `export { a as b } from` clause: part of
  -- the export surface, not a use, so it never counts as a reference or makes an edge.
  is_export_site      INTEGER NOT NULL DEFAULT 0 CHECK (is_export_site IN (0, 1)),
  is_external         INTEGER GENERATED ALWAYS AS (package_id <> def_package_id) STORED
) STRICT;
CREATE INDEX IF NOT EXISTS occurrences_symbol ON occurrences (symbol_id);
CREATE INDEX IF NOT EXISTS occurrences_file ON occurrences (package_id, file);
CREATE INDEX IF NOT EXISTS occurrences_enclosing ON occurrences (enclosing_symbol_id);

-- Reachability graph: enclosing symbol -> referenced symbol, from SCIP or explicit overlays.
CREATE TABLE IF NOT EXISTS edges (
  from_symbol_id  INTEGER NOT NULL REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  to_symbol_id    INTEGER NOT NULL REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  from_package_id TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  to_package_id   TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('scip', 'overlay')),
  PRIMARY KEY (from_symbol_id, to_symbol_id, source)
) STRICT;
CREATE INDEX IF NOT EXISTS edges_from ON edges (from_symbol_id);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_symbol_id);

-- References from a consumer into an org package whose symbol has no definition in
-- that package's index (version skew, indexer gaps). Reported, never counted as a
-- reference: the symbol it names does not exist at HEAD, so it is neither dead nor alive.
CREATE TABLE IF NOT EXISTS unresolved_refs (
  consumer_package_id TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  target_package_id   TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  symbol_str          TEXT NOT NULL,             -- version-normalized SCIP symbol, or the imported
                                                 -- name for a sidecar unresolvedImports entry
  file                TEXT NOT NULL,             -- in the consumer's repo
  line                INTEGER,
  col                 INTEGER,
  CHECK (consumer_package_id <> target_package_id)
) STRICT;
CREATE INDEX IF NOT EXISTS unresolved_refs_target ON unresolved_refs (target_package_id);

-- Uncertainty markers on a package; any row makes the package opaque (fail closed).
CREATE TABLE IF NOT EXISTS package_flags (
  package_id TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  flag       TEXT NOT NULL CHECK (flag IN (
               'opaque_consumer', 'index_failed', 'dynamic_access',
               'namespace_dynamic', 'unindexed_consumer')),
  reason     TEXT,
  file       TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS package_flags_package ON package_flags (package_id);

-- Org-level policy knobs (sentei.json), values JSON-encoded; read only by views.
CREATE TABLE IF NOT EXISTS policy (
  key   TEXT PRIMARY KEY CHECK (key IN (
          'minAgeDays', 'trustPrivateRegistry', 'assumeClosedWorld',
          'countTestsAsConsumers', 'countDocsAsConsumers')),
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;

-- Policy defaults (PLAN.md §6.5). OR IGNORE so an existing DB keeps its settings.
INSERT OR IGNORE INTO policy (key, value) VALUES
  ('minAgeDays', '180'),
  ('trustPrivateRegistry', 'true'),
  ('assumeClosedWorld', 'false'),
  ('countTestsAsConsumers', 'false'),
  ('countDocsAsConsumers', 'false');

-- `keep` list entries ("<package_id>#<symbol name>"); symbol_name '*' keeps every symbol.
CREATE TABLE IF NOT EXISTS keep_rules (
  package_id  TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  symbol_name TEXT NOT NULL,
  PRIMARY KEY (package_id, symbol_name)
) STRICT;

-- Presence = the text witness (PLAN.md §9) ran for this symbol and found no mention.
CREATE TABLE IF NOT EXISTS witness_ok (
  symbol_id  INTEGER PRIMARY KEY REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL                    -- epoch seconds
) STRICT;

-- Analysis output: one verdict per symbol, guarded by the fail-closed triggers below.
CREATE TABLE IF NOT EXISTS findings (
  symbol_id  INTEGER NOT NULL REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL CHECK (verdict IN (
               'deletion_candidate', 'deprecation_candidate', 'unexport_candidate',
               'private_dead', 'needs_review', 'version_skew')),
  reasons    TEXT NOT NULL DEFAULT '[]'
             CHECK (json_valid(reasons) AND json_type(reasons) = 'array'),
  blocked_by TEXT NOT NULL DEFAULT '[]'
             CHECK (json_valid(blocked_by) AND json_type(blocked_by) = 'array'),
  PRIMARY KEY (symbol_id, verdict)
) STRICT;

-- ---------------------------------------------------------------------------
-- Policy views (rules that read a config value)
-- ---------------------------------------------------------------------------

-- Packages whose full consumer set is visible to us. Missing/false policy keys mean "no".
CREATE VIEW IF NOT EXISTS closed_world_packages (package_id) AS
SELECT p.package_id
FROM packages p
WHERE p.visibility = 'private'
   OR (p.visibility = 'published-private'
       AND coalesce((SELECT json_extract(value, '$') FROM policy WHERE key = 'trustPrivateRegistry'), 0) = 1)
   OR coalesce((SELECT json_extract(value, '$') FROM policy WHERE key = 'assumeClosedWorld'), 0) = 1;

-- Packages we cannot see into: any package_flags row at all.
CREATE VIEW IF NOT EXISTS opaque_packages (package_id) AS
SELECT DISTINCT package_id FROM package_flags;

-- (P, C, flag) where C declares a manifest dependency on P and C is opaque: no verdict for P.
CREATE VIEW IF NOT EXISTS blocked_packages (package_id, blocker_package_id, flag) AS
SELECT DISTINCT d.resolved_package_id, d.consumer_package_id, f.flag
FROM package_deps d
JOIN package_flags f ON f.package_id = d.consumer_package_id
WHERE d.resolved_package_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- occurrences.def_package_id must equal the defining symbol's package (no drift).
-- IS NOT (not <>) so a missing symbol also aborts: ingest inserts symbols first.
CREATE TRIGGER IF NOT EXISTS occurrences_def_package_matches
BEFORE INSERT ON occurrences
WHEN NEW.def_package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: occurrences.def_package_id does not match symbols.package_id');
END;

-- Same drift guard for updates to an occurrence.
CREATE TRIGGER IF NOT EXISTS occurrences_def_package_matches_update
BEFORE UPDATE OF symbol_id, def_package_id ON occurrences
WHEN NEW.def_package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: occurrences.def_package_id does not match symbols.package_id');
END;

-- A symbol never moves package (would silently invalidate occurrences.def_package_id).
CREATE TRIGGER IF NOT EXISTS symbols_package_immutable
BEFORE UPDATE OF package_id ON symbols
WHEN NEW.package_id IS NOT OLD.package_id
BEGIN
  SELECT RAISE(ABORT, 'sentei: symbols.package_id is immutable');
END;

-- edges.{from,to}_package_id must equal the endpoints' packages (same denormalization rule).
CREATE TRIGGER IF NOT EXISTS edges_packages_match
BEFORE INSERT ON edges
WHEN NEW.from_package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.from_symbol_id)
  OR NEW.to_package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.to_symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: edges package ids do not match endpoint symbols');
END;

-- A member's parent is a symbol of the same package.
CREATE TRIGGER IF NOT EXISTS symbols_parent_same_package
BEFORE INSERT ON symbols
WHEN NEW.parent_symbol_id IS NOT NULL
 AND NEW.package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.parent_symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: symbols.parent_symbol_id must be a symbol of the same package');
END;

CREATE TRIGGER IF NOT EXISTS symbols_parent_same_package_update
BEFORE UPDATE OF parent_symbol_id ON symbols
WHEN NEW.parent_symbol_id IS NOT NULL
 AND NEW.package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.parent_symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: symbols.parent_symbol_id must be a symbol of the same package');
END;

-- A document's file pseudo-symbol belongs to the document's package.
CREATE TRIGGER IF NOT EXISTS documents_module_same_package
BEFORE INSERT ON documents
WHEN NEW.module_symbol_id IS NOT NULL
 AND NEW.package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.module_symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: documents.module_symbol_id must be a symbol of the document package');
END;

CREATE TRIGGER IF NOT EXISTS documents_module_same_package_update
BEFORE UPDATE OF package_id, module_symbol_id ON documents
WHEN NEW.module_symbol_id IS NOT NULL
 AND NEW.package_id IS NOT (SELECT package_id FROM symbols WHERE symbol_id = NEW.module_symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: documents.module_symbol_id must be a symbol of the document package');
END;

-- Findings are insert-only so the guards below cannot be bypassed with UPDATE.
CREATE TRIGGER IF NOT EXISTS findings_insert_only
BEFORE UPDATE ON findings
BEGIN
  SELECT RAISE(ABORT, 'sentei: findings are insert-only; delete and re-insert');
END;

-- §5.1: no deletion_candidate while any consumer of the symbol's package is opaque.
CREATE TRIGGER IF NOT EXISTS findings_deletion_requires_transparent_consumers
BEFORE INSERT ON findings
WHEN NEW.verdict = 'deletion_candidate'
 AND EXISTS (SELECT 1 FROM symbols s
             JOIN blocked_packages b ON b.package_id = s.package_id
             WHERE s.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion_candidate blocked by opaque consumer');
END;

-- §5.1: deletion/unexport verdicts only for closed-world packages.
CREATE TRIGGER IF NOT EXISTS findings_requires_closed_world
BEFORE INSERT ON findings
WHEN NEW.verdict IN ('deletion_candidate', 'unexport_candidate')
 AND NOT EXISTS (SELECT 1 FROM symbols s
                 JOIN closed_world_packages c ON c.package_id = s.package_id
                 WHERE s.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion/unexport candidate requires closed-world package');
END;

-- §5.1: keep list suppresses deletion (exact symbol name or '*').
CREATE TRIGGER IF NOT EXISTS findings_deletion_respects_keep
BEFORE INSERT ON findings
WHEN NEW.verdict = 'deletion_candidate'
 AND EXISTS (SELECT 1 FROM symbols s
             JOIN keep_rules k ON k.package_id = s.package_id
             WHERE s.symbol_id = NEW.symbol_id
               AND (k.symbol_name = '*' OR k.symbol_name = s.name))
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion_candidate matches keep rule');
END;

-- §5.1/§9: deletion_candidate requires the text witness to have passed.
CREATE TRIGGER IF NOT EXISTS findings_deletion_requires_witness
BEFORE INSERT ON findings
WHEN NEW.verdict = 'deletion_candidate'
 AND NOT EXISTS (SELECT 1 FROM witness_ok w WHERE w.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion_candidate requires witness_ok');
END;
