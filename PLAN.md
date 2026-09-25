# sentei (剪定) — org-wide dead export detection

Handoff plan. Read fully before starting. Decisions marked **DECIDED** are settled;
do not relitigate them. Items marked **OPEN** need a decision from Budro; ask before
building on them.

## 1. Goal

Given every repo in a GitHub org, find exported symbols in org-owned packages that
no other repo in the org uses, apply an age/closed-world policy, and report them
as deletion candidates. Then compute what becomes unreachable inside each package
once those exports are gone (private symbols, private circular islands).

Output is a report (SARIF + JSON), optionally auto-PRs. The tool never deletes
anything on its own in v1.

## 2. Non-goals (v1)

- Dead-branch / unreachable-statement detection. Assumed handled by per-repo lints.
- Runtime/dynamic usage evidence (telemetry, logs). Static only. Overlay hook is
  designed in (see §7) but not implemented.
- Public npm/pub.dev packages with unknown external consumers. These are analyzed
  but only ever produce `deprecation_candidate`, never `deletion_candidate`.
- Auto-PRs. Design the report so a later milestone can generate them.
- Languages other than TypeScript/JavaScript and Dart. A consumer repo containing
  code in a language with no precise indexer is flagged `unindexed_consumer`
  (opaque) — we never guess. The tool only runs with proper indexers.

## 3. Architecture (DECIDED)

Pipeline of independent stages, each writing to disk so stages can be rerun alone.

```
discover  →  index  →  ingest  →  analyze  →  report
 (org)      (per repo)  (DB)      (queries)   (SARIF/JSON)
```

- **Ingest format: SCIP.** Indexers emit `.scip` protobuf files. We never write
  language-specific resolution logic ourselves for TS/Dart.
- **No Glean.** Own storage. Glean can be added later as an optional sink; it reads
  SCIP natively.
- **Storage: SQLite via `node:sqlite`** (built into Node ≥ 26; zero dependency).
  Chosen over DuckDB because we lean on constraints and triggers (§5.1), which
  DuckDB lacks. All tables `STRICT`. `PRAGMA foreign_keys = ON` always. Escape
  hatch if a query is ever too slow: DuckDB's sqlite extension can read the same
  file for that one query; no migration.
- **Implementation language: TypeScript (Node ≥ 26).** Reasons: scip-typescript is
  Node, SCIP protobuf bindings are trivial to generate, and the orchestration layer
  is glue. Keep dependencies minimal (see §11).
- **Lean on the schema.** Structural invariants live in the schema (FKs, UNIQUE,
  CHECK, NOT NULL, triggers — see §5.1) so no stage can violate them. Analysis
  rules that are policy (age, test-file handling, closed-world) live in SQL views
  in `packages/core/sql/*.sql`, loaded verbatim. TypeScript does orchestration,
  subprocesses, SCIP decoding, and inserts. Rule of thumb: if a rule references
  a config value, it's a view; if it's always true, it's a constraint. The DB file
  is a first-class debugging artifact (`SELECT * FROM findings WHERE ...`).
- **Indexers are out of scope.** They're subprocesses behind a boundary contract
  (§6.8). We pin versions, capture diagnostics, and fail closed; we do not patch
  their bugs in our code.
- **Own internal model.** SCIP is converted to our schema (§5) at ingest. Nothing
  after ingest may reference SCIP types. This is the escape hatch for swapping
  indexers.
- **Fail closed.** Any uncertainty poisons toward "alive", never toward "dead".

Main dev box is Windows 10; CI is Linux. Use `path.posix` for anything stored in
the DB, normalize line endings, never assume a shell.

## 4. Repo layout

```
sentei/
  package.json            # workspaces
  packages/
    core/                 # schema, ingest, policy config — no I/O to GitHub
      sql/                # ALL analysis lives here as views/CTEs, loaded verbatim
    cli/                  # `sentei` entry point, subcommands = stages
    indexers/
      scip-dart-emitter/  # Dart analyzer → SCIP (only if scip-dart proves inadequate, §6.2)
  fixtures/
    org-small/            # 3–4 fake repos exercising every edge case in §8
  docs/
    DESIGN.md             # keep this plan's decisions here as they evolve
```

