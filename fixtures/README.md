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

Current contents (M0): `lib-core` (`@acme/core`, lib) and `app` (`@acme/app`,
consumer of `@acme/core` via an ordinary `^1.0.0` dependency; the indexer stage
links them). Later milestones extend the org with the PLAN.md §8 checklist cases,
updating `expected-findings.json` alongside.
