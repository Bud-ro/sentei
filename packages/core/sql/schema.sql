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
-- Identity is (repo, path, manager), not the name: two repos may publish the same
-- name (a fork, a rewrite, a private copy), and both are real packages.
CREATE TABLE IF NOT EXISTS packages (
  package_id   TEXT PRIMARY KEY,                 -- "<manager>:<repo>:<name>", e.g. "npm:acme/lib-core:@acme/core"
  repo         TEXT NOT NULL REFERENCES repos (repo) ON DELETE CASCADE,
  path         TEXT NOT NULL,                    -- dir of the manifest, POSIX, repo-relative
  manager      TEXT NOT NULL CHECK (manager IN ('npm', 'pub')),
  name         TEXT NOT NULL,
  version      TEXT,
  visibility   TEXT NOT NULL CHECK (visibility IN ('private', 'published-private', 'published-public')),
  -- Manifest shape: 1 = a library (npm package.json with exports/types/typings/module;
  -- pub with a lib/*.dart), 0 = an app run by a runtime (e.g. a Worker with only `main`).
  is_library   INTEGER NOT NULL DEFAULT 0 CHECK (is_library IN (0, 1)),
  entry_points TEXT NOT NULL DEFAULT '[]'
               CHECK (json_valid(entry_points) AND json_type(entry_points) = 'array'),
  UNIQUE (repo, path, manager),
  CHECK (package_id = manager || ':' || repo || ':' || name)
) STRICT;
CREATE INDEX IF NOT EXISTS packages_name ON packages (manager, name);

-- Manifest-declared dependencies (not code references); resolved to org packages by
-- name when possible (discover.ts resolveDep): one org package of that name -> it
-- (resolution 'name'); several -> the one in the consumer's repo ('same-repo'), else
-- the only non-private one ('published'); otherwise ambiguous = 1, resolved_package_id
-- NULL, and the consumer gets an `ambiguous_dep` flag targeted at every candidate.
CREATE TABLE IF NOT EXISTS package_deps (
  consumer_package_id TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  dep_name            TEXT NOT NULL,
  dep_manager         TEXT NOT NULL CHECK (dep_manager IN ('npm', 'pub')),
  dep_constraint      TEXT,                      -- "constraint" is reserved in SQL
  resolved_package_id TEXT REFERENCES packages (package_id) ON DELETE SET NULL,
  -- 1 = declared ONLY as a dev dependency (npm devDependencies / pub dev_dependencies):
  -- the consumer's test files are then real consumers of the target (analyze.sql).
  dev                 INTEGER NOT NULL DEFAULT 0 CHECK (dev IN (0, 1)),
  resolution          TEXT CHECK (resolution IN ('name', 'same-repo', 'published')),
  ambiguous           INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
  CHECK (ambiguous = 0 OR resolved_package_id IS NULL),
  PRIMARY KEY (consumer_package_id, dep_manager, dep_name)
) STRICT;
CREATE INDEX IF NOT EXISTS package_deps_resolved ON package_deps (resolved_package_id);

-- Interned SCIP symbols (definitions); symbol_str is the SCIP symbol string with its
-- package version replaced by '.', or, when several org packages share the symbol's
-- package name, by the owning package_id (ingest.ts symbolKey), so it stays unique.
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
  -- 1 = a generated file (sidecar generatedFiles: `@generated` / "do not edit" headers,
  -- or a GENERATED_GLOBS path, set by ingest): analyze.sql `generated_files` reads it,
  -- and the witness never self-scans it.
  is_generated     INTEGER NOT NULL DEFAULT 0 CHECK (is_generated IN (0, 1)),
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

-- Every name under which an entry file exports a symbol (sidecar `exports[]`: entry,
-- exportedAs), including `default` for default exports (named or anonymous). An
-- `export { a as b }` consumer names `b`, never `a`; the witness searches every alias
-- and analyze treats a `default` export of a runtime entry specially.
CREATE TABLE IF NOT EXISTS symbol_exports (
  symbol_id   INTEGER NOT NULL REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  entry_file  TEXT NOT NULL,                     -- repo-relative entry point
  exported_as TEXT NOT NULL,                     -- `ns.x` for namespace re-exports
  PRIMARY KEY (symbol_id, entry_file, exported_as)
) STRICT;

-- Declarations the runtime or a tool invokes by name with no code reference (sidecar
-- `entrySymbols`: Dart `main` of a script, a build.yaml builder factory, dart_dev's
-- `config`). Reachability seeds; never given a verdict or a private_dead row.
-- kind 'ambient': a global declaration the type checker sees with no import (a
-- `worker-configuration.d.ts` `declare namespace`, a `global.d.ts`): still a seed, but
-- it says nothing about how the package is run, so it never makes a package eligible
-- for private_dead (analyze.sql private_dead_eligible). 'runtime' (default) does.
CREATE TABLE IF NOT EXISTS entry_symbols (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols (symbol_id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'runtime' CHECK (kind IN ('runtime', 'ambient'))
) STRICT;

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

-- Uncertainty markers on a package (fail closed). An untargeted row (target_package_id
-- NULL) makes the package opaque and blocks every package it depends on. A targeted row
-- says "package_id has code we cannot see that uses target_package_id" (e.g. an
-- unindexed eslint.config.mjs importing an org config package): it blocks only the
-- target, and does not make package_id itself opaque. `ambiguous_dep` is always
-- targeted: package_id names a package (manifest dep, or a SCIP reference) that several
-- org packages share, and the one it means is unknown, so each candidate is blocked.
CREATE TABLE IF NOT EXISTS package_flags (
  package_id        TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  flag              TEXT NOT NULL CHECK (flag IN (
                      'opaque_consumer', 'index_failed', 'dynamic_access',
                      'namespace_dynamic', 'unindexed_consumer', 'ambiguous_dep')),
  reason            TEXT,
  file              TEXT,
  target_package_id TEXT REFERENCES packages (package_id) ON DELETE CASCADE
                    CHECK (target_package_id IS NOT package_id),
  CHECK (flag <> 'ambiguous_dep' OR target_package_id IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS package_flags_package ON package_flags (package_id);

-- Org-level policy knobs (sentei.json), values JSON-encoded; read only by views.
-- Every key only changes analyze / witness / report, never what index produced
-- (DESIGN.md Phase 2 decision 2: no option requires a re-index).
CREATE TABLE IF NOT EXISTS policy (
  key   TEXT PRIMARY KEY CHECK (key IN (
          'minAgeDays', 'trustPrivateRegistry',
          'countTestsAsConsumers', 'countDocsAsConsumers')),
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;

-- Removed policy keys are dropped on insert rather than rejected, so a sentei.json (or
-- a Policy object) that still carries one does not abort discover. `assumeClosedWorld`
-- (removed in Phase 2): the verdicts no longer depend on it; the report's `org_dead`
-- view states the assertion it used to make silently.
CREATE TRIGGER IF NOT EXISTS policy_drop_removed_keys
BEFORE INSERT ON policy
WHEN NEW.key IN ('assumeClosedWorld')
BEGIN
  SELECT RAISE(IGNORE);
END;

-- Policy defaults (PLAN.md §6.5). OR IGNORE so an existing DB keeps its settings.
INSERT OR IGNORE INTO policy (key, value) VALUES
  ('minAgeDays', '180'),
  ('trustPrivateRegistry', 'true'),
  ('countTestsAsConsumers', 'false'),
  ('countDocsAsConsumers', 'false');

-- `keep` list entries ("<package_id>#<symbol name>"); symbol_name '*' keeps every symbol.
-- A name-only sentei.json entry ("npm:<name>#sym") is expanded at discover to one row
-- per package of that name.
CREATE TABLE IF NOT EXISTS keep_rules (
  package_id  TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  symbol_name TEXT NOT NULL,
  PRIMARY KEY (package_id, symbol_name)
) STRICT;

-- Unindexed files of a consumer package that import a target org package and are
-- script / docs / test code (sidecar unindexedImports with a `scope`: under
-- SCRIPT_GLOBS / DOCS_GLOBS / TEST_GLOBS, e.g. unhead's `bench/`). They do not block
-- the target (unlike a targeted unindexed_consumer flag); the witness scans them as
-- consumer files of the target instead (name search, same rules). Repo-relative file.
CREATE TABLE IF NOT EXISTS witness_files (
  consumer_package_id TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  target_package_id   TEXT NOT NULL REFERENCES packages (package_id) ON DELETE CASCADE,
  file                TEXT NOT NULL,
  PRIMARY KEY (consumer_package_id, target_package_id, file)
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
               'private_dead', 'needs_review', 'version_skew',
               -- would have had a verdict, but an opaque consumer (or the package itself) hides refs
               'blocked')),
  reasons    TEXT NOT NULL DEFAULT '[]'
             CHECK (json_valid(reasons) AND json_type(reasons) = 'array'),
  blocked_by TEXT NOT NULL DEFAULT '[]'
             CHECK (json_valid(blocked_by) AND json_type(blocked_by) = 'array'),
  PRIMARY KEY (symbol_id, verdict)
) STRICT;

-- ---------------------------------------------------------------------------
-- Policy views (rules that read a config value)
-- ---------------------------------------------------------------------------

-- Private packages: nobody outside the org can depend on them, so the org's code is
-- their whole consumer set. `private`, or `published-private` with trustPrivateRegistry
-- (an org-internal registry). Every other package is "published": external consumers
-- may exist, so its unused exports are deprecation_candidate, not deletion_candidate.
-- A missing / false policy key means "no".
CREATE VIEW IF NOT EXISTS private_packages (package_id) AS
SELECT p.package_id
FROM packages p
WHERE p.visibility = 'private'
   OR (p.visibility = 'published-private'
       AND coalesce((SELECT json_extract(value, '$') FROM policy WHERE key = 'trustPrivateRegistry'), 0) = 1);

-- Packages we cannot see into: any untargeted package_flags row. A targeted flag is
-- about the consumer's use of one other package, not about the consumer's own code.
CREATE VIEW IF NOT EXISTS opaque_packages (package_id) AS
SELECT DISTINCT package_id FROM package_flags WHERE target_package_id IS NULL;

-- (P, C, flag): no verdict for P because C may use P in ways we cannot see. Either C
-- declares a manifest dependency on P and has an untargeted flag (or a flag targeted
-- at P), or C has a flag targeted at P even without a declared dependency (a hoisted
-- workspace dependency is still a use).
CREATE VIEW IF NOT EXISTS blocked_packages (package_id, blocker_package_id, flag) AS
SELECT d.resolved_package_id, d.consumer_package_id, f.flag
FROM package_deps d
JOIN package_flags f ON f.package_id = d.consumer_package_id
WHERE d.resolved_package_id IS NOT NULL
  AND (f.target_package_id IS NULL OR f.target_package_id = d.resolved_package_id)
UNION
SELECT target_package_id, package_id, flag
FROM package_flags
WHERE target_package_id IS NOT NULL;

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

-- The "would-be deletion" verdicts: deletion_candidate (private package) and a
-- deprecation_candidate that is not an internal-only export (reasons no_refs /
-- only_test_refs, or dead_island: published package, the same evidence as a deletion;
-- the report's org_dead view reads these as deletions). A deprecation_candidate with
-- reason internal_refs_only and no dead_island is the published form of an unexport.

-- §5.1: no deletion/deprecation candidate while any consumer of the symbol's package is opaque.
CREATE TRIGGER IF NOT EXISTS findings_candidate_requires_transparent_consumers
BEFORE INSERT ON findings
WHEN NEW.verdict IN ('deletion_candidate', 'deprecation_candidate')
 AND EXISTS (SELECT 1 FROM symbols s
             JOIN blocked_packages b ON b.package_id = s.package_id
             WHERE s.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion/deprecation candidate blocked by opaque consumer');
END;

-- §5.1: deletion/unexport verdicts only for private packages (nobody outside the org
-- can depend on them).
CREATE TRIGGER IF NOT EXISTS findings_requires_private_package
BEFORE INSERT ON findings
WHEN NEW.verdict IN ('deletion_candidate', 'unexport_candidate')
 AND NOT EXISTS (SELECT 1 FROM symbols s
                 JOIN private_packages c ON c.package_id = s.package_id
                 WHERE s.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion/unexport candidate requires a private package');
END;

-- ... and deprecation verdicts only for published ones.
CREATE TRIGGER IF NOT EXISTS findings_deprecation_requires_published_package
BEFORE INSERT ON findings
WHEN NEW.verdict = 'deprecation_candidate'
 AND EXISTS (SELECT 1 FROM symbols s
             JOIN private_packages c ON c.package_id = s.package_id
             WHERE s.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deprecation_candidate requires a published package');
END;

-- §5.1: keep list suppresses deletion and deprecation (exact symbol name or '*').
CREATE TRIGGER IF NOT EXISTS findings_candidate_respects_keep
BEFORE INSERT ON findings
WHEN NEW.verdict IN ('deletion_candidate', 'deprecation_candidate')
 AND EXISTS (SELECT 1 FROM symbols s
             JOIN keep_rules k ON k.package_id = s.package_id
             WHERE s.symbol_id = NEW.symbol_id
               AND (k.symbol_name = '*' OR k.symbol_name = s.name))
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion/deprecation candidate matches keep rule');
END;

-- §5.1/§9: a would-be deletion (deletion_candidate, or a deprecation_candidate that is
-- not internal-only) requires the text witness to have passed.
CREATE TRIGGER IF NOT EXISTS findings_candidate_requires_witness
BEFORE INSERT ON findings
WHEN (NEW.verdict = 'deletion_candidate'
      OR (NEW.verdict = 'deprecation_candidate'
          AND (NOT EXISTS (SELECT 1 FROM json_each(NEW.reasons) j WHERE j.value = 'internal_refs_only')
               OR EXISTS (SELECT 1 FROM json_each(NEW.reasons) j WHERE j.value = 'dead_island'))))
 AND NOT EXISTS (SELECT 1 FROM witness_ok w WHERE w.symbol_id = NEW.symbol_id)
BEGIN
  SELECT RAISE(ABORT, 'sentei: deletion/deprecation candidate requires witness_ok');
END;
