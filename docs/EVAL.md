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
