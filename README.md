# sentei (剪定)

sentei finds exported symbols in an organisation's own npm and pub packages that
no other repo in the org uses. It lists and clones every repo, indexes each one
with a precise SCIP indexer (scip-typescript, a vendored scip_dart fork), links
references across repos in a SQLite database, applies an age and closed-world
policy, and reports deletion, unexport and deprecation candidates. It also reports
what becomes unreachable inside a package once those exports are gone (private
dead code). It never deletes code, pushes, or opens PRs.

sentei **fails closed**: any uncertainty counts as "alive", never "dead". An index
that failed or is partial, a consumer written in a language with no indexer, a
dynamic `require()`/`import()`, or a namespace import used as a value makes the
affected packages *opaque*. Opaque packages block verdicts for everything they
depend on instead of guessing. Before any `deletion_candidate` is emitted, a text
search of every declared consumer (the *witness*) must find no mention of the
symbol. Structural rules are schema constraints and triggers; policy is SQL views
you can query.

## Requirements

- Node ≥ 26 (`node:sqlite`, native TypeScript type stripping)
- git
- Dart SDK ≥ 3.11 for Dart repos
- A GitHub token for listing repos: `GITHUB_TOKEN`, else `GH_TOKEN`, else
  `gh auth token`. Rerunning from an existing lockfile makes no API calls (public
  repos clone without a token).

## Quick start

```sh
npm ci
S="node packages/cli/src/main.ts"
$S discover --org unjs --lockfile fixtures/orgs/unjs.lock.json   # list (lockfile written on first run, read after), shallow-clone
$S index      # SCIP indexes per package (cached by head sha; --force, --no-install)
$S ingest     # load .scip files into work/sentei.db
$S blame      # first-seen dates for exported symbols (unshallows clones)
$S analyze    # reachability + verdicts
$S witness    # text-search check, promotes witnessed candidates to deletion_candidate
$S report     # report.json, SARIF, summary on stdout
# or all of the above in order:
$S run --org unjs --lockfile fixtures/orgs/unjs.lock.json
```

`--org-dir <dir>` replaces `--org` for a local org directory (`org.json` +
`repos/<name>/`, see `fixtures/org-small`). Useful options: `--work <dir>`
(default `./work`), `--include/--exclude <glob>` (repo names), `--include-forks`,
`--update-lockfile`, `--config-dir <dir>` (where the org `sentei.json` lives;
default the cwd if it has one), `--max-old-space-mb <n>`, `--quiet`, `--verbose`.
`--policy key=value` (repeatable, JSON values) overrides one org policy key for
`discover`/`run`, e.g. `--policy assumeClosedWorld=true --policy minAgeDays=0`.
Run with `--help` for the full list.

Each stage prints `[stage] done in 1.2s`; `run` ends with a total. Exit codes: 0
success, 1 a stage failed (`sentei <stage>: <message>` on stderr; `--verbose` adds
the stack), 2 usage error.

Behind a proxy set `NODE_USE_ENV_PROXY=1`: Node's `fetch` ignores `HTTPS_PROXY`
by default (git does not).

## Work directory

```
work/
  discover.json            org model: repos, packages, deps, policy, overlays
  repos/<name>/            shallow clones (--org; --clones-dir to move)
  index/<owner>__<repo>/   index.json, <pkg>.scip, <pkg>.exports.json sidecars
  sentei.db                SQLite: schema + analysis views (first-class debug artifact)
  blame/<owner>__<repo>.json  blame cache, trusted only for the same head sha
  report.json              full findings, reasons, blockers, warnings, version skew
  sarif/<owner>__<repo>.sarif  one SARIF 2.1.0 log per repo (also for clean repos)
```

Stages can be rerun alone. `discover` and `ingest` rebuild the whole org;
`blame` must follow every `ingest` (its cache makes that cheap).

## Configuration

**Org `sentei.json`** (in `--config-dir`, the cwd, or the `--org-dir`). Unknown
keys and wrong types are errors, so a typo cannot silently fail open.

| Key | Default | Meaning |
|---|---|---|
| `minAgeDays` | 180 | closed-world verdicts need the symbol's blame date to be at least this old; unknown dates block them |
| `trustPrivateRegistry` | true | `published-private` packages count as closed-world |
| `assumeClosedWorld` | false | treat every package as closed-world (see below) |
| `countTestsAsConsumers` | false | references from test files count as uses |
| `countDocsAsConsumers` | false | references from docs files count as uses |
| `keep` | `[]` | never report these: `"npm:@acme/foo#sym"`, `"pub:bar#*"` |
| `ignoreManifestDirs` | built-in list | directory names (fixtures, templates, examples, ...) whose manifests are not org packages; replaces the default |
| `ignoreManifests` | `[]` | globs `"<repo>/<manifest path>"`, e.g. `"vscode/package.json"` |

