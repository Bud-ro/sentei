# sentei (剪定)

sentei finds exported symbols in an organisation's own npm and pub packages that
no other repo in the org uses. It lists and clones every repo, indexes each one
with a precise SCIP indexer (scip-typescript, a vendored scip_dart fork), links
references across repos in a SQLite database, applies an age policy, and reports
deletion candidates (private packages), deprecation candidates (published ones),
unexport candidates and, as an explicit assertion, what the org could delete if it
is the only consumer of its published packages. It also reports
what becomes unreachable inside a package once those exports are gone (private
dead code). It never deletes code, pushes, or opens PRs.

sentei **fails closed**: any uncertainty counts as "alive", never "dead". An index
that failed or is partial, a consumer written in a language with no indexer, a
dynamic `require()`/`import()`, or a namespace import used as a value makes the
affected packages *opaque*. Opaque packages block verdicts for everything they
depend on instead of guessing. Before any deletion or deprecation candidate is emitted, a text
search of every declared consumer (the *witness*) must find no mention of the
symbol. Structural rules are schema constraints and triggers; policy is SQL views
you can query.

## Status

Pre-release and under active development: the CLI, the config keys, the database
schema and the report format can still change without notice. It has been
dogfooded on three public orgs (unjs and honojs for TypeScript, Workiva for Dart;
lockfiles in `fixtures/orgs/`). Findings only see consumers inside the org (the
`org_dead` view states outright that it assumes there are no others), so treat
them as candidates to review, not instructions. sentei only reports: it never edits, deletes or pushes code and never
opens pull requests.

## Requirements

- Node ≥ 26 (`node:sqlite`, native TypeScript type stripping); `.nvmrc` pins it
- git
- Dart SDK ≥ 3.11 for Dart repos
- A GitHub token for listing repos with `--org`: `GITHUB_TOKEN`, else `GH_TOKEN`,
  else `gh auth token`. Rerunning from an existing lockfile makes no API calls
  (public repos clone without a token). `--org-dir` needs no token.
- Behind a proxy, `NODE_USE_ENV_PROXY=1` (Node's `fetch` ignores `HTTPS_PROXY` by
  default; git does not).
- Repos using pnpm, yarn or bun are installed with their own lockfile
  (`--frozen-lockfile` / `--immutable`, scripts off). A missing pnpm or yarn is run
  through `npm exec` at the version the repo's `packageManager` (or
  `devEngines.packageManager`) names; a missing bun skips the install with a
  warning. pnpm, yarn and corepack state and caches go under `<work>/.pm/`, not
  `$HOME` (npm keeps its usual cache). `--no-install` skips installs altogether.

## Quick start

```sh
npm ci
S="node packages/cli/src/main.ts"
$S discover --org unjs --lockfile fixtures/orgs/unjs.lock.json   # list (lockfile written on first run, read after), shallow-clone
$S index      # SCIP indexes per package (cached by head sha; --force, --no-install)
$S ingest     # load .scip files into work/sentei.db
$S blame      # first-seen dates for exported symbols (unshallows clones)
$S analyze    # reachability + verdicts
$S witness    # text-search check: witnessed candidates become deletion/deprecation candidates
$S report     # report.json, SARIF, summary on stdout (--view org_dead,... to pick views)
# or all of the above in order:
$S run --org unjs --lockfile fixtures/orgs/unjs.lock.json
```

