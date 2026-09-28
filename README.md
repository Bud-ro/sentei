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
dogfooded on public orgs (unjs and honojs for TypeScript; supabase for a
TypeScript / Dart mix; Workiva, flame-engine and dart-lang for Dart and Flutter;
lockfiles in `fixtures/orgs/`), with spot checks against the clones recorded in
`docs/DESIGN.md` ("Phase 2 verification reruns"). Findings only see consumers
inside the org (unused exports of published packages are therefore only
*deprecation* candidates, unless the org asserts `closedOrg`, which the report then
states), so treat them as candidates to review, not instructions. sentei only reports: it never edits, deletes or pushes code and never
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
- npm packages are installed with their own lockfile before indexing
  (`npm ci`, `--frozen-lockfile` / `--immutable`, scripts off), found from the
  package dir up to the repo root. A package inside a workspace installs at the
  workspace root with the root's lockfile and manager (the root has a lockfile and
  lists the package in `pnpm-workspace.yaml`, its package.json `workspaces` or
  `lerna.json`, or its lockfile names the package as a workspace importer); a
  lockfile of the package's own inside such a workspace is ignored with a `warn:`
  line in the package's diagnostics. No lifecycle script of the repo or its
  dependencies runs: yarn berry gets `--mode=skip-build` and
  `YARN_ENABLE_SCRIPTS=false`, and reads a copy of the repo's `.yarnrc.yml`
  without its `plugins` (yarn plugins are repo code; one ran the root
  `postinstallDev` script). How the install is chosen:
  - **Manager**: the `packageManager` field (`pnpm@9.12.0`, `yarn@4.5.0`,
    `npm@10`) when that manager's lockfile is there, then
    `devEngines.packageManager`, then the first lockfile in the order
    `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock(b)`.
  - **Version** of a pnpm, yarn or bun that is not on `PATH` (run through
    `npm exec`): `packageManager`, then `devEngines.packageManager`, then a
    `mise.toml` / `.mise.toml` `[tools]` or `.tool-versions` pin, then the major
    that wrote the lockfile (pnpm `lockfileVersion` 9.0 → 9, 6.x → 8, 5.4 → 7;
    yarn v1 header → 1, berry `__metadata.version` → 2/3/4; bun → 1), else
    pnpm 9 / yarn 1 / bun 1. Never `latest`. A pinned pnpm older than the major
    that wrote the lockfile (`pnpm@7.1.7` with `lockfileVersion: '6.0'`) runs at
    the lockfile's major instead, and an install that fails with
    `ERR_PNPM_LOCKFILE_BREAKING_CHANGE` is retried once at that major.
  - **Engines** checks are off (`--engine-strict=false`,
    `--config.engine-strict=false`, yarn 1 `--ignore-engines`), so a repo
    pinning another Node major still installs.
  pnpm, yarn and corepack state and caches go under `<work>/.pm/`, not `$HOME`
  (npm keeps its usual cache). `--no-install` skips installs altogether.
  - **Network**: registry.npmjs.org, registry.yarnpkg.com (yarn), and nodejs.org:
    pnpm 11 / 12 downloads the Node runtime a `devEngines.runtime` field asks for.
  - **pnpm 12 needs a writable store lock**: it cannot install where the lock
    directory of its store is on a read-only file system
    (`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`, seen in a sandbox evaluation: 36
    vitejs and 43 tanstack packages).
  - **A failed install fails closed**: the package is indexed anyway, but its
    status is `partial` (the install's error is the `cause`), so it is an
    `opaque_consumer`: it gets no verdicts and blocks the verdicts of every org
    package it depends on, which the report lists as blockers. Fix the install (or
    use `--no-install` with an existing `node_modules`) and rerun `index`.
- Org dependencies are source-linked: `node_modules/<name>` is the org package's
  checkout at HEAD, or a shadow of it whose unbuilt `dist/` entry targets point at
  the sources (also for a manifest copied from the build output, as drizzle-orm's
  `main: ./index.cjs` whose `drizzle-orm/pg-core` exists only in `dist/`: the same
  path under `src/` or the tsconfig `rootDir`). A deep build-output import (`@acme/x/dist/module/lib/types`) is linked
  to its source through the package's tsconfig outDir→rootDir (or the dist→src
  convention), and its module counts as package surface; one with no source flags the
  package (`opaque_consumer`), so its symbols get no verdict.
- Dart packages are resolved with `dart pub get` (`flutter pub get` for Flutter
  packages; `flutter` must be on `PATH`), org dependencies source-linked in a
  `pubspec_overrides.yaml` (an existing one is backed up to `.sentei-backup/`;
  the package's own `dependency_overrides`, from that file or else from
  `pubspec.yaml`, are kept: pub reads only one of the two). When pub rejects a
  link (the org package's HEAD conflicts with the consumer's constraints), the
  links it names are dropped and `pub get` is retried, up to 8 times, one `warn:`
  per dropped link.
  A pub workspace (root `workspace:`, members `resolution: workspace`) is
  resolved once at its root, with the links there and only for org
  dependencies outside the workspace that no member overrides itself (pub
  refuses a name overridden twice), and indexed by one scip-dart run over
  all its packages. When `part '*.g.dart'` / `*.freezed.dart` files are missing
  (neither next to the library nor under `.dart_tool/build/generated/<package>/`,
  where `build_to: cache` builders such as over_react's write them) and the
  package depends on `build_runner`, `dart run build_runner build
  --delete-conflicting-outputs` runs first (at most 10 minutes; the outcome is
  a `build_runner: ran|ran with errors|skipped|failed` line in the package's
  index diagnostics: `ran with errors` is a non-zero exit that still wrote
  every part). Parts the analyzer resolves from `.dart_tool/build/generated/`
  are indexed as generated documents at that path. A part that is still
  missing (under `lib/` or `bin/`), or that lies outside the package, makes the
  package `partial`. A package whose `lib/` has Dart files but whose index has
  none of them is `failed`, never `ok`.
- Files a runtime starts (a `node scripts/x.mjs` / `tsx` / `tsm` / `tsimp` /
  `vite-node` / `jiti` / `bun` / `deno run` script, a Dockerfile `CMD`,
  Next.js `next.config.*` / `middleware`, a `bin`) are entry points that keep what
  they use reachable, never export surface. When the package's tsconfig does not
  include them, they are indexed through a temporary
  `tsconfig.sentei-runtime.json` next to it (it `extends` the package tsconfig and
  is removed after the run); they never make the package opaque. A `main` /
  `exports` / `types` entry outside the tsconfig still does. A code file the
  package's own source names relative to itself, `new URL('./worker.ts',
  import.meta.url)` or `path.join(__dirname, 'x.js')` (a bundler, worker or
  subprocess input), is such an entry too. So are browser / bundler inputs: the
  `<script src>` and the modules an inline `<script>` body `require`s / `import`s
  in a package-root HTML file or in one an Electron window opens
  (`loadFile('index.html')`, ``loadURL(`file://${__dirname}/x.html`)``,
  `loadURL(url.format({ pathname: path.join(__dirname, 'index.html') }))`), the
  `input` of `vite.config.*` / `rollup.config.*`, and the `entry` of
  `webpack.config.*` / `webpack.<x>.config.*` (webpack's default
  `./src/index.{js,ts,jsx,tsx}` without one). A script that loads build output
  (`./dist/main.js`) is mapped to its source like a declared entry, or to the
  webpack entry its `[name].js` names.
