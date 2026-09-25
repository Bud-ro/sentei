# sentei — agent notes

Read `PLAN.md` fully before touching anything. Decisions marked DECIDED are settled.
`docs/DESIGN.md` records what was learned and any deviations.

## Environment

- **Node ≥ 26 is required** (`node:sqlite`, native type stripping); the version is
  pinned in `.nvmrc`. If the system `node` is older, run `nvm use` (or put a Node 26
  `bin/` first on `PATH`) before any `npm`/`node` command.
- If the default npm cache directory is not writable (some sandboxes), point
  `npm_config_cache` at a writable directory.
- Dart SDK ≥ 3.11 on `PATH` for the Dart indexer tests (CI uses 3.11.3; they are
  skipped without `dart`). `gh` (or `GITHUB_TOKEN`) only for `discover --org`.
- Network hosts used: registry.npmjs.org, pub.dev, github.com, api.github.com.
- Temp files go in `$TMPDIR`, never `/tmp`.

## Conventions

- TypeScript, ESM, strict. No ORM, no framework, no LLM calls. Dependencies are
  listed in PLAN.md §11; anything else needs a justification in `docs/DESIGN.md`.
- All analysis policy is SQL in `packages/core/sql/*.sql`, loaded verbatim.
- Paths stored in the DB are POSIX, relative to the repo root.
- Fail closed: uncertainty means "alive", never "dead".
- Tests: vitest. Every §5.1 invariant has a negative test.
- Commits are atomic: one logical change per commit, tests green at each commit.
- Never push, never open PRs, never delete anything outside the work dir.