`--org-dir <dir>` replaces `--org` for a local org directory (`org.json` +
`repos/<name>/`, see `fixtures/org-small`). Useful options: `--work <dir>`
(default `./work`), `--db <file>` (default `<work>/sentei.db`), `--include/--exclude <glob>`,
`--include-forks`, `--include-archived`, `--clone-concurrency <n>`,
`--allow-clone-failures` (see [Choosing repos](#choosing-repos)),
`--update-lockfile`, `--config-dir <dir>` (where the org `sentei.json` lives;
default the cwd if it has one), `--max-old-space-mb <n>`, `--quiet`, `--verbose`.
`--policy key=value` (repeatable, JSON values) overrides one org policy key for
`discover`/`run`, e.g. `--policy countTestsAsConsumers=true --policy minAgeDays=0`.
`--view <name>[,<name>]` (report/run) limits the summary and SARIF to those
[views](#views).
Run with `--help` for the full list.

Each stage prints `[stage] done in 1.2s`; `run` ends with a total. Exit codes: 0
success, 1 a stage failed (`sentei <stage>: <message>` on stderr; `--verbose` adds
the stack), 2 usage error.

## Choosing repos

Real orgs hold hardware repos, hackathons, forks and archives. `discover --org`
decides which repos to clone **before cloning**, and `sentei repos` shows that
decision for every repo without cloning anything:

```sh
$S repos --org acme            # table: repo, language, size, pushed, selected, reasons
$S repos --org acme --json     # the same as JSON
# edit sentei.json "repos" (below) until the selection looks right, then:
$S discover --org acme         # clones only the selected repos
```

Both read `<work>/<org>.lock.json` (or `--lockfile <file>`) when it exists, so the
second and later runs make no API calls; the first run lists the org and writes
it. `--update-lockfile` relists (new repos, new head shas). The lockfile records,
per repo, the listing facts (`language`, `sizeKb`, `pushedAt`, fork/archived/
template), the manifest probe result (`manifests`), the pinned `headSha`, the
decision (`selected`, `reasons`) and the last `cloneError`; its `selection` header
records the settings used. When the settings change, the decisions are recomputed
from the recorded facts (pins kept) and the API is only called for what the
lockfile does not hold yet (a probe, or the head sha of a newly selected repo).
Lockfiles written by older versions (no `selection` header) still work, with only
the include/exclude/fork/template rules; `--update-lockfile` upgrades them.

Rules, first match wins:

1. `--include` globs, then `--exclude`, then `repos.include`, then `repos.exclude`
   (repo names, `*`/`?`/`**`). An include match forces the repo in past every rule
   below (a forced archived, forked, huge or Python repo is cloned), so
   `--exclude '*' --include 'h3*'` clones just the `h3*` repos.
2. Empty repos (no commit on the default branch) and repos disabled by GitHub.
3. Archived repos (`--include-archived`), forks (`--include-forks`), templates.
4. `repos.maxSizeMb` (default 500) against the API `size`. That is the size of
   the whole history, so it overstates what a shallow clone downloads.
5. `repos.minPushed`: skip repos last pushed before an ISO date or `<n>d` ago.
6. Language: GitHub's primary language is in `repos.languages` (default
   TypeScript, JavaScript, Dart), **or** a manifest probe finds `package.json` or
   `pubspec.yaml` at the repo root (a docs site written mostly in Vue or HTML,
   a CLI tagged "Shell"). The probe costs 1–2 API requests per repo and only runs
   for repos no other rule has already excluded.

Org `sentei.json`:

```json
{
  "repos": {
    "exclude": ["hackathon-*", "*-firmware", "pcb-*"],
    "include": ["legacy-portal"],
    "languages": ["TypeScript", "JavaScript", "Dart"],
    "maxSizeMb": 500,
    "minPushed": "730d",
    "includeForks": false,
    "includeArchived": false,
    "probe": true,
    "cloneConcurrency": 8
  }
}
```

| `repos` key | Default | Meaning |
|---|---|---|
| `include` | `[]` | globs always cloned (past every automatic rule) |
| `exclude` | `[]` | globs never cloned (unless included) |
| `languages` | TypeScript, JavaScript, Dart | primary languages that select a repo; `[]` turns the language rule off |
| `maxSizeMb` | 500 | skip repos whose API size is larger; `null` for no limit |
| `minPushed` | none | ISO date (`"2025-01-01"`) or `"<n>d"` |
| `includeForks` / `includeArchived` | false | overridden by `--include-forks` / `--include-archived` (and `--no-…`) |
| `probe` | true | look for a root `package.json` / `pubspec.yaml` when the language does not match |
| `cloneConcurrency` | 8 | parallel clones; overridden by `--clone-concurrency` (1–32) |

CLI flags override the config: `--include`/`--exclude` rank above
`repos.include`/`repos.exclude` (rule 1), the boolean flags replace the config
values.

### Cloning

Selected repos are cloned in parallel (`--clone-concurrency`, default 8) with
`git clone --depth=1 --single-branch --no-tags` and `GIT_LFS_SKIP_SMUDGE=1` (LFS
objects are never downloaded), then pinned to the lockfile's sha. Existing
clones at the right sha are reused. Progress looks like
`[discover] cloned 37/100 (12 cached) 4.2 MB/s avg, slowest: big-repo 48 s`, and
discover ends with the ten slowest clones and their sizes: if one of them is not
worth analysing, add it to `repos.exclude`.

A failed clone does not stop the others. Its error is stored in the lockfile
(`cloneError`, shown by `sentei repos`) and discover exits 1 listing every repo
that could not be cloned; rerunning retries only those. With
`--allow-clone-failures` they are skipped with a warning instead
(`discover.json` lists them under `source.cloneFailures`). Every package in a
skipped repo is then unknown to the run: its uses of other org packages are not
counted, so exports only it uses can be reported as dead.

### GitHub API limits

Listing costs one request per 100 repos, one per selected repo (its head sha),
and 1–2 per probed repo: about 150 requests for a 100-repo org, against 5,000 per
hour for a token. Requests run at most 8 at a time. sentei honours GitHub's rate
limit headers for all of them together:

- when `x-ratelimit-remaining` reaches 0, every request waits until
  `x-ratelimit-reset` (one log line with the time); a 403/429 with no remaining
  quota is retried after the reset, twice at most;
- a secondary rate limit (429, or 403 with `retry-after` or a "secondary rate
  limit" message) pauses every request for `retry-after` seconds, or 60 s, 120 s
  and 240 s without the header, and fails after the third retry;
- any other error fails at once with GitHub's message.

Cloning uses git over https, not the REST API, and is not counted against these
limits.

## Work directory

```
work/
  discover.json            org model: repos, packages, deps, policy, overlays
  <org>.lock.json          --org listing, selection and pinned shas (--lockfile to move)
  repos/<name>/            shallow clones (--org; --clones-dir to move)
  index/<owner>__<repo>/   index.json; per package <pkg>.scip, <pkg>.exports.json
                           (sidecar) and <pkg>.log (indexer and install output)
  .pm/                     package-manager caches and state for installs
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
| `minAgeDays` | 180 | every verdict on an export needs its blame date to be at least this old; unknown dates block them |
| `trustPrivateRegistry` | true | `published-private` packages count as private (nobody outside the org can depend on them) |
| `countTestsAsConsumers` | false | references from test files count as uses |
| `countDocsAsConsumers` | false | references from docs files count as uses |
| `keep` | `[]` | never report these: `"npm:@acme/foo#sym"` (every package named `@acme/foo`), `"npm:acme/foo:@acme/foo#sym"` (only the one in repo `acme/foo`), `"pub:bar#*"` |
| `ignoreManifestDirs` | built-in list | directory names (fixtures, templates, examples, ...) whose manifests are not org packages; replaces the default |
| `ignoreManifests` | `[]` | globs `"<repo>/<manifest path>"`, e.g. `"vscode/package.json"` |
| `repos` | `{}` | which GitHub repos to clone, see [Choosing repos](#choosing-repos) |

**Per-repo `sentei.json`** (repo root) holds overlays only; per-repo policy
overrides are rejected.

| Key | Meaning |
|---|---|
| `extraEntryPoints` | repo-relative globs treated as entry points (stories, scripts, codegen inputs) |
| `extraEdges` | `[{ "from": "file:src/registry.ts", "to": "npm:@acme/plugins#*" }]`; counted as references (`to` takes the same package forms as `keep`) |
| `keep` | same syntax as the org `keep` |

## Package identity

A package is identified by where it lives, not by its name: its id is
`<manager>:<repo>:<name>`, e.g. `npm:acme/lib-core:@acme/core` or
`pub:Workiva/w_flux:w_flux`. Two repos may publish the same name (a fork, a
rewrite, a private copy); both are real packages with their own findings. Report
rows, `blocked_by` entries, blockers, `witness_mismatch` consumers and SARIF
fingerprints all use this id; the summary table shows the name and the repo in two
columns. (Within one repo a name must stay unique per manager: a private duplicate
there is ignored like a template; two public ones are an error.)

Manifests and SCIP symbols name dependencies by name only, so a dependency on a
name several org packages share is resolved per consumer:

1. the only org package of that name;
2. otherwise the one in the consumer's own repo (`same-repo`);
3. otherwise the only one that is not private (`published`: a private package
   cannot be installed from a registry);
4. otherwise it is **ambiguous**: no package is picked, the consumer gets an
   `ambiguous_dep` flag at every candidate, and all of them are `blocked` (fail
   closed). Discover logs a warning with `ignoreManifests` entries to disambiguate;
   the report lists each such dependency in its warnings.

Symbol references follow the same rule: a use of a shared name is attributed to the
consumer's resolved dependency, or dropped (and the candidates blocked) when there
is none.

## Verdicts and reasons

`analyze` + `witness` give each exported symbol one **base verdict**. It depends on
the evidence (references, age, `keep`, blockers, the witness) and on whether the
package is **private** (`private`, or `published-private` with
`trustPrivateRegistry`: nobody outside the org can depend on it) or **published**
(everything else). Nothing else about the world goes in, so every way of reading
the result is a [view](#views) over the same findings.

| Verdict | Meaning |
|---|---|
| `deletion_candidate` | private package, no counted references (or only test references), old enough, not kept, witness found nothing |
| `deprecation_candidate` | published package, same evidence (the witness ran too); or, with reason `internal_refs_only`, an export used only inside its published package |
| `unexport_candidate` | private package, only used inside its own package: drop the `export` |
| `private_dead` | not exported, unreachable from the package's entry points (now, or once the candidates it names are gone) |
| `needs_review` | would be a candidate but the witness found a textual mention |
| `blocked` | would have had a verdict, but an opaque package prevents it (`blocked_by`) |

Reasons: `no_refs`, `internal_refs_only`, `only_test_refs` (delete the tests
too), `witness_pending` (analyze output before `witness` runs),
`witness_mismatch:<consumer>:<file>:<line>` (1-based; `<consumer>` is a package
id, `self`, `self-string` or `ignored:<repo>/<manifest>`, and `<file>:<line>` can be
`checkout missing`), `dead_island` (exports used only by other candidates, so they
go together: a would-be unexport that becomes a deletion, or a deprecation in a
published package), `already_unreachable` (an existing private island),
`unlocked_by:<symbol>` (dead once that candidate goes). `blocked_by` entries are
`<package id>:<flag>`, with flags `opaque_consumer`, `index_failed`,
`dynamic_access`, `namespace_dynamic`, `unindexed_consumer`, `ambiguous_dep`.
Version skew (a consumer referencing a symbol missing at HEAD) is reported
separately, never as a finding.

## Views

`report.json` holds the base `findings` and every view under `views`, each
`{ description, assertion?, rows }`:

| View | Rows | Summary column | SARIF rule (level) |
|---|---|---|---|
| `delete` | `deletion_candidate` | DELETE | `sentei/delete` (warning) |
| `deprecate` | `deprecation_candidate` with `no_refs` / `only_test_refs` / `dead_island` | DEPRECATE | `sentei/deprecate` (note) |
| `org_dead` | the `deprecate` rows read as deletions, plus (`private_dead`) the private helpers only they unlock; carries an **assertion** | ORG-DEAD (a total line, with a footnote) | `sentei/org-dead` (warning), only with `--view org_dead` |
| `unexport` | `unexport_candidate`, plus (`published`) `deprecation_candidate` with only `internal_refs_only` | UNEXPORT | `sentei/unexport` (note) |
| `private_dead` | `private_dead`, minus the helpers listed under `org_dead` | PRIV-DEAD | `sentei/private-dead` (note) |
| `needs_review` | `needs_review` | REVIEW | `sentei/needs-review` (note) |
| `blocked` | `blocked` | BLOCKED | `sentei/blocked` (note) |
| `version_skew` | `versionSkew` | VERSION-SKEW | `sentei/version-skew` (note) |

`org_dead` replaces the old `assumeClosedWorld` flag: for an org whose published
packages have no consumer outside it (a dogfood run on a public org, a monorepo
that publishes for itself), it lists what the org could delete. It is only as
true as its assertion, "the org is the only consumer of these packages", which
`report.json`, the summary footnote, the SARIF run (`run.properties.assertions`)
and every `sentei/org-dead` result message state. It is the same evidence as
`deprecate`, witness included; only the label differs.

`sentei report --view <name>[,<name>]` (repeatable; `org-dead` works too) limits
the stdout summary and the SARIF logs to those views; `report.json` always has
all of them. Default: every view on stdout, every view except `org_dead` in SARIF.

**No option needs a re-index.** Indexing is the only expensive stage and is
cached per package by head sha and indexer version. Changing the policy
(`minAgeDays`, `countTestsAsConsumers`, `countDocsAsConsumers`,
`trustPrivateRegistry`, `keep`) needs `discover` (it records the policy in the DB)
and then `analyze`, `witness` and `report`, never `index`; choosing views needs
only `report`.

## Reading the summary

The report stage prints: the policy line (and the selected views with
`--view`); a `!!` warning banner (`minAgeDays` 0, repos whose index was partial
or failed, dependencies on a name several org packages share); a per-package
table (package name, repo, visibility, private, opaque, one count per view,
blockers); the **view totals**, with the reasons of the DELETE and DEPRECATE rows
(`no_refs`, `only_test_refs`, `dead_island`: islands are a reason, not a column)
and ORG-DEAD printed once as "= DEPRECATE" with the assertion as a footnote; then
**top blockers**, the opaque packages preventing the most verdicts, the "fix that
repo's tsconfig first" list (the top 10; all of them are in `report.json`); and
the version skew count. `blame` dates the last edit of the definition line, not
its creation, which errs toward younger (the safe direction).

## Debugging with SQL

```sh
sqlite3 work/sentei.db
sqlite> SELECT * FROM verdicts v JOIN symbols s USING (symbol_id) WHERE s.name = 'foo';
sqlite> SELECT * FROM findings WHERE verdict = 'deletion_candidate';
sqlite> SELECT * FROM private_packages;       -- deletion (listed) vs deprecation (not)
sqlite> SELECT * FROM package_flags;          -- why a package is opaque
sqlite> SELECT * FROM blocked_packages;       -- who blocks whom
```

`packages/core/sql/analyze.sql` (recreated on every `analyze`) defines the
views: `external_refs`, `internal_refs`, `test_only_refs`, `symbol_age_ok`,
`kept_symbols`, `reachable`, `verdict_blockers`, `verdicts`, `candidate_symbols`,
`reachable_after`, `candidate_reach`, `unreachable_before`, `private_dead`, and
their helpers. `schema.sql` defines `private_packages`, `opaque_packages`
and `blocked_packages`. The `policy` table holds the policy in effect.

## SARIF upload

Each `work/sarif/<owner>__<repo>.sarif` is one Code Scanning upload: one rule
per [view](#views) (`sentei/delete` and `sentei/org-dead` at level `warning`, the
rest `note`), results for the selected views only (default: all but `org_dead`),
locations repo-relative. Every run declares every rule, lists its views in
`run.properties.views` and the assertions they rely on in
`run.properties.assertions`. Fingerprints (`senteiSymbol/v1`) depend on the
package, symbol and file, not on the line or the view, so an alert survives code
moving within its file. Upload with the repo owner's token (`security_events`,
or `public_repo` for a public repo):

```sh
gh api -X POST repos/OWNER/REPO/code-scanning/sarifs \
  -f commit_sha=<runs[0].properties.headSha> -f ref=refs/heads/<branch> \
  -f tool_name=sentei -f sarif="$(gzip -c work/sarif/OWNER__REPO.sarif | base64 -w0)"
```

GitHub caps a run at 25 000 results.

## Contributing / running the tests

```sh
nvm use                    # Node 26 from .nvmrc, if the system node is older
npm ci
npm run typecheck          # tsc over every workspace
npm test                   # vitest, about a minute
npm run snapshots:update   # regenerate fixtures/snapshots after an indexer change
```

The Dart tests (the vendored scip-dart fork, dart-surface, `fixtures/org-dart`)
need a Dart SDK ≥ 3.11 on `PATH` and are skipped without one; the checked-in
snapshots were generated with Dart 3.11.3. Tests need no GitHub token and make no
GitHub API calls (clone tests use local `file://` repos, the API is faked), but
`dart pub get` for the vendored tools needs pub.dev once. CI
(`.github/workflows/ci.yml`) runs the same `npm ci`, `npm run typecheck` and
`npm test` on Node 26 with Dart 3.11.3. When the snapshot test fails, run
`npm run snapshots:update` and review `git diff fixtures/snapshots`. See `CLAUDE.md`
for code conventions (policy lives in SQL, fail closed, one logical change per
commit).

## More

`PLAN.md` is the design (architecture, schema invariants, stages, policy tree);
`docs/DESIGN.md` records decisions, deviations and dogfood findings.
