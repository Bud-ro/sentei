# org-dup

Package identity is `<manager>:<repo>:<name>`, so one name in two repos is two
packages. This org checks that end to end (`packages/cli/test/pipeline.test.ts`):

| Repo | Package id | Visibility | Role |
| --- | --- | --- | --- |
| `one` | `npm:acme/one:@acme/dup` | published-public | defines `onlyInOne`, `shared`, `unusedInOne` |
| `two` | `npm:acme/two:@acme/dup` | private (`"private": true`) | defines `shared`, `onlyInTwo`; no consumer |
| `three` | `npm:acme/three:@acme/three` | private | depends on `@acme/dup`, uses `onlyInOne` and `shared` |

`three`'s dependency names two org packages. Neither is in `three`'s repo, and
only `one`'s is published (a private package cannot be installed from a
registry), so discover resolves it to `npm:acme/one:@acme/dup` (resolution
`published`), logs that, and the report carries a warning saying which package
was picked. The index stage source-links `one` into `three`'s `node_modules`, and
ingest attributes `three`'s references to `@acme/dup` symbols to `one` (its
resolved dependency), even though `one` and `two` both define
`src/index.ts/shared()`.

`expected-findings.json` is the exact output (`sentei.json`: `minAgeDays: 0`):
`onlyInOne` is alive (only `one` defines it, so a wrong resolution would make it a
candidate and add a version-skew row), `unusedInOne` is a deprecation candidate
(`one` is published), and both of `two`'s exports are deletion candidates (it is
private and has no consumer; `three`'s `shared` is `one`'s).

When no candidate can be preferred (two published packages of one name in other
repos), the dependency is ambiguous: nothing is resolved, the consumer is flagged
`ambiguous_dep` at every candidate and all of them are `blocked`. That case, and
same-name manifests inside one repo (private ones auto-ignored, two public ones an
error), are unit tests in `packages/core/test/discover.test.ts`,
`ingest.test.ts` and `report.test.ts`.
