# org-dart

Dart fixture org (`acme`) for M3, kept separate from `org-small` so the TypeScript
acceptance test is unaffected. Same layout and conventions as `org-small`
(see `../README.md`): `org.json`, `sentei.json` (`assumeClosedWorld: true`,
`minAgeDays: 0`), `repos/<name>/` as plain directories, one `// Expected:` comment
per symbol, `expected-findings.json` (closed world, as checked in) and
`expected-findings.open-world.json` (same org with `assumeClosedWorld: false`).

| Repo | Package | Visibility | Role |
| --- | --- | --- | --- |
| `dart-lib-x` | `acme_x` | private (`publish_to: none`) | lib: entry `lib/acme_x.dart` with `export`, `export ... show`, `part` |
| `dart-lib-pub` | `acme_pub` | **published-public** (no `publish_to`) | lib with one unused export |
| `dart-app` | `acme_app` | private (`publish_to: none`) | consumer: `path:` dep on `acme_x`, hosted `^1.0.0` dep on `acme_pub` |

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
all three packages pass `dart analyze` with no issues (Dart 3.11.3).

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
| `pubspec.yaml` `publish_to: none` | `acme_x`, `acme_app` (private) vs `acme_pub` (published-public) | `pub:acme_pub#pubUnused` deletion_candidate in closed world, deprecation_candidate `["no_refs","open_world"]` in open world |
| Path dependency (`path: ../y`) resolves to an org package | `dart-app/pubspec.yaml` `acme_x: {path: ../dart-lib-x}` | discover resolves it to `pub:acme_x` (constraint `path:../dart-lib-x`); consumer refs link to acme_x's own symbols |

Also covered, beyond the checklist: a class used only through its implicit default
constructor (`Shown()`), and a hosted constraint on an org package (`acme_pub`)
that must be source-linked.