## 5. Data model

All paths POSIX, relative to repo root. All IDs stable across runs.

```sql
CREATE TABLE repos (
  repo TEXT PRIMARY KEY,           -- "org/name"
  default_branch TEXT,
  head_sha TEXT,
  indexed_at TIMESTAMP,
  index_status TEXT                -- 'ok' | 'partial' | 'failed'
);

CREATE TABLE packages (
  package_id TEXT PRIMARY KEY,     -- "<manager>:<name>" e.g. "npm:@acme/foo", "pub:foo"
  repo TEXT,
  path TEXT,                       -- dir of package.json / pubspec.yaml
  manager TEXT,                    -- 'npm' | 'pub'
  name TEXT,
  version TEXT,
  visibility TEXT,                 -- 'private' | 'published-private' | 'published-public'
  entry_points TEXT[]              -- resolved entry files (see §6.3)
);

-- who depends on whom, from manifests (NOT from code)
CREATE TABLE package_deps (
  consumer_package_id TEXT,
  dep_name TEXT,
  dep_manager TEXT,
  constraint TEXT,
  resolved_package_id TEXT         -- NULL if dep is not an org package
);

CREATE TABLE symbols (
  symbol_id TEXT PRIMARY KEY,      -- SCIP symbol string, verbatim
  package_id TEXT,
  file TEXT,
  line INT, col INT,               -- definition site
  kind TEXT,                       -- function|class|variable|type|... (from SCIP SymbolInformation.kind)
  name TEXT,
  is_exported BOOLEAN,             -- computed in analyze, §6.3
  is_entry_reachable BOOLEAN,      -- computed in analyze
  first_seen_sha TEXT,
  first_seen_at TIMESTAMP          -- git blame of definition line (author date)
);

-- one row per occurrence; roles per SCIP
CREATE TABLE occurrences (
  symbol_id TEXT,
  package_id TEXT,                 -- package of the FILE containing the occurrence
  file TEXT,
  line INT, col INT,
  role INT,                        -- SCIP SymbolRole bitmask
  enclosing_symbol_id TEXT         -- NULL at top level
);

-- derived edges for reachability: enclosing symbol -> referenced symbol
CREATE TABLE edges (
  from_symbol_id TEXT,
  to_symbol_id TEXT,
  from_package_id TEXT,
  to_package_id TEXT,
  source TEXT                      -- 'scip' | 'overlay'
);

CREATE TABLE package_flags (
  package_id TEXT,
  flag TEXT,                       -- 'opaque_consumer' | 'index_failed' | 'dynamic_access' | ...
  reason TEXT,
  file TEXT
);

CREATE TABLE witness_ok (             -- §9; presence = text witness passed
  symbol_id TEXT PRIMARY KEY REFERENCES symbols,
  checked_at TIMESTAMP NOT NULL
);

CREATE TABLE findings (
  symbol_id TEXT,
  verdict TEXT,                    -- 'deletion_candidate' | 'deprecation_candidate' | 'unexport_candidate' | 'private_dead'
  reasons TEXT[],
  blocked_by TEXT[]                -- flags that would have prevented a stronger verdict
);
```

### 5.1 Schema invariants (DECIDED — these are the point of using a DB)

Encode in `packages/core/sql/schema.sql`; the test suite must include a negative
test per invariant proving the insert is rejected.

- `packages`: `UNIQUE (manager, name)` — duplicate org package names are a hard
  error at discover, not a runtime surprise. `CHECK (visibility IN (...))`.
- `symbols`: `symbol_id INTEGER PRIMARY KEY` (interned); `symbol_str TEXT UNIQUE NOT NULL`
  holds the SCIP string. `package_id NOT NULL REFERENCES packages ON DELETE CASCADE`.
