-- sentei analysis policy (PLAN.md §6.3 step 6, §6.5). Loaded verbatim by
-- packages/core/src/analyze.ts before every analyze run.
--
-- Everything here reads a config value (policy, keep_rules, run_params) or is a
-- derived relation, so it is a VIEW (PLAN.md §3). schema.sql holds the structural
-- invariants; this file holds the rules. It lives apart from schema.sql so that
-- changing a rule never changes the schema (and SCHEMA_VERSION), and so that the
-- views are (re)created from the current file on every run: each view is dropped
-- and recreated, which keeps the file idempotent AND means a work DB built by an
-- older sentei never answers with a stale rule.
--
-- Query any of these directly against a work DB to debug a verdict, e.g.
--   SELECT * FROM verdicts v JOIN symbols s USING (symbol_id) WHERE s.name = 'foo';

-- Per-run inputs that are not org policy. analyze.ts fills it: `now` (epoch seconds).
CREATE TABLE IF NOT EXISTS run_params (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- Dependents first, so every DROP succeeds.
DROP VIEW IF EXISTS private_dead;
DROP VIEW IF EXISTS private_dead_unlocked;
DROP VIEW IF EXISTS candidate_reach;
DROP VIEW IF EXISTS reachable_after;
DROP VIEW IF EXISTS reach_seeds_after;
DROP VIEW IF EXISTS unreachable_before;
DROP VIEW IF EXISTS private_dead_eligible;
DROP VIEW IF EXISTS candidate_symbols;
DROP VIEW IF EXISTS verdicts;
DROP VIEW IF EXISTS verdict_blockers;
DROP VIEW IF EXISTS runtime_entry_defaults;
DROP VIEW IF EXISTS reachable;
DROP VIEW IF EXISTS reach_seeds_before;
DROP VIEW IF EXISTS reach_edges;
DROP VIEW IF EXISTS kept_symbols;
DROP VIEW IF EXISTS symbol_age_ok;
DROP VIEW IF EXISTS internal_refs;
DROP VIEW IF EXISTS test_only_refs;
DROP VIEW IF EXISTS internal_ref_occurrences;
DROP VIEW IF EXISTS external_refs;
DROP VIEW IF EXISTS overlay_refs;
DROP VIEW IF EXISTS external_ref_occurrences;
DROP VIEW IF EXISTS owner_ref_occurrences;
DROP VIEW IF EXISTS symbol_ancestors;
DROP VIEW IF EXISTS symbol_owners;
DROP VIEW IF EXISTS doc_files;
DROP VIEW IF EXISTS test_files;
DROP VIEW IF EXISTS ref_occurrences;
DROP VIEW IF EXISTS module_symbols;
DROP VIEW IF EXISTS analysis_params;

-- ---------------------------------------------------------------------------
-- Parameters
-- ---------------------------------------------------------------------------

-- One row: policy knobs + run parameters. A missing boolean key reads as false and a
-- missing minAgeDays / now as NULL, which makes symbol_age_ok empty (fail closed).
CREATE VIEW analysis_params (count_tests, count_docs, min_age_days, now) AS
SELECT
  coalesce((SELECT json_extract(value, '$') FROM policy WHERE key = 'countTestsAsConsumers'), 0) = 1,
  coalesce((SELECT json_extract(value, '$') FROM policy WHERE key = 'countDocsAsConsumers'), 0) = 1,
  (SELECT json_extract(value, '$') FROM policy WHERE key = 'minAgeDays'),
  (SELECT CAST(value AS INTEGER) FROM run_params WHERE key = 'now');

-- ---------------------------------------------------------------------------
-- References
-- ---------------------------------------------------------------------------

-- File pseudo-symbols (a document's module symbol, or a synthetic 'file' symbol).
CREATE VIEW module_symbols (symbol_id) AS
SELECT module_symbol_id FROM documents WHERE module_symbol_id IS NOT NULL
UNION
SELECT symbol_id FROM symbols WHERE kind = 'file';

-- Uses of a symbol: not its Definition (SCIP role bit 1) and not an identifier inside
-- an `export { a }` clause (that is the export surface, not a use).
CREATE VIEW ref_occurrences AS
SELECT symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id, is_external
FROM occurrences
WHERE (role & 1) = 0 AND is_export_site = 0;

-- PLAN.md §6.5 test globs, extended with test support dirs/files (mocks, fixtures,
-- e2e, schemas, specs, stories). The SAME lists as packages/core/src/globs.ts
-- (TEST_GLOBS / DOCS_GLOBS): test/globs.test.ts parses the GLOB patterns below and
-- asserts equality, so edit both together. A `**/<file pattern>` glob is matched
-- against the base name (everything after the last '/'; GLOB's * crosses '/'), a
-- `**/<dir>/**` glob against '/' || file so a leading segment is optional
-- (test/x.ts and src/test/x.ts both match).
CREATE VIEW test_files (package_id, file) AS
SELECT package_id, file
FROM documents
WHERE substr(file, length(rtrim(file, replace(file, '/', ''))) + 1) GLOB '*.test.*'
   OR substr(file, length(rtrim(file, replace(file, '/', ''))) + 1) GLOB '*_test.dart'
   OR substr(file, length(rtrim(file, replace(file, '/', ''))) + 1) GLOB '*.spec.*'
   OR substr(file, length(rtrim(file, replace(file, '/', ''))) + 1) GLOB '*_test.*'
   OR substr(file, length(rtrim(file, replace(file, '/', ''))) + 1) GLOB '*.stories.*'
   OR ('/' || file) GLOB '*/test/*'
   OR ('/' || file) GLOB '*/__tests__/*'
   OR ('/' || file) GLOB '*/mocks/*'
   OR ('/' || file) GLOB '*/__mocks__/*'
   OR ('/' || file) GLOB '*/fixtures/*'
   OR ('/' || file) GLOB '*/__fixtures__/*'
   OR ('/' || file) GLOB '*/e2e/*'
   OR ('/' || file) GLOB '*/test-integration/*'
   OR ('/' || file) GLOB '*/__schemas__/*';

-- Docs globs: docs and in-package examples / demos.
CREATE VIEW doc_files (package_id, file) AS
SELECT package_id, file
FROM documents
WHERE ('/' || file) GLOB '*/docs/*'
   OR ('/' || file) GLOB '*/examples/*'
   OR ('/' || file) GLOB '*/example/*'
   OR ('/' || file) GLOB '*/demo/*';

-- Structural owner of a symbol: its descriptor parent (Foo#bar(). -> Foo#), or the
-- declaration whose body contains its definition (e.g. an object-literal property
-- scip-typescript names `tag0:` inside function Widget). File pseudo-symbols are not
-- owners: a module does not keep its top-level declarations alive.
CREATE VIEW symbol_owners (symbol_id, owner_id) AS
SELECT symbol_id, parent_symbol_id
FROM symbols
WHERE parent_symbol_id IS NOT NULL
UNION
SELECT o.symbol_id, o.enclosing_symbol_id
FROM occurrences o
JOIN symbols s ON s.symbol_id = o.symbol_id
JOIN symbols e ON e.symbol_id = o.enclosing_symbol_id
WHERE (o.role & 1) = 1
  AND o.enclosing_symbol_id <> o.symbol_id
  AND e.package_id = s.package_id
  AND o.enclosing_symbol_id NOT IN (SELECT symbol_id FROM module_symbols);

-- Transitive owners: (symbol, every declaration it is nested in).
CREATE VIEW symbol_ancestors (symbol_id, ancestor_id) AS
WITH RECURSIVE anc (symbol_id, ancestor_id) AS (
  SELECT symbol_id, owner_id FROM symbol_owners
  UNION
  SELECT a.symbol_id, o.owner_id
  FROM anc a JOIN symbol_owners o ON o.symbol_id = a.ancestor_id
)
SELECT symbol_id, ancestor_id FROM anc;

-- Uses of a symbol with the uses of its members folded in: an occurrence of S also
-- counts for every ancestor A of S (symbol_ancestors), at the same position, from the
-- same enclosing symbol. A member cannot be used without its owner existing (Dart
-- `3.doubled` names only IntTimes#`<get>doubled`., TS `o.label` only
-- WidgetOptions#label.), so an owner whose members are used is not unused. Fail
-- closed: this only ever adds references. `member_symbol_id` is the symbol the
-- occurrence actually names (= symbol_id for a direct use). An owner may count the
-- same source position several times (once per used member): consumers check
-- existence, and `n` is a count of occurrences, not of distinct positions.
CREATE VIEW owner_ref_occurrences AS
SELECT symbol_id, symbol_id AS member_symbol_id, package_id, file, line, col, enclosing_symbol_id, is_external
FROM ref_occurrences
UNION ALL
SELECT a.ancestor_id, r.symbol_id, r.package_id, r.file, r.line, r.col, r.enclosing_symbol_id, r.is_external
FROM ref_occurrences r
JOIN symbol_ancestors a ON a.symbol_id = r.symbol_id;

-- Cross-package uses (members count for their owners), tagged with whether the using
-- file is a test / docs file.
CREATE VIEW external_ref_occurrences AS
SELECT r.symbol_id, r.member_symbol_id, r.package_id AS consumer_package_id, r.file, r.line, r.col,
       t.file IS NOT NULL AS in_test,
       d.file IS NOT NULL AS in_docs
FROM owner_ref_occurrences r
LEFT JOIN test_files t ON t.package_id = r.package_id AND t.file = r.file
LEFT JOIN doc_files d ON d.package_id = r.package_id AND d.file = r.file
WHERE r.is_external = 1;

-- sentei.json extraEdges (PLAN.md §7): an explicit "this file uses that symbol".
-- They count as references (cross-package -> external, same package -> internal) so
-- an overlay keeps its target alive, never the other way round. Like any use, an
-- overlay onto a member also counts for the member's ancestors.
CREATE VIEW overlay_refs (symbol_id, from_package_id, is_external) AS
SELECT to_symbol_id, from_package_id, from_package_id <> to_package_id
FROM edges
WHERE source = 'overlay'
UNION ALL
SELECT a.ancestor_id, e.from_package_id, e.from_package_id <> e.to_package_id
FROM edges e
JOIN symbol_ancestors a ON a.symbol_id = e.to_symbol_id
WHERE e.source = 'overlay';

-- Counted cross-package references per consumer package. Test files count only with
-- countTestsAsConsumers, docs files only with countDocsAsConsumers.
CREATE VIEW external_refs (symbol_id, consumer_package_id, n) AS
SELECT symbol_id, consumer_package_id, count(*)
FROM (
  SELECT e.symbol_id, e.consumer_package_id
  FROM external_ref_occurrences e, analysis_params p
  WHERE (NOT e.in_test OR p.count_tests) AND (NOT e.in_docs OR p.count_docs)
  UNION ALL
  SELECT symbol_id, from_package_id FROM overlay_refs WHERE is_external
)
GROUP BY symbol_id, consumer_package_id;

-- Same-package uses (members count for their owners), excluding self-references: a
-- use enclosed by the symbol itself or by anything nested in it (a recursive function
-- used nowhere else has none; a method using its own class, or a sibling member, is
-- not a use of the class). Tagged like external_ref_occurrences: the package's own
-- tests are no more a consumer than another package's tests.
CREATE VIEW internal_ref_occurrences AS
SELECT r.symbol_id, r.member_symbol_id, r.package_id, r.file, r.line, r.col,
       t.file IS NOT NULL AS in_test,
       d.file IS NOT NULL AS in_docs
FROM owner_ref_occurrences r
LEFT JOIN symbol_ancestors a
  ON a.symbol_id = r.enclosing_symbol_id AND a.ancestor_id = r.symbol_id
LEFT JOIN test_files t ON t.package_id = r.package_id AND t.file = r.file
LEFT JOIN doc_files d ON d.package_id = r.package_id AND d.file = r.file
WHERE r.is_external = 0
  AND r.enclosing_symbol_id IS NOT r.symbol_id
  AND a.symbol_id IS NULL;

-- Counted same-package uses, under the same test/docs policy as external_refs (an
-- export used only by its own package's tests is a deletion with only_test_refs, not
-- an unexport).
CREATE VIEW internal_refs (symbol_id, n) AS
SELECT symbol_id, count(*)
FROM (
  SELECT i.symbol_id
  FROM internal_ref_occurrences i, analysis_params p
  WHERE (NOT i.in_test OR p.count_tests) AND (NOT i.in_docs OR p.count_docs)
  UNION ALL
  SELECT symbol_id FROM overlay_refs WHERE NOT is_external
)
GROUP BY symbol_id;

-- Symbols with uses in excluded test files (any package, including their own) and no
-- counted cross-package use: the report can say "delete the tests too" (reason
-- only_test_refs). Counted internal uses may coexist (unexport + only_test_refs).
CREATE VIEW test_only_refs (symbol_id) AS
SELECT e.symbol_id
FROM external_ref_occurrences e, analysis_params p
WHERE e.in_test AND NOT p.count_tests
UNION
SELECT i.symbol_id
FROM internal_ref_occurrences i, analysis_params p
WHERE i.in_test AND NOT p.count_tests
EXCEPT
SELECT symbol_id FROM external_refs;

-- ---------------------------------------------------------------------------
-- Policy filters
-- ---------------------------------------------------------------------------

-- Old enough to act on. Unknown age with a positive minAgeDays is NOT ok (fail closed).
CREATE VIEW symbol_age_ok (symbol_id) AS
SELECT s.symbol_id
FROM symbols s, analysis_params p
WHERE p.min_age_days = 0
   OR (s.first_seen_at IS NOT NULL AND p.now IS NOT NULL
       AND s.first_seen_at <= p.now - p.min_age_days * 86400);

-- sentei.json `keep`: '*' or the exact symbol name, per package.
CREATE VIEW kept_symbols (symbol_id) AS
SELECT DISTINCT s.symbol_id
FROM symbols s
JOIN keep_rules k ON k.package_id = s.package_id
WHERE k.symbol_name = '*' OR k.symbol_name = s.name;

-- ---------------------------------------------------------------------------
-- Reachability (PLAN.md §6.3.6). One recursion shape, used with three seed sets:
--   reachable        seeds reach_seeds_before
--   reachable_after  seeds reach_seeds_after (= before minus candidate_symbols)
--   candidate_reach  seeds each candidate separately, keyed by origin
-- ---------------------------------------------------------------------------

-- Intra-package graph: same-package edges, owner -> nested declaration, and nested
-- declaration -> owner. The last one: using a member requires its owner (`new X()`
-- names only X#<constructor>()., `o.label` only the property), so a reachable member
-- makes its owner reachable, and with it every sibling member (fail closed).
CREATE VIEW reach_edges (from_symbol_id, to_symbol_id) AS
SELECT from_symbol_id, to_symbol_id FROM edges WHERE from_package_id = to_package_id
UNION
SELECT owner_id, symbol_id FROM symbol_owners
UNION
SELECT symbol_id, owner_id FROM symbol_owners;

-- Exported symbols + the file pseudo-symbols of entry documents.
CREATE VIEW reach_seeds_before (symbol_id) AS
SELECT symbol_id FROM symbols WHERE is_exported = 1
UNION
SELECT module_symbol_id FROM documents WHERE is_entry = 1 AND module_symbol_id IS NOT NULL;

CREATE VIEW reachable (symbol_id) AS
WITH RECURSIVE reach (symbol_id) AS (
  SELECT symbol_id FROM reach_seeds_before
  UNION
  SELECT e.to_symbol_id FROM reach_edges e JOIN reach r ON e.from_symbol_id = r.symbol_id
)
SELECT symbol_id FROM reach;

-- ---------------------------------------------------------------------------
-- Verdicts for exported symbols (PLAN.md §6.5)
-- ---------------------------------------------------------------------------

-- Why a package gets no verdict: an opaque manifest consumer (schema view
-- blocked_packages) or the package itself being opaque (its own index is partial /
-- dynamic, so its internal references are uncertain). Only untargeted flags make the
-- package itself opaque (same rule as the schema view opaque_packages).
CREATE VIEW verdict_blockers (package_id, blocker_package_id, flag) AS
SELECT package_id, blocker_package_id, flag FROM blocked_packages
UNION
SELECT package_id, package_id, flag FROM package_flags WHERE target_package_id IS NULL;

-- Default exports of a runtime entry: S is exported as `default` (symbol_exports) from
-- an entry file of an APP package P (packages.is_library = 0: no exports/types/module in
-- package.json, no lib/*.dart) that no org package declares a dependency on
-- (package_deps.resolved_package_id = P is empty). A library's default export with no
-- org consumer is a candidate like any other export. A Workers / Lambda / Vite app's
-- `export default app` (and a Durable Object class exported alongside it) is consumed
-- by the runtime, not by code we can see. Such symbols get no verdict; they stay
-- reachability seeds (they are exported). Named exports of the same entry stay
-- candidates. symbol_exports.entry_file is the sidecar's entry, always an entry point.
CREATE VIEW runtime_entry_defaults (symbol_id) AS
SELECT DISTINCT x.symbol_id
FROM symbol_exports x
JOIN symbols s ON s.symbol_id = x.symbol_id
JOIN packages p ON p.package_id = s.package_id
WHERE x.exported_as = 'default'
  AND p.is_library = 0
  AND NOT EXISTS (SELECT 1 FROM package_deps d WHERE d.resolved_package_id = s.package_id);

-- Decision tree, per exported symbol S of package P not kept, not a runtime entry
-- default (runtime_entry_defaults) and with no counted external reference (those are
-- alive: no row):
--   internal refs > 0:  closed_world & age ok -> unexport_candidate [internal_refs_only]
--                       not closed_world      -> deprecation_candidate [internal_refs_only, open_world]
--                       closed_world, young   -> no row
--   no refs:            closed_world & age ok -> needs_review [no_refs, witness_pending]
--                                                (the witness stage turns it into deletion_candidate)
--                       not closed_world      -> deprecation_candidate [no_refs, open_world]
--                       closed_world, young   -> no row
-- no_refs becomes only_test_refs when the only uses (same-package or cross-package) are
-- in excluded test files (and only_test_refs is appended after internal_refs_only in the
-- first branch when there are also excluded test uses).
-- Any would-be verdict in a package with a verdict_blockers row becomes `blocked`,
-- keeping the base reasons, with blocked_by = sorted distinct '<blocker>:<flag>'.
-- The age rule gates only closed-world verdicts, exactly as in the §6.5 tree.
CREATE VIEW verdicts (symbol_id, verdict, reasons, blocked_by) AS
WITH base AS (
  SELECT s.symbol_id, s.package_id,
         EXISTS (SELECT 1 FROM internal_refs i WHERE i.symbol_id = s.symbol_id) AS has_internal,
         EXISTS (SELECT 1 FROM test_only_refs t WHERE t.symbol_id = s.symbol_id) AS test_only,
         EXISTS (SELECT 1 FROM closed_world_packages c WHERE c.package_id = s.package_id) AS closed,
         EXISTS (SELECT 1 FROM symbol_age_ok g WHERE g.symbol_id = s.symbol_id) AS age_ok
  FROM symbols s
  WHERE s.is_exported = 1
    AND NOT EXISTS (SELECT 1 FROM external_refs x WHERE x.symbol_id = s.symbol_id)
    AND NOT EXISTS (SELECT 1 FROM kept_symbols k WHERE k.symbol_id = s.symbol_id)
    AND NOT EXISTS (SELECT 1 FROM runtime_entry_defaults r WHERE r.symbol_id = s.symbol_id)
),
classified AS (
  SELECT symbol_id, package_id,
         CASE
           WHEN closed AND age_ok AND has_internal THEN 'unexport_candidate'
           WHEN closed AND age_ok THEN 'needs_review'
           WHEN NOT closed THEN 'deprecation_candidate'
         END AS verdict,
         CASE
           WHEN has_internal AND test_only THEN json_array('internal_refs_only', 'only_test_refs')
           WHEN has_internal THEN json_array('internal_refs_only')
           WHEN test_only THEN json_array('only_test_refs')
           ELSE json_array('no_refs')
         END AS base_reasons
  FROM base
),
blockers AS (
  SELECT package_id, json_group_array(blocker ORDER BY blocker) AS blocked_by
  FROM (SELECT DISTINCT package_id, blocker_package_id || ':' || flag AS blocker FROM verdict_blockers)
  GROUP BY package_id
)
SELECT c.symbol_id,
       CASE WHEN b.package_id IS NOT NULL THEN 'blocked' ELSE c.verdict END,
       CASE
         WHEN b.package_id IS NOT NULL THEN c.base_reasons
         WHEN c.verdict = 'needs_review' THEN json_insert(c.base_reasons, '$[#]', 'witness_pending')
         WHEN c.verdict = 'deprecation_candidate' THEN json_insert(c.base_reasons, '$[#]', 'open_world')
         ELSE c.base_reasons
       END,
       coalesce(b.blocked_by, json_array())
FROM classified c
LEFT JOIN blockers b ON b.package_id = c.package_id
WHERE c.verdict IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Private dead code (PLAN.md §6.5, second half)
-- ---------------------------------------------------------------------------

-- Exports that the verdicts propose to delete or unexport: they stop being seeds.
CREATE VIEW candidate_symbols (symbol_id, package_id, name) AS
SELECT s.symbol_id, s.package_id, s.name
FROM verdicts v
JOIN symbols s ON s.symbol_id = v.symbol_id
WHERE v.verdict = 'unexport_candidate'
   OR (v.verdict = 'needs_review'
       AND EXISTS (SELECT 1 FROM json_each(v.reasons) j WHERE j.value = 'witness_pending'));

CREATE VIEW reach_seeds_after (symbol_id) AS
SELECT symbol_id FROM reach_seeds_before
EXCEPT
SELECT symbol_id FROM candidate_symbols;

CREATE VIEW reachable_after (symbol_id) AS
WITH RECURSIVE reach (symbol_id) AS (
  SELECT symbol_id FROM reach_seeds_after
  UNION
  SELECT e.to_symbol_id FROM reach_edges e JOIN reach r ON e.from_symbol_id = r.symbol_id
)
SELECT symbol_id FROM reach;

-- What each candidate reaches that nothing else still reaches (the walk stops at
-- symbols in reachable_after, which cannot be unlocked by anything).
CREATE VIEW candidate_reach (origin_id, symbol_id) AS
WITH RECURSIVE reach (origin_id, symbol_id) AS (
  SELECT symbol_id, symbol_id FROM candidate_symbols
  UNION
  SELECT r.origin_id, e.to_symbol_id
  FROM reach_edges e JOIN reach r ON e.from_symbol_id = r.symbol_id
  WHERE e.to_symbol_id NOT IN (SELECT symbol_id FROM reachable_after)
)
SELECT origin_id, symbol_id FROM reach;

-- Symbols that may be reported private_dead: never exported, never a file symbol,
-- never an anonymous-literal member (kind 'anonymous-member', set by ingest: members of
-- an anonymous object/type literal live and die with whatever contains it), not defined in a test/docs file (not entry points, so everything in them is
-- "unreachable"), not kept, and in a package we can see into (not opaque, not
-- blocked) that has at least one reachability seed (no entry and no export means
-- the entry points are unknown, not that everything is dead).
CREATE VIEW private_dead_eligible (symbol_id) AS
SELECT s.symbol_id
FROM symbols s
WHERE s.is_exported = 0
  AND s.symbol_id NOT IN (SELECT symbol_id FROM module_symbols)
  AND s.kind IS NOT 'anonymous-member'
  AND NOT EXISTS (SELECT 1 FROM test_files t WHERE t.package_id = s.package_id AND t.file = s.file)
  AND NOT EXISTS (SELECT 1 FROM doc_files d WHERE d.package_id = s.package_id AND d.file = s.file)
  AND s.symbol_id NOT IN (SELECT symbol_id FROM kept_symbols)
  AND s.package_id NOT IN (SELECT package_id FROM opaque_packages)
  AND s.package_id NOT IN (SELECT package_id FROM verdict_blockers)
  AND (EXISTS (SELECT 1 FROM symbols x WHERE x.package_id = s.package_id AND x.is_exported = 1)
       OR EXISTS (SELECT 1 FROM documents d WHERE d.package_id = s.package_id AND d.is_entry = 1));

-- Already dead before any removal: the private islands per-repo lints miss.
CREATE VIEW unreachable_before (symbol_id) AS
SELECT symbol_id FROM private_dead_eligible
WHERE symbol_id NOT IN (SELECT symbol_id FROM reachable);

-- Reachable now, unreachable once the candidates are gone, with the candidates
-- that unlock it.
CREATE VIEW private_dead_unlocked (symbol_id, reasons) AS
SELECT symbol_id, json_group_array(reason ORDER BY reason)
FROM (
  SELECT DISTINCT cr.symbol_id, 'unlocked_by:' || c.name AS reason
  FROM candidate_reach cr
  JOIN candidate_symbols c ON c.symbol_id = cr.origin_id
  WHERE cr.symbol_id IN (SELECT symbol_id FROM private_dead_eligible)
    AND cr.symbol_id IN (SELECT symbol_id FROM reachable)
    AND cr.symbol_id NOT IN (SELECT symbol_id FROM reachable_after)
)
GROUP BY symbol_id;

-- The private_dead findings. Only the outermost declaration is reported: a symbol is
-- dropped when a declaration it is nested in (symbol_ancestors) is itself reported
-- or is a candidate (a class's members go with the class). Members of a live
-- exported class are reachable through the owner edge and never get here.
CREATE VIEW private_dead (symbol_id, verdict, reasons, blocked_by) AS
WITH dead (symbol_id, reasons) AS (
  SELECT symbol_id, json_array('already_unreachable') FROM unreachable_before
  UNION ALL
  SELECT symbol_id, reasons FROM private_dead_unlocked
)
SELECT d.symbol_id, 'private_dead', d.reasons, json_array()
FROM dead d
WHERE NOT EXISTS (
  SELECT 1 FROM symbol_ancestors a
  WHERE a.symbol_id = d.symbol_id
    AND (a.ancestor_id IN (SELECT symbol_id FROM dead)
         OR a.ancestor_id IN (SELECT symbol_id FROM candidate_symbols))
);
