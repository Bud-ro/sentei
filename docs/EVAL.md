# Evaluation set

Public orgs sentei is run against, shallow clones only, with no hand-written repo
filters (the selection rules and the git-tree probe decide). Each org's pinned
commits are in `fixtures/orgs/<org>.lock.json`; a `<org>.sentei.json` exists only
where the run needed something beyond the defaults (every one of those is an
`ignoreManifests` entry, listed under "Config caveats"). Rerun an org with

```
sentei run --org <org> --lockfile fixtures/orgs/<org>.lock.json [--config-dir fixtures/orgs]
```

Spot checks are rows an agent verified against the clones with grep:
right / total, where "right" includes rows that are correct under the policy
but not worth acting on (a published library's public API that only outside
users import). Numbers are from the run at the named commit; DESIGN.md records
what each later fix round changed.

## Phase 3 run at `f25900a` (2026-09-27)

| org | repos selected / listed | packages | index ok / partial / failed | index | DELETE | DEPRECATE | UNEXPORT | PRIV-DEAD | REVIEW | BLOCKED | skew | spot check |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tanstack | 24 / 30 | 813 | 704 / 109 / 0 | 67 min | 53 | 1464 | 396 | 743 | 25 | 3913 | 14 | 17 / 23 |
| trpc | 5 / 22 | 18 | 17 / 1 / 0 | 4 min | 0 | 2 | 0 | 28 | 2 | 301 | 0 | 4 / 13 |
| vitejs | 21 / 32 | 69 | 23 / 46 / 0 | 9 min | 0 | 0 | 4 | 59 | 0 | 358 | 0 | 7 / 12 |
| withastro | 37 / 60 | 134 | 97 / 35 / 2 | 25 min | 0 | 56 | 104 | 494 | 0 | 997 | 4 | 15 / 28 |
| nuxt | 31 / 65 | 101 | 54 / 15 / 32 | 31 min | 0 | 4 | 0 | 87 | 0 | 544 | 189 | 0 / 12 |
| drizzle-team | 39 / 45 | 61 | 30 / 25 / 6 | 14 min | 0 | 18 | 30 | 117 | 0 | 628 | 0 | 15 / 22 |
| VeryGoodOpenSource | 13 / 37 | 39 | 29 / 0 / 10 | 16 min | 17 | 66 | 32 | 32 | 0 | 0 | 0 | 9 / 16 |
| bluefireteam | 34 / 44 | 65 | 51 / 1 / 13 | 17 min | 3 | 62 | 95 | 17 | 0 | 8 | 6 | 13 / 14 |
| fluttercommunity | 41 / 51 | 77 | 65 / 3 / 9 | 32 min | 8 | 223 | 181 | 41 | 4 | 36 | 0 | 15 / 17 |
| Baseflow | 31 / 92 | 72 | 63 / 1 / 8 | 27 min | 7 | 58 | 22 | 86 | 2 | 8 | 0 | 13 / 16 |
| material-foundation | 3 / 50 | 9 | 6 / 3 / 0 | 4 min | 0 | 68 | 5 | 6 | 0 | 1 | 0 | 11 / 12 |
| invertase | 12 / 173 | 42 | 25 / 17 / 0 | 11 min | 1 | 10 | 62 | 128 | 0 | 293 | 0 | 9 / 13 |

Index times were measured with four orgs running at once on one machine (load
20–33), so they are upper bounds. `blame` skipped every repo (shallow clones)
and the `minAgeDays` warning appeared in every run, as intended.

**Where the wrong rows came from** (each is a fix-round item in DESIGN.md
"Phase 3 fix round 8", or a policy note):

- Framework apps whose roots sentei did not know: Astro pages / middleware /
  actions and `~/` aliases, Nuxt auto-import dirs, Docusaurus config and theme,
  VitePress config and `.md` data loaders, jscodeshift and codemod transforms,
  Firebase Functions, React Native platform-extension modules, Electron
  `loadURL(url.format(…))`, mason hooks, dart_frog routes, analyzer plugins,
  pigeon inputs. These produced most false PRIV-DEAD rows and a few false
  DELETE / DEPRECATE rows.
- A `bin` that loads an unbuilt `dist/` by dynamic import was reported `ok`
  with its whole `src/` private-dead (withastro: 253 rows).
- Module-level code of a non-entry module was never reachable (drizzle-team).
- Unnamed Dart extensions lost their references (VeryGoodOpenSource,
  bluefireteam: most PRIV-DEAD rows).
- Templates indexed as packages: mason `__brick__` (with `{{…}}` names), Nx
  generator files (`<%= name %>`), an unparseable template manifest aborting
  discover.
- A repo-provided yarn plugin ran the repo's build during install (invertase):
  fixed in round 8a.