- `occurrences`: `symbol_id NOT NULL REFERENCES symbols`; `package_id NOT NULL
  REFERENCES packages`; generated column
  `is_external AS (package_id <> (SELECT package_id FROM symbols WHERE ...))` —
  if SQLite rejects the subquery in a generated column, store `def_package_id`
  denormalized on insert and generate from that. One definition of "external",
  used everywhere.
- `edges`: both endpoints `REFERENCES symbols`, both packages `REFERENCES packages`,
  `CHECK (source IN ('scip','overlay'))`, index on `from_symbol_id`.
- `repos` is the cascade root: `DELETE FROM repos WHERE repo = ?` removes every
  derived row. Re-index = delete + insert inside one transaction.
- `findings` triggers (fail-closed made structural):
  - `BEFORE INSERT`: RAISE(ABORT) if `verdict = 'deletion_candidate'` and any
    consumer package of the symbol's package has a row in `package_flags` with
    an opaque-class flag.
  - `BEFORE INSERT`: RAISE(ABORT) if `verdict IN ('deletion_candidate',
    'unexport_candidate')` and the symbol's package is not closed-world.
  - `BEFORE INSERT`: RAISE(ABORT) if `verdict = 'deletion_candidate'` and
    `keep` list matches (keep list is loaded into a `keep_rules` table).
  - `BEFORE INSERT`: RAISE(ABORT) if `verdict = 'deletion_candidate'` and the
    symbol has no row in `witness_ok` (§9) — the text witness must have run and
    passed for every deletion candidate.
- Ingest transaction discipline: one repo per transaction; `PRAGMA defer_foreign_keys = ON`
  inside it for bulk-insert speed; `PRAGMA foreign_key_check` before COMMIT.
- Never disable `foreign_keys` globally. Never `INSERT OR IGNORE` into
  `symbols`/`packages` — a conflict is a bug to surface.

Materialized views (recompute in `analyze`):
- `external_refs(symbol_id, consumer_package_id, count)` — occurrences with
  Reference role where `occurrences.package_id != symbols.package_id`.
- `internal_refs(symbol_id, count)`.

## 6. Stages

### 6.1 `discover`

Input: org name, GitHub token (env `GITHUB_TOKEN`), optional repo allow/deny globs.
Output: `work/discover.json`.

1. List all non-archived repos via GitHub API. Record default branch + HEAD sha.
2. Shallow-clone each (`--depth=1` for indexing; blame needs history — see 6.5).
3. Walk each repo for `package.json` and `pubspec.yaml`. Skip `node_modules`,
   `.dart_tool`, `build`, vendored dirs.
4. Populate `packages` and `package_deps`. Resolve `resolved_package_id` by
   matching `(manager, name)` against org packages. Workspace/path deps resolve too.
5. Determine `visibility`:
   - npm: `"private": true` → `private`; `publishConfig.registry` pointing at a
     non-registry.npmjs.org host → `published-private`; otherwise
     `published-public`. **OPEN:** confirm what the org's private registry is.
   - pub: `publish_to: none` → `private`; custom `publish_to` → `published-private`;
     otherwise `published-public`.

### 6.2 `index`

Per repo, produce `work/index/<repo>/*.scip`. Each package/tsconfig gets its own
index file; record which package each file belongs to.

TypeScript/JavaScript:
- `npm ci` (or pnpm/yarn per lockfile), then `scip-typescript index` with
  `--yarn-workspaces` / `--pnpm-workspaces` where applicable; `--infer-tsconfig`
  for JS-only packages.
- Capture stderr. Any diagnostics of severity error → `index_status='partial'`,
  and flag every package in that project `opaque_consumer`.
- Run under `node --max-old-space-size=8192`; make configurable.

Dart:
- Try `scip-dart` first. Evaluate on `fixtures/org-small` against the checklist in
  §8. If it fails any of: `show`/`hide` combinators, part files, extension methods,
  `export` directives in `lib/foo.dart` re-exporting `src/`, then implement
  `packages/indexers/scip-dart-emitter` using `package:analyzer` resolved ASTs.
  This is a few hundred lines; don't over-engineer it. Emit the SCIP symbol format
  as `scip-dart pub <name> <version> <lib path>/<descriptors>` so it matches what
  scip-dart would produce.

