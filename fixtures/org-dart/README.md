# org-dart

Dart fixture org (`acme`) for M3, kept separate from `org-small` so the TypeScript
acceptance test is unaffected. Same layout and conventions as `org-small`
(see `../README.md`): `org.json`, `sentei.json` (`minAgeDays: 0`),
`repos/<name>/` as plain directories, one `// Expected:` comment per symbol, and
`expected-findings.json`, the exact base verdicts (the report views are filters
over them).

| Repo | Package | Visibility | Role |
| --- | --- | --- | --- |
| `dart-lib-x` | `acme_x` | private (`publish_to: none`) | lib: entry `lib/acme_x.dart` with `export`, `export ... show`, `part`; entries `lib/syntax.dart`, `lib/builder.dart` |
| `dart-lib-pub` | `acme_pub` | **published-public** (no `publish_to`) | lib with one unused export |
| `dart-app` | `acme_app` | private (`publish_to: none`) | consumer (`bin/main.dart`, `bin/shapes.dart`): `path:` dep on `acme_x`, hosted `^1.0.0` dep on `acme_pub`; `test/kit_test.dart` uses `acme_kit` (regular `path:` dep) |
| `dart-js` | `acme_js_app` (root) + npm `acme-js-src` (`js_src/`) | private | mixed repo: Dart `bin/main.dart` reads the JS bundle built from `js_src/` through `@JS('acmeBridge.start')`; no dependency either way |
| `dart-testkit` | `acme_kit` | private (`publish_to: none`) | test-support library: `lib/testing.dart` entry, `lib/src/test_utils/` |
| `flutter-widgets` | `acme_widgets` | private (`publish_to: none`) | Flutter lib (`environment.flutter`, `flutter: {sdk: flutter}`): `AcmeButton` (used), `AcmeBanner` (unused) |
| `flutter-app` | `acme_flutter_app` | private (`publish_to: none`) | Flutter app: `lib/main.dart` `main` calls `runApp` with an `AcmeButton`; `path:` dep on `acme_widgets` |
| `dart-workspace` | `acme_ws` (root), `acme_core`, `acme_tools` | private (`publish_to: none`) | pub workspace, members listed by path; `acme_tools` depends on its sibling `acme_core` and (hosted `^1.0.0`) on `acme_x` |

No `pubspec.lock` / `.dart_tool` is checked in. To build or index, copy the repos
somewhere else and run `dart pub get` in each package. `dart-app` depends on
`acme_pub` by a hosted constraint (`^1.0.0`, not on pub.dev), like real org repos
do. It resolves only when the indexer source-links it, e.g. with a
`pubspec_overrides.yaml` next to `dart-app/pubspec.yaml`:

```yaml
dependency_overrides:
  acme_pub:
    path: ../dart-lib-pub
```

This is the Dart equivalent of the npm `node_modules` symlinks. With it in place,
the three Dart packages pass `dart analyze` with no issues (Dart 3.11.3 and 3.13.4).
The two Flutter packages need `flutter pub get` instead (then `dart analyze` is
clean, Flutter 3.47.5). Without `flutter` on PATH the indexer reports them
`partial` and the tests that need them skip (see `packages/cli/test/index-dart.test.ts`).

Name hygiene for the §9 text witness: the consumer never names the would-be
deletion candidates, or the extension `IntTimes`. The extension is used only
through `3.doubled`, so the witness cannot hide a missing reference to it.

### §8 Dart checklist coverage