- Framework and tool conventions add runtime entries the same way:
  Docusaurus (`docusaurus.config.*`, `sidebars.*`, `src/theme/**`, `src/pages/**`,
  `src/plugins/**`), VitePress (with a `vitepress` dependency:
  `.vitepress/config.*`, `.vitepress/theme/**`, `*.data.*` loaders), Astro (with an
  `astro.config.*`: the config, `src/pages/**`, `src/middleware*`,
  `src/actions/**`, the content config), Nuxt (with a `nuxt.config.*`: the config,
  `app.config.*`, `app/**`, `pages/`, `layouts/`, `middleware/`, `plugins/`,
  `server/`, `composables/`, `utils/`, `stores/`, `components/`, `modules/`,
  `shared/`), and every own file one of these configs names with a relative path;
  jscodeshift codemods (a `jscodeshift` dependency or a `*-codemods` dir:
  `transforms/**`, `codemods/**` and transform modules; their `parser` export is
  kept by name); a Firebase Functions source (a `firebase.json`
  `functions.source`: its main and the modules it re-exports, whose exports are all
  deployed); a terraform `entry_point = "name"` (that export of the repo's
  packages); React Native platform modules (`x.ios.js`, `x.android.js`, … of an
  imported `./x`, and root `index.<platform>.*`); a React Native app's root
  `index.{js,ts,tsx}` (`AppRegistry.registerComponent`, no exports) and `App.*`
  (with a `react-native` / `expo` dependency or an `app.json`); an Expo config
  plugin's `app.plugin.js` (Expo loads it by path; it stays surface too) and the
  source of what it requires (`require('./plugin/build')` → `plugin/src/index.ts`,
  also through `plugin/tsconfig.json`'s outDir → rootDir). A React Native / Expo package's
  native code (`android/`, `ios/`, `macos/`, `windows/`, and Java / Kotlin / Swift
  / Objective-C / C++ anywhere in it) never makes it an unindexed consumer.
- Build output maps back to source through the tsconfig outDirs, the dist→src
  convention, leading output segments (`dist/<a>/<b>/x.js` → `src/b/x.*`,
  `src/x.*`), a `src/` under the output dir (`dist/esm/src/index.d.ts`), build-format
  dirs dropped anywhere (`lib/typescript/commonjs/index.d.ts`,
  `dist/default-entry/esm/server.js`), and a bundler's named input (`input: {
  internal: 'src/node/internalIndex.ts' }` → `dist/node/internal.js`, also after a
  build script's `mv dist/index.mjs dist/cli.js`), a build dir named for one target
  (`dist-electron/main.js`, `build-<name>/`, `out-<name>/`, `<name>-dist/` →
  `src/electron/main.ts`, then `electron/`, then `src/`), and a build dir nested in
  the package (`plugin/build/index.js` → `plugin/src/index.ts`); a top-level
  `main` / `types` that maps nowhere is fine when `source` / `react-native` names the
  source (react-native-builder-bob). A manifest published from its build dir
  (drizzle-orm: `main: ./index.cjs`, no `exports`) names paths under the tsconfig
  rootDir (else `src/`): `./index.cjs` → `src/index.ts`, and without `exports` every
  directory index under it (`src/pg-core/index.ts`, the `drizzle-orm/pg-core`
  subpath) is surface too.
- Own code that single-file components and bundlers load where no index sees it
  keeps its top-level declarations alive (all of them: sentei cannot see which
  names are used): relative imports in `.vue` / `.svelte` / `.astro` / `.marko` /
  `.mdx` files, their aliased imports (`~/lib/api`, `@/api/client`: through the
  package tsconfig's `paths`, else the Vite / Nuxt / Astro conventions `~/` and
  `@/` → `src/` when it exists, else the package root, `~~/` and `@@/` → the root,
  SvelteKit `$lib/` → `src/lib/`; Nuxt's `#imports` / `#app` are skipped; an
  alias into another org package is an unindexed import of it), `<script src>` in
  `.astro` / `.vue` files, every file an `import.meta.glob('./pages/*.ts')`
  pattern matches (in any own file, `!` exclusions and `{a,b}` braces included),
  and the files a framework loads by convention from its config (Astro:
  `src/pages/**` endpoints, middleware, actions, content config; Nuxt:
  auto-imported `composables/`, `utils/`, `stores/`, `shared/`, `server/utils/`,
  plugins, route middleware, local modules; plus own files the config names, such
  as Starlight's `routeMiddleware: './src/routeData.ts'`). These are seeds, not
  entry points (see `private_dead` below). An MDX file's fenced code blocks and
  inline code spans are example code: only its real imports count, for own code and
  org packages alike (a docs site showing `import … from '@acme/x'` in examples is
  no consumer of `@acme/x`). An alias or glob pattern that
  names no file is recorded as an unresolved load (`unindexed_loads`, resolved = 0).
- Importing a module runs its top-level code: a module one of whose declarations
  is reachable (or that a reachable module imports) keeps alive what its
  top-level statements and initializers use.

  of them is `failed`, never `ok`. Every `.dart` file of the package's `lib/`,
  `bin/`, `test/`, `example/`, `tool/`, `benchmark/`, `web/`,
  `integration_test/` and `test_driver/` is indexed, including files
  `analysis_options.yaml` excludes (an `info:` line lists them; one that does
  not resolve makes the package `partial`).
- Dart entry points: every public library (each `.dart` file under `lib/`
  outside `lib/src/`, importable as `package:<name>/<path>`) and `bin/`. Kept
  alive although nothing references them: the top-level `main` of every
  library (wherever it is; test files excepted), build.yaml builder factories,
  grinder tasks (`@Task` / `@DefaultTask`, run by reflection from
  `tool/grind.dart`), dart_dev's `config`, the Flutter plugin classes a pubspec names
  (`flutter.plugin.platforms.*.pluginClass` / `dartPluginClass`), and the
  `main` / `hybridMain` of a library of the repo that a `package:` string
  literal names (`spawnHybridUri('package:x/src/server.dart')`,
  `Isolate.spawnUri(Uri.parse('package:x/worker.dart'), …)`). Framework
  conventions too: mason hooks' `run` (`pre_gen.dart` / `post_gen.dart`),
  dart_frog's `onRequest` (`routes/**`), `middleware` (`_middleware.dart`) and
  entrypoint `init` / `run`, an analyzer plugin's `plugin` (`lib/main.dart` of a
  package depending on `analysis_server_plugin` / `analyzer_plugin`), and every
  declaration of a pigeon input (a file outside `lib/` importing
  `package:pigeon/…`: a codegen input, no verdicts).