Indexes are cacheable by `head_sha`; skip if unchanged.

### 6.3 `ingest` + entry points / export surface

1. Parse `.scip` (generate TS bindings from `scip.proto`; vendor the `.proto`).
2. Map every document to a `package_id` by longest-prefix match on package path.
3. Insert symbols/occurrences. Build `edges` from `(enclosing_symbol → symbol)` for
   Reference-role occurrences. Occurrences at file top level get
   `enclosing_symbol = <file pseudo-symbol>`.
4. Compute `entry_points` per package:
   - npm: `main`, `module`, `types`, `bin` (object or string), `exports` (all
     conditions, resolve `*` patterns against the filesystem), `browser` if string.
     Fall back to `index.{ts,js,mjs,cjs}`.
   - pub: every file directly under `lib/` (not `lib/src/`), plus `bin/`.
   Also treat as entry points: files matched by a per-repo `sentei.json`
   `extraEntryPoints` glob list (for Storybook, examples, codegen inputs).
5. `is_exported`: symbol is defined in an entry file and has an export-ish SCIP
   descriptor (TS: the symbol is exported from the module, incl. via `export ... from`
   chains; Dart: not underscore-prefixed and in a `lib/` non-`src` file, or
   re-exported via `export` directive). Follow `export *` chains transitively;
   if a chain hits an unresolvable module, flag the package `dynamic_access`.
6. `is_entry_reachable`: recursive CTE over `edges`, seeded from all exported
   symbols + entry file pseudo-symbols, restricted to `from_package_id =
   to_package_id`. Everything not reached is unreachable within the package.
   (This is what catches private circular islands.) Sketch:

   ```sql
   WITH RECURSIVE reach(symbol_id, package_id) AS (
     SELECT symbol_id, package_id FROM symbols WHERE is_exported
     UNION
     SELECT e.to_symbol_id, e.to_package_id
     FROM edges e JOIN reach r ON e.from_symbol_id = r.symbol_id
     WHERE e.from_package_id = e.to_package_id
   )
   SELECT ...
   ```
   The private-dead closure in §6.5 is the same CTE with a different seed
   (exported symbols minus candidates); implement it as one parameterized view.

### 6.4 `blame`

For every symbol with `is_exported=true`, `git blame -L<line>,<line> --porcelain`
at the definition file; store author-time as `first_seen_at`. Requires
non-shallow history for those files only: `git fetch --unshallow` is simplest;
if too slow, `git fetch --deepen` incrementally. Cache by `(repo, sha, file, line)`.

**Caveat to encode:** blame gives the last edit of that line, not creation. Good
enough for v1; note it in the report. Follow-up: use `git log -S<name> --reverse`
for a creation estimate on candidates only.

### 6.5 `analyze` — verdicts

Definitions:
- `closed_world(P)` := `P.visibility == 'private'` OR (`'published-private'` AND
  config `trustPrivateRegistry: true`).
- `consumers(P)` := packages with `package_deps.resolved_package_id = P`.
- `opaque(P)` := P has any `package_flags` in
  {`opaque_consumer`, `index_failed`, `dynamic_access`, `namespace_dynamic`}.

For each exported symbol S in package P:

```
if any consumer C in consumers(P) is opaque(C):        → no verdict, blocked_by += opaque consumers
elif external_refs(S) > 0:                              → alive
elif internal_refs(S) > 0:
    if closed_world(P) and age(S) >= policy.minAgeDays: → unexport_candidate
    else:                                               → deprecation_candidate (published) / none
else:  # no refs anywhere
    if closed_world(P) and age(S) >= policy.minAgeDays: → deletion_candidate
    elif not closed_world(P):                           → deprecation_candidate
    else:                                               → none (too young)
```

