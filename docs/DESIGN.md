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
- **A use of a member is a use of its owner.** `owner_ref_occurrences` folds every
  reference into each ancestor of the referenced symbol (descriptor parents and
  body owners), so an extension whose getter is used, or a class whose method is
  called, is alive even though nothing names the owner. `n` may count one
  position several times (once per used member); verdicts only test existence.
- **Implicit constructors.** At ingest, a reference to an undefined
  `Owner#<constructor>()` whose owner is defined is recorded against the owner
  (Dart never defines implicit constructors). Any other missing member is real
  version skew and stays in `unresolved_refs`.
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

### M2 — blame

- One `git blame --porcelain <sha> -- <file>` per file holding exported symbols
  (not per symbol), at the discovered head sha; results are cached per repo under
  `work/blame/<repo>.json`, trusted only when the cache sha matches.
- **Every target symbol is reset to NULL before the update**, in the same
  transaction, so a symbol that cannot be dated this run (skipped repo, blame
  error) fails closed under the age rule instead of keeping a stale age. Because
  `ingest` rebuilds `symbols`, `blame` must run after every ingest; the cache
  makes that cheap.
- Shallow clones are unshallowed with `git fetch --unshallow --filter=blob:none`
  (fallback without the filter). Against a real GitHub remote the filter makes a
  partial clone, so blame may fetch old blobs on demand; untested at scale.
- Caveat carried into the report wording: blame dates the last edit of the
  definition line, not the symbol's creation (the safe direction).

### M2 — GitHub discovery

- **Plain `fetch` instead of `@octokit/rest`** (§11 allows octokit): listing,
  Link-header pagination and error handling are ~120 lines and add no
  dependency. Pagination links to another host are refused so the token only
  ever goes to the API host. Behind a proxy set `NODE_USE_ENV_PROXY=1`: Node's
  `fetch` ignores `HTTPS_PROXY` by default (git does not).
- **The token never enters argv, URLs or logs.** Clone auth goes through
  `GIT_CONFIG_COUNT/KEY_0/VALUE_0` as an `http.<origin>/.extraheader`
  (`basic x-access-token:<token>`, GitHub's documented form), scoped to the
  clone URL's origin and never written to `.git/config`.
- **Lockfile holds the full listing** (every non-archived repo, forks flagged);
  include/exclude/fork filters apply at run time, so changing filters never
  makes the lockfile stale. Rerunning from a lockfile makes zero API calls.
- **Forks are skipped by default** (`--include-forks`): they are usually other
  people's code and cause duplicate package names. Archived repos are dropped
  per §6.1; empty repos (no default-branch commit) are skipped with a log line.
- **Any clone failure aborts discover** (a missing consumer would make live code
  look dead). `ensureClone` never deletes a directory.
- **Real-org finding (honojs, 16 repos, 57 MB, ~5 s):** the §5.1 duplicate
  `(manager, name)` error fires on templates (`starter:templates/*`), fixtures
  (`agent-dx`), examples and a VS Code extension literally named `hono`. The
  policy adopted: manifests under fixture/template/example-style directories are
  not org packages (their files still belong to the enclosing package), the org
  `sentei.json` can extend that list (`ignoreManifestDirs`) or ignore specific
  manifests (`ignoreManifests` globs), and any remaining clash stays a hard error
  whose message lists copy-pasteable `ignoreManifests` entries.

### M5 — SARIF

- One log per repo at `work/sarif/<owner>__<repo>.sarif` (supersedes §6.7's
  `work/report.sarif` wording): Code Scanning uploads are per repo and commit.
  Every repo gets a log, even an empty one, so a clean upload closes old alerts.
- Locations are repo-relative under `%SRCROOT%`; the base URI is deliberately
  left undefined (description only) because sentei does not know where the
  consumer of the log checked the repo out, and `file:///` would be wrong.
- `partialFingerprints["senteiSymbol/v1"]` = sha256 of `<package>#<symbol>#<file>`
  (not the line), so moving code within a file keeps the alert identity;
  duplicate keys get `#n` suffixes in sort order.
- The vendored schema is the schemastore draft-07 copy (the OASIS copy is
  draft-04, which ajv 8 cannot load); it is slightly looser on `region`, which
  our output never relies on. `ajv` + `ajv-formats` are dev dependencies for
  tests only; the runtime validates nothing.
- Levels: `warning` for deletion, `note` for everything else. GitHub caps a run
  at 25 000 results; an unjs-scale org with many `private_dead` rows may need
  note-level rules dropped from the upload (not implemented).
- **M5 acceptance (a real upload) needs the repo owner:** `gh api -X POST
  repos/OWNER/REPO/code-scanning/sarifs` with the gzipped+base64 log,
  `commit_sha` = `runs[0].properties.headSha`, `ref`, `tool_name=sentei`; the
  token needs `security_events` (or `public_repo` for a public repo).

### M4 — discover hardening and unindexed consumers

- **Ignored manifests.** `fixtures`, `__fixtures__`, `templates`, `examples`,
  `benchmarks`, `playground`, `sandbox`, `__mocks__`, `test(s)`, `__tests__`
  and similar directory names (any depth) never hold org packages. Their files
  still belong to the enclosing package for indexing. Org `sentei.json`
  `ignoreManifestDirs` replaces the list; `ignoreManifests` globs
  (`<repo>/<manifest path>`) ignore specific manifests; the duplicate-name
  error prints copy-pasteable entries. Trade-off: consumer code under those
  directories is usually not indexed (an `include: ["src"]` tsconfig does not
  cover `examples/`), so it never adds references. To keep that from being
  fail-open, the text witness also scans ignored manifests that declare a
  dependency on the candidate's package (they can downgrade to `needs_review`,
  never add edges, per §12).
- **`unindexed_consumer`** is decided at discover from file extensions of
  programming languages we have no indexer for (`.py`, `.go`, `.rs`, `.java`,
  ...). Shell, YAML, JSON, Markdown and Dockerfiles are deliberately not code
  that can load an npm/pub package. Only packages that consume an org package
  are flagged. Known false positives (`.fs` GLSL shaders, `.c`/`.h` node-gyp
  addons) err toward blocking. The flag is written by discover and survives
  ingest, which rebuilds only its own four flags. PLAN §6.5's `opaque(P)` list
  omits `unindexed_consumer`; the schema views already treat every flag as
  opaque, which is the M4 behaviour.

### M3 — Dart evaluation (fixtures/org-dart)

Evaluated `scip_dart` against the §8 Dart checklist (details and evidence in
the M3 agent run; decoded outputs were compared across pub.dev 1.6.2, git
9dde7de, and 1.7.0).

