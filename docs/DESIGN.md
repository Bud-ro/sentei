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

### M1 — index refinements (learned from running the fixture)

- **Links before indexing.** Module resolution is transitive: a consumer that
  resolves org package A also resolves A's own org imports through A's
  `node_modules`. The index stage therefore runs `Indexer.prepare` (install +
  source links) for every org package, cached repos included, before running any
  indexer. Indexing per package as it went produced wrong symbols for
  `export { yThing as widgetY } from '@acme/y'` when the consumer was indexed
  before the re-exporting lib.
- **Type errors do not make a consumer opaque.** PLAN §6.2's "any diagnostic of
  severity error → partial" is applied to the indexer's own diagnostics only.
  For our TypeScript program, only resolution failures can hide references, so
  the adapter checks syntactically (with checker resolution, never by parsing
  messages): an **org module specifier that does not resolve** → `partial`
  (`opaque_consumer`, fail closed); a **named import an org module does not
  export** → sidecar `unresolvedImports` → `unresolved_refs` → reported as
  `version_skew`, status unchanged; every other compiler error is a warning.
  Without this, the fixture's version-skew consumer would have blocked every
  verdict for the lib it imports, and most real repos would be opaque.
- **Consumer flags come from the adapter, not from `analyze`.** `namespace_dynamic`
  (a value use of `import * as X from '<org pkg>'` other than `X.member` /
  `X['lit']`) and `dynamic_access` (`require()`/`import()` with a non-literal
  specifier unless its leading literal is a relative or absolute path) are
  detected by a syntax walk in `packages/cli/src/indexers/consumer-checks.ts`
  and written to the sidecar; ingest turns them into `package_flags`.

### M1 — ingest

- **Whole org, one transaction.** PLAN §5.1 says one repo per transaction, but
  consumer occurrences reference symbols defined in other repos' indexes, so
  ingest processes all definitions (pass 1) before all references (pass 2) and
  commits once. `defer_foreign_keys` is on; `foreign_key_check` runs before
  commit. The drift trigger on `occurrences.def_package_id` requires symbols to
  exist first, which the two-pass order guarantees.
- **Only org symbols are stored.** Symbols of third-party packages and the
  TypeScript lib are never interned; occurrences referencing them are dropped.
  Parameters, type parameters and `local N` symbols are skipped too (otherwise
  every parameter of a dead function would be a `private_dead` finding).
- **Enclosing symbol** = innermost definition in the same document whose SCIP
  `enclosing_range` contains the occurrence; scip-typescript 0.4.0 emits it for
  declarations. Fallback is the file's module symbol (scip-typescript emits one
  per module; a synthetic `sentei file <pkg> <file>` symbol is created otherwise).
- **Parents** (`Foo#bar().` → `Foo#`) are only non-namespace descriptors, and
  ingest adds `parent → member` edges so members are reachable when their owner
  is. Files are never parents: a module→top-level edge would make private
  islands reachable.
- **Import bindings are role-0 references** in scip-typescript (the `Import`
  role is never set), so an entry module's imports make module→symbol edges.
  Combined with entry modules being reachability seeds, anything imported by an
  entry file stays alive even if only dead code uses it. Fail-closed; the
  sidecar records import bindings on the export chain as sites to limit this.
- **`SymbolInformation.kind` is always 0** in scip-typescript 0.4.0 output, so
  `symbols.kind` is empty for TypeScript. Nothing depends on it yet.
- **Anonymous default exports get no SCIP symbol at all** (`export default () =>
  ...`); an importer's default import is a `local`. Ingest creates a synthetic
  `sentei default <pkg> <file>` symbol from the sidecar record and treats every
  reference to that file's module symbol as a reference to it (any import of
  the file keeps the default alive; over-approximation). This borders on the
  "do not patch the indexer" rule but derives only from our own sidecar.
- **Version skew**: a consumer's `import { removedFn }` comes out of SCIP as
  `local 0`, so SCIP cannot report it; only the sidecar's `unresolvedImports`
  can. Both paths land in `unresolved_refs`.