| §8 item | Where | Expected |
| --- | --- | --- |
| `import 'package:x/x.dart' show a;` / `hide` | `dart-app/bin/main.dart`: `show usedFn, Shown, implUsed, shownOnly` and `hide usedFn` | `shownOnly` (only named in `show`) alive: a shown name counts as a reference (fail closed) |
| `lib/x.dart` with `export 'src/impl.dart';` (surface follows the export) | `dart-lib-x/lib/acme_x.dart` → `lib/src/impl.dart` | `implUsed` alive; `implUnused` deletion_candidate |
| `export 'src/impl.dart' show Foo;` | `acme_x.dart`: `export 'src/shown.dart' show Shown;` | `Shown` alive; `Hidden` is not on the surface → private_dead `already_unreachable`, never a deletion_candidate |
| `part` / `part of` files | `acme_x.dart` `part 'src/part_a.dart'` | `partUsed` alive; `partUnused` deletion_candidate (on the surface although the file is under `lib/src/`) |
| Extension method usage (implicit) | `acme_x.dart` `extension IntTimes on int { get doubled }`, used as `3.doubled` | `IntTimes` and `doubled` alive |
| Unqualified use of an imported top-level function | `main.dart` `usedFn()` | `usedFn` alive |
| `_private` top-level in `lib/x.dart`, never exported | `acme_x.dart` `_privateFn` (used by `usedFn`), `_islandA`/`_islandB` (private cycle) | `_privateFn` no finding; `_islandA`/`_islandB` private_dead `already_unreachable` |
| `pubspec.yaml` `publish_to: none` | `acme_x`, `acme_app` (private) vs `acme_pub` (published-public) | `pub:acme_pub#pubUnused` deprecation_candidate `["no_refs"]` (witnessed; in the report's `deprecate` and `org_dead` views); the same symbol in a private package would be a deletion_candidate |
| Path dependency (`path: ../y`) resolves to an org package | `dart-app/pubspec.yaml` `acme_x: {path: ../dart-lib-x}` | discover resolves it to `pub:acme_x` (constraint `path:../dart-lib-x`); consumer refs link to acme_x's own symbols |

Also covered, beyond the checklist: a class used only through its implicit default
constructor (`Shown()`), and a hosted constraint on an org package (`acme_pub`)
that must be source-linked.

### Flutter

| Case | Where | Expected |
| --- | --- | --- |
| `package:flutter/material.dart` resolves (`flutter pub get`, the Flutter SDK's Dart SDK) | both Flutter packages | status `ok`, no analyzer errors; references into `pub flutter` symbols |
| Exported widget used by an org app | `acme_widgets` `AcmeButton`, built in `acme_flutter_app`'s `main` | no finding |
| Exported widget nobody uses | `acme_widgets` `AcmeBanner` | deletion_candidate `["no_refs"]` (closed and open world: private package) |
| `main` of `lib/main.dart` (run by the Flutter engine, referenced by nothing) | `flutter-app/lib/main.dart` | no finding (sidecar `entrySymbols`, `lib/*.dart` entry) |

### Symbol shapes and Dart entry conventions (first Workiva run)

| Case | Where | Expected |
| --- | --- | --- |
| `operator ==`, `operator []` (SCIP names must be backticked: `` Vec#`==`(). ``) | `dart-lib-x/lib/syntax.dart` `Vec`, used by `dart-app/bin/shapes.dart` | no finding (`Vec` is used; members live with it) |
| Unnamed extension (`extension on String`) | `lib/syntax.dart`, used by `labelOf` | no finding: it and its getter are `local` symbols |
| Generic function typedef with a type parameter and a named parameter | `lib/syntax.dart` `typedef Mapper = T Function<T>(T value, {int? times})`; a closure with a named parameter in `bin/shapes.dart` | `Mapper` alive (named by acme_app); `T`, `times` and the closure are `local` |
| Import prefix (`import 'src/shown.dart' as p;`) | `lib/syntax.dart` | no finding: the prefix is a `local` symbol, not a declaration |
| build.yaml `builder_factories` | `dart-lib-x/build.yaml` → `lib/builder.dart` `acmeBuilder` | no finding: exported but called by build_runner by name (sidecar `entrySymbols`) |
| dart_dev's `config` | `dart-lib-x/tool/dart_dev/config.dart` | no finding (sidecar `entrySymbols`) |
| `main` of a script outside `lib/` that is not a discover entry | `dart-lib-x/benchmark/bench.dart` (`main`, and `work` reached from it) | no finding (sidecar `entrySymbols`) |
| Export used only by its own package's `example/` (a docs file) | `dart-lib-pub/example/example.dart` calls `pubExampleOnly` | deprecation_candidate `["only_docs_refs"]` (not `no_refs`; the policy is unchanged) |
| Public function named only in a dartdoc link (`/// See [docOnly].` on `doubled`) | `dart-lib-x/lib/acme_x.dart` `docOnly` | deletion_candidate `["no_refs"]`: a doc link is not a reference (fork patch 4), so no occurrence and no `internal_refs_only` |

### Test-looking library code under lib/ (Phase 2 fix round 1)

Nothing under a pub package's `lib/` is a test, docs or script file (`SURFACE_DIRS`
in `packages/core/src/globs.ts`): it is importable as `package:acme_x/…`.

| Case | Where | Expected |
| --- | --- | --- |
| `lib/src/*_test.dart` that is not a test | `dart-lib-x/lib/src/wire_test.dart`, re-exported by the entry `lib/testing.dart` | `wireUnused` deletion_candidate `["no_refs"]`; `_wireIsland` private_dead `already_unreachable` (a test file's symbols never are) |
| Test-support code in `lib/mocks/` | `dart-lib-x/lib/mocks/fake_clock.dart` `FakeClock`, used by `dart-app/bin/clock.dart` | `FakeClock` alive; its use of `wireTick` counts, so `wireTick` is unexport_candidate `["internal_refs_only"]`, not `only_test_refs` |

### Test-support libraries (Phase 2 fix round 1)

A symbol in a test-support surface (analyze.sql `test_support_symbols`: exported
through an entry named `test` / `testing` / …, under `lib/src/test*/` and friends,
or in a package named like `*testkit`, `*_test`) counts other packages' test-file
uses as references, whatever the dependency kind.

| Case | Where | Expected |
| --- | --- | --- |
| Test-support entry used by another package's test through a regular dependency | `dart-testkit/lib/testing.dart` → `FakeServer`, used by `dart-app/test/kit_test.dart` | `FakeServer` alive |
| Test-support dir | `dart-testkit/lib/src/test_utils/matchers.dart` `isFake` (exported by the main library), used by the same test | alive |
| Normal library symbol used only by another package's test (negative) | `dart-testkit/lib/acme_kit.dart` `kitRealOnlyInTests` | deletion_candidate `["only_test_refs"]` |
| Test-support symbol used only by its own package's test | `dart-testkit/lib/src/fakes.dart` `ownTestOnlyFake` | deletion_candidate `["only_test_refs"]` |
| Test-support symbol used nowhere | `unusedFakeServer` | deletion_candidate `["no_refs"]` |

### Mixed repo: Dart reading a JS bundle of the same repo (Phase 2 fix round 1)

The witness scans the same-repo packages of the other manager (witness.ts
`crossHits`): any name of the symbol in a JS-interop Dart file, strings included,
so `@JS('acmeBridge.start')` names `acmeBridge` and `start`. It also re-checks
unexports of such packages, which analyze otherwise never sends to the witness.

| Case | Where | Expected |
| --- | --- | --- |
| npm export used only inside its package, read by Dart through `@JS('acmeBridge.start')` | `dart-js/js_src/src/index.ts` `acmeBridge` (the bundle's default export) | needs_review `["internal_refs_only", "witness_mismatch:pub:acme/dart-js:acme_js_app:bin/main.dart:8"]`, not unexport_candidate |
| npm export nothing in the index uses, bound by an `@JS()` declaration of the same name | `acmeLegacyStart` | needs_review `["no_refs", …main.dart:13, …main.dart:18]` |
| npm export no Dart file names (negative) | `jsOnlyUnused` | deletion_candidate `["no_refs"]` |

### Pub workspace (Phase 2 fix round 1)

`dart-workspace` is a pub workspace (root `workspace: [packages/acme_core,
packages/acme_tools]`, members `resolution: workspace`), like flame-engine's
flame, tiled.dart, gamepads and forge2d, and supabase-flutter.

| Case | Where | Expected |
| --- | --- | --- |
| Source links of a workspace | `acme_tools` depends on `acme_x` (hosted `^1.0.0`, another repo) and on its sibling `acme_core` | one `pubspec_overrides.yaml`, at the workspace root, linking `acme_x` only (pub refuses to override a workspace package: "Cannot override workspace packages."); one `pub get` at the root; every package `ok` |
| Members listed by path, not by glob | root `workspace:` list | `acme_core`'s `lib/` is indexed (fork patch 7: scip-dart used to index none of it); a package with `lib/` code and no `lib/` document would be `failed` |
| Name-based parts (`part of acme_core;`) in a dir that sorts before the library | `acme_core/lib/_parts/engine.dart` uses `_Helper` from `lib/_parts/helper.dart` | `_Helper` alive (fork patch 8: resolved alone, the part lost the reference and `_Helper` was private_dead) |
| Operators used without a name | `acme_tools` `a & b`, `a % 2`, `a[0]` (extension `Vec2Ops`); `acme_core` `v + d` (private extension `_Shift`) | `Vec2Ops` and `_Shift` alive (fork patch 9: no occurrence for an operator expression made `Vec2Ops` a deletion_candidate the witness could not catch, and `_Shift` private_dead) |
| One scip-dart run for the workspace | all three packages | each gets its own `.scip`, equal to a run on it alone (fork patch 6) |
