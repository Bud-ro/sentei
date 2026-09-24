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

### M1 — discover (local org directory)

- **Whole-org rebuild.** `writeDiscoverToDb` runs `DELETE FROM repos` (the cascade
  root) and re-inserts everything in one transaction. This resolves the M0
  concern about `package_deps.resolved_package_id ON DELETE SET NULL` dropping
  blockers when one repo is re-indexed: discover never re-indexes one repo, so
  cross-repo links are always rebuilt together. `index` is the cached, per-repo,
  expensive stage; `discover` and `ingest` are cheap and always whole-org.
- **Unknown keys in `sentei.json` are errors** (org and repo level), as are wrong
  types and malformed `keep` entries. A typo like `extraEntryPoint` would
  otherwise silently drop entry points and make live code look dead. Per-repo
  policy overrides (PLAN §6.5 "overridable per repo") are therefore rejected for
  now; only overlays (`extraEntryPoints`, `extraEdges`, `keep`) are per-repo.
- **Malformed manifests are hard errors** naming the file (skipping one could
  hide a consumer). Real orgs may need a deny-list for intentionally broken
  test-fixture manifests; revisit in M2.
- **Every nested `package.json`/`pubspec.yaml` is an org package**, including ones
  under `test/fixtures/`. In real orgs this may produce spurious duplicate-name
  errors; revisit in M2 with evidence.
- **npm entry points** go beyond §6.3: each declared path is tried as-is, then
  with Node-style extension/`index` probing, then with a dist→src mapping
  (`dist|lib|build|out/x.js` → `src/x.ts[x]`) so unbuilt TS repos still resolve.
  `exports` `*` patterns are globbed against the filesystem (a `*` may span
  slashes, as in Node). Non-code targets (`./package.json`) are ignored.
- **npm deps:** `dependencies`, `peerDependencies`, `optionalDependencies`, then
  `devDependencies`; first occurrence wins; the dev/prod distinction is not
  stored. npm aliases (`"x": "npm:@acme/a@^1"`) resolve to the alias target.
  `registry.yarnpkg.com` counts as the public registry.
- **pubspec YAML** is read by a ~100-line subset parser (block maps, scalars,
  comments, one-line flow maps); block sequences and block scalars are skipped.
  No yaml dependency.

### M1 — indexing model (settled by experiment, see `packages/cli/src/indexers/`)

- **Org dependencies are source-linked.** Before indexing a consumer, every
  manifest dep that resolves to an org package gets `node_modules/<name>`
  symlinked to that package's checkout at HEAD. scip-typescript then emits the
  consumer's references with exactly the lib's own definition symbol strings
  (`scip-typescript npm @acme/core 1.0.0 src/\`fns.ts\`/usedFn().`), so
  cross-repo linking is an exact string match, and the analysis is always
  "does anyone use the lib *as it is at HEAD*". The installed/published copy is
  never what gets indexed. Consequence: libs whose `types` point at unbuilt
  `dist/` output must be built first or their consumers fail to resolve them
  (which fails closed: the consumer becomes `partial`/opaque).
- **Symbol versions are normalized to `.`** at ingest so a consumer that somehow
  sees a different version string still links.
- **SCIP carries no export information** (scip-typescript gives non-exported
  top-level declarations global symbols too), so the TypeScript indexer adapter
  emits a sidecar `<pkg>.exports.json` computed with the TypeScript compiler API
  (`checker.getExportsOfModule` per entry point, aliases followed to the
  declaration). This is language-specific but lives inside the indexer boundary
  (§6.6), not in `analyze`. The sidecar also records **export sites** (the
  identifier positions inside `export { a }` / `export { a as b } from` clauses)
  because those SCIP occurrences would otherwise count as internal references
  and turn every re-exported symbol into an `unexport_candidate`.
