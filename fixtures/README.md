# fixtures

## org-small

A fake GitHub org (`acme`) used as the end-to-end test input.

- `org.json` — the org listing (`org`, `repos[].name`, `repos[].default_branch`),
  standing in for the GitHub API response.
- `repos/<name>/` — one directory per repo (plain directories, not git repos).
- `sentei.json` — org-level policy. `minAgeDays` is 0 because fixtures have no
  git history yet (blame arrives in M2).
- `expected-findings.json` — the exact findings the pipeline must produce,
  sorted by `package_id` then `symbol`. Tests assert it **exactly**: a missing
  or extra finding fails.

Every symbol in the fixture sources carries a one-line comment stating its
expected verdict.

Current contents: `lib-core` (`@acme/core`) and `app` (`@acme/app`) from M0, plus
the PLAN.md §8 TypeScript/General cases below. `expected-findings.json` is the
exact output (base verdicts) for `sentei.json` as checked in (`minAgeDays: 0`).
There is one expected file per org: the report views (`delete`, `deprecate`,
`org_dead`, `unexport`, ...) are filters over these rows, and
`packages/cli/test/pipeline.test.ts` checks them on the same run.
Published-public `@acme/widgets` gets `deprecation_candidate` where a private
package gets `deletion_candidate` (same evidence, witness included); its
`unusedHelper` is `private_dead` `unlocked_by:internalUnused` and shows in the
`org_dead` view (dead only if the org is widgets' only consumer), not in
`private_dead`.

Findings rows: `package_id` (`<manager>:<repo>:<name>`, e.g.
`npm:acme/lib-core:@acme/core`), `symbol`, `file` (repo-relative), `verdict`,
`reasons`, `blocked_by` (only when non-empty), sorted by package_id, symbol, verdict.

| Repo | Package | Visibility | Role |
| --- | --- | --- | --- |
| `lib-core` | `@acme/core` | private | lib (M0) |
| `app` | `@acme/app` | private | consumer of core (M0) |
| `lib-y` | `@acme/y` | private | lib; consumed by widgets, consumer, broken, tool-py |
| `lib-widgets` | `@acme/widgets` | **published-public** | lib with an `exports` map; depends on y |
| `app-consumer` | `@acme/consumer` | private | consumer of widgets + y (all the static reference forms); `@acme/testkit` in `devDependencies` only |
| `lib-dyn` | `@acme/dyn` | private | lib whose only consumer is dynamic |
| `lib-testkit` | `@acme/testkit` | private | test-support lib; its only consumer uses it from a test file, as a dev dependency |
| `app-dynamic` | `@acme/app-dynamic` | private | flagged `namespace_dynamic` + `dynamic_access` |
| `app-skew` | `@acme/app-skew` | private | pinned to widgets `1.0.0`, names a removed export |
| `repo-broken` | `@acme/broken` | private | invalid `tsconfig.json` → index fails |
| `tool-py` | `@acme/tool-py` | private | consumer of y with a Python file (`scripts/build.py`) → `unindexed_consumer` |
| `lib-cascade` | `@acme/cascade` | private | no org consumer; exercises the witness → analyze cascade, `exports` conditions, the `imports` map and a Vite `index.html` entry (see below) |
| `app-worker` | `@acme/worker` | private | Cloudflare Worker app, no `main`/`exports`: runtime entries by convention (wrangler `main`, Pages `functions/`), a `bin` outside the program, TS namespaces, and a consumer of `@acme/widgets/lazy` naming a widgets candidate (see below) |

Note: `lib-widgets` imports `@acme/y`, so it typechecks only with
`node_modules/@acme/y` linked (as the indexer does). `app-skew` fails typecheck
by design with a single TS2305 on `removedFn`. Consumers of `@acme/widgets` need
`"jsx": "preserve"` because `widget.tsx` is compiled into their program;
`widget.tsx` pulls its JSX typing in with a `/// <reference path>`.

### §8 checklist coverage

| §8 item | Where | Expected |
| --- | --- | --- |
| Named import `import { a } from '@acme/x'` | `app-consumer/src/main.ts` → `@acme/widgets#internalUsed` | alive |
| `import * as X; X.a()` counts as ref to `a` | `app-consumer/src/main.ts` `W.namespaceUsed()`; `namespaceUnused` never accessed | `namespaceUsed` alive; `namespaceUnused` deprecation_candidate (widgets is published) |
| `import * as X; X[key]` → `namespace_dynamic` | `app-dynamic/src/main.ts` | `@acme/dyn#dynA`, `dynB` blocked |
| `export * from './internal'` in entry file | `lib-widgets/src/index.ts` → `src/internal.ts` | `internalUsed` alive; `internalUnused` deprecation_candidate |
| `export { a as b } from '@acme/y'` | `lib-widgets/src/index.ts` (`yThing as widgetY`), used as `widgetY` in `app-consumer` | `@acme/y#yThing` alive |
| `export default` anonymous → symbol `default` | `lib-widgets/src/anon.ts` (imported), `src/unused-anon.ts` (not) | anon alive; unused-anon `default` deprecation_candidate |
| `import('@acme/x')` with static string | `app-consumer/src/main.ts` → `@acme/widgets/lazy` | `lazyWidget` alive |
| `require('@acme/' + name)` → `dynamic_access` | `app-dynamic/src/load.cts` | `@acme/dyn` verdicts blocked |
| Subpath import against `exports` `*` pattern | `app-consumer/src/main.ts` → `@acme/widgets/deep/thing` (`"./deep/*"`) | `deepThing` alive |
| `import type` counts as a ref | `app-consumer/src/main.ts` → `WidgetOptions` | alive |
| JSX `<Foo />` | `app-consumer/src/view.tsx` → `Widget` | alive |
| Used only in `*.test.ts` of another repo → `only_test_refs` | `app-consumer/src/widgets.test.ts` → `testOnlyFn` | deprecation_candidate `["only_test_refs"]` (widgets is published) |
| Used only in a test file of a consumer that declares the package only in `devDependencies` → counts | `app-consumer/src/widgets.test.ts` → `@acme/testkit#renderHelper`; `unusedKitHelper` never used | `renderHelper` alive; `unusedKitHelper` deletion_candidate `["no_refs"]` (the witness scans the test file too) |
| Same package name in two repos | `fixtures/org-dup` (`one` publishes `@acme/dup`, `two` has a private `@acme/dup`, `three` depends on `@acme/dup`) | both are packages (`npm:acme/one:@acme/dup`, `npm:acme/two:@acme/dup`); `three` resolves to `one` (the only published candidate) and the report warns which one it picked; see [`org-dup/README.md`](org-dup/README.md). The ambiguous case (no candidate preferred: every one `blocked`, `ambiguous_dep`) and same-repo duplicates (private ones auto-ignored, public ones an error) are unit tests in `packages/core/test/discover.test.ts` / `ingest.test.ts` |
| Consumer pinned to old P, refs symbol gone at HEAD → `version_skew` | `app-skew/src/main.ts` → `removedFn` | version_skew row on `@acme/app-skew`; `internalUsed` still alive |
| Private circular island | `lib-core/src/fns.ts` `islandA`/`islandB` | private_dead `already_unreachable` |
| Test infrastructure in `tests/` (a helper used only by a `*.test.ts`) | `lib-core/tests/helpers.ts` `setupCore`/`seedValue`, used by `tests/core.test.ts` | no finding: `tests/` is a TEST_GLOBS dir, so the unreachable helpers are test files, not private_dead |
| Private helper unlocked by a candidate | `lib-widgets/src/internal.ts` `unusedHelper` | private_dead `unlocked_by:internalUnused`; in the `org_dead` view (its unlocker is a published deprecation), not in `private_dead` |
| Export used internally only → `unexport_candidate` | `lib-core/src/fns.ts` `internalOnlyFn` | unexport_candidate |
| `"private": true` vs published-public → verdict differs | `@acme/core` (private) vs `@acme/widgets` (public) | private: deletion_candidate / unexport_candidate; public: deprecation_candidate (the report's `org_dead` view reads them as deletions under a stated assertion) |
| Repo whose index fails → dependents' verdicts blocked naming it | `repo-broken` (invalid `tsconfig.json`) → `@acme/y#yUnused` | blocked, `blocked_by` includes `"npm:acme/repo-broken:@acme/broken:index_failed"` (see `unindexed_consumer` below for the second blocker) |
| Symbol younger than `minAgeDays` | — | TODO (M2: needs git history / blame) |
| `keep` list suppresses a finding | `sentei.json` keep `npm:@acme/widgets#keptFn` (name-only form: every package of that name; `npm:acme/lib-widgets:@acme/widgets#keptFn` would name just this one) (`lib-widgets/src/misc.ts`) | no row |
| Non-indexed-language consumer → `unindexed_consumer` | `tool-py/scripts/build.py` (flag set by discover; `.sh`/YAML/JSON/Markdown do not count) → `@acme/y#yUnused` | blocked, `blocked_by ["npm:acme/repo-broken:@acme/broken:index_failed", "npm:acme/tool-py:@acme/tool-py:unindexed_consumer"]` |
| Witness: corrupted `.scip` drops a ref → `needs_review` / `witness_mismatch` | `packages/cli/test/witness-corruption.test.ts` drops `usedFn` (private `@acme/core`) and `deepThing` (published `@acme/widgets`) references from the consumers' `.scip` | both needs_review with `witness_mismatch` (the witness runs for deprecations too) |
| Witness downgrade propagates: a candidate kept by the witness stops unlocking its helpers, and the dead island it alone used reverts to an unexport | `lib-cascade/src/index.ts`: `viewer` (named by the unindexed `bin/viewer.mjs`, which imports the package by name) uses `initParams`, `helperC`; `initParams` uses `helperA` | `viewer` needs_review `witness_mismatch:self:bin/viewer.mjs:*`; `initParams` unexport_candidate (a dead island at analyze time); `helperA`/`helperC` alive; control `dropped` deletion_candidate + `helperB` private_dead `unlocked_by:dropped` |
| `exports` entry with one unresolvable condition | `lib-cascade/package.json` `"."`: `import` → `src/index.ts`, `require` → unbuilt `dist/cjs/index.cjs` | not `opaque_consumer` (one condition resolves) |
| `imports` map arms are runtime entries | `lib-cascade/package.json` `#impl` → `src/impl.node.ts` (never picked by tsc) / `src/impl.ts` | both `digest`s alive (entry_symbols), no private_dead |
| Vite `index.html` `<script src>` is an entry | `lib-cascade/index.html` → `src/client.ts` (`boot()` called at top level) | `boot` alive |
| Runtime entries by convention: wrangler `main`, Pages Functions | `app-worker/wrangler.jsonc` `main` → `src/worker.ts`; `functions/api/hello.ts` (a wrangler config exists) | both entry points; `default` / `onRequest` alive (entry_symbols), `handle` / `greet` alive; the package is eligible for private_dead: `neverCalled` private_dead |
| TS namespace members are owned by their namespace | `app-worker/src/worker.ts`: `Routes` (used) with `unusedRoute`; `Legacy` (unused) with `oldHandler` | `unusedRoute` alive (owner edge); only `Legacy` private_dead (its member is nested) |
| `bin` is a runtime entry, never surface | `app-worker/package.json` `bin` → `bin/cli.mjs` (outside the program) | not in the adapter's entry points: repo index `ok`, not `partial` |
| An import vouches only for what its specifier reaches | `app-worker/src/worker.ts` imports only `@acme/widgets/lazy` and has a local `internalUnused` | `@acme/widgets#internalUnused` stays deprecation_candidate (the `./lazy` entry does not export it) |
| Dart items | `fixtures/org-dart` (see [`org-dart/README.md`](org-dart/README.md) for the §8 Dart checklist) | `org-dart/expected-findings*.json` |

Consumer files that import `@acme/widgets` deliberately never mention the names
of its would-be deletion candidates (including the word `default`) outside of
test files, so the §9 text witness passes on them. The one exception is
`app-worker/src/worker.ts`, whose import of the `./lazy` entry cannot vouch for
`internalUnused` (exported only from `./`).