- Dart applications: a pub package without `publish_to` whose `lib/main.dart`
  declares `main`, a Flutter app (`flutter: uses-material-design` / `assets`
  and no library besides `lib/main.dart`) or mason hooks is private (nobody
  depends on an app), so its unused exports are deletions, not deprecations.
- `pub get` runs with `--no-example`: a package's `example/` (not part of its
  index) cannot make it `partial`. After a failed `pub get` its error, not what
  fails next, is the recorded cause (the report names a pre-null-safety SDK
  bound or dependency).
- Dart re-exports of another org package of the same repo (`package:test`'s
  `export 'package:matcher/expect.dart'`) are exports of the re-exporting entry
  too; re-exports of packages in other repos are not recorded.
- Dart conditional imports / exports (`import 'stub.dart' if (dart.library.io)
  'io.dart'`): the index sees only the default; its uses are lent to the
  alternatives' same-named declarations, and for a conditional `export` the
  alternatives also take the default's export surface.
- tsconfig `lib`/`target`/`module` values newer than the bundled TypeScript
  5.9 (`ES2025`) are read as its newest (`esnext`, `nodenext`), with an
  `info:` line in the package's index log.

## Quick start

```sh
npm ci
S="node packages/cli/src/main.ts"
$S discover --org unjs --lockfile fixtures/orgs/unjs.lock.json   # list (lockfile written on first run, read after), shallow-clone
$S index      # SCIP indexes per package (cached by head sha; --force, --retry-failed, --no-install)
$S ingest     # load .scip files into work/sentei.db
$S blame      # first-seen dates for exported symbols (full clones only, see below; --clone-concurrency at a time)
$S analyze    # reachability + verdicts
$S witness    # text-search check: witnessed candidates become deletion/deprecation candidates
$S report     # report.json, SARIF, summary on stdout (--view delete,... to pick views)
# or all of the above in order:
$S run --org unjs --lockfile fixtures/orgs/unjs.lock.json
```

