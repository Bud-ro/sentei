# sentei — agent notes

Read `PLAN.md` fully before touching anything. Decisions marked DECIDED are settled.
`docs/DESIGN.md` records what was learned and any deviations.

## Environment (this dev box)

- **Node 26 is required** (`node:sqlite`). The system `node` is v18. Every shell
  command must first do:
  `export PATH="$HOME/.nvm/versions/node/v26.10.0/bin:$PATH" npm_config_cache="$HOME/.cache/npm"`
  (the default npm cache dir is read-only in the sandbox)
  Shell state does not persist between commands.
- Dart SDK 3.11.3 is on PATH. `gh` is authenticated. Network egress is sandboxed;
  declare hosts you need (registry.npmjs.org, pub.dev, github.com, api.github.com).
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
