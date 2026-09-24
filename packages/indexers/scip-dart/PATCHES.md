# Patches to scip-dart

Vendored from <https://github.com/Workiva/scip-dart> at tag `1.7.0`,
commit `8d017a25874efb8513617e85e508a573692cbb63` (Apache-2.0, see `LICENSE`).
sentei's adapter (`packages/cli/src/indexers/scip-dart.ts`) reports this copy as
`1.7.0+sentei.2` (sentei.2: dart-surface gained `entrySymbols`; the fork itself is unchanged): bump the `+sentei.N` patch level whenever this directory changes.

Kept from upstream: `bin/`, `lib/`, `pubspec.yaml`, `LICENSE`, `README.md`.
Dropped (not needed to run): tests/snapshots, `tool/`, CI config, `Makefile`,
`analysis_options.yaml`, `CHANGELOG.md`, `pubspec.lock` (pub resolves the same
versions as upstream's lock from the constraints; see the adapter).

Diffs are against the upstream commit, paths relative to this directory.

## 1. SDK floor 3.11 (`pubspec.yaml`)

scip-dart 1.7.0 requires Dart >= 3.12 but its only SDK-sensitive dependency,
`analyzer` ^14 (resolves to 14.4.0), needs only 3.11. Relaxing the floor gives
byte-identical `.scip` output on Dart 3.11.3 (checked on fixtures/org-dart during
the M3 evaluation). Upstreamable only if Workiva wants the wider range.

```diff
--- a/pubspec.yaml
+++ b/pubspec.yaml
@@ -4,7 +4,7 @@
 repository: https://github.com/Workiva/scip-dart
 
 environment:
-  sdk: ">=3.12.0 <4.0.0"
+  sdk: ">=3.11.0 <4.0.0"
 
 executables:
   scip_dart:
```

## 2. `--private-symbols`: global symbols for private declarations

Upstream gives every private (`_name`) declaration a `local N` symbol
(`if (element.isPrivate) return _localSymbolFor(element);` in
`symbol_generator.dart`). sentei needs global symbols for them: private
top-level declarations and members are exactly what the private-dead closure
reports (PLAN.md §6.3 step 6), and a `local` symbol is document-scoped, so a
private declaration used from a part file (a different document of the same
library) would not link. The flag defaults to off, so upstream behaviour is
unchanged unless asked for; sentei always passes `--private-symbols`. Local
functions stay `local` even with the flag: their descriptor
(`<file>/_name().`) has no enclosing scope and could collide with a top-level
declaration of the same name.

Private symbols are library-private, and the descriptor already includes the
declaring file, so two libraries' `_helper` never collide.

```diff
--- a/bin/scip_dart.dart
+++ b/bin/scip_dart.dart
@@ -37,6 +37,13 @@
               help: 'Whether or not to display debugging text during indexing',
             )
             ..addFlag(
+              'private-symbols',
+              defaultsTo: false,
+              help:
+                  'Emit global symbols for private (_name) declarations '
+                  'instead of local symbols',
+            )
+            ..addFlag(
               'version',
               defaultsTo: false,
               help: 'Display the current version of scip-dart',
--- a/lib/src/flags.dart
+++ b/lib/src/flags.dart
@@ -7,9 +7,15 @@
   bool get performance => _performance;
   bool _performance = false;
 
+  /// Emit global symbols for private (`_name`) declarations instead of
+  /// `local N` symbols, so private members are addressable across documents.
+  bool get privateSymbols => _privateSymbols;
+  bool _privateSymbols = false;
+
   void init(ArgResults results) {
     _verbose = results['verbose'] as bool? ?? false;
     _performance = results['performance'] as bool? ?? false;
+    _privateSymbols = results['private-symbols'] as bool? ?? false;
   }
 
   static Flags get instance => _instance;
--- a/lib/src/symbol_generator.dart
+++ b/lib/src/symbol_generator.dart
@@ -2,6 +2,7 @@
 import 'package:analyzer/dart/element/element.dart';
 import 'package:pubspec_parse/pubspec_parse.dart';
 import 'package:package_config/package_config.dart';
+import 'package:scip_dart/src/flags.dart';
 import 'package:scip_dart/src/package_version_cache.dart';
 import 'package:scip_dart/src/utils.dart';
 
@@ -137,7 +138,10 @@
       return _localSymbolFor(element);
     }
 
-    if (element.isPrivate) {
+    // Local functions stay local even with --private-symbols: their
+    // descriptor has no enclosing scope and could collide with a top-level.
+    if (element.isPrivate &&
+        (!Flags.instance.privateSymbols || element is LocalFunctionElement)) {
       return _localSymbolFor(element);
     }
 
```

## Trim: no dev dependencies (`pubspec.yaml`)

Not a behaviour change. The dev dependencies serve upstream's tests and CI,
which are not vendored; dropping them keeps `dart pub get` offline-capable with
fewer packages.

```diff
--- a/pubspec.yaml
+++ b/pubspec.yaml
@@ -18,9 +18,3 @@
   pubspec_parse: ^1.2.1
   pubspec_lock_parse: ^2.2.0
   collection: ^1.18.0
-
-dev_dependencies:
-  chalk: ^1.2.1
-  dart_dev: ^4.2.3
-  glob: ^2.1.1
-  workiva_analysis_options: ^1.4.3
```