Then: recompute reachability with all `deletion_candidate` + `unexport_candidate`
symbols treated as non-exported. Every symbol that was reachable before and is
unreachable after → `private_dead`, with `reasons` naming which candidate(s)
unlock it. Also report symbols that were *already* unreachable before any
removal as `private_dead` with reason `already_unreachable` (these are the
existing private islands the per-repo lints miss).

Policy defaults (`sentei.json` at org level, overridable per repo):
```json
{
  "minAgeDays": 180,
  "trustPrivateRegistry": true,
  "countTestsAsConsumers": false,
  "countDocsAsConsumers": false,
  "keep": ["npm:@acme/foo#someSymbol", "pub:bar#*"]
}
```

`countTestsAsConsumers=false` means references from files matching test globs
(`**/*.test.*`, `**/*_test.dart`, `**/test/**`, `**/__tests__/**`) do not count
as external refs, but a symbol whose only refs are tests gets reason
`only_test_refs` so the report can say "delete the tests too".

### 6.6 Indexer boundary contract

Each indexer (scip-typescript, scip-dart, any future one) is
invoked through one interface in `packages/cli/src/indexers/<name>.ts`:

```ts
interface Indexer {
  name: string;
  version: string;                       // pinned; bump deliberately
  detect(pkg: Package): boolean;         // does this indexer own this package?
  run(pkg: Package, out: string): Promise<{ status: 'ok'|'partial'|'failed'; diagnostics: string[] }>;
}
```

Rules:
- Indexer versions are pinned in `package.json`/lockfile. Upgrading one requires
  re-running the fixture org and diffing the produced `.scip` snapshots
  (`scip snapshot` output checked into `fixtures/snapshots/<indexer>@<version>/`).
  A changed snapshot is reviewed like a code change.
- Any diagnostic of severity error → `partial`, package flagged `opaque_consumer`.
- We never post-process SCIP to "fix" an indexer. Workarounds go in overlays (§7)
  with a comment naming the upstream issue.

### 6.7 `report`

- `work/report.json`: full findings with reasons and blocked_by.
- `work/report.sarif` per repo: one result per finding, level = note for
  deprecation/unexport, warning for deletion_candidate, with the definition
  location. Rule IDs: `sentei/deletion`, `sentei/unexport`,
  `sentei/private-dead`, `sentei/deprecation`.
- Summary table to stdout: per package, counts by verdict, and the top blockers
  (which opaque consumer is preventing the most verdicts — this is the
  actionable "go fix that repo's tsconfig" list).

## 7. Overlays (design now, minimal impl)

`sentei.json` per repo may contain:
```json
{
  "extraEntryPoints": ["stories/**/*.tsx"],
  "extraEdges": [{ "from": "file:src/registry.ts", "to": "npm:@acme/plugins#*" }],
  "keep": ["npm:@acme/foo#legacyThing"]
}
```
`extraEdges` insert rows into `edges` with `source='overlay'`. `*` expands to all
exported symbols of the package. This is also where runtime evidence would be
injected later (a job that writes `extraEdges` from logs).

## 8. Edge cases — fixture checklist

`fixtures/org-small` must contain each of these, with an expected-findings file
that the test suite asserts against exactly.

TypeScript:
- [ ] `import { a } from '@acme/x'` (named)
- [ ] `import * as X from '@acme/x'; X.a()` — member access counts as ref to `a`
- [ ] `import * as X ...; X[key]` — flag consumer `namespace_dynamic`
- [ ] `export * from './internal'` in entry file — transitive export surface
- [ ] `export { a as b } from '@acme/y'` — re-export across org packages: `a` is alive
- [ ] `export default` anonymous — treat as symbol named `default`
- [ ] `import('@acme/x')` dynamic import with static string — resolve normally
- [ ] `require('@acme/' + name)` — flag `dynamic_access`
- [ ] Subpath import `@acme/x/deep` against `exports` map with `*`
- [ ] Type-only import (`import type`) — counts as a ref (deleting a type breaks builds)
- [ ] JSX component usage `<Foo />`
- [ ] Symbol used only in `*.test.ts` in another repo → `only_test_refs`
- [ ] Two org packages with the same name in different repos → error at discover, must be unique
- [ ] Consumer pinned to old version of P that references a symbol no longer at HEAD →
      report as `version_skew`, do not treat as dead (need: ref to unknown symbol in P)