- **Ingest owns four flags** (`opaque_consumer`, `index_failed`,
  `dynamic_access`, `namespace_dynamic`) and rebuilds them each run; no
  `index.json` / missing package / missing `.scip` → `index_failed`; missing
  exports sidecar → `opaque_consumer` (an unknown export surface would be
  fail-open otherwise).

### M1 — analyze

- **Rules live in `packages/core/sql/analyze.sql`, not `schema.sql`.** Changing a
  rule must not bump `SCHEMA_VERSION`. The file drops and recreates every view on
  each run, so a work DB built by an older sentei never answers with a stale rule.
  Per-run inputs that are not policy (`now`) go in a tiny `run_params` table so
  the views stay parameter-free. Debug a verdict with
  `SELECT * FROM verdicts v JOIN symbols s USING (symbol_id) WHERE s.name = ?`.
- **Analyze never inserts `deletion_candidate`.** The schema trigger requires
  `witness_ok`; analyze emits `needs_review` + `witness_pending`, and the witness
  stage promotes or downgrades. So the pipeline order is analyze → witness → report
  and a report can never contain an unwitnessed deletion.
- **`blocked` verdict** (added to the CHECK): a symbol that would have had a
  verdict in a package with an opaque consumer, or in a package that is itself
  opaque (`blocked_by` names `<package>:<flag>` in both cases). Reasons carry the
  base reason only, so the report can say what the verdict would have been.
- **Owners.** A symbol's structural owner is its descriptor parent or the
  declaration whose body contains its definition (scip-typescript names
  object-literal properties inside a function without a parent descriptor).
  Owner → member edges make members reachable with their owner; self-references
  through owners are excluded from internal refs; and only the outermost dead
  declaration is reported. Consequence: unused members of live exported classes
  are never reported in v1.
- **Age rule gates only closed-world verdicts** (as in the §6.5 tree). Unknown
  `first_seen_at` with a positive `minAgeDays` means no verdict (fail closed).
- **Overlay edges count as references** (external or internal by package), so
  `extraEdges` can keep an export alive.
- **Private-dead exclusions beyond the plan:** declarations in test and docs
  files (never entry points, so everything in them would be "unreachable"), kept
  symbols, packages with no seed at all (no entry document and no export means
  the entry points are unknown, not that everything is dead), and any package
  that is opaque or blocked.
- **Known noise source:** any file not reachable from an entry point (scripts,
  config files) yields `private_dead` rows for its declarations. That is the
  plan's design (list them in `extraEntryPoints`); M2 will show whether a default
  allow-list is needed.

### M1 — witness

- Runs only over `needs_review` rows carrying `witness_pending`; searches
  manifest-declared consumers (`package_deps`), never SCIP.
- Skips test/docs files under the same policy analyze uses, otherwise every
  `only_test_refs` candidate would be a mismatch.
- Anonymous default exports: matched only by a default import whose specifier
  subpath's last segment equals the defining file's basename (or a bare
  specifier), so `import anon from '@acme/widgets/anon'` does not vouch for
  `unused-anon.ts`. An `exports` map that renames a subpath is a known gap.
- Name search is `(?<!\w)NAME(?![\w$])` rather than `\b` so Dart `'$name'`
  interpolation still hits. Mismatch reasons are `witness_mismatch:<consumer>:<file>:<line>`
  (1-based line), capped at 5 per symbol.

### M1 — report

- `work/report.json` positions are 1-based; the DB stays 0-based (SCIP).
- `warnings` shouts about `assumeClosedWorld`, a disabled age policy, and repos
  whose index was partial/failed; the summary prints them in a banner first.
- Version skew is reported from `unresolved_refs`, keyed by the consumer, and is
  never a finding.
- Blockers are ranked by how many findings they block: the "fix that repo first"
  list.

### M1 — indexer gap found end to end

- scip-typescript 0.4.0 emits a `local` symbol for `W.member` when `W` is a
  namespace import and `member` reaches the entry through `export { member } from`
  (an alias export); `export *` members resolve fine. The witness caught it
  (`needs_review` + `witness_mismatch`), which is the fail-closed path working, but
  the symbol is in use. Workaround at the indexer boundary: the adapter records
  checker-resolved namespace member accesses in the sidecar
  (`namespaceMemberRefs`) and ingest adds the occurrence and edge when SCIP has
  none at that position.