**Per-repo `sentei.json`** (repo root) holds overlays only; per-repo policy
overrides are rejected.

| Key | Meaning |
|---|---|
| `extraEntryPoints` | repo-relative globs treated as entry points (stories, scripts, codegen inputs) |
| `extraEdges` | `[{ "from": "file:src/registry.ts", "to": "npm:@acme/plugins#*" }]`; counted as references |
| `keep` | same syntax as the org `keep` |

## Verdicts and reasons

| Verdict | Meaning |
|---|---|
| `deletion_candidate` | exported, closed-world, old enough, no references anywhere, witness found nothing |
| `unexport_candidate` | only used inside its own package: drop the `export` |
| `deprecation_candidate` | unused but the package is open-world (published publicly) |
| `private_dead` | unreachable from the package's entry points |
| `needs_review` | would be a deletion candidate but the witness found a textual mention |
| `blocked` | would have had a verdict, but an opaque package prevents it (`blocked_by`) |

Reasons: `no_refs`, `internal_refs_only`, `only_test_refs` (delete the tests
too), `open_world`, `witness_pending` (analyze output before `witness` runs),
`witness_mismatch:<consumer>:<file>:<line>` (1-based), `already_unreachable`
(an existing private island), `unlocked_by:<symbol>` (dead once that candidate
goes). `blocked_by` entries are `<package>:<flag>`, with flags
`opaque_consumer`, `index_failed`, `dynamic_access`, `namespace_dynamic`,
`unindexed_consumer`. Version skew (a consumer referencing a symbol missing at
HEAD) is reported separately, never as a finding.

## Reading the summary

The report stage prints: the policy line; a `!!` warning banner (assumeClosedWorld,
`minAgeDays` 0, repos whose index was partial or failed); a per-package table
(visibility, closed/open world, opaque, counts per verdict, blockers); **top
blockers**, the opaque packages preventing the most verdicts, the "fix that
repo's tsconfig first" list (all of them are in `report.json`); and the version
skew count. `blame` dates the last edit of the definition line, not its creation,
which errs toward younger (the safe direction).

### `assumeClosedWorld`

Public packages may have consumers outside the org, so by default they can only
produce `deprecation_candidate`. `assumeClosedWorld: true` treats every package as
closed-world so deletion verdicts are reachable; this is how dogfood runs on
public orgs work (PLAN.md §13). The report header warns loudly when it is on:
those deletions are only valid if nothing outside the org uses the package.

## Debugging with SQL

```sh
sqlite3 work/sentei.db
sqlite> SELECT * FROM verdicts v JOIN symbols s USING (symbol_id) WHERE s.name = 'foo';
sqlite> SELECT * FROM findings WHERE verdict = 'deletion_candidate';
sqlite> SELECT * FROM package_flags;          -- why a package is opaque
sqlite> SELECT * FROM blocked_packages;       -- who blocks whom
```

`packages/core/sql/analyze.sql` (recreated on every `analyze`) defines the
views: `external_refs`, `internal_refs`, `test_only_refs`, `symbol_age_ok`,
`kept_symbols`, `reachable`, `verdict_blockers`, `verdicts`, `candidate_symbols`,
`reachable_after`, `candidate_reach`, `unreachable_before`, `private_dead`, and
their helpers. `schema.sql` defines `closed_world_packages`, `opaque_packages`
and `blocked_packages`. The `policy` table holds the policy in effect.

## SARIF upload

Each `work/sarif/<owner>__<repo>.sarif` is one Code Scanning upload (level
`warning` for deletions, `note` otherwise; locations are repo-relative). Upload
with the repo owner's token (`security_events`, or `public_repo` for a public
repo):

```sh
gh api -X POST repos/OWNER/REPO/code-scanning/sarifs \
  -f commit_sha=<runs[0].properties.headSha> -f ref=refs/heads/<branch> \
  -f tool_name=sentei -f sarif="$(gzip -c work/sarif/OWNER__REPO.sarif | base64 -w0)"
```

GitHub caps a run at 25 000 results.

## More

`PLAN.md` is the design (architecture, schema invariants, stages, policy tree);
`docs/DESIGN.md` records decisions, deviations and dogfood findings.