- [ ] Private circular island: `_a` calls `_b`, `_b` calls `_a`, nothing exported reaches them
- [ ] Export used internally only → `unexport_candidate`, not deletion
- [ ] Package with `"private": true` vs published-public → verdict differs

Dart:
- [ ] `import 'package:x/x.dart' show a;` / `hide`
- [ ] `lib/x.dart` with `export 'src/impl.dart';` — surface follows the export
- [ ] `export 'src/impl.dart' show Foo;`
- [ ] `part` / `part of` files
- [ ] Extension method usage (implicit — no identifier names the extension)
- [ ] Unqualified use of an imported top-level function
- [ ] `_private` top-level in `lib/x.dart` — never exported
- [ ] `pubspec.yaml` `publish_to: none`
- [ ] Path dependency (`path: ../y`) resolves to org package

General:
- [ ] Repo whose index fails → all its packages opaque; every P it depends on has
      blocked verdicts naming this repo
- [ ] Symbol younger than `minAgeDays` → no deletion verdict
- [ ] `keep` list suppresses a finding
- [ ] Consumer repo with a Go/Python/other file importing an npm org package (e.g.
      via a build script) → `unindexed_consumer`, verdicts for that package blocked
- [ ] Witness check: hand-corrupt a `.scip` fixture to drop one reference; the
      deletion candidate must be downgraded to `needs_review` / `witness_mismatch`

## 9. Text witness (required before any `deletion_candidate` is emitted)

We run only with precise indexers, but we do not fully trust them. The witness is
a deliberately dumb, independent second opinion with zero shared code with the
indexer: plain text search.

For each would-be `deletion_candidate` S in package P, for every consumer C of P
(from `package_deps`, i.e. manifests, not SCIP):
1. Collect files in C that mention P's package name in an import/require/`export from`
   line (regex, per language).
2. Search those files for `\bS.name\b`.
3. Any hit → downgrade S to `needs_review` with reason `witness_mismatch` and the
   file:line. No hit → insert `(symbol_id, checked_at)` into `witness_ok`.

The `findings` trigger (§5.1) refuses a `deletion_candidate` without a `witness_ok`
row, so the witness cannot be skipped by accident. False positives (a same-named
local variable) cost a manual look; false negatives are impossible for anything the
indexer could have seen. This also catches version skew: a consumer pinned to an
older P that still names the symbol.

No tree-sitter, no dependencies: `node:fs` + regex. Runs only over candidates, so
cost is negligible.

## 10. Milestones

Each milestone ends with tests green on `fixtures/org-small` and a short note in
`docs/DESIGN.md` on anything learned.

**M0 — Skeleton (½ day)**
Monorepo, CLI with stage subcommands that no-op, SQLite schema created from §5
including every §5.1 constraint and trigger, with one negative test per
invariant. Fixture org with 2 TS packages (one consumer, one lib) checked in.

**M1 — TS end to end, single repo (1–2 days)**
`discover` on a local directory (no GitHub yet), `index` via scip-typescript,
`ingest`, `analyze` with the verdict rules, JSON report. Fixture: TS cases only.
Acceptance: expected-findings match exactly.

