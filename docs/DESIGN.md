# sentei design notes

Running record of decisions and deviations from `PLAN.md`. Newest milestone last.

## Decisions

### M0 (skeleton + schema)

- **TEXT[] as JSON.** SQLite has no arrays. `packages.entry_points`,
  `findings.reasons`, `findings.blocked_by` are `TEXT NOT NULL DEFAULT '[]'` with
  `CHECK (json_valid(x) AND json_type(x) = 'array')`.
- **Timestamps are INTEGER epoch seconds (UTC).** `repos.indexed_at`,
  `symbols.first_seen_at` (git author-time is already epoch seconds),
  `witness_ok.checked_at`.
- **`occurrences.def_package_id` denormalization.** SQLite rejects the planned
  generated column (`subqueries prohibited in generated columns`, verified on
  SQLite 3.53.4). `def_package_id` is stored on insert and
  `is_external = (package_id <> def_package_id)` is a STORED generated column.
  Trigger `occurrences_def_package_matches` (insert + update) aborts on drift and
  uses `IS NOT`, so an occurrence whose symbol does not exist yet is rejected too:
  **ingest must insert symbols before their occurrences**, even under
  `defer_foreign_keys`. `symbols_package_immutable` forbids moving a symbol.
  The same rule is applied to `edges.{from,to}_package_id` (`edges_packages_match`).
- **Policy table + views split.** Org policy lives in `policy(key, value)` with
  JSON-encoded values; keys are CHECK-restricted so typos fail. Defaults from
  §6.5 are seeded with `INSERT OR IGNORE` (the one allowed use; never on
  symbols/packages). Rules that read policy are views: `closed_world_packages`,
  `opaque_packages`, `blocked_packages`. A missing policy key reads as false
  (fail closed). The `findings` triggers read those views, so e.g. setting
  `assumeClosedWorld = true` immediately admits deletion verdicts for public
  packages. `keep` list lives in `keep_rules` (`'*'` = whole package).
- **Opaque = any `package_flags` row.** `unindexed_consumer` is included in the
  flag CHECK and counts as opaque, same as the four flags listed in §6.5.
- **`findings` is insert-only** (`findings_insert_only`), so the §5.1 guards
  cannot be bypassed via `UPDATE`. Re-analysis deletes and re-inserts.
- **Extra verdicts** `needs_review` and `version_skew` are in the verdict CHECK
  (§8/§9 need them). `findings` PK is `(symbol_id, verdict)`.
- **`package_deps.constraint` → `dep_constraint`** (reserved word).
- **Schema versioning.** Every statement is `IF NOT EXISTS`; `openDb` stamps
  `PRAGMA user_version = 1` and refuses a DB stamped with a different version.
  Work DBs are rebuilt, not migrated.
- **Native Node type stripping, no tsx/ts-node.** Node 26 runs `.ts` directly;
  tsconfig has `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noEmit`,
  `allowImportingTsExtensions`, `module/moduleResolution: nodenext`. Imports use
  explicit `.ts`. No enums, no parameter properties. `@sentei/core` exports point
  at `.ts` sources; this works because workspaces are symlinks whose real path
  is outside `node_modules` (Node refuses to strip types under `node_modules`).
- **Toolchain versions (exact pins):** typescript 7.0.2 (the native `tsc`),
  vitest 5.0.1, @types/node 26.6.2. `npm run typecheck` runs `tsc -p .` per
  workspace (no project references: `composite` wants emit, we use `noEmit`).
- **CLI** opens (and so creates) the DB for every subcommand, including no-op
  stages, so a broken schema fails at the first command.

### Open concern (for ingest, M1)

`package_deps.resolved_package_id` is `ON DELETE SET NULL`. Re-indexing repo R
(delete + insert) nulls the links *from other repos' consumers* to R's packages,
which would silently drop blockers from `blocked_packages` (fail open). Ingest
must re-resolve `resolved_package_id` for all `package_deps` rows in the same
transaction that re-inserts R's packages.
