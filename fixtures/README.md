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
exact output for `sentei.json` as checked in (`assumeClosedWorld: true`,
`minAgeDays: 0`); `expected-findings.open-world.json` is the exact output for the
same org with `assumeClosedWorld: false` (published-public `@acme/widgets` gets
`deprecation_candidate` instead of deletion/unexport, and the helper its deletion
would unlock is no longer `private_dead`).

Findings rows: `package_id`, `symbol`, `file` (repo-relative), `verdict`,
`reasons`, `blocked_by` (only when non-empty), sorted by package_id, symbol, verdict.

| Repo | Package | Visibility | Role |
| --- | --- | --- | --- |
| `lib-core` | `@acme/core` | private | lib (M0) |
| `app` | `@acme/app` | private | consumer of core (M0) |
| `lib-y` | `@acme/y` | private | lib; consumed by widgets, consumer, broken, tool-py |
| `lib-widgets` | `@acme/widgets` | **published-public** | lib with an `exports` map; depends on y |
| `app-consumer` | `@acme/consumer` | private | consumer of widgets + y (all the static reference forms) |
| `lib-dyn` | `@acme/dyn` | private | lib whose only consumer is dynamic |
| `app-dynamic` | `@acme/app-dynamic` | private | flagged `namespace_dynamic` + `dynamic_access` |
| `app-skew` | `@acme/app-skew` | private | pinned to widgets `1.0.0`, names a removed export |
| `repo-broken` | `@acme/broken` | private | invalid `tsconfig.json` → index fails |
| `tool-py` | `@acme/tool-py` | private | consumer of y with a Python file (`scripts/build.py`) → `unindexed_consumer` |

Note: `lib-widgets` imports `@acme/y`, so it typechecks only with
`node_modules/@acme/y` linked (as the indexer does). `app-skew` fails typecheck
by design with a single TS2305 on `removedFn`. Consumers of `@acme/widgets` need
`"jsx": "preserve"` because `widget.tsx` is compiled into their program;
`widget.tsx` pulls its JSX typing in with a `/// <reference path>`.

### §8 checklist coverage

| §8 item | Where | Expected |
| --- | --- | --- |
| Named import `import { a } from '@acme/x'` | `app-consumer/src/main.ts` → `@acme/widgets#internalUsed` | alive |
| `import * as X; X.a()` counts as ref to `a` | `app-consumer/src/main.ts` `W.namespaceUsed()`; `namespaceUnused` never accessed | `namespaceUsed` alive; `namespaceUnused` deletion_candidate |
| `import * as X; X[key]` → `namespace_dynamic` | `app-dynamic/src/main.ts` | `@acme/dyn#dynA`, `dynB` blocked |
| `export * from './internal'` in entry file | `lib-widgets/src/index.ts` → `src/internal.ts` | `internalUsed` alive; `internalUnused` deletion_candidate |
| `export { a as b } from '@acme/y'` | `lib-widgets/src/index.ts` (`yThing as widgetY`), used as `widgetY` in `app-consumer` | `@acme/y#yThing` alive |
| `export default` anonymous → symbol `default` | `lib-widgets/src/anon.ts` (imported), `src/unused-anon.ts` (not) | anon alive; unused-anon `default` deletion_candidate |
| `import('@acme/x')` with static string | `app-consumer/src/main.ts` → `@acme/widgets/lazy` | `lazyWidget` alive |
| `require('@acme/' + name)` → `dynamic_access` | `app-dynamic/src/load.cts` | `@acme/dyn` verdicts blocked |
| Subpath import against `exports` `*` pattern | `app-consumer/src/main.ts` → `@acme/widgets/deep/thing` (`"./deep/*"`) | `deepThing` alive |
| `import type` counts as a ref | `app-consumer/src/main.ts` → `WidgetOptions` | alive |
| JSX `<Foo />` | `app-consumer/src/view.tsx` → `Widget` | alive |
| Used only in `*.test.ts` of another repo → `only_test_refs` | `app-consumer/src/widgets.test.ts` → `testOnlyFn` | deletion_candidate `["only_test_refs"]` |
| Duplicate org package name → discover error | `fixtures/org-dup` (`one`, `two` both `@acme/dup`) | discover fails |
| Consumer pinned to old P, refs symbol gone at HEAD → `version_skew` | `app-skew/src/main.ts` → `removedFn` | version_skew row on `@acme/app-skew`; `internalUsed` still alive |
| Private circular island | `lib-core/src/fns.ts` `islandA`/`islandB` | private_dead `already_unreachable` |
| Private helper unlocked by a candidate | `lib-widgets/src/internal.ts` `unusedHelper` | private_dead `unlocked_by:internalUnused` (closed world only) |
| Export used internally only → `unexport_candidate` | `lib-core/src/fns.ts` `internalOnlyFn` | unexport_candidate |
| `"private": true` vs published-public → verdict differs | `@acme/core` (private) vs `@acme/widgets` (public); compare the two expected files | public ones become deprecation_candidate in open world |
| Repo whose index fails → dependents' verdicts blocked naming it | `repo-broken` (invalid `tsconfig.json`) → `@acme/y#yUnused` | blocked, `blocked_by` includes `"npm:@acme/broken:index_failed"` (see `unindexed_consumer` below for the second blocker) |
| Symbol younger than `minAgeDays` | — | TODO (M2: needs git history / blame) |
| `keep` list suppresses a finding | `sentei.json` keep `npm:@acme/widgets#keptFn` (`lib-widgets/src/misc.ts`) | no row |
| Non-indexed-language consumer → `unindexed_consumer` | `tool-py/scripts/build.py` (flag set by discover; `.sh`/YAML/JSON/Markdown do not count) → `@acme/y#yUnused` | blocked, `blocked_by ["npm:@acme/broken:index_failed", "npm:@acme/tool-py:unindexed_consumer"]` |
| Witness: corrupted `.scip` drops a ref → `needs_review` / `witness_mismatch` | — | TODO (needs checked-in `.scip` snapshots) |
| Dart items | — | TODO (Dart milestone) |

Consumer files that import `@acme/widgets` deliberately never mention the names
of its would-be deletion candidates (including the word `default`) outside of
test files, so the §9 text witness passes on them.