- Policy, not defects: DEPRECATE in public-library orgs (tanstack, material-
  foundation, drizzle-team, bluefireteam) is the API outside users import; the
  facts are right (no consumer inside the org) but the rows are not a to-do
  list. Duplicate non-private package names inside one repo (workshop copies,
  example monorepos) needed one `ignoreManifests` entry each until round 8b.

**Config caveats.** Baseflow, invertase, drizzle-team, vitejs and
VeryGoodOpenSource needed the `ignoreManifests` entries in their
`<org>.sentei.json` for the reasons above; the other seven ran with `{}`.
pnpm 12 cannot install in the sandbox these runs used (a store-lock error on a
read-only path), which left 36 vitejs and 43 tanstack packages partial: that is
the environment, not the orgs.

## Phase 3 rerun at `840cd97` (2026-09-28)

The four orgs with the most wrong rows above, rerun on the tool after fix
round 8 (8a–8f) with the same lockfiles (same commits, same repo selection,
shallow clones, one org at a time or two at once). Every package re-indexed
(the adapters changed: scip-typescript `0.4.0+sentei.10`, scip-dart
`1.7.0+sentei.15`). Spot checks as above; nuxt's are the rows I checked
myself, the others an agent's seeded sample (all private-dead rows for
withastro, twenty for invertase).

| org | packages | index ok / partial / failed | index | DELETE | DEPRECATE | UNEXPORT | PRIV-DEAD | REVIEW | BLOCKED | skew | spot check |
|---|---|---|---|---|---|---|---|---|---|---|---|
| nuxt | 101 | 51 / 18 / 32 | 7 min | 0 | 0 | 2 | 9 | 0 | 422 | 189 | 2 / 11 |
| withastro | 134 | 97 / 35 / 2 | 13 min | 0 | 54 | 83 | 32 | 0 | 679 | 4 | 42 / 52 |
| VeryGoodOpenSource | 30 | 29 / 0 / 1 | 6 min | 11 | 60 | 27 | 5 | 0 | 0 | 0 | 35 / 35 |
| invertase | 42 | 25 / 17 / 0 | 2 min | 0 | 12 | 64 | 115 | 0 | 274 | 0 | 26 / 35 |

Against the `f25900a` run: PRIV-DEAD 87 → 9 (nuxt), 494 → 32 (withastro),
32 → 5 (VeryGoodOpenSource), 128 → 115 (invertase); BLOCKED 544 → 422,
997 → 679, 0, 293 → 274; VeryGoodOpenSource lost nine mason `__brick__`
"packages" (templates, round 8b) and its ten failed indexes (unnamed
extensions, fork patch 15). No view gained a wrong row that a spot check
found, except the `type-test.tsx` rows in invertase (right: the file is
orphaned upstream, but sentei does not know it as a type test).

**Where the remaining wrong rows come from** (numbers are rows in the run):

- Loaders sentei cannot see: learn.nuxt.com's own Nuxt module reads
  `content/**/.template/**` from disk as playground data (all 9 nuxt
  PRIV-DEAD rows); a `next/dynamic(() => import('./x'))` reaches the module
  but not its default export (docs.page, 7 rows); a `tsm src/stats.ts`
  script (houston-discord, 3 rows: `tsm` is not a known runner); an
  `import type` by relative path into another workspace package (marlo,
  1 row).
- Files outside the TypeScript program: Next app-router routes under a dot
  directory (`app/.well-known/jwks.json/route.ts`; TypeScript's `**/*`
  skips dot directories: docs.page, 3 rows); Expo config plugins whose
  `app.plugin.js` requires the unbuilt `plugin/build` (12 opaque invertase
  packages, the top blockers of 131 rows each); a React Native app's
  `index.js` (`AppRegistry.registerComponent`, no exports) not taken as an
  entry (RNGoogleMobileAdsExample, blocks 197 rows); an Electron entry
  `dist-electron/main.js` built by astro-electron from `src/electron/`
  (marlo, blocks 386 withastro rows); astro's solution-style tsconfig
  (`files` + `references`) leaving its entries out of the program.
- A type in a public signature not pinned: a class property's type
  (`readonly failure: FlueExecutionFailure` on an exported class; 3 flue
  UNEXPORT rows). Round 8d pinned parameter and constraint types only.
- Build caches scanned as consumers: `.nx/cache/**` created by the install
  (react-native-google-mobile-ads).
- An install at the wrong level: a stale `package-lock.json` inside a pnpm
  workspace package made sentei run `npm ci` there instead of at the
  workspace root (@tanstack-query-firebase/react, 54 blocked rows).
- Policy, not defects: test-only uses (`getCartSubtotal`, melos
  `writeTextFile`: tests are not consumers, the rows carry the note);
  bun benchmark scripts that run themselves (`await run()` at top level,
  no importer: 45 invertase rows); `env.require(...)` constants whose
  initializer is a startup check; a release-please version marker.

The `org_dead` view is still written to `report.json` (every view) although
the default report no longer uses it.