**M2 — Org discovery + blame (1 day)**
GitHub API listing, cloning, cache by sha, blame stage, age policy. Acceptance:
runs against a real org (pick one of Budro's) and produces a report; spot-check
5 deletion candidates by hand.

**M3 — Dart (1–2 days)**
Evaluate scip-dart against the Dart checklist. Implement own emitter if needed.
Acceptance: Dart fixture cases pass.

**M4 — Text witness + unindexed consumers (½ day)**
§9 witness, `witness_ok` table + trigger, `unindexed_consumer` flagging wired
through blocked_by. Acceptance: the corrupted-`.scip` fixture case and the
unindexed-consumer case pass.

**M5 — SARIF + blockers summary (½ day)**
SARIF output validated against the schema; stdout summary. Acceptance: upload to
GitHub Code Scanning on one repo and see results.

**M6 — Hardening on real org**
Run nightly for a week. Log every false "dead" found by humans as a fixture case.
Only after this may an auto-PR milestone be considered.

## 11. Dependencies (keep this list short; justify additions in DESIGN.md)

- `@sourcegraph/scip-typescript` (indexer, invoked as a subprocess, not imported)
- `protobufjs` or `@bufbuild/protobuf` for SCIP decoding (vendor `scip.proto`)
- (none for storage — `node:sqlite` is built in)
- `@octokit/rest`
- `simple-git` or raw `git` subprocess (prefer raw subprocess)
- Test: `vitest`

No ORM, no framework, no LLM calls anywhere in the pipeline.

## 12. Things to NOT do

- Do not attempt to make a verdict for a package with any opaque consumer. Report
  the blocker instead.
- Do not add heuristic/unresolved reference extraction as a source of edges. The
  only edges are precise-indexer edges and explicit overlays. Unindexed code makes
  its package opaque; it never contributes guesses.
- Do not infer "unused" from download counts, npm stats, or GitHub search for
  public packages in v1.
- Do not delete, open PRs, or push anything.
- Do not add per-language resolution logic outside the indexer boundary; if the
  indexer is wrong, fix or replace the indexer, don't patch around it in `analyze`.

## 13. Dogfood orgs

Public orgs used as integration targets. Every package in them is
`published-public`, so runs use `assumeClosedWorld: true` (policy flag; the report
header must state loudly that it was on). Pin SHAs on first run via
`sentei discover --lockfile fixtures/orgs/<org>.lock.json` and commit the lockfile;
rerun against the lockfile so tool regressions are distinguishable from upstream
churn.

| Org | Language | Why | Milestones |
|---|---|---|---|
| `unjs` | TS | ~60 independent single-purpose repos that depend on each other heavily; clean CI; the canonical cross-repo case | M1, M2, M4, M5 |
| `Workiva` | Dart | Dozens of interdependent Dart repos; the org scip-dart was written against | M3 |
| `dart-lang` | Dart | Few repos, each a monorepo of many packages — tests "one repo, many packages" | M3 |
| `honojs` | TS | Small (~12 repos), quick second TS data point | M2 |
| `sindresorhus` | TS/JS | A user, not an org: hundreds of tiny cross-dependent packages. Volume test and index-failure-handling test; `discover` must accept users | after M5 |
| `VeryGoodOpenSource`, `bluefireteam` | Dart | Smaller multi-repo Dart orgs, optional second data points | optional |

Budget ~1h for the first `unjs` index; every later run must hit the sha cache and
go straight to ingest. Spot-check ≥5 deletion candidates per org by hand and
record outcomes in `docs/DESIGN.md`.

## 14. OPEN questions for Budro

1. Which org(s) to run against first, and is there a private npm/pub registry?
2. Should `bin/` scripts and example apps count as consumers or as entry points
   of their own package? (Default in plan: entry points, so they keep things alive.)
3. `minAgeDays` default of 180 — ok?

---

## Decisions taken at kickoff (2026-09-24)

Answers from Budro to the OPEN items, recorded here so the plan is self-contained:

1. **Orgs / registry:** dogfood orgs per §13 (unjs first for TS, Workiva for Dart).
   No private registry to detect. **For the implementation/testing phase, every
   package is treated as `published-private`** (policy flag `assumeClosedWorld`
   / visibility override), so deletion verdicts are reachable. This may flip to
   `published-public` after implementation and testing; the report header must
   state the assumption loudly (§13).
2. **`bin/` and example apps:** keep the plan default — entry points of their own
   package.
3. **`minAgeDays`:** 180.
4. **Toolchain:** Node 26, Dart 3.11.3, git, gh authenticated. M6 (a week of
   nightly runs) is out of scope for the autonomous run.