- **Adequate on every §6.2 must-have:** `show`/`hide` (names are role-0
  references, on imports and on export directives), `part`/`part of` (parts are
  their own documents, symbols named by the part file), extension methods
  (`3.doubled` references `IntTimes#\`<get>doubled\`.`), `export 'src/x.dart'`
  (consumer references resolve to the declaring file's symbol). Cross-package
  linking is an exact string match when the dependency resolves to the source
  path (path dep, or `pubspec_overrides.yaml` `dependency_overrides` — the Dart
  equivalent of the npm source links).
- **Not adequate as released, three ways:** (1) private declarations become
  `local N` (`if (element.isPrivate) return _localSymbolFor(element)`), so
  private islands can never be found and references inside private bodies lose
  their enclosing symbol; (2) pub.dev 1.6.2 has no `enclosing_range`; (3) 1.6.2
  runs analyzer 5.13, which silently misparses Dart ≥3.3 syntax (dot shorthands,
  extension types). 1.7.0 fixes (2) and (3) but requires Dart ≥3.12 although
  analyzer 14.4 only needs 3.11; relaxing the constraint gives byte-identical
  output on 3.11.3.
- **Decision: vendor a fork of scip_dart 1.7.0** under `packages/indexers/scip-dart`
  with two patches (SDK constraint ≥3.11; private declarations as global
  symbols), recorded in `PATCHES.md`. Upgrading the dev box to Dart ≥3.12 would
  remove the first patch; that is Budro's call.
- **SCIP carries no export information for Dart either**, and §6.3's "public
  name in a `lib/` non-`src` file" rule is wrong for parts and `show`, so a
  `dart-surface` sidecar built on `LibraryElement.exportNamespace` is required,
  emitting the same sidecar shape as the TS adapter (export-directive `show`
  names as sites).
- **Two language-neutral pipeline changes** fell out: a reference to a member
  also counts for its owner (extension use never names the extension), and a
  reference to an undefined `<constructor>` member is attributed to the defined
  owner (implicit constructors are never defined; they were false version skew).
- scip_dart exits 0 on type errors and on unresolved `package:` imports
  (references silently vanish), so the adapter classifies resolution failures
  itself, like the TS adapter.

### M2 — first dogfood run on honojs (2026-09-24)

12 repos after excluding templates/examples/fixtures, 61 packages. Timings:
discover 0.35 s from the lockfile, index ~30 s, ingest 1 s, blame 60 s (four
unshallows), analyze/witness/report under 1 s each. Result: 0 deletion
candidates, 61 blocked findings, 12 `private_dead` rows of which every checked
one except a config file was a false "dead". M2 acceptance (spot-check 5 real
deletion candidates) is **not met yet**. What the run taught, and the fixes
adopted:

- **Solution-style tsconfig** (`"files": []` + `references`, hono itself): the
  export-surface program had no root files, all 119 entry points were "missing"
  and the org's main package was opaque. Fix: follow project references when
  building surface programs.
- **Unbuilt libraries**: source links point at checkouts whose `exports`/`types`
  target `dist/`, which a fresh clone lacks, so every consumer of hono was
  `partial`. Fix: when a linked package's declared targets are missing, the
  adapter creates a shadow package dir (rewritten `package.json` with the same
  dist→src rule discover uses, plus symlinks to the checkout's files) instead of
  a bare symlink; `realpath` still lands in the checkout so symbol strings are
  unchanged.
- **Monorepo module symbols**: the root index and the nested package's index both
  carry the nested files; the module-symbol check compared the descriptor path
  with the root index's relative path, so a synthetic file symbol shadowed the
  real module symbol, which became an orphan `private_dead` row and entry seeds
  never reached the file's code. Fix: compare package-relative paths and prefer
  the owning package's index when documents collide.
- **Config files outside any tsconfig** (`eslint.config.mjs` importing
  `@hono/eslint-config` in 8 repos) are unindexed consumers; `config` would have
  been a deletion candidate. Fix: the adapter text-scans JS/TS files that are in
  no program for org imports and the flag they produce is **targeted**
  (`package_flags.target_package_id`, schema v4): it blocks only the imported
  package, not everything the consumer depends on.
- **Members without an owner**: object-literal properties of a module-level
  const (`npm0:`) and anonymous type-literal members (`typeLiteral3:__html.`)
  have no parent in scip-typescript output and the owner's `enclosing_range`
  does not cover the initializer. Fix: counter-suffixed anonymous member names
  are a scip-typescript convention; they are never reported as declarations, and
  undefined references to them are attributed to the nearest defined ancestor
  (the counter differs per program, which also produced a false `version_skew`).
- **`new X()` only references `X#<constructor>()`**: nothing made `X` reachable
  from its member. Fix: member → owner edges in reachability.
- **`build/` directories were skipped by name**, hiding a real package
  (`packages/build`). Fix: in git checkouts, walk `git ls-files` (tracked plus
  untracked-not-ignored) instead of skipping directory names.
- **Same-package test refs** counted as internal refs, turning test-only exports
  into `unexport_candidate`. Fix: internal refs follow the same test/docs policy.
- **Package managers**: pnpm/yarn were missing; installs failed with a bare
  "exited with -1". Fix: fall back to `npm exec --yes <pm>@<version>` (from the
  `packageManager` field), recognise `bun.lock`, and never reuse a cached index
  whose status was partial/failed.
- Remaining public-API cases (`bunAdapter`, `nodeAdapter`, `createHono`) are
  exactly what `assumeClosedWorld` hides; they are correct under the flag and
  the banner says so.

### M1 — witness (addendum)

- Consumers of P are the manifest-declared ones **plus ignored manifests** whose
  deps resolve to P (examples, templates). Their hits read
  `witness_mismatch:ignored:<org>/<repo>/<manifest path>:<file>:<line>`; the
  `ignored:` prefix cannot collide with a package id. Unparseable ignored
  manifests are scanned for every package (deps unknown → fail closed).

### M3 — Dart indexer (as built)

- `packages/indexers/scip-dart` is the vendored fork (upstream tag 1.7.0,
  commit 8d017a2, Apache-2.0) with `PATCHES.md`; the adapter reports
  `1.7.0+sentei.N` and N is the cache key, bumped whenever the fork or
  `dart-surface` changes output. Tool `pubspec.lock` files are checked in so the
  analyzer version is pinned (§6.6), unlike the first draft which ignored them.
- `--private-symbols` is off by default in the fork (upstream behaviour
  unchanged) and always passed by the adapter. Local functions stay `local`
  even with the flag (descriptor collision with top-level names).
- Org deps are source-linked with `pubspec_overrides.yaml`
  (`dependency_overrides: {dep: {path: ...}}`); an original file is backed up
  once under `.sentei-backup/`; `pubspec.yaml` is never touched. `dart pub get
  --offline` when installs are off (fixtures have only path deps).
- `dart-surface` emits the same sidecar shape as the TS adapter from
  `LibraryElement.exportNamespace`; export-directive `show` names are sites;
  `hide` names have no record and stay internal references (fail closed);
  re-exports of other packages are not surface entries (consumers already
  reference the declaring package). Unresolved relative imports also make the
  package `partial` (internal references would otherwise vanish, fail-open to
  `private_dead`).
- **Entry symbols.** A Dart program's `main()` is invoked by the runtime and
  referenced by nothing, so `bin/main.dart#main` came out `private_dead`. The
  sidecar now carries `entrySymbols` (the indexer boundary knows what the
  runtime calls) and ingest adds a file → symbol edge, reachable but never
  exported. TypeScript emits an empty list.
- Flutter packages (`environment.flutter`, `sdk: flutter` deps, or an org
  dependency that is itself Flutter) are prepared with `flutter pub get` and
  indexed with the Flutter SDK's Dart (`--sdk-path <flutterRoot>/bin/cache/dart-sdk`,
  fork patch 5); the package config `flutter pub get` writes already points
  `flutter` and `sky_engine` into the SDK, so `package:flutter/material.dart`
  resolves. Without `flutter` on PATH such packages are `partial` with a clear
  diagnostic. Dart 3.13.4 needs no dependency changes (analyzer 14.4 covers
  language 3.14); snapshots are byte-identical between 3.11 and 3.13. Known
  gap: scip-dart emits no definitions for primary constructors or their
  fields, so those never get a verdict (errs toward no report).

### Known remaining noise (from the fixed honojs DB)

- 47 "document appears twice with different contents" warnings come from one
  index (`hono.scip`) containing the same file twice, the second copy carrying
  module augmentations declared in `*.test.ts`; the first copy is kept and
  those references are lost. Pre-existing; revisit if a spot-check blames it.
- Targeted `unindexed_consumer` flags with no manifest dependency still block
  their target (a hoisted workspace dependency is still a use).

### M2 — second honojs run (with installs): acceptance and spot checks

16 repos, 76 packages, 47/48 middleware packages `ok` once pnpm/yarn ran
(hono itself stayed partial: pnpm 12's store lock needs a writable home; the
sandbox forbids it). 978 exported symbols blamed; 93 deletion candidates, 242
unexport, 460 private_dead, 397 blocked. The witness passed all 93. Hand
spot-check of 11 deletion candidates: 1 truly dead (`ua-blocker#__test`),
7 public API hidden only by `assumeClosedWorld` (as designed), **3 wrong**:

| symbol | why the pipeline missed the use | fix adopted |
|---|---|---|
| `cloudflarePagesBuildPlugin`, `cloudflareWorkersBuildPlugin` (vite-build) | consumers do `import build from '@hono/vite-build/cloudflare-pages'`; the symbol is `export default cloudflarePagesBuildPlugin`, so the witness searched the identifier, not the default-import form | ingest records every exported alias (`symbol_exports`); the witness searches aliases and applies its default-import rule whenever a symbol is exported as `default` |
| `HonoXIsland` (honox) | honox's Vite plugin writes `import { HonoXIsland } from 'honox/vite/components'` into generated island files; the import exists only as a string at build time | self-witness: the defining package's own non-test sources are scanned for its own package name inside string literals that are not import statements; a symbol named in such a file is `needs_review` |

Also found: scip-typescript emits only `PracticalTask#grade().` for a shorthand
property `{ grade }` in a contextually typed object literal (no reference to the
local `grade`), producing 12 false `private_dead` rows (adapter records
checker-resolved shorthand references like namespace members); `mocks/`,
`fixtures/`, `e2e/`, `__schemas__/` and in-package `examples/` are test/docs
support and were reported dead (~160 rows; globs extended, shared between
analyze and witness); Workers entry files' `export default app` and Durable
Object classes came out `unexport_candidate` (a default export in an entry file
of a package with no org consumers is now treated as a runtime entry); the
`FC:PropsWithChildren:typeLiteralN:` chains still produced false version skew
(any undefined reference passing through an anonymous descriptor is attributed
to its nearest defined ancestor); `namespace_dynamic` on `import * as X from
'hono/jsx'` blocked all 387 hono rows although its target is known (now
targeted); ignored-manifest subtrees inside an org package were flagged by the
out-of-program scan (now skipped there: they are witness-only); installs must be
hermetic (pnpm/yarn write under `$HOME`; store and global dirs now live in the
work dir and the proxy is passed to yarn). The honojs lockfile is committed at
`fixtures/orgs/honojs.lock.json` (PLAN §13).

### Round 2 fixes (as built) — what changed in the rules

- **Export aliases are first-class** (`symbol_exports`, schema v5). The witness
  searches every alias a symbol is exported under; before, `export { a as b }`
  consumers naming `b` were invisible to it (fail-open).
- **Default exports and the witness.** For every alias `default` the witness
  applies its default-import rule keyed on the *entry file* of that alias
  (`export default x` in `src/adapter/cloudflare-pages/index.ts` reached via the
  exports key `./cloudflare-pages`); the subpath heuristic is deliberately
  over-inclusive and listed in `witness.ts`.
- **Self-witness.** A package's own non-test sources are scanned for string
  literals containing its own package name that are not module specifiers and
  read like code (`import`/`from`/`require`/`export` inside the literal); a
  symbol named in such a file becomes `needs_review` (`witness_mismatch:self:`).
  This is the only defence against code-generated imports.
- **Test/docs globs** are one list (`packages/core/src/globs.ts`) used by the
  witness and the adapter, with a test that parses `analyze.sql` to keep the SQL
  views identical. `mocks/`, `fixtures/`, `e2e/`, `__schemas__/`, `*.spec.*`,
  `*.stories.*` are tests; in-package `examples/`, `example/`, `demo/` are docs.
  Effect on honojs: ~160 fewer `private_dead` rows; a few exports whose only
  internal uses sit in `examples/` moved from unexport to deletion candidates,
  which is what `countDocsAsConsumers=false` means.
- **Runtime entry defaults.** `export default app` in an entry file of a
  package that is not library-shaped (no `exports`/`types`/`module`; pub: no
  `lib/*.dart`) and has no org consumers gets no verdict: the runtime consumes
  it (Workers, Lambda, Vite). Library-shaped packages keep their verdicts.
- **Anonymous descriptors anywhere in a reference chain** attribute the
  reference to the nearest defined ancestor (`FC:PropsWithChildren:typeLiteralN:`
  chains); real skew (missing top-level names) is still reported.
- **Per-package index cache**; hermetic installs under `<work>/.pm`; targeted
  `namespace_dynamic`; shorthand-property references recorded by the adapter
  (scip-typescript emits only the property symbol for `{ grade }`).
- Effect of the round on the honojs DB (before adapter re-index): unresolved
  refs 9 → 0, deletion candidates 93 → 84, private_dead 460 → 300, and the
  witness now downgrades 15 symbols including all three known-wrong ones.

### M3 — first Workiva run (30 Dart repos, 42 packages)

Index 600 s first run (229 s cached), blame 637 s (22 unshallows), analyze
50 s. Report: 81 deletion, 280 unexport, 623 private_dead, 14 needs_review,
412 blocked. Two showstoppers needed work-dir workarounds to get past ingest:

- **scip-dart emits invalid symbols**: operator methods unescaped
  (`ActionsClass#==().`, `#[]().`, `#<=().`; ~150 symbols in 10 packages),
  `null`-namespaced descriptors for type parameters of generic function types
  and named params of function-typed parameters, and colliding `…/null#` /
  `…/null().` for unnamed extensions and closures. One bad symbol aborted
  ingest for the whole org. Fix: patch the vendored fork (escape non-identifier
  names, emit locals for the nameless cases, do not define import prefixes as
  namespaces) and make ingest fail only the affected package.
- **A `package.json` next to a `pubspec.yaml`** (react-dart, pdfjs_dart,
  w_transport, sockjs_client_wrapper): output slugs collided when names matched,
  and document ownership ignored the manager when they differed (React's 5682
  Dart symbols landed in the opaque npm package; `PDFPageView` was reported
  under `npm:pdfjs_dart`). Fix: slugs carry the manager; documents from a Dart
  index belong to the pub package at that path and vice versa.

Spot checks (5 deletion candidates, 3 private_dead): `builtRedux` is
**wrong** (`build.yaml` `builder_factories` loads it by name); `screen`
(react_testing_library) is wrong in intent: its only consumers are tests
because it is a dev_dependency, so `countTestsAsConsumers=false` empties the
whole test-support package (12 delete, 80 unexport, 119 private_dead); the rest
are public-API-only. private_dead: `tool/dart_dev/config.dart#config` (4×,
dart_dev's run script reads it), `benchmark/benchmarks.dart#main` (runnable
script), and import prefixes (`$0`, 130 rows) are all wrong; generated
`*.pb.dart` files add 168 rows. Fixes adopted: Dart entry conventions in the
sidecar (`build.yaml` builder factories, `main` in any non-lib, non-test
script, dart_dev's `config`), test references count when the consumer declares
the package only as a dev dependency, generated files are never reported,
`test_fixtures` is an ignored manifest dir, later stages refuse to run on an
empty DB, and version skew against a target that failed to index is not
reported. Two packages need Dart ≥3.12/3.13 (Budro's call). Lockfile committed
at `fixtures/orgs/workiva.lock.json`.

### M2 — first unjs run (84 repos, 114 packages, at commit 8788a71)

Index 12 min (the sentei process itself ran out of heap once at ~4 GB and was
resumed with a bigger heap; per-package cache made that cheap), blame 15 min
first time (84 unshallows), analyze 36 s. Work dir 12 GB after installs.
Report: 106 deletion, 584 unexport, 216 private_dead, 9 needs_review, 3240
blocked (unenv and ast-types/recast alone block 2200). 58 packages ok, 46
partial, 10 failed; the main partial causes were installs (`devEngines`
runtime mismatch makes `npm exec` refuse; pnpm 12's store lock; Nuxt apps
missing `.nuxt/tsconfig.json` under `--ignore-scripts`) and unresolved own
subpath imports. Spot checks: of 8 deletion candidates, 3 **wrong**, 4
public-API-only, 1 right; all 3 checked private_dead rows wrong. Lockfile and
org config committed under `fixtures/orgs/unjs.*`.

What the wrong rows taught, and the fixes adopted:

- **A package's own unindexed files importing it by name** (`actions/*.ts`
  outside `src/` doing `import { defineAction } from "codeup"`) were skipped as
  self-imports. Fix: the witness treats the package itself as a consumer for own
  files that import it by name; and any own non-test file that holds the
  symbol's name inside a string literal (`helperName: "executeAsync"`,
  auto-import lists, codegen with a variable module path) downgrades the
  candidate (`witness_mismatch:self-string:`). This is the cheap, fail-closed
  answer to codegen we cannot follow.
- **Unresolved `exports` subpaths were silently dropped** (`./vue` →
  `dist/vue.mjs`; only `src/vue.ts` was tried, not `src/vue/index.ts`), so an
  entire entry point vanished and ~100 symbols were false `private_dead`. Fix:
  `index.ts` variants in the dist→src rule, and a code-looking exports leaf that
  resolves to nothing flags the package opaque (unknown surface is fail-open).
- **A namespace import used as a value** (`{..._pkg}` of a relative module) made
  no edges and no flag. Fix: the adapter records such uses and ingest adds
  edges to every top-level symbol of that module (over-approximation).
- **Cross-repo compile-option mismatch**: c12 (nodenext) cannot follow pathe's
  extensionless `export * from "./_path"`, so `resolve`/`join` looked "not
  exported" and became version skew. Fix in ingest: an unresolved named import
  from an org package whose HEAD export surface contains that name is a use of
  that export, not skew.
- **Unexport candidates that only reference each other** (nanotar's
  `createTar*` island) left their private helper `private_dead` while they
  themselves stayed "unexport". Fix: an unexport candidate that is unreachable
  once candidates stop seeding is a dead island and goes to the witness as a
  deletion candidate (`dead_island`).
- **Playground, bench, sandbox and scripts directories** are runnable code:
  their references count, their declarations are never reported dead
  (`SCRIPT_GLOBS`).
- Also adopted: template repos (`is_template`) are skipped at discover; private
  duplicate manifests are auto-ignored instead of aborting (they are still
  witness-scanned); skew against an unindexed target is not reported; the
  export-surface computation runs in a child process per package so the
  orchestrator's heap stays flat; scip-typescript retries once with double
  heap on SIGABRT; `devEngines.packageManager` is honoured and `npm exec` runs
  with engine checks off; install stderr tails go into diagnostics; blame checks
  its cache before unshallowing. 297 sidecar exports matched no SCIP
  definition on unjs; cause under investigation.

### M3 — Dart fixes as built (after Workiva)

- **Fork patch 3 (`1.7.0+sentei.4`)**: every descriptor name that is not a plain
  identifier is backticked (`Vec#\`==\`().`, `\`[]=\``, `\`<=\``); nameless
  elements (unnamed extensions and their members, closures, type parameters and
  named parameters of generic function types) and import prefixes become
  `local N` symbols. Verified on w_module, built_redux and over_react: no
  malformed symbols remain. Ingest additionally fails only the affected package
  when an org symbol is still unparseable, and skips unparseable third-party
  symbols (they were dropped anyway).
- **Output slugs carry the manager** (`npm__acme__core`, `pub__acme_x`), so an
  npm and a pub package in one directory no longer overwrite each other; the
  cache re-indexes entries whose file names are not the current slug.
- **Dart entry conventions in the sidecar** (`entrySymbols`): `main` in every
  library outside `lib/` (bin, tool, benchmark, example, web, root scripts),
  `build.yaml` `builder_factories` / `builder_factory` targets when their
  `import:` is the package's own library, and dart_dev's
  `tool/dart_dev/config.dart#config`. Core stores them in `entry_symbols`: they
  seed reachability and never get a verdict.
- **`dart pub get` conflicts with a source-linked HEAD** (an older pin on
  analyzer, say) are retried up to three times, dropping the override for each
  named dependency in turn and restoring any user override, with a `warn:`
  per conflict.
- **A `part` whose generated file is missing** (`uri_has_not_been_generated`,
  `.over_react.g.dart` not committed) makes the package `partial` when the
  declaring library is under `lib/` or `bin/`: the library is incomplete and
  references inside the missing part are unknown. Missing parts in `web/`,
  `example/`, `test/` or `tool/` only warn (over_react's `web/` demos would
  otherwise block 451 findings); a missing part there can still hide a use.
- **JS-only npm packages**: scip-typescript's `--infer-tsconfig` walks
  `node_modules`, finds `.d.ts` files and writes an empty `tsconfig.json`
  without `allowJs`, so nothing was indexed (react_testing_library's `js_src`).
  sentei now writes the inferred tsconfig itself (skipping dependency and
  build dirs, `allowJs` on), upgrades a stale empty one, and gives a package
  with no code files an empty `ok` index with a warning instead of "no
  indexer".
- **Manager-aware document ownership**: a document from a Dart index belongs to
  the innermost pub package enclosing it, and vice versa for npm; only when no
  same-manager package encloses it does the longest-prefix rule apply.
- **Dev dependencies** (`package_deps.dev`, schema v7): a consumer's test files
  count as consumers of a package it declares only as a dev dependency, in
  analyze and in the witness. Test-support libraries (react_testing_library)
  are no longer entirely "dead".
- **Generated files** (`*.g.dart`, `*.pb*.dart`, `*.freezed.dart`,
  `*.mocks.dart`, `generated/`, `*.generated.*`) get no verdicts and no
  private_dead rows; references from them still count.
- **Stage guards**: ingest requires packages, blame/analyze require symbols,
  witness/report require the `analyzed_at` marker analyze writes, so a stage
  run out of order fails loudly instead of printing an empty clean report.
- **Version skew against a package whose index failed** is dropped from the
  report with a warning (1781 such rows on Workiva).
- Import prefixes emitted by older Dart indexes are classified `import-prefix`
  at ingest and never reported (a stopgap; the fork no longer emits them).

### unjs-driven fixes as built

- **Sidecar `namespaceSpreadRefs`**: any value use of a namespace import whose
  module lives in an org checkout (own package included) other than
  `X.member`/`X['lit']` is recorded with its target module; ingest keeps that
  module's declarations reachable. Org-package namespace imports still raise
  the targeted `namespace_dynamic` flag as well.
- **Export surface runs out of process** (`surface-worker.ts`, one child per
  package with the configured heap), so the orchestrator's memory stays flat;
  scip-typescript and the worker retry once with double heap on exhaustion.
- **Unmatched sidecar exports explained**: scip-typescript 0.4.0 defines
  destructured exports (`export const { a, b } = obj`) as locals, treats
  expando assignments (`fetch.Promise = …`) as extra declarations, and emits
  nothing for JSDoc typedefs or JSON modules; such records are dropped with a
  count. Exports declared in files outside every tsconfig root (hand-written
  `lib/*.d.mts`, playground files reached only by import) flag the package
  partial: those files are invisible to SCIP.
- **Installs**: version from `devEngines.packageManager` when `packageManager`
  is absent; `npm exec` runs from an empty prefix with engine checks off (npm
  11 enforces `devEngines.runtime` at its prefix, and `--force` would leak into
  pnpm); stderr tails in diagnostics. pnpm 11 may download a Node runtime for
  `devEngines.runtime` (`onFail: download`), so `nodejs.org` must be reachable.
- **Witness**: the package is its own consumer for own files that import it by
  name (`witness_mismatch:self:`), and any own non-test file holding the
  candidate's name as a whole string literal or in an import-clause shape
  downgrades it (`self-string`). Self hits ignore comments and the defining
  line. Very short names (`id`, `type`) will produce noise; fail closed.
- **Entry points**: dist→src tries `src/x/index.ts` and sources next to built
  output; a code-looking leaf that resolves to nothing becomes an untargeted
  `opaque_consumer` flag written by discover (reason prefixed `discover: `,
  which ingest preserves). On unjs this made `@unhead/angular`, `unhead`,
  `unpdf` and `md4x` opaque: their entries are produced by builds we do not
  run, which is the honest answer.
- **Skew that is a use**: a sidecar unresolved import whose name the target
  exports at HEAD becomes a reference (100 on unjs).
- **Dead islands**: `verdicts` is now computed after `reachable_after`; an
  unexport candidate not reachable once candidates stop seeding becomes
  `needs_review` + `dead_island` + `witness_pending`. Script directories,
  counted test/docs files and overlay sources seed reachability.
- **Discover**: private duplicate manifests are auto-ignored (still witness
  scanned); template repos are skipped; `fixtures/org-dup` is non-private so
  it still shows the hard error.
- Indicative rerun on the old unjs index: deletion 106 → 104, unexport 584 →
  534, private_dead 216 → 151, needs_review 9 → 48; every previously wrong row
  is caught or fixed. Known noise: capnp-es generated files carry
  `displayName: "X"` strings that self-string matches.

### honojs verification rerun (HEAD bf4a486)

72 ok / 4 partial (hono itself: pnpm 12 store-lock error inside the sandbox;
three example/starter packages: unresolved `hono`). Index 230 s with installs,
analyze 29 s (was <1 s: the dead-island views re-ran the recursive CTEs;
reachability is now materialized), witness 212 checked / 18 mismatched.
Verdicts: deletion 93 → 194 (113 of them `dead_island`: exports used only by
other candidates, correct under closed world but they double the delete list,
so the summary now separates ISLAND from DELETE), unexport 242 → 108,
private_dead 460 → 282, needs_review 0 → 18, blocked ~400.

- All three previously wrong deletion candidates are now `needs_review` with
  real witness hits; agent-dx `grade` and honox `mocks/**` are fixed; the
  cloudflare-pages private helpers stayed `private_dead` because witness
  downgrades did not reach the `unlocked_by` cascade (fixed: the cascade is
  recomputed from `findings` after the witness).
- Spot check of 8 new deletion candidates: 1 right, 6 public-API-only, 1
  wrong (`hono-vite-jsx#AppType`: the Vite client entry `src/client.tsx` is
  referenced only from `index.html`/`vite.config.ts`, now added as entry
  points).
- Of 18 needs_review rows, 7 witness hits were real and 11 noise: external
  module specifiers equal to a symbol name, `c.set('sentry', …)` keys, class
  `name` fields, default titles, a deprecation message, `describe()` strings in
  a `*.test-d.ts` file. Fixes: specifiers never count, a bare name literal
  counts only in files that also build import text, codegen hits are limited to
  names inside the literal, more test/script globs.
- private_dead noise: `mocks.ts`, `test-utils.ts`, `script/`, config files,
  and ambient module augmentations (`declare module 'hono' { interface
  ContextVariableMap }`, `declare global`), which are contributions consumed
  elsewhere; the adapter now lists ambient declarations as entry symbols.
- hono self-flagged `opaque_consumer` 153 times for `require` conditions
  pointing at `dist/cjs/*`: an exports entry is now unresolved only when none of
  its conditions resolves.

### Workiva verification rerun (HEAD bf4a486)

No work-dir workarounds needed: npm and pub packages in one directory index
side by side, ingest had zero package errors and zero skipped symbols. Index
461 s with installs, blame 0.4 s from cache. Verdicts: deletion 81 → 60,
unexport 280 → 146, private_dead 623 → 82, needs_review 14 → 52, blocked
412 → 451, version skew 16 → 0.

- Fixed as intended: `builtRedux` (build.yaml builder factory) and the
  dart_dev `config` / benchmark `main` symbols are entry symbols; import
  prefixes and generated `*.pb.dart`/`*.g.dart` produce no rows; `pub:react`
  and `pub:pdfjs` own their documents; the dev-dependency rule keeps
  react_testing_library's `screen` alive while its truly test-only API keeps
  `only_test_refs`.
- New blocker: `over_react` became `partial` for 19 missing
  `*.over_react.g.dart` parts in `web/` demo code, blocking 451 findings. The
  missing-part rule is now limited to library code (`lib/`, `bin/`).
- Self-witness was too broad for Dart: own `lib/` files import the package by
  `package:` URI and are indexed, so `show MockClient`, a constructor line and
  a same-named class in another library counted as hits (30 of 52
  needs_review rows). The self consumer now scans only own files that are not
  indexed documents, ignores directive lines, restricts `self-string` to the
  package's own language files and skips the defining line.
- Dead islands did not follow witness downgrades (pdfjs
  `DocumentInitParameters` stayed a deletion candidate after `PDFJS`, its only
  user, became `needs_review`); the island verdicts are now recomputed after
  the witness until stable.
- Spot check of 6 new deletion candidates: 4 public-API-only, 2 wrong only
  through the island/witness interaction above. Two open toolchain items for
  Budro: Dart ≥3.12/3.13 for codemod packages, and pnpm's store-operation lock
  failing inside this sandbox (react-dart, hono).

### unjs verification rerun (HEAD bf4a486)

One pass, no orchestrator heap failure: index 9.5 min with installs, blame
44 s from cache, analyze 39 s. 68 ok / 38 partial / 8 failed (was 58/46/10):
the `devEngines` repos now install (pnpm 11.24, 12.3, 12.5); the newest pnpm
12 (`^12`, `latest`) still fails on its store-operation lock in this sandbox.
Ingest: unmatched exports 297 → 0, unmatched namespace refs 45 → 0, 100
unresolved imports became uses. Verdicts: deletion 106 → 127 (36 dead
islands, 35 previously blocked), unexport 584 → 392, private_dead 216 → 152,
needs_review 9 → 41, skew 272 → 45.

- Every previously wrong row is fixed except codeup's `utils` members: the
  adapter emits `namespaceSpreadRefs` but ingest did not consume it (an
  omission in the dispatch, now added).
- Spot check of 8 new deletion candidates: 7 public-API-only, 1 wrong
  (`SvelteStreamableHeadContext`, the return type of a function the witness
  kept; dead islands are now re-evaluated after the witness).
- Witness hits: real for codegen (`mask: "getFloat32Mask"`, autoImports
  presets); noise from generated capnp-es files carrying `displayName: "X"`
  strings and importing the package by name, and from compiler reserved-name
  lists (`fetchdts`). Fail closed.
- Whole-package blocks from unindexed files in `bench/` (unhead-monorepo:
  377 findings): unindexed script/docs/test files now feed the witness instead
  of flagging (`witness_files`).
- package.json `imports` map arms TypeScript does not pick (`#crypto` →
  `default`) were `private_dead`: every `imports` target is an entry point.
- Skew residue: `.d.ts` module symbols reported as missing symbols are not
  symbol references and are dropped.
- Still open: Vue/Svelte SFC consumers are invisible to scip-typescript (text
  scan them as unindexed consumers); TS generated files (`@generated`,
  "automatically generated" headers) need the Dart generated-file treatment;
  scule runs out of heap at 8 GB; Nuxt apps need `nuxt prepare`.

### Adapter round 3 (as built)

- **Scoped unindexed imports.** `unindexedImports[].scope` is `test`, `docs`
  or `script` (folder patterns only; tool configs at the package root stay
  unscoped and keep flagging). Core routes scoped entries to `witness_files`
  (name search only), never to package flags, so a `bench/` directory can no
  longer block an entire package.
- **Single-file components** (`.vue`, `.svelte`, `.astro`, `.marko`, `.mdx`)
  are text-scanned as consumers of org packages, and their relative imports of
  the package's own code are recorded with `relative: true` so those files'
  declarations are kept alive through the self-witness.
- **`generatedFiles`**: own files under tool-output folders (`.nuxt/`,
  `.output/`, `.svelte-kit/`, …) or with a `@generated` / "automatically
  generated" / "do not edit" comment in their first 20 lines. Core gives their
  declarations no verdicts and skips them in self scans.
- **scule**: not our bug. TypeScript 5.9's type printer never finishes on
  scule's template-literal overloads; scip-typescript calls it only to build
  hover documentation, which sentei never reads. On heap exhaustion the retry
  preloads `scip-typescript-nodocs.cjs`, which replaces only the hover text
  (symbols, occurrences and relationships unchanged, `warn:` recorded); scule
  then indexes in under a second. Also found: an `exports` `"./*": "./*"`
  mapping turned dotfiles and `LICENSE` into entry points (fixed in discover).
- **Nuxt apps**: `nuxt prepare` runs once during prepare when installs are on
  and `.nuxt/tsconfig.json` is missing; devtools-app went from failed to
  partial (an unresolved `unhead/validate` remains).

### Core round 3 (as built)

- **Witness outcomes propagate.** `candidate_symbols` reads `findings`, so
  the private-dead closure and the dead-island verdicts are recomputed after
  the witness (`insertPrivateDead`, `reconcileDeadIslands`, bounded fixpoint).
  A dead island whose only user was downgraded reverts to `unexport_candidate`.
  On honojs: 26 wrongly-cascaded `private_dead` rows → 0, witness noise 18 → 8.
- **Materialized scratch tables** (`mat_reachable`, `mat_reachable_after`,
  `mat_base_verdicts`): the recursion is still defined once, in views; every
  downstream view reads the tables. The cost was not the recursion but views
  re-evaluated per row (correlated EXISTS in the decision tree, a per-symbol
  package-seed scan, a CTE evaluated twice). Analyze on honojs: 25 s → 1.8 s.
  `analyzeOrg` stages base verdicts in `findings` before computing islands
  because the island rule needs `reachable_after`, which needs candidates.
- **Self-witness precision**: module specifiers never count; a bare name
  literal counts only in a file that also builds import text; codegen hits
  name only the symbols inside the literal; the self consumer scans only own
  files that are not indexed documents and not generated, in the package's own
  language, ignoring directive lines and the defining line. (Refined later, see
  "Witness rules, final form": a `witness_files` self row, i.e. an own TypeScript
  file importing the package by name that SCIP could not resolve, is scanned even
  when it is an indexed document.)
- **Runtime entry points** (`ManifestPackage.runtimeEntryPoints`): package.json
  `imports` arms and Vite/HTML client entries are not export surface (that
  would make the arm TypeScript picks an unexport candidate and the other a
  deletion); their exported top-level declarations become `entry_symbols`.
- **Spread refs**: edges to every symbol of the target document always;
  occurrences on top-level exports only within the same package, or across
  packages when the consumer carries no dynamic flag for that target
  (otherwise the flag's blocker would be hidden by a counted use).
- **Scoped unindexed imports** and relative single-file-component imports go to
  `witness_files` (schema v8) and never flag; generated files
  (`documents.is_generated`) get no verdicts and are never self-scanned.
- `**/testing/**` as a test glob also catches public test-support entry points
  (hono's `src/helper/testing`); uses from those files no longer count, so a
  few exports gained `only_test_refs`. Acceptable under the policy; revisit if
  a real org objects.
- Fixture `lib-cascade` exercises the cascade, exports conditions, `imports`
  arms and the HTML client entry end to end.

### honojs final verification (HEAD 8ef28d4)

72 ok / 4 partial / 0 failed; analyze 2.1 s. DELETE 97, ISLAND 95, UNEXPORT
130, PRIV-DEAD 246, REVIEW 11, BLOCKED 396. **Spot check of 10 non-island
deletion candidates: 1 right, 9 public-API-only, 0 wrong.** needs_review: 7
real hits (starter-template imports, honox codegen), 4 noise (a deprecation
message that quotes an import line; a bare default import vouching for every
subpath default). The list's character is now "public API nobody in the org
uses", which is what `assumeClosedWorld` produces by design.

One regression: ambient declarations (711 in Wrangler's generated
`worker-configuration.d.ts`) counted as reachability seeds *for eligibility*,
so app packages whose real entries are runtime conventions became eligible for
private_dead and 75 false rows appeared (their own declarations, honox
`app/server.ts`, a Pages function, a Worker `export default app`). Fixes:
entry symbols carry a kind and only runtime ones make a package eligible;
namespace members get owners; Wrangler/Pages/honox/Next/SvelteKit/Nuxt
runtime entry conventions are modelled; Wrangler's header counts as
generated; deprecation messages are not codegen; a bare default import
vouches only for the root entry's default.

### Workiva final verification (HEAD 8ef28d4)

33 ok / 3 partial / 3 failed (over_react and over_react_analyzer_plugin now
ok; the remaining ones need Dart ≥3.12, a pre-2.12 SDK, a real missing part
in `lib/`, or pnpm's store lock). Analyze 4 s. DELETE 81, ISLAND 70,
UNEXPORT 195, PRIV-DEAD 92, REVIEW 17, BLOCKED 347. **Spot check of 8
deletion candidates: 1 right, 7 public-API-only, 0 wrong**; zero self-witness
hits; pdfjs consistent. needs_review: 10 real (example apps under `example/`
pubspecs, ignored as packages, witness-scanned), 7 noise from member-access
names in indexed consumer files (`screen.findByTestId` vouching for the
top-level `findByTestId`) and an English word in a comment. New finding:
scip-dart emits reference occurrences for dartdoc `[Name]` links, so 19
symbols mentioned only in documentation looked internally used (fork patch 4
removes them). todo_client's own `export 'package:todo_client/…'` lines were
reported as dynamic access on top of its failed pub get (suppressed). Real
version skew found: over_react_analyzer_plugin pins over_react 5.7.0 and uses
`nameLexeme`, gone at HEAD.

### unjs final verification (HEAD 8ef28d4)

72 ok / 40 partial / 2 failed; index 7.6 min, analyze 6.6 s. DELETE 94,
ISLAND 56, UNEXPORT 472, PRIV-DEAD 109, REVIEW 24, BLOCKED 2738. Every
previously wrong row is fixed (codeup utils, ocache digest, md4x-demo, capnp-es
generated files, `SvelteStreamableHeadContext`); scule indexes via the no-docs
shim; unhead-monorepo's `bench/` no longer blocks anything. **Spot check of 10
non-island deletion candidates: 6 right, 4 public-API-only, 0 wrong.**

Regression caught: the round-3 self-string precision rule ("a bare name
literal counts only in a file that builds import text") was too narrow. unctx's
template has no quotes after `from` (`from ${JSON.stringify(m)}`), capnp-es
keeps names in `constants.ts` and templates in `generators/*.ts`, and unhead's
presets list names in `autoImports.ts`; 14 real codegen uses fell back to
deletion. Fix: the codegen qualifier is package-wide and any own literal
containing the name as a whole word then counts. Other items adopted: witness
vouching respects import subpaths; `exports` wildcards respect `files`; `bin`
targets are runtime entries, not surface; re-exports of external declarations
(`export default globalThis`) are not "unresolved" (unenv blocked its own
1552 findings on that); self-imports from unindexed own config files feed the
self-witness instead of flagging; template repos are remembered in the
lockfile; subprocess diagnostics keep the error head as well as the tail.
Environmental, unchanged: the newest pnpm 12's store lock in this sandbox, bun
not installed, Nuxt apps that need built org packages at `nuxt prepare`.

### Final adapter rounds (as built)

- **Dart fork patch 4 (`1.7.0+sentei.7`)**: `CommentReference` nodes produce no
  occurrences, so dartdoc `[Name]` links are documentation, not uses.
- **Failed `pub get`**: own `package:<self>/…` URIs that cannot resolve are
  reported once as "package unresolvable (pub get failed)" instead of per-export
  `unresolved` entries that turned into `dynamic_access` flags.
- **External re-exports** (`export default globalThis`, `export { basename }
  from 'pathe'`) are neither surface records nor unresolved; only aliases that
  resolve to nothing stay unresolved.
- **Self-imports** from own files, in or outside the tsconfig program, are
  recorded against the package itself and feed the self-witness (never a
  partial status); JavaScript entries outside the program are text-scanned
  and their exports reported as unresolved with a clear warning.
- **Diagnostics** keep the first three and last five lines of subprocess
  output so error heads survive (`nuxt prepare`'s "Cannot find module").
- Adapter versions: scip-typescript `0.4.0+sentei.5`, scip-dart
  `1.7.0+sentei.7`; every version bump invalidates the index cache and renames
  the snapshot directory, which is the intended review trigger (§6.6).

### Core round 4 (as built)

- **Eligibility vs. seeds.** `entry_symbols.kind` (schema v9): ambient
  declarations seed reachability but never make a package eligible for
  `private_dead`; only runtime entry symbols, exported symbols and entry
  documents do. This removed the 75 false rows from Wrangler's generated
  declarations and honox app files.
- **Namespace owners**: a namespace descriptor is a parent when it is a
  same-file declaration that is neither a module symbol nor an import prefix.
- **Runtime entry conventions** (one table in `manifests.ts`): wrangler
  `main`, Pages `functions/**`, HonoX `app/{server,client,routes,islands}`,
  Netlify functions, Vercel `api/**`, Next `pages/**` and `app/**`, SvelteKit
  and SolidStart `src/routes/**`, Nuxt `pages/**` and `server/**`. They are
  entry points (so the adapter emits their exports) and runtime entries (so
  those exports seed reachability without verdicts). `bin` targets are runtime
  entries only; `exports` wildcards respect `files`. Pages `functions/**` also
  triggers on a `wrangler` dependency or a `wrangler pages` script; wrangler
  `main` falls back to the file in a `wrangler dev|deploy <file>` script; Durable
  Object and Workflow `class_name`s from the wrangler config are runtime entry
  symbols (`runtimeEntrySymbols`), so a class the runtime instantiates by name
  gets no verdict.
- **Witness rules, final form**: an import vouches only for symbols exported
  from the entry file its specifier reaches (bare specifier → root entry);
  message literals (`deprecated()`, `warn()`, `console.*`, `[deprecated]`) are
  never codegen and never self-string hits; member-access and comment matches
  in indexed files are skipped, as are matches where SCIP already resolved
  that name to another symbol on the line; the codegen qualifier is
  package-wide (any own literal holding the name as a whole word counts once
  the package is known to build import text, with `from` followed by a
  template, `JSON.stringify` or an identifier accepted). Self unindexed
  imports scan even indexed files. The string scanner is linear (Workiva
  witness 13 s → 1.5 s).
- Effects on the real DBs (re-analysed, not re-indexed): honojs 975 → 907
  findings with the ambient/app rows gone; Workiva's 7 false needs_review rows
  became deletion candidates; unjs recovered the unctx, capnp-es and unhead
  codegen protections lost in round 3.
- Fixture `app-worker` covers wrangler `main`, a Pages function, a bin outside
  the program, namespaces and non-vouching imports.

### honojs smoke run at the final HEAD (dc28a40)

Fresh index, 217 s; analyze 1.9 s; 72 ok / 4 partial / 0 failed. DELETE 101,
ISLAND 95, UNEXPORT 130, PRIV-DEAD 173, REVIEW 7, BLOCKED 392. All 7
needs_review rows are real hits (starter templates, honox codegen). The 75
false private_dead rows from ambient and app files are gone; `nextjs-stack`
has zero rows on a fresh index. Spot checks: 5 deletion candidates → 2 right,
3 public-API-only, 0 wrong; 5 private_dead → 4 right (one is the vendored
esbuild typings block, correct but 22 % of the list), 1 wrong: a Cloudflare
Pages project with no wrangler config (only `devDependencies.wrangler` and
`wrangler pages` scripts), whose `functions/api/[[route]].ts#onRequest` is
loaded by path. Also still open: a Durable Object class exported by name for
the Workers runtime (`wrangler.toml` `class_name`) reads as an unexport
candidate. Both are convention additions in `manifests.ts` (last tweak).
Environmental as before: hono's pnpm 12 store lock in the sandbox; three
example packages with unresolved `hono`.

### Where this leaves the tool (2026-09-24)

Across honojs, unjs and Workiva the final spot checks found no wrong deletion
candidate; the lists are dominated by public API that nobody in the org uses,
which is exactly what `assumeClosedWorld` asks for and what the report banner
warns about. What remains is toolchain (pnpm 12 and bun in this sandbox, Dart
≥3.12 for two Workiva packages, Nuxt apps needing built org packages) and the
M5 real upload, which needs a repo owner. M6 (nightly runs, false-dead log
as fixtures) has not started.

## Phase 2 (2026-09-26) — decisions from Budro after using the tool

1. **Package identity is `<manager>:<repo>:<name>`.** Name collisions across
   repos were the first source of trouble on every real org. PLAN §5.1's
   "duplicate names are a hard error" is superseded: duplicates are allowed,
   dependency resolution goes by name with disambiguation (same repo, then
   published over private), and anything still ambiguous fails closed
   (`ambiguous_dep` flags on the consumer, targeted at each candidate).
2. **No user option may require a re-index.** Indexing is the expensive stage
   and is cached per package by sha and indexer version; discover, ingest,
   analyze, witness and report are cheap and must absorb every option change.
3. **`assumeClosedWorld` is removed.** It only turned "deprecate" into
   "delete" and required re-analysis to compare. The analysis computes one
   base verdict per symbol plus the package's visibility, and the report offers
   views over the same index:
   - `delete`: private packages (nobody outside the org can depend on them),
     no counted references or test-only references, witness passed;
   - `deprecate`: published packages, same evidence;
   - `org-dead` (the old closed-world deletion): the deprecate list read as
     deletions on the assertion that the org is the only consumer. Same rows,
     different label; the report and SARIF state the assertion.
   `trustPrivateRegistry` stays (published-private is closed by definition).
4. **Repo selection must be easy.** Orgs contain hardware repos, hackathons
   and archives; discover pre-filters by primary language and manifest probe
   before cloning, `sentei repos` lists candidates with reasons, and filters
   persist in the org `sentei.json`.
5. **Cloning must be parallel and polite**: shallow clones in parallel with a
   configurable limit; REST calls honour `Retry-After` and the secondary
   rate-limit headers with backoff. One hour for 100 shallow clones is not
   acceptable.
6. **Dart 3.13 and Flutter** are now on the dev box; Flutter packages get
   `flutter pub get` and the Flutter SDK's package config.
7. Next dogfood targets: larger Dart orgs (full Workiva, dart-lang, a Flutter
   org) and an org with a real language mix (supabase), with spot checks.

### Package identity (as built)

**Identity is (repo, path, manager), not the name.** Name collisions across
repos were the biggest source of trouble on every real org (honojs's
templates, fixtures and a VS Code extension all named `hono`; Workiva's
private duplicates). `UNIQUE (manager, name)` forced an abort or a guess. A
package id is now `<manager>:<repo>:<name>` (`npm:acme/lib-core:@acme/core`,
`pub:Workiva/w_flux:w_flux`); two repos may publish one name and both get
findings. Inside one repo a name stays unique per manager (ids would collide):
private duplicates there are auto-ignored, two public ones are an error.

Manifests and SCIP symbols name packages only by name, so **dependencies are
resolved per consumer**: the only org package of that name; else the one in
the consumer's repo (`same-repo`); else the only non-private one
(`published`, since a private package cannot come from a registry); else
ambiguous — nothing is resolved and the consumer gets an `ambiguous_dep` flag
targeted at every candidate, so all of them are `blocked` (fail closed);
discover warns with `ignoreManifests` suggestions and the report lists each
such dependency. `package_deps` records `resolution` and `ambiguous`.

Ingest attributes a SCIP reference to a shared name the same way (own name →
the consumer; unique name → that package; the consumer's resolved dependency →
it; otherwise dropped and counted, with `ambiguous_dep` rows added if
discover had none). Because two packages can define byte-identical SCIP
symbols, a shared name's symbol strings carry the package id in the version
slot; unshared names are unchanged. `keep` accepts `npm:<name>#sym` (every
package of that name) and `npm:<org>/<repo>:<name>#sym`. Index slugs are
`<manager>__<repo>__<name>`. SARIF fingerprints use the new id (existing
alerts re-key once); old work DBs are refused (schema v10).

### Phase 2 — org survey for the large runs (API listing only)

| Org | Repos | Dart / TS / JS by primary language | Notes |
|---|---|---|---|
| dart-lang | 38 | 32 / 0 / 1 | ~200 pub packages in `pkgs/` monorepos (tools 43, native 24, pub-dev 17, build 15, core 14, http 13, test 9, shelf 9); densest cross-repo graph; skip `sdk` (1.6 GB), `site-www`, `co19` |
| flutter | 24 | 20 / 0 / 0 | `flutter` (88 pubspecs, engine merged in) + `packages` (125 federated plugins) ≈ 215 packages, ~700 MB |
| flame-engine | 31 | 18 / 0 / 1 | `flame` monorepo (36 pubspecs) + gamepads, forge2d; ~55 packages, ~80 MB |
| Workiva | 38 | 25 / 2 / 6 | 25 single-package Dart repos with real cross-repo deps (~35 packages) |
| supabase | 81 | 1 / 29 / 0 | TS monorepos (supabase-js 8, cli 16, supabase 29 packages) + supabase-flutter (14 pubspecs) + Go 13, Rust 9, Python 6, Elixir 4: the language-mix target; skip `supabase/supabase` (2.4 GB) |
| serverpod | 33 | 22 Dart | one repo with 119 pubspecs, 35 MB: the cheapest large Dart graph |

REST limits observed: 5000 core requests/hour authenticated, 30 searches/minute.
Chosen runs: dart-lang, flame-engine and Workiva (full Dart set) for Dart;
supabase for the mix; flutter/flutter + flutter/packages and serverpod as
stretch targets.

### Phase 2 — decision 3 as built (views)

One base verdict per exported symbol. Its only input about the world is
`private_packages` (schema view: `private`, or `published-private` with
`trustPrivateRegistry`: nobody outside the org can depend on it). Same
evidence either way (references, test-only uses, dev deps, age, keep,
blockers, dead islands, witness): private → `deletion_candidate` /
`unexport_candidate`; published → `deprecation_candidate` with reasons
`no_refs` / `only_test_refs` / `dead_island` (a would-be deletion) or
`internal_refs_only` (a would-be unexport). The witness now runs for published
would-be deletions too and a hit makes them `needs_review`; trigger
`findings_candidate_requires_witness` enforces it, and the keep and
opaque-consumer triggers cover deprecations. A deprecation is a candidate (it
stops seeding reachability), so dead islands and the private-dead cascade
behave in published packages as they did under `assumeClosedWorld`. The age
rule gates every verdict now (M1's "closed-world only" is superseded: a young
published export is not worth deprecating, and `org_dead` must equal the old
closed-world deletions). `open_world` is gone; `assumeClosedWorld` rows are
dropped on insert and rejected in config. Schema v11.

The report computes views over `findings`: `delete`, `deprecate`, `org_dead`
(the deprecate rows plus the private helpers only they unlock, under the
assertion "the org is the only consumer of these packages"), `unexport` (plus
`published`: internal-only deprecations), `private_dead` (minus those helpers),
`needs_review`, `blocked`, `version_skew`. `report --view` limits stdout and
SARIF; SARIF defaults to everything but `org_dead`, whose rule `sentei/org-dead`
(warning) emits only when selected, with the assertion in
`run.properties.assertions` and every result message. Rules are named per
view; fingerprints unchanged. No option needs a re-index: policy needs
discover then analyze, witness and report; views need only report.

### Phase 2 — decisions 4 and 5 as built (repo selection, cloning)

- **Selection is pure** (`repo-select.ts`), first match wins: `--include` >
  `--exclude` > `repos.include` > `repos.exclude`; empty or disabled repos;
  archived, forks, templates; `maxSizeMb` (default 500, API `size` = full
  history, an upper bound); `minPushed`; language in `repos.languages`
  (default TypeScript/JavaScript/Dart) or a root `package.json`/`pubspec.yaml`
  probe, run only for repos no other rule excluded. An include forces a repo
  past every rule (this replaces include-as-whitelist; `--exclude '*'
  --include x` narrows).
- **Lockfile v2** (default `<work>/<org>.lock.json`) records every listed repo
  with its facts, probe result, pinned sha (selected repos only), decision and
  reasons, and any clone error; the header holds the merged settings. A
  settings change re-decides from recorded facts and keeps the pins. Legacy
  lockfiles still work with the glob/fork/template rules only.
- **API cost** ≈ 1 request per 100 repos + 1 per selected repo + 1–2 per probed
  repo; at most 8 in flight sharing one pause: `remaining: 0` sleeps until the
  reset; secondary limits (429, or 403 with `retry-after` or the secondary-limit
  message) wait `retry-after` or 60/120/240 s then fail.
- **Clones** run in parallel (default 8) with `--depth=1 --single-branch
  --no-tags` and `GIT_LFS_SKIP_SMUDGE=1`, with progress and a ten-slowest list;
  a failure is recorded per repo and the rest continue (exit 1 at the end
  unless `--allow-clone-failures`).
- **Measured through the sandbox proxy**: a typical shallow clone is ~0.6 s,
  nearly all latency; all 84 unjs repos take 58.6 s at concurrency 1 and 8.8 s
  at 8. An hour for 100 clones therefore points at huge HEAD trees or LFS in
  hardware repos (now excluded by size/language, LFS skipped) or at blame's
  unshallow and index installs, not at shallow cloning.

### Phase 2 runs — full Workiva (33 selected of 126 listed, Dart 3.13)

Selection skipped 75 archived, 13 forks and 5 non-Dart repos with readable
reasons and pulled in the JavaScript-labelled Dart repos; index 584 s, no
workarounds, codemod and over_react_codemod index on 3.13, 0 ambiguous deps
(npm/pub pairs in one directory are kept apart by manager). DEPRECATE 183
(= ORG-DEAD), UNEXPORT 172, PRIV-DEAD 428, REVIEW 16 (all 4 checked real),
BLOCKED 348, skew 3 (all real: `nameLexeme` pinned at 5.7.0). Spot checks:
deprecate 1 right / 6 public-API-only / 1 wrong; private_dead 2 right / 2
wrong standing for 390 rows. Wrong rows and the fixes adopted:
- `bin/*.dart` that only `export 'package:x/src/executables/X.dart'`: the
  `main` lives in the export namespace, not the file's top-level functions,
  so over_react_codemod had 0 entry symbols (dart-surface resolves `main`
  through the export namespace).
- A test-support library (`codemod/lib/test.dart`) used by another repo's
  tests under a regular dependency came out `only_test_refs`: references from
  test files to test-support code now count (symbols defined in
  `lib/test.dart`, `lib/testing.dart`, `test_utils`, `mocks`, `testing` paths,
  or packages named `*_test`/`*_test_utils`).
- Test/docs/script globs matched inside `lib/` (`lib/over_react_test.dart`,
  `lib/src/mocks/`, `lib/src/handlers/example/`): for pub packages nothing
  under `lib/` is test, docs or script code.
- A private npm bundle consumed only by Dart through `@JS('rtl.…')` got an
  unexport verdict (fail-open): same-repo packages of another manager are
  now witness consumers of each other.
- Blockers: over_react_test (one uncommitted generated part) and todo_client
  (a pre-2.12 example app) block ~330 findings each; the report now says why
  and suggests `ignoreManifests`, and missing generated parts trigger one
  targeted `build_runner` attempt when the package depends on it.

### Phase 2 fix round 1: TS indexer toolchain

From the supabase run (`index.txt`, per-package logs); all in
`packages/cli/src/indexers/scip-typescript.ts` plus two preload files.

- **Manager choice** (`choosePackageManager`): `packageManager`, then
  `devEngines.packageManager`, then lockfile order (npm, pnpm, yarn, bun), read
  from the nearest package.json that declares one. A declared manager whose
  lockfile is absent falls through (a frozen install needs it). Cause:
  auth-helpers has `package-lock.json` + `pnpm-lock.yaml` and `pnpm@7.1.7`;
  `npm ci` failed EUSAGE on all nine packages.
- **Pinned fallback version** (`packageManagerVersion`, `toolVersionPin`,
  `pinnedVersion`): packageManager → devEngines → `mise.toml`/`.mise.toml`
  `[tools]` / `.tool-versions` → lockfile major → pnpm 9 / yarn 1 / bun 1;
  never `latest`. Cause: mcp and tanstack-db ran `pnpm@latest` = pnpm 12,
  which failed on its store operation lock (read-only filesystem); mcp pins
  pnpm 10 in `mise.toml`. `.nvmrc` pins only node and is not read. The pin
  applies to the `npm exec` fallback only; a manager already on `PATH` runs
  as is.
- **bun via npm exec**: a missing bun used to skip the install, and sdk /
  setup-cli then failed outright: their tsconfig `extends` `@tsconfig/node24`
  / `@tsconfig/bun`, which only the install provides (TS6053, no files
  indexed). `npm exec --package=bun@1 -- bun install --frozen-lockfile` works
  (checked by hand on a copy of setup-cli: `@tsconfig/bun` installed).
- **Engines** (`installArgs`): the env already set engine-strict=false, but
  pnpm 10 lets `engineStrict: true` in `pnpm-workspace.yaml` beat the env
  (evals: ERR_PNPM_UNSUPPORTED_ENGINE, node 24.x wanted). Flags on the
  manager's own command line: npm `--engine-strict=false`, pnpm
  `--config.engine-strict=false`, yarn 1 `--ignore-engines` (it rejects the
  root package's engines too). Checked offline with cached pnpm 8.15, 9.15,
  10.24 (fails without the flag, passes with it) and 11.1, yarn 1.22 and
  4.10, npm 11. Berry checks no engines (and deprecates the flag); bun
  enforces none. Yarn's flags (classic vs berry) now come from the resolved
  version on the first call, not only in the fallback.
- **TS6046** (orb-sync-engine, `lib: ["ES2025"]`, `target: "es2025"`, written
  for TypeScript 7): scip-typescript 0.4.0 and the export surface run
  TypeScript 5.9.3 (knows es2024/esnext); scip-typescript exits 1 on config
  errors, failing every package. Options considered:
  - *Run the repo's TypeScript*: rejected. scip-typescript `require`s its
    own pinned copy and uses the 5.x compiler API; orb-sync-engine's
    `typescript@7.0.2` is the native port (only `lib/tsc.js` and a binary, no
    JS API), and older repo copies (4.x) would break scip-typescript instead.
  - *A sentei-written tsconfig overriding lib/target*: does not help, the
    extended base config is still converted and its TS6046 still reported.
  - *Chosen*: `ts-option-compat-preload.cjs`, `--require`d into both node
    children, wraps `get` of TypeScript's lib/target/module/moduleResolution
    option maps (the only lookup its tsconfig conversion and
    `/// <reference lib>` use). Only values *newer* than it knows are aliased:
    `esYYYY[.part]` past its newest year and unknown `esnext.part` →
    `esnext.part` when known, else `esnext` (es2025 features live in 5.9's
    esnext libs); target/module `esYYYY` → `esnext`; `nodeNN` → `nodenext`.
    Typos and other unknown values stay TS6046. Each alias prints a
    `sentei-ts-compat:` line, which becomes an `info:` diagnostic. Missing
    typings can only add type errors; they never drop an org reference.
- The adapter version stays `0.4.0+sentei.5`: the sidecar format is unchanged
  and the packages these fixes rescue were partial or failed, which the index
  cache never reuses (bumping it would also regenerate `fixtures/snapshots`).

### Phase 2 fix round 1: repo selection by git tree

Found on the supabase and Workiva dogfood runs.

- **One recursive git tree per candidate replaces the root probe.** The
  root-only `contents` probe missed repos whose manifests are all nested
  (supabase/realtime `assets/package.json`, edge-runtime's JS test packages,
  Dart `pkgs/*` monorepos). `GET /repos/{o}/{r}/git/trees/{ref}?recursive=1`
  accepts a branch name (checked against the live API), so it is one request;
  `ref` is the pinned sha when the lockfile has one. Manifests are every
  `package.json` / `pubspec.yaml` outside `node_modules`, `.dart_tool`, `.git`,
  `build`, `vendor`, `third_party` (ALWAYS_SKIP_DIRS from manifests.ts plus
  three); the example/test/fixture dirs that discover ignores still count, so
  selection errs toward cloning. Fallbacks: 409 = empty repo; 404 by branch
  name → branch lookup (404 = empty) and a retry by sha; `truncated: true`
  (100k entries / 7 MB) → partial tree plus root probe (`probe: truncated`);
  still no tree → root probe (`probe: root`). Requests: 1 per probed repo + 1
  per selected repo (pin), as before for selected-by-language repos; the tree
  and the pin are fetched moments apart by branch name (a push in between
  only makes the recorded manifests one commit older).
- **Who is probed:** every repo rules 2–3 let through (so language-matched
  repos too: the size rule needs the HEAD size), plus repos an explicit
  include/exclude glob matched (for the record: the excluded-repo warning).
  Archived, fork, template, empty and disabled repos are not probed; their
  manifests are unknown (`null`) and they are never in the warning.
  `repos.probe: false` skips every tree: API size and language only.
- **Size rule uses the HEAD size** (sum of blob sizes, KB): supabase/cli is
  301 MB by API `size` (packed history) and 26 MB at HEAD, supabase/supabase
  2.4 GB vs 740 MB. The API size is the fallback only when the tree was
  truncated or unreadable; the reason names which one was used. Default
  threshold unchanged (500).
- **Lockfile v3** (`"version": 3`): per repo `manifests` (paths), `headTreeKb`,
  `probe`; plus a derived `excluded` list (repo, joined reasons, manifests or
  null) for auditing. A rerun makes no API call. v2 files are read with their
  boolean root-probe results dropped, so each candidate is re-probed once at
  its pinned sha; a version above 3 is refused. Key order is canonical so
  unchanged selections never rewrite the file. The committed fixture
  lockfiles were upgraded with their pins kept.
- **Excluded repos with manifests are a warning** in the selection log,
  `sentei repos`, and the report. discover writes every listed repo it does
  not analyse (exclusions and clone failures skipped with
  `--allow-clone-failures`) to `excluded_repos (repo, reason, manifests)`; the
  report names each one with manifests, its exclusion kind and manifest count
  (report.json: all; stdout: the first ten). supabase/supabase (72 manifests,
  excluded by config) is the case that motivated it. The table is additive
  (`CREATE TABLE IF NOT EXISTS`, applied to an existing DB by openDb), so
  SCHEMA_VERSION stays 11 rather than forcing a rebuild of work DBs.
- **Live check** (2026-09-26): honojs, unjs and Workiva select the same repos
  as the old rules would (no repo there has only nested manifests outside a
  language match); supabase with its dogfood config selects 37 instead of 29:
  +realtime, edge-runtime, supavisor, etl, benchmarks, slim-services,
  supabase-swift, pulumi-supabase-analytics (nested manifests only); cli is
  now selected by its HEAD size (the dogfood run had to force it with
  `--include`); supabase and productions (excluded by config, 72 and 1
  manifests) are named in the warning.

### Phase 2 fix round 1: discover on flame-engine

- **Platform and native code of a pub package is not a consumer.**
  `unindexed_consumer` skips, for pub packages only, files under the
  package's `android`, `ios`, `macos`, `linux`, `windows`, `web`, `darwin`
  and `native` dirs and under `.plugin_symlinks` / `ephemeral`: Flutter
  runners, generated plugin registrants, federated plugin implementations and
  FFI shims reach Dart over method channels or FFI and cannot import a Dart
  library. The flag had blocked 313 flame-engine findings (306 in
  defend_the_donut). Unindexed code elsewhere in a pub package still flags it.
- **A pub package without `lib/` is private, `is_library = 0`**, whatever
  `publish_to` says (workspace roots `_` / `forge2d_workspace`, bin-only
  tools): package URIs resolve under `lib/`, so nothing can import it. Its
  "no entry points" warning is dropped. `lib/src/`-only packages stay as read.
  Done in discover (it has the file list) so manifests.ts is unchanged.

### Phase 2 fix round 1: version-skew filtering; test globs

**Version skew.** The supabase run reported 2572 version-skew references from
17 packages; none was skew. analyze.sql's new `unresolved_ref_classes` view
classifies every `unresolved_refs` row, first match wins, and the report keeps
only `version_skew` rows; the rest go to `report.json` `diagnostics`
(`unresolved_same_repo`, `unresolved_opaque_target`,
`unresolved_unindexed_module`: per target package, count and three example
names, most referenced first) with one stdout line each under the version skew
line. The old "index failed" warning is the `opaque_target` class now.

- `same_repo`: consumer and target in one repo, and the consumer's dependency
  admits HEAD (workspace / path / file, a range HEAD satisfies, or no declared
  dependency). One commit cannot skew against itself; the miss is an indexing
  gap (supabase-flutter: 2553 rows into pub workspace packages whose `lib/`
  failed to index, constraints equal to the HEAD version). **Deviation from the
  brief** ("same repo can never be skew"): the only real skew seen on any org,
  Workiva's over_react_analyzer_plugin, lives in the over_react repo and pins
  `over_react: 5.7.0` while HEAD is 5.8.0: pub takes the registry copy. So an
  exact version other than HEAD's, or a `^`/`~` range whose major differs from
  HEAD's, stays skew (Workiva rerun: the 3 `nameLexeme` rows survive). Other
  ranges that exclude HEAD (`<5.8.0`) are treated as admitting it: a missed
  skew row is only a report row, never a verdict.
- `opaque_target`: the target has an untargeted `package_flags` row
  (`opaque_packages`: index failed or partial, dynamic access) or no exported
  symbol. Only untargeted flags: a targeted flag is about the target's use of
  another package, not about its own surface.
- **External alias re-exports** (auth-helpers-shared's `export { parse as
  parseCookies } from 'cookie'`): the DB cannot tell "alias of an external
  module" from "org re-export the checker could not resolve": neither has a
  `symbols` row, and `symbol_exports` only links org symbols. Both reach the DB
  the same way, as the target's own sidecar `unresolved` entry
  (`<entry>#<name>`), which ingest turns into an untargeted `dynamic_access`
  flag, so such references are `opaque_target` (and on supabase also
  `same_repo`). Not distinguished further; that would need ingest to record the
  export's origin module.
- `unindexed_module`: a deep dist import (sidecar name `*`, e.g.
  `@supabase/supabase-js/dist/module/lib/types`; the M2 decision routed these
  to skew, but "missing at HEAD" is unknowable for build output) or a member of
  a JSON module (`` `openapi.json`/… ``: JSON documents are never indexed).
  Matched by `*.json` in the module segment only; other non-source modules have
  not been seen.
- supabase rerun of the report on the existing DB: version skew 2572 → 0;
  same_repo 2560, opaque_target 75 (`@supabase/postgrest-typegen`, index
  failed), unindexed_module 12. Workiva: 3 → 3.

**Test globs.** The supabase run had 235 `private_dead` rows that were test
infrastructure: `tests/` (cli `@supabase/stack`, pg-delta) and `type-tests/`
(middleware-openfeature). TEST_GLOBS gain `tests/`, `type-tests/`,
`testdata/`, `spec/`, `cypress/`, `playwright/`, Flutter `test_driver/` and
`integration_test/`, `*.fixture.*`, `*.e2e.*`, `vitest.setup.*`,
`jest.setup.*`, `setupTests.*` (`test/`, `__tests__/`, `__mocks__/`,
`test-utils/`, `testing/`, `e2e/`, `*.spec.*`, `*.test.*`, `*_test.dart` were
already there). Rerunning analyze on the supabase DB: `private_dead` 655 →
424, none left under `tests/` or `type-tests/`. Semantics unchanged: a test
file's references are not counted consumers (`only_test_refs`), and nothing
defined in a test file is ever `private_dead`. Not added: `integration/` and
`integrations/` (supabase uses them for product integrations), `setup.*`,
tool configs (`vitest.config.ts` stays a script file, whose references
count). Stories stay test files (the round-3 decision): moving them to docs
would switch which policy knob counts them and drop the dev-dependency rule,
and Storybook runs them as tests; `extraEntryPoints` is the way to make them
consumers. DOCS / SCRIPT: no gaps with findings in the evidence (over_react's
`web/**/demos/` has none).

**Library surface is never test/docs/script.** `SURFACE_DIRS` in globs.ts
(`pub: ['lib']`, `npm: []`), spelled by the new `surface_files` view that
`test_files` / `doc_files` / `script_files` exclude; globs.test.ts checks both
agree. Everything in a pub package's `lib/` is importable as
`package:<name>/…` and tests never live there, so `lib/src/*_test.dart`,
`lib/**/mocks/`, `lib/**/example/`, `lib/testing/` are library code; a
test-support package's whole API sits in such files. Generated globs still
apply under `lib/`. The witness uses the same rule for consumer files
(`inSurfaceDir`), so a mention in `lib/src/foo_test.dart` counts. On the
Workiva DB, `lib/over_react_test.dart` (over_react_test's main library!) was a
test file before; after, over_react_analyzer_plugin gets 41 `private_dead`
rows: the package sits under the repo's `tools/` directory, so every file of it
was a script file before (no findings at all); the new rows are real (e.g.
`BoolPropNameReadabilityDiagnostic` and `WrapUnwrapAssistContributor`, whose
registrations in `plugin.dart` are commented out).

npm gets no such directory. `src/` cannot be exempt, not even from directory
patterns only: `src/__tests__/`, `src/test/` and `src/mocks/` are standard
Jest/Vitest layouts. The closest npm analogue of `lib/`, the manifest's entry
points, is not exempt either: an entry can be test support on purpose (hono's
`hono/testing`, the known `testing/` trade-off of round 3) and
`extraEntryPoints` deliberately includes stories.

Not done (outside this change's files): the indexers still match TEST_GLOBS
without the `lib/` rule (`scip-dart.ts` drops `entrySymbols` in test-named
files, `consumer-checks.ts` `isExcludedConsumerFile` ignores unresolved imports
in them); `inSurfaceDir` is exported from `@sentei/core` for them. Globs are
matched against repo-relative paths, so a whole npm package under a `tests/`,
`e2e/` or `tools/` directory is still entirely test/script code; matching
package-relative paths is a separate change.

### Phase 2 fix round 1: namespace destructuring; conditional imports; headerless codegen

**Namespace values other than `import * as` bindings (adapter `+sentei.6`).**
supabase pg-delta's `const { analyzeAndSort } = await loadPgTopo()` (with
`loadPgTopo = () => import('@supabase/pg-topo')`) left pg-topo's
`analyzeAndSort` with no reference: scip-typescript 0.4.0 defines the
destructured binding as a `local` and links nothing to the module member; only
a module-level reference to `@supabase/pg-topo src/index.ts/` remains, which
ingest drops. Only the text witness kept it out of the deletion list.

The fix is at the sidecar boundary (`consumer-checks.ts`), with the checker:
- A **namespace type** is a type whose symbol is a source-file module inside
  an org checkout (`typeof import('x')`), found directly, in a union, as the
  awaited type of a `Promise`, or as an array / tuple element
  (`Promise.all([import('a'), import('b')])`).
- Every **object binding pattern** (variable, parameter, nested, `for…of`,
  `.then(({ a }) => …)`) whose type is a namespace records each element as a
  `namespaceMemberRefs` entry (the existing field: position of the property
  name, checker-resolved declaration; ingest adds the occurrence and edge when
  SCIP has none there). A destructuring assignment `({ a } = ns)` likewise.
- **Tracking instead of data flow.** Every identifier, property access,
  element access and call whose type holds a namespace is an *origin*. Its
  use is classified by its parent after climbing pass-throughs (`await`,
  parentheses, `as`, `!`, `??`, `||`, conditional arms, array literals) while
  the type stays a namespace: a member read (`m.a`, `m['a']`) is recorded; a
  location still typed as the namespace (a variable, a return with a namespace
  return type, an argument whose parameter is typed so, an assignment target,
  an object-literal property) is fine because its own reads are origins in
  turn; `await x;`, `!x`, `x === y`, `'k' in x`, conditions are harmless.
  Anything else (a rest element, a computed key, an argument of type
  `object` / `any` / a type parameter, a spread, `export`, a widening cast, a
  `.then(fn)` with a non-inline callback) raises **`namespace_dynamic`
  targeted at the module's package** plus a `namespaceSpreadRefs` entry for
  the module file (the existing handling: all its declarations stay
  reachable; cross-package occurrences are withheld because the flag blocks
  the package). Own-package modules get only the spread ref (a self-targeted
  flag would make the package opaque). A missing member of another org
  package is an `unresolvedImports` entry (version skew). Each widening is
  caught where it happens, so `async function load(): Promise<any> { return
  import('x') }` flags at the `return`.
- `import * as ns` keeps its own path (member refs only for bare org
  specifiers, as before), but its value uses now go through the same
  classification: `const { a } = ns` and `const m = ns; m.a` are resolved
  instead of flagged; `f(ns)` with a wider parameter, spreads, `export { ns }`
  still flag.
- Known gap (accepted): a namespace stored in an inferred object literal that
  is later widened as a whole (`const o = { ns }; take(o as unknown)`) is not
  seen; only the property's own reads are.

Measured on the supabase evidence (76 npm packages, new vs old adapter): no
flag, spread-ref or unresolved-import difference outside test files; pg-delta
gains `analyzeAndSort` (sql-order.ts:215) plus 14 own-package refs from
`await import('../src/…')` in tests and scripts; supabase/storage 462 member
refs (own modules imported dynamically by vitest mocks) and 15 fewer spread
refs than before (`const m = ns` is now tracked). Time is within noise (the
checker has typed these nodes already for the diagnostics pass). Fixture:
`lib-lazy` / `lib-lazy-opaque` / `app-lazy` in `fixtures/org-small`; the other
shapes are unit tests in `packages/cli/test/namespace-destructuring.test.ts`.
Snapshot change on the existing fixture: one new member ref (`app-consumer`'s
`import('@acme/widgets/lazy').then((m) => m.lazyWidget)`).

**Conditional imports (Dart; ingest side of the dart-surface `conditionalImports`
field).** `import 'unsupported.dart' if (dart.library.io) 'desktop.dart'` (and
the `export` form, fire_atlas's `storage.dart`): the analyzer, and so the
index, resolves every use against the default target, so the alternatives'
declarations (flame_3d's web GPU backend, ~70 symbols) had no references and
were `private_dead` whenever their package was not blocked. Ingest handles
each `{ file, line, col, target, alternatives }` entry with the existing
tables only (no schema or analyze.sql change):
- **Twin mirroring** when the target T is an indexed document of the repo: a
  conditional import requires each alternative B to offer T's API, so every
  symbol X of T lends its uses to B's twin X' (same descriptors after the
  module path; for a top-level X without one, B's top-level symbol of the same
  name, which covers a function in one file and a getter in the other): a copy
  of every reference occurrence of X (same consumer position and enclosing
  declaration) and of every edge into X. B's twins are then reachable and
  referenced exactly where T's are; B's private helpers follow through B's own
  edges and its members through their owners, so a helper nothing in B uses is
  still reported. Uses through a conditional export in a consumer file are
  covered too, since every reference to X is mirrored wherever it sits.
- **Document fallback** when there is nothing to match on (the default is a
  `dart:` / `package:` URI outside the repo, or a synthetic module symbol):
  every top-level symbol of B gets an edge from A's module symbol and from each
  top-level declaration of A ("B is reachable whenever A is"), plus an
  occurrence at the directive for exported ones (fail closed).
- An alternative in another package than the importing document is seeded
  (`entry_symbols`), since `reach_edges` never crosses packages; alternatives
  outside the repo are skipped; an importing file or in-repo alternative that
  is not an indexed document is counted and warned about.
- Because everything lands in `occurrences` / `edges` / `entry_symbols`, no
  SQL view needs a new input. Test: `packages/core/test/conditional-imports.test.ts`
  (hand-made SCIP and sidecar; the gap without the field, twins by descriptor
  and by name, the URI fallback, the negative dead helper, warnings). The
  scip-dart adapter must copy the field into `<pkg>.exports.json` (the Dart
  branch's side).

**`lib/` exemption in the adapter checks.** `isExcludedConsumerFile` and
`unindexedScope` (consumer-checks.ts) take an optional package location and
apply core `inSurfaceDir` first, so a file under a pub package's `lib/` is
never test/docs/script code there either, as in the SQL views. The TS adapter
passes its (npm) package, a no-op today (`SURFACE_DIRS.npm` is empty). The one
pub caller, `scip-dart.ts`'s unresolved-import filter
(`isExcludedConsumerFile(m.file, input.policy)`), still calls it without a
package and so keeps glob-only matching until it passes `{ manager: 'pub',
path: pkg.path }` (that file belongs to the Dart branch).

**Headerless codegen.** `documents.is_generated` is set at ingest from two
inputs: core `GENERATED_GLOBS` on the path (every language) and the TS
sidecar's `generatedFiles`, which the adapter fills with
`isGeneratedFile` (consumer-checks.ts: globs, tool-output dirs, a few names,
and generated-header comments in the first 20 lines). `supabase gen types
typescript` output has no header, so dbdev-website's
`website/data/database.types.ts` produced 6 noise rows. `isSupabaseGenTypes`
now recognises that shape, and only all of it: a `.ts` file whose first
statement (after comments) is `export type Json =`, with a top-level `export
type Database = {` (older CLIs: `export interface Database {`) and `Tables: {`,
`Views: {` and `Functions: {` blocks at the generator's schema indentation
(four spaces, or two tabs after reformatting); the whole file is read only when
the head starts with `export type Json =`. On the supabase checkouts it matches
the 9 real gen-types files (dbdev-website, smart-office-demo, the CLI's
feedback types, supabase-action-example, auth-helpers examples, supabase-js
test fixtures) and none of the ~30 other files mentioning `Database`/`Json`
(the typegen's own source and tests, hand-written clients). Prisma: its client
lives in `node_modules/.prisma/client` (never a document); a custom output
under `generated/` is already a glob, Prisma's own header ("code generated by
Prisma") is already a header match, and a `.prisma/` directory elsewhere is
now a tool-output dir. A wrong `is_generated` hides real code, hence no looser
rule (no name-only match on `database.types.ts`).