`--org-dir <dir>` replaces `--org` for a local org directory (`org.json` +
`repos/<name>/`, see `fixtures/org-small`). Useful options: `--work <dir>`
(default `./work`), `--db <file>` (default `<work>/sentei.db`), `--include/--exclude <glob>`,
`--include-forks`, `--include-archived`, `--clone-concurrency <n>` (parallel clones,
and repos blamed at once by `blame`), `--full-clone` (discover/run `--org`: clone
whole histories so `blame` can date symbols for `minAgeDays`, see
[Shallow or full clones](#shallow-or-full-clones-symbol-ages)),
`--allow-clone-failures` (see [Choosing repos](#choosing-repos)),
`--update-lockfile`, `--config-dir <dir>` (where the org `sentei.json` lives;
default the cwd if it has one), `--max-old-space-mb <n>`, `--quiet`, `--verbose`.
`--policy key=value` (repeatable, JSON values) overrides one org policy key for
`discover`/`run`, e.g. `--policy countTestsAsConsumers=true --policy minAgeDays=0`.
`--view <name>[,<name>]` (report/run) limits the summary and SARIF to those
[views](#views). `--strict` (index/run) exits 2 when any package failed to index
(see [Reading the summary](#reading-the-summary)); `run --strict` still runs every
stage and writes the report first. `index --json` prints the end-of-run summary as
JSON (`{"summary": {...}}`) on stdout and the progress lines on stderr.
Run with `--help` for the full list.

Each stage prints `[stage] done in 1.2s`; `run` ends with a total. Exit codes: 0
success, 1 a stage failed (`sentei <stage>: <message>` on stderr; `--verbose` adds
the stack), 2 usage error, or with `--strict` a package that failed to index.

## Choosing repos

Real orgs hold hardware repos, hackathons, forks and archives. `discover --org`
decides which repos to clone **before cloning**, and `sentei repos` shows that
decision for every repo without cloning anything:

```sh
$S repos --org acme            # selected and excluded repos: language, HEAD size, manifests, pushed, reasons
$S repos --org acme --json     # the same as JSON
# edit sentei.json "repos" (below) until the selection looks right, then:
$S discover --org acme         # clones only the selected repos
```

Both read `<work>/<org>.lock.json` (or `--lockfile <file>`) when it exists, so the
second and later runs make no API calls; the first run lists the org and writes
it. `--update-lockfile` relists (new repos, new head shas). The lockfile
(`"version": 3`) records, per repo, the listing facts (`language`, `sizeKb` = GitHub's
full-history size, `pushedAt`, fork/archived/template), what the git tree probe
found (`manifests`: every `package.json` / `pubspec.yaml` path, `headTreeKb`: the
HEAD size, `probe`: `tree`, `truncated` or `root`), the pinned `headSha`, the
decision (`selected`, `reasons`), the last `cloneError` and, after a clone, `clone`
(`"full"` or `"shallow"`: the checkout's history, which `sentei repos` sums up); its `selection` header
records the settings used, and `excluded` lists every excluded repo with its reason
and manifests, for auditing what was skipped. When the settings change, the
decisions are recomputed from the recorded facts (pins kept) and the API is only
called for what the lockfile does not hold yet (a tree, or the head sha of a newly
selected repo). Version 2 lockfiles (root-only manifest probe) are upgraded on the
next run: each candidate's tree is fetched at its pinned sha. Lockfiles written
before selection existed (no `selection` header) still work, with only the
include/exclude/fork/template rules; `--update-lockfile` upgrades them.

`sentei repos` prints the selected repos, then the excluded ones, with language,
size (the HEAD tree; `api` marks the full-history size when the tree was not read),
the number of manifests found (`-` = not probed) and the reasons. **Excluded repos
that carry manifests are named** there, in the selection log and as a report
warning: they may use org packages, and those uses are invisible to the analysis,
so an export only they use can come out dead. A repo of example apps or benchmarks
(a `flutter/samples`-style repo) is worth selecting: its apps under `example/`,
`samples/`, `benchmarks/`, ... that depend on another repo's org package are indexed
as consumers (see `ignoreManifestDirs` below); `sentei repos` cannot tell, since it
reads no manifest contents, but `discover` logs every such promotion. Include them, or treat findings
touching what they might use with care.

Rules, first match wins:

1. `--include` globs, then `--exclude`, then `repos.include`, then `repos.exclude`
   (repo names, `*`/`?`/`**`). An include match forces the repo in past every rule
   below (a forced archived, forked, huge or Python repo is cloned), so
   `--exclude '*' --include 'h3*'` clones just the `h3*` repos.
2. Empty repos (no commit on the default branch) and repos disabled by GitHub.
3. Archived repos (`--include-archived`), forks (`--include-forks`), templates. A
   template repo's git tree is still probed (one request), so the warning about
   excluded repos with manifests (possible consumers) names it.
4. `repos.maxSizeMb` (default 500) against the **HEAD size**: the sum of the blob
   sizes in the default branch's tree, about what a shallow clone checks out. The
   API `size` (the packed full history: supabase/cli is 301 MB there, 26 MB at
   HEAD) is used only when GitHub truncated the tree (over 100,000 entries or
   7 MB of listing) or the tree could not be read; `sentei repos` and the reason
   say which one was used.
5. `repos.minPushed`: skip repos last pushed before an ISO date or `<n>d` ago.
6. Language: GitHub's primary language is in `repos.languages` (default
   TypeScript, JavaScript, Dart), **or** the repo has a `package.json` or
   `pubspec.yaml` anywhere in its HEAD tree outside `node_modules/`,
   `.dart_tool/`, `build/`, `vendor/` and `third_party/` (a docs site written
   mostly in Vue, an Elixir app with `assets/package.json`, a Rust repo with JS
   test packages, a Dart monorepo with only `pkgs/*/pubspec.yaml`).

Rules 4 and 6 read one git tree per repo (`GET .../git/trees/<branch>?recursive=1`,
one request), fetched for every repo rules 2–3 let through and for repos an
explicit include/exclude matched (so an excluded repo's manifests are known). A
truncated tree falls back to its partial listing plus a root `package.json` /
`pubspec.yaml` probe (`probe: truncated`).

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
    "cloneConcurrency": 8,
    "clone": "shallow"
  }
}
```

| `repos` key | Default | Meaning |
|---|---|---|
| `include` | `[]` | globs always cloned (past every automatic rule) |
| `exclude` | `[]` | globs never cloned (unless included) |
| `languages` | TypeScript, JavaScript, Dart | primary languages that select a repo; `[]` turns the language rule off |
| `maxSizeMb` | 500 | skip repos whose HEAD size (API size when the tree is truncated) is larger; `null` for no limit |
| `minPushed` | none | ISO date (`"2025-01-01"`) or `"<n>d"` |
| `includeForks` / `includeArchived` | false | overridden by `--include-forks` / `--include-archived` (and `--no-…`) |
| `probe` | true | read each candidate's git tree (manifests anywhere, HEAD size); `false`: language and API size only, no per-repo requests before pinning |
| `cloneConcurrency` | 8 | parallel clones; overridden by `--clone-concurrency` (1–32) |
| `clone` | `"shallow"` | `"shallow"` (`--depth=1`: fast, but symbol ages are unknown and `minAgeDays` has no effect) or `"full"` (whole history, so `blame` dates symbols); `--full-clone` sets `"full"`, see [Shallow or full clones](#shallow-or-full-clones-symbol-ages) |

CLI flags override the config: `--include`/`--exclude` rank above
`repos.include`/`repos.exclude` (rule 1), the boolean flags replace the config
values.

### Cloning

Selected repos are cloned in parallel (`--clone-concurrency`, default 8) with
`git clone --depth=1 --single-branch --no-tags` (without `--depth=1` for
[full clones](#shallow-or-full-clones-symbol-ages)) and `GIT_LFS_SKIP_SMUDGE=1` (LFS
objects are never downloaded), then pinned to the lockfile's sha. Existing
clones at the right sha are reused (a full clone also for a shallow request).
Progress looks like
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

### Shallow or full clones (symbol ages)

`minAgeDays` (default 180) keeps young exports out of every verdict: a symbol is
only a candidate once the last edit of its definition line (`git blame`) is at
least that many days old. Dating needs the repo's history, and **clones are
shallow by default** (`--depth=1`: one commit, the fastest clone), so by default
sentei does not know symbol ages:

- `blame` runs only on checkouts with full history (`git rev-parse
  --is-shallow-repository` is `false`). A shallow repo is skipped with one line
  (`[blame] acme/app: shallow clone, not blamed: ...`) and a summary line; its
  history is never fetched implicitly.
- A symbol whose age is unknown (a shallow clone, a directory without git
  history, a line blame could not date) is treated as **old enough**: for that
  repo `minAgeDays` has no effect, and a symbol added yesterday can be a
  candidate.
- Whenever `minAgeDays` > 0 and some repo that exports symbols is not dated
  (a shallow clone, no git history, or `blame` not rerun after `ingest`), `blame`
  and `analyze` print a `warn:` line and the report a `!! WARNING`, e.g.
  `minAgeDays=180 has no effect on 30 of 33 repos (shallow clones: symbol ages
  unknown, treated as old enough); pass --full-clone (repos.clone: "full") to date
  symbols`, and the summary's policy line says `minAgeDays=180 (applied to 3 of
  33 repos)`. Repos without exports (apps) are not counted.

To date symbols, clone with full history: `discover --full-clone` (or `run
--full-clone`), or `"repos": { "clone": "full" }` in the org `sentei.json`. It
costs the whole history of every selected repo: far more data and time than a
shallow clone for old, busy repos (unshallowing dart-lang's 31 repos and blaming
them took about 21 minutes). Existing shallow checkouts are upgraded in place
(`git fetch --unshallow`), a full checkout is reused as it is by later shallow
runs, and the lockfile records each repo's `clone` mode (`sentei repos` prints
the counts). `blame` then dates full repos `--clone-concurrency` at a time.
With `minAgeDays: 0` the ages are not used and shallow clones lose nothing.

### GitHub API limits

Listing costs one request per 100 repos, one per probed repo (its git tree), and
one per selected repo (its head sha): at most about 200 requests for a 100-repo
org, against 5,000 per hour for a token (a truncated tree adds 1–2 root probes,
and a default branch the trees endpoint does not resolve adds a branch lookup).
Above 300 probed repos a progress line is printed every 50. Requests run at most 8
at a time. sentei honours GitHub's rate limit headers for all of them together:

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
  repos/<name>/            clones, shallow unless --full-clone (--org; --clones-dir to move)
  index/<owner>__<repo>/   index.json; per package <pkg>.scip, <pkg>.exports.json
                           (sidecar) and <pkg>.log (indexer and install output)
  .pm/                     package-manager caches and state for installs
  sentei.db                SQLite: schema + analysis views (first-class debug artifact)
  blame/<owner>__<repo>.json  blame cache, trusted only for the same head sha
  report.json              full findings, reasons, blockers, warnings, version skew
  sarif/<owner>__<repo>.sarif  one SARIF 2.1.0 log per repo (also for clean repos)
  sarif-<view>[,<view>]/   the same for a `report --view` run (sarif/ is left alone)
```

Stages can be rerun alone. `discover` and `ingest` rebuild the whole org;
`blame` must follow every `ingest` (its cache makes that cheap).

## Configuration

**Org `sentei.json`** (in `--config-dir`, the cwd, or the `--org-dir`). Unknown
keys and wrong types are errors, so a typo cannot silently fail open.

| Key | Default | Meaning |
|---|---|---|
| `minAgeDays` | 180 | every verdict on an export needs its blame date to be at least this old; an unknown date (shallow clone, no git history) counts as old enough, with a warning, see [Shallow or full clones](#shallow-or-full-clones-symbol-ages) |
| `trustPrivateRegistry` | true | `published-private` packages count as private (nobody outside the org can depend on them) |
| `countTestsAsConsumers` | false | references from test files count as uses (always, without it, for a dev-only dependency and for test-support code, below) |
| `countDocsAsConsumers` | false | references from docs files count as uses |
| `closedOrg` | false | the org **asserts** that nothing outside it depends on its published packages: their unused exports are `delete` (deletion candidates, witness still required), not `deprecate`. sentei cannot check this; the summary's policy line, `report.json` `assertions` and SARIF state it. No re-index (see [Views](#views)) |
| `keep` | `[]` | never report these: `"npm:@acme/foo#sym"` (every package named `@acme/foo`), `"npm:acme/foo:@acme/foo#sym"` (only the one in repo `acme/foo`), `"pub:bar#*"` |
| `ignoreManifestDirs` | built-in list | directory names (fixtures, templates, examples, test, ...) whose manifests are not org packages; replaces the default. A name matching any *ancestor* of the manifest's dir always ignores it; matching the manifest's *own* dir ignores it unless that dir is a monorepo member: its parent is `pkgs`, `packages`, `apps`, `libs` or `modules` (`pkgs/test` is the `test` package), or it is a pub `workspace:` / npm `workspaces` member (or has `resolution: workspace`) whose parent dir holds no manifest (a package's own `example/` stays ignored). **Examples and benchmarks of another repo are consumers:** an ignored manifest whose ignored dirs are all example-like (`example(s)`, `sample(s)`, `demo(s)`, `benchmark(s)`, `bench`, `playground(s)`, `sandbox`) and that has a regular (non-dev) dependency on an org package of ANOTHER repo is indexed as a private consumer package (no export surface; `discover` logs `promoted ignored-dir manifest … : example app depends on <package id> (repo <repo>)`). Its uses of other repos' packages count like any consumer's (the docs globs match paths below its own root, so its files are not docs files); its uses of its own repo's packages count as docs uses (`only_docs_refs`). An ignored manifest that uses only its own repo's packages never counts: the witness notes its uses (`note:used by …`) without changing a verdict. Test / fixture / template dirs are never promoted. Whatever this list says, scaffold templates are never packages: a manifest under a generator's `files/` (`generators/<name>/files/`, `schematics/<name>/files/`), mason's `__brick__` or a `.template` dir, or one whose name is a placeholder (`<%= name %>`, `{{name}}`) |
| `ignoreManifests` | `[]` | globs `"<repo>/<manifest path>"` (repo name without the org), e.g. `"vscode/package.json"`, `"over_react/app/**"`: those manifests are not org packages (never indexed, never a blocker, not a counted consumer; the text witness still scans their code, fail closed). The report lists every one in a warning. Use it for a package that cannot be indexed and that nothing depends on (a pre-Dart-2.12 example app, a repo-internal demo); a blocker's hint gives the exact entry. It also keeps an example app of another repo from being promoted to a consumer package (e.g. one that fails to index and would block what it uses) |
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
columns. (Within one repo the ids of two manifests of one name would collide:
private duplicates are ignored like templates; when two or more are not private,
all of them are ignored as copies, with a warning listing them and the
`ignoreManifests` entries that keep the real one. Discover never stops on it.)
A manifest that does not parse (a mason template's `{{…}}` tags) or whose name is a
template (`{{project_name}}`) is no package either: a warning, and the report's
ignored-manifest warning names it. Mason `__brick__/` and `.mason/` are default
ignored dirs, and `.nx`, `.turbo`, `.cache`, `.parcel-cache`, `.yarn`,
`.pnpm-store` (package-manager and build-tool state) are never scanned, like
`node_modules`.

A `package.json` without `"name"` that declares dependencies (a demo app, a Phoenix
`assets/` bundle) is still indexed, as a consumer: its name is `_unnamed/<dir>`
(`_unnamed/.` at the repo root), it is private, has no export surface and gets no
findings of its own, but its uses of org packages count. One without dependencies
(a bare `{"private": true}` marker) is skipped with a warning. scip-typescript names
the symbols of every nameless package `npm . .`; ingest gives each such package's
own symbols its own name and id, so two nameless apps never share a symbol. A use
of the synthetic name resolves only within the repo (every repo's root may be
`_unnamed/.`).

Manifests and SCIP symbols name dependencies by name only, so a dependency on a
name several org packages share is resolved per consumer:

1. the only org package of that name;
2. otherwise the one in the consumer's own repo (`same-repo`);
3. otherwise the only one that is not private (`published`: a private package
   cannot be installed from a registry);
4. otherwise the only one whose manifest `version` satisfies the dependency's
   version constraint (`constraint`: npm ranges `^` `~` `>=`/`<` `||` `*`, pub
   `^` / ranges / `any`); a `workspace:` / `file:` / path / git dependency, a
   dist-tag, or a candidate without a version never decides, and zero or several
   matches do not either (never "the highest version");
5. otherwise it is **ambiguous**: no package is picked, the consumer gets an
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
`trustPrivateRegistry`: nobody outside the org can depend on it; with `closedOrg`,
every package, by the org's assertion) or **published** (everything else). Nothing
else about the world goes in, so every way of reading the result is a
[view](#views) over the same findings.

| Verdict | Meaning |
|---|---|
| `deletion_candidate` | private package (or, with `closedOrg`, a published one), no counted references (or only test references), old enough, not kept, witness found nothing |
| `deprecation_candidate` | published package (never with `closedOrg`), same evidence (the witness ran too); or, with reason `internal_refs_only`, an export used only inside its published package |
| `unexport_candidate` | private package with dependents in the org, only used inside its own package: drop the `export` (see below for what never gets one) |
| `private_dead` | not exported, unreachable from the package's entry points (now, or once the candidates it names are gone); only in a package whose entry set sentei trusts (below) |
| `needs_review` | would be a candidate (or an unexport) but the witness found a textual mention |
| `blocked` | would have had a verdict, but an opaque package prevents it (`blocked_by`) |

`private_dead` is reported only for a package whose entry set is credible: it has
a declared or convention entry point (an export, a manifest `main` / `exports` /
`bin`, a runtime entry: scripts, Dockerfile `CMD`, HTML / bundler client entries,
Next.js / Nuxt / SvelteKit / Astro / Docusaurus / VitePress conventions, wrangler
`main`, a Dart `main` or builder) and
none of its own loads went unresolved (an alias or `import.meta.glob` naming no
file, a loaded file that is not indexed). Seeds from single-file components alone
do not count: an Astro site with no entry point (its roots are file-routed pages)
used to get every module its components do not import directly as a false
`private_dead` row. Such a package gets no `private_dead` rows (fail closed); the
summary says so under the view totals (`(private_dead skipped for N package(s)
whose entry points sentei cannot see; M unreachable private symbol(s) not
reported: <package> (no known entry points), <package> (unresolved load: ~/x in
src/pages/a.astro), …)`) and `report.json` carries
`packages[].private_dead_skipped` (`reason`, `symbols`).

No unexport (and no published `deprecation_candidate [internal_refs_only]`) is
proposed for:
- an export of a **private app**: a `private` package (npm `"private": true`, pub
  `publish_to: none`) that nothing in the org depends on or uses (no resolved
  manifest dependency, no flag or witness file targeting it, no cross-package
  reference). Its exports have no audience, so they are judged like private
  symbols: alive when its entry points reach them, a `dead_island` would-be
  deletion (through the witness) when not. A published package, or a private one
  with dependents, keeps its unexport candidates.
- a type **named in the signature of public API**: an internal-only export used in
  the signature of an exported symbol of the same package that is itself not an
  internal-only export (the return type of a public function, the type of a public
  field, a class header's `extends` / `implements`), directly or through another
  such type. The index has no signature range, so "signature" is positional: the
  header of a type declaration, a field's definition line, the part of a function's
  definition line before its name (Dart return type), and, in npm packages, any type
  on the definition line; and for a function, method or constructor everything
  between its name and its body (parameter types on any line, generic constraints,
  the return type), found in the checkout's text at ingest (never for a TypeScript
  `private` member). Missed (the symbol then stays an unexport candidate): an arrow
  function held by a variable after its first line, and a return type written as a
  function type after its `=>`.

**Code the package loads by path or by name.** A bin or script importing the
package's own unbuilt build output (`import { runCli } from '../dist/cli.mjs'`,
`import('./dist/index.js')`) is mapped to the source (tsconfig outDir → rootDir,
dist → src): what it takes is a runtime entry (no verdict) that it references.
Build output that no source maps to makes the package `partial` (its `cause:`
names the import), never `ok`. A string naming the package's own subpath
(`serverEntrypoint: '@astrojs/preact/server.js'`,
`require.resolve('@trpc/upgrade/transforms/provider')`, through `exports`) or an
own code file (`'./src/routeData.ts'`, `new URL('./worker.ts', import.meta.url)`)
makes that module's exports runtime entries too (a framework or tool loads them).

Reasons: `no_refs`, `internal_refs_only`, `only_test_refs` (delete the tests
too), `only_docs_refs` (used only in docs / examples, e.g. the package's own
`example/` or an example app of its own repo, which count as consumers only with `countDocsAsConsumers`; next to
`only_test_refs` when both exist), `witness_pending` (analyze output before `witness` runs),
`witness_mismatch:<consumer>:<file>:<line>` (1-based; `<consumer>` is a package
id, `self`, `self-string` or `ignored:<repo>/<manifest>`, and `<file>:<line>` can be
`checkout missing`; a hit on a member name of a Dart extension, which is used
through its members, ends ` (member <name>)`; an unexport re-checked against code
the index never saw ends ` (used by ignored manifest <org>/<repo>:<manifest>)` or
` (used in a docs/example file)`), `note:used by <manifest> (<file>:<line>)` /
`note:used by <file>:<line>` (not a policy reason, never changes a verdict or a view:
the witness found the symbol in the package's OWN repo's example / benchmark / docs
code, an ignored `example/` app or a docs file, which is no consumer; with
`countDocsAsConsumers` such a hit is a `witness_mismatch` instead), `dead_island` (exports used only by other candidates, so they
go together: a would-be unexport that becomes a deletion, or a deprecation in a
published package), `already_unreachable` (an existing private island),
`unlocked_by:<symbol>` (dead once that candidate goes). `blocked_by` entries are
`<package id>:<flag>`, with flags `opaque_consumer`, `index_failed`,
`dynamic_access`, `namespace_dynamic`, `unindexed_consumer`, `ambiguous_dep`.
`unindexed_consumer` marks a package that depends on org packages and holds code
no indexer reads: for npm, Python, Go, Rust, Java, C, … files; for pub, only
JS-family files (`.js`, `.ts`, `.html`, `.vue`, …) outside the platform dirs,
and only when an org dependency exports Dart to JS (`@JSExport`,
`createJSInteropWrapper`, `createDartExport`), since no other language can
name a Dart symbol.
Version skew (a consumer referencing a symbol missing at HEAD) is reported
separately, never as a finding. Only references that can be skew count
(analyze.sql `unresolved_ref_classes`): a reference into a package of the same
repo whose dependency admits HEAD (workspace, path, a range HEAD satisfies), into
an opaque or export-less package, or into a module no index defines (a deep
`dist/` import, a JSON module) is an indexing gap instead; a reference to a name
the target still defines at HEAD, in another file or as a member inherited from
a supertype (`moved_at_head`), is not skew either. Both are counted per target
package under `report.json` `diagnostics` (`unresolved_same_repo`,
`unresolved_opaque_target`, `unresolved_unindexed_module`,
`unresolved_moved_at_head`) and summarized under the version skew line.

**Test-support code** is meant to be used by other packages' tests, so their
test-file uses of it count as references even under a regular dependency
(analyze.sql `test_support_symbols`): symbols exported through an entry named
`test`, `testing`, `test_utils`, `test-utils`, `testkit`, `mock(s)` or
`*_test_utils`, `*_testing`, … (pub `lib/test.dart`, npm `./testing` →
`src/testing.ts` or `src/testing/index.ts`), symbols under `lib/src/test*/`,
`lib/src/mocks/`, `lib/testing/`, `src/testing/`, `src/test-utils/`, and every
symbol of a package named `*testkit`, `*_test`, `*_test_utils`, `*-testing`,
`*-e2e`, `*_e2e` (a shared end-to-end suite), …,
and symbols defined in a pub `lib/` library named that way
(`lib/src/code_assets/testing.dart`). An entry of another org package of the
same repo counts too: matcher's `closeTo`, re-exported by `package:test`'s
`lib/test.dart`, is test-support surface. A test use also counts through a
dev-only dependency on a package that re-exports the symbol (consumers depend
on `test`, not on `matcher`). A test-support helper used only by its own
package's tests is still `only_test_refs`.

**Mixed repos.** A package of the other manager in the same repo is a witness
consumer: a Dart package that reads a JS bundle built in the same repo through
`@JS('acmeBridge.start')` keeps the bundle's `acmeBridge` alive
(`needs_review`), even when the index saw it used only inside its own package
(an unexport). Dart files count when they use JS interop; JS files count for a
Dart symbol only when its file exports Dart to JS (`@JSExport`).

Test, docs, generated and script files are recognized by path
(`packages/core/src/globs.ts`: `test/`, `tests/`, `__tests__/`, `*.test.*`,
`*.spec.*`, `*_test.dart`, `mocks/`, `fixtures/`, `e2e/`, `tests-e2e/`,
`e2e-tests/`, `type-tests/`,
`cypress/`, `playwright/`, Flutter `test_driver/` and `integration_test/`,
`test-utils.*`, `test_utils.*`, `test_util.*`, `testutils.*`, ...; docs:
`docs/`, `examples/`, `example/`, `demo/`, Docusaurus `blog/` and
`versioned_docs/`, VitePress `.vitepress/`),
except that nothing under a pub package's `lib/` is ever one of them: every file
there is importable library code. TypeScript files are also generated when a
comment in their first 20 lines says so (`@generated`, "do not edit", "do not
modify", "auto generated", "generated from … IDL", ...), Dart files when a
comment before their first directive or declaration does, in any leading
block and doc comments excepted (ffigen / jnigen bindings, source_gen and
protoc output, package:web's Web IDL bindings), TypeScript files when
they sit under a tool-output directory (`.nuxt/`, `.svelte-kit/`, `.prisma/`,
...), or when they have the exact shape of `supabase gen types typescript`
output (which carries no header). Generated globs include ffigen / jnigen style
`*_generated.dart` and protoc's `*.pb*.dart` (`*.pbgrpc.dart` included). Vendored code, in a `third_party/`, `vendor/` or `vendored/`
directory below the package root, is treated like generated code: nothing
defined there gets a verdict, references from it still count (a package whose
own root is under such a directory is still org code).

## Views

**Delete or deprecate.** By default an unused export is `delete` in a private
package (nobody outside the org can depend on it) and `deprecate` in a published
one (consumers outside the org may exist: deprecate now, remove in a major
version). Set `closedOrg: true` (org `sentei.json`, or `--policy closedOrg=true`
at discover) only if you can assert that **nothing outside the org depends on its
published packages** (a monorepo that publishes for itself, an internal org with
public package names): then unused exports are `delete` in both, under that
assertion, which the summary's policy line (`closedOrg=true (asserted: ...)`), the
`PRIVATE` column (`closedOrg` instead of `yes`), `report.json` (`assertions`,
`views.delete.assertion`, `packages[].private_by_assertion`) and each affected
SARIF `sentei/delete` result state. The evidence is the same either way, the text
witness included.

`report.json` holds the base `findings`, `assertions` (empty unless `closedOrg`)
and every view but the legacy `org_dead` under `views`, each `{ description,
assertion?, rows }`:

| View | Rows | Summary column | SARIF rule (level) |
|---|---|---|---|
| `delete` | `deletion_candidate` (with `closedOrg`, published packages too; the view then carries the assertion) | DELETE | `sentei/delete` (warning) |
| `deprecate` | `deprecation_candidate` with `no_refs` / `only_test_refs` / `only_docs_refs` / `dead_island` (empty with `closedOrg`) | DEPRECATE | `sentei/deprecate` (note) |
| `org_dead` | **legacy, prefer `closedOrg`**: the `deprecate` rows read as deletions, plus (`private_dead`) the private helpers only they unlock; carries an **assertion**; empty with `closedOrg`; in `report.json` only with `--view org_dead` | ORG-DEAD, only with `--view org_dead` | `sentei/org-dead` (warning), only with `--view org_dead` |
| `unexport` | `unexport_candidate`, plus (`published`) `deprecation_candidate` with only `internal_refs_only`; never for a private app nothing in the org depends on, nor for a type in a public signature | UNEXPORT | `sentei/unexport` (note) |
| `private_dead` | `private_dead`, minus the helpers of a published package that only its `deprecate` rows unlock (those are in `org_dead`; none with `closedOrg`); packages without a credible entry set have none (`packages[].private_dead_skipped`, a note under the view totals) | PRIV-DEAD | `sentei/private-dead` (note) |
| `needs_review` | `needs_review` | REVIEW | `sentei/needs-review` (note) |
| `blocked` | `blocked` | BLOCKED | `sentei/blocked` (note) |
| `version_skew` | `versionSkew` | VERSION-SKEW | `sentei/version-skew` (note) |

`org_dead` (legacy) was the Phase 2 way to read the `deprecate` rows as
deletions, as a view that asserted "the org is the only consumer of these
packages" on its own. It is no longer in the default summary (no column, total
line or footnote), SARIF or `report.json`; `--view org_dead` still prints it,
with its assertion in the footnote, the SARIF run (`run.properties.assertions`)
and every `sentei/org-dead` result message, and writes it to `report.json`
(`views.org_dead` and the per-package `counts.org_dead`, absent from a report
written without it). Prefer `closedOrg`: the org makes the assertion once, the rows
become real `deletion_candidate`s (so the private helpers they unlock are plain
`private_dead`), and `org_dead` is empty by construction.

`sentei report --view <name>[,<name>]` (repeatable; `org-dead` works too) limits
the stdout summary and the SARIF logs to those views; `report.json` always has
all the others, and `org_dead` too when `--view` names it. Default: every view
except `org_dead`, on stdout, in SARIF and in `report.json`.
The SARIF of a `--view` run goes to its own directory next to the default set,
`work/sarif-<view>[,<view>]/` (views in the order of the table above, e.g.
`work/sarif-delete,org_dead/`); `work/sarif/` is only written by a run without
`--view`, so a filtered look never replaces the logs you upload. The report
prints where each file went.

**No option needs a re-index.** Indexing is the only expensive stage and is
cached per package by head sha and indexer version. Changing the policy
(`minAgeDays`, `countTestsAsConsumers`, `countDocsAsConsumers`,
`trustPrivateRegistry`, `closedOrg`, `keep`) needs `discover` (it records the
policy in the DB) and then `index` (all cached), `ingest`, `analyze`, `witness`
and `report`, never a re-index; choosing views needs only `report`.

Partial and failed results are cached too, keyed by everything they depend on:
the package's head sha, indexer version, install mode (`--no-install`), toolchain
(`node` version for npm; `dart --version` and the Flutter SDK for pub), the
policy keys index reads (`countTestsAsConsumers`, `countDocsAsConsumers`; not
`minAgeDays`, `trustPrivateRegistry` or `closedOrg`), and the head shas of every
org package it resolves through. While those are
unchanged a rerun reuses the failure without re-running its install and replays
it (`cached failure from <time>; rerun with --retry-failed to retry`, with the
log path). `--retry-failed` (index/run) retries them after you fixed the
environment; `--force` re-indexes everything.

While it runs, `index` prints each install as it starts (`pub get <package>`,
`installing <package> (pnpm)`, `linking <package> (--no-install)`) and, with more
than 20 packages, `N/M packages prepared` / `N/M packages done` lines.

## Reading the summary

`index` ends with its own summary: packages indexed, reused from the cache and
failed (plus partial), per indexer (a failed package counts as failed only, so
indexed + cached + failed is the number of packages; partial ones are also in
indexed or cached), then one line per failed package with the
first line of its diagnostics that names a cause (a `TS1012`, an `Error:`, heap
exhaustion, ...) and the path of its log (`work/index/<owner>__<repo>/<pkg>.log`,
the full indexer and install output):

```
[index] summary: 14 indexed, 0 cached, 1 failed
  INDEXER          INDEXED  CACHED  FAILED  PARTIAL
  scip-typescript       14       0       1        0
[index] 1 package(s) failed to index; their consumers' findings are blocked (index_failed). (exit 2 with --strict):
  npm:acme/repo-broken:@acme/broken: tsconfig.json(11,2): error TS1012: Unexpected token. (log: work/index/acme__repo-broken/npm__repo-broken__acme__broken.log)
```

A failed package is not fatal: sentei fails closed, so every symbol it might
consume is `blocked` with `<package id>:index_failed` rather than reported dead,
and the run exits 0. Fix those first (they cost verdicts, see top blockers
below), or pass `--strict` in CI to make them exit 2.

The report stage prints: the policy line (with `closedOrg=true`, followed by
`(asserted: nothing outside the org depends on published packages)`), and the
selected views with `--view`; a `!!` warning banner (`minAgeDays` 0, repos whose index was partial

The report stage prints: the policy line, where `minAgeDays=180 (applied to K of
M repos)` counts the repos whose symbols `blame` could date (full clones; see
[Shallow or full clones](#shallow-or-full-clones-symbol-ages)), and with
`minAgeDays` > 0 a `blame:` line, e.g. `blame: 1200 of 5400 exported symbol(s)
dated; 4150 undated in shallow clones, 50 undated otherwise (unknown ages count, outside full clones,
as old enough)` (the same numbers are `ageCoverage` in `report.json`); the
selected views with `--view`; a `!!` warning banner (`minAgeDays` 0, `minAgeDays`
without effect on shallow or undated repos, repos whose index was partial
or failed, dependencies on a name several org packages share, excluded or
uncloned repos that carry manifests, manifests excluded by `ignoreManifests`:
the first ten on stdout, all of them in `report.json`); a per-package
table (package name, repo, visibility, private (`yes`, or `closedOrg` when only
the assertion makes it so), opaque, one count per view, blockers); the **view
totals**, with the reasons of the DELETE and DEPRECATE rows (`no_refs`,
`only_test_refs`, `only_docs_refs`, `dead_island`: islands are a reason, not a
column) (with `--view org_dead`, ORG-DEAD printed once as "= DEPRECATE" with its
assertion as a footnote); then
**top blockers**, the opaque packages preventing the most verdicts, the "fix that
repo's tsconfig first" list (the top 10; all of them are in `report.json`),
followed by a "What to do:" line per blocker (`report.json` `blockers[].hint`):
the first error line and the index log for a failed or partial index (a
pre-2.12 Dart SDK constraint is named as such; a failed install shows its error
code, `pnpm install failed (exit 1): ERR_PNPM_…`, not the command line; a missing
`.nuxt/tsconfig.json` says to run `nuxi prepare` or exclude the package; a
package-name tsconfig `extends` that is not installed names the package), the `ignoreManifests` entry
that removes a blocker nothing depends on, the unresolved entry point, the
candidates of an ambiguous dependency with the `ignoreManifests` entries to drop
the wrong ones (there is no way to pin a dependency to one package id), or the
unindexed / dynamic code that makes a package opaque; and
the version skew count, with one line per class of unresolved references that
are indexing gaps rather than skew. `blame` dates the last edit of the definition line, not
its creation, which errs toward younger (the safe direction). The `blame` stage
itself ends with `[blame] N symbol(s): a blamed, b cached, c undated (d shallow,
...); e repo(s) skipped (s shallow)` (shallow clones count as skipped: they are
never blamed), and, when some repos are shallow, `[blame] S of M
repo(s) are shallow clones: not blamed ...` plus the `warn:` line about
`minAgeDays`.

## Debugging with SQL

```sh
sqlite3 work/sentei.db
sqlite> SELECT * FROM verdicts v JOIN symbols s USING (symbol_id) WHERE s.name = 'foo';
sqlite> SELECT * FROM findings WHERE verdict = 'deletion_candidate';
sqlite> SELECT * FROM private_packages;       -- deletion (listed) vs deprecation (not)
sqlite> SELECT * FROM package_flags;          -- why a package is opaque
sqlite> SELECT * FROM blocked_packages;       -- who blocks whom
sqlite> SELECT * FROM repo_history;           -- which repos blame dated (full / shallow / none)

sqlite> SELECT * FROM promoted_packages;      -- example apps / benchmarks indexed as consumers, and why
sqlite> SELECT * FROM unindexed_loads WHERE resolved = 0;   -- aliases / globs that named no file
sqlite> SELECT * FROM private_dead_skipped;   -- packages with no private_dead rows, and why
```

`packages/core/sql/analyze.sql` (recreated on every `analyze`) defines the
views: `external_refs`, `internal_refs`, `test_only_refs`, `symbol_age_ok`,
`kept_symbols`, `reachable`, `verdict_blockers`, `verdicts`, `candidate_symbols`,
`reachable_after`, `candidate_reach`, `unreachable_before`, `private_dead`,
`private_dead_packages` (whose entry set is credible), `private_dead_skipped`, and
their helpers. `schema.sql` defines `private_packages`, `opaque_packages`
and `blocked_packages`. The `policy` table holds the policy in effect.

## SARIF upload

Each `work/sarif/<owner>__<repo>.sarif` is one Code Scanning upload: one rule
per [view](#views) (`sentei/delete` and `sentei/org-dead` at level `warning`, the
rest `note`), results for the selected views only (default: all but `org_dead`),
locations repo-relative. Every run declares every rule, lists its views in
`run.properties.views`, the policy in `run.properties.policy` and the assertions
they rely on in `run.properties.assertions` (`delete`'s with `closedOrg`, whose
published-package delete results also repeat it in their message). Fingerprints (`senteiSymbol/v1`) depend on the
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
