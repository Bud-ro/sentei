# Patches to scip-dart

Vendored from <https://github.com/Workiva/scip-dart> at tag `1.7.0`,
commit `8d017a25874efb8513617e85e508a573692cbb63` (Apache-2.0, see `LICENSE`).
sentei's adapter (`packages/cli/src/indexers/scip-dart.ts`) reports this copy as
`1.7.0+sentei.12` (sentei.2: dart-surface gained `entrySymbols`; sentei.3: the sidecar gained `shorthandRefs`; sentei.4: patch 3 below, manager-prefixed output file names, and dart-surface's Dart entry conventions; sentei.5: the adapter treats ignored nested manifests as not ours, and missing parts outside `lib/`/`bin/` no longer make a package partial; sentei.6: the adapter sets `entrySymbols[].kind` to `runtime`; sentei.7: patch 4 below, and dart-surface's `--pub-get-failed`; sentei.8: patch 5 below, dart-surface's `--sdk-path`/`--package-name`, and Flutter packages resolved with `flutter pub get`; sentei.9: patches 6 to 9 below, pub workspaces resolved once at the root, a package with `lib/` code but no `lib/` document fails, and dart-surface finds a re-exported `main`; sentei.10: patches 10 to 12 below, every public library under `lib/` is an entry point, dart-surface records the `main` of every library and the Flutter plugin classes named in pubspec.yaml; sentei.11: patch 13 below; sentei.12: patch 14 below, and the adapter's sidecar `generatedFiles`): bump the `+sentei.N` patch level whenever this directory or dart-surface changes output.

Kept from upstream: `bin/`, `lib/`, `pubspec.yaml`, `LICENSE`, `README.md`.
Dropped (not needed to run): tests/snapshots, `tool/`, CI config, `Makefile`,
`analysis_options.yaml`, `CHANGELOG.md`, and upstream's `pubspec.lock`. The
`pubspec.lock` here is sentei's own, resolved for the trimmed dependency set and
checked in so the analyzer version is pinned (docs/DESIGN.md, M3).

Diffs are against the upstream commit, paths relative to this directory.
Each modified file (`pubspec.yaml`, `bin/scip_dart.dart`, `lib/src/flags.dart`,
`lib/src/symbol_generator.dart`, `lib/src/scip_visitor.dart`,
`lib/src/indexer.dart`) also starts with a
one-line "Modified by sentei" notice (Apache-2.0 §4(b)) plus, in the Dart files,
a blank line after it; the diffs below leave that header out, so their new-side
line numbers are offset by it.

## 1. SDK floor 3.11 (`pubspec.yaml`)

scip-dart 1.7.0 requires Dart >= 3.12 but its only SDK-sensitive dependency,
`analyzer` ^14 (resolves to 14.4.0), needs only 3.11. Relaxing the floor gives
byte-identical `.scip` output on Dart 3.11.3 (checked on fixtures/org-dart during
the M3 evaluation). Upstreamable only if Workiva wants the wider range.

Still needed after the dev box moved to Dart 3.13.4: the floor is what users on
3.11 get. The checked-in `pubspec.lock` (analyzer 14.4.0, `_fe_analyzer_shared`
108.0.0) resolves unchanged on 3.13.4 (`dart pub get --enforce-lockfile`), 14.4.0
is still the newest analyzer on pub.dev, and its current language version is
3.14, so 3.12/3.13 syntax (private named parameters, primary constructors)
parses. fixtures/org-dart gives byte-identical `.scip` snapshots on 3.11.3 and
3.13.4.

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

## 3. Valid symbols always (`lib/src/symbol_generator.dart`)

Upstream interpolates element names into descriptors verbatim, so on the first
Workiva run (30 repos) it emitted symbols the SCIP grammar rejects, and one bad
symbol aborted ingest for the whole org:

- **Operator methods** unescaped: `ActionsClass#==().`, `CssValue#<=().`,
  `MapViewMixin#[]().` (~150 symbols in 10 packages; `[]` even parses as an
  empty name). The grammar's `<simple-identifier>` is `[A-Za-z0-9_+\-$]+`, so
  any other name must be an `<escaped-identifier>`: every name now goes through
  `_name`, which backtick-quotes it (doubling backticks) unless it is simple.
  `+`, `-` and `unary-` are simple and stay bare; `<get>x`/`<set>x` keep
  upstream's backticks (byte-identical for ordinary names).
- **Elements with no name** became the string `null`: unnamed extensions
  (`…/null#`) and their members (`…/null#capitalize().`, which also collided
  across extensions of one file), closures with named parameters
  (`…/null().(indent)`), and type parameters or named parameters whose
  enclosing element has no descriptor at all (`null[TValue]` for a generic
  function type's type parameter, `null(tags)`). An unnamed extension's
  top-level-looking getter even lost its owner (`…/\`<get>x\`.`, colliding with
  a real top-level getter). A missing or empty name, or an enclosing element
  without a descriptor, now throws `_NamelessElement` and `symbolFor` returns a
  `local N` symbol: nothing outside the document can name such an element
  (an unnamed extension is not importable), so a local is exact, and it is
  never a verdict subject.
- **Import prefixes** (`import 'x.dart' as $0;`) were global term symbols
  (`<file>/$0.`), defined by the directive and never exported, so the
  private-dead closure reported every prefix (130 rows in the Workiva run).
  A prefix is not a declaration of the library: it is now a `local N` symbol.

Upstreamable: all three are grammar/semantics bugs independent of sentei.
The diff is against the file with patch 2 applied.

```diff
--- a/lib/src/symbol_generator.dart
+++ b/lib/src/symbol_generator.dart
@@ -145,7 +145,23 @@
       return _localSymbolFor(element);
     }
 
-    final descriptor = _getDescriptor(element);
+    // Import prefixes (`import 'x.dart' as p;`) are not declarations of the
+    // library: a global `<file>/p.` symbol would be an addressable, never
+    // exported "declaration" that nothing outside the file can reference.
+    if (element is PrefixElement) {
+      return _localSymbolFor(element);
+    }
+
+    final String? descriptor;
+    try {
+      descriptor = _getDescriptor(element);
+    } on _NamelessElement {
+      // The element (or an element its descriptor is built from) has no name:
+      // an unnamed extension and its members, a closure, a type parameter or
+      // named parameter of a generic function type. No global symbol can
+      // address it, so it is document-local.
+      return _localSymbolFor(element);
+    }
     if (descriptor == null) return null;
 
     // Symbol Form: '<scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>'
@@ -244,34 +260,34 @@
     if (element is InterfaceElement || // class, mixin, enum, extension type
         element is TypeAliasElement ||
         element is ExtensionElement) {
-      return '$namespace/${element.name}#';
+      return '$namespace/${_name(element.name)}#';
     }
 
     if (element is ConstructorElement) {
-      final className = element.enclosingElement.name;
+      final className = _name(element.enclosingElement.name);
       final constructorName = element.name != null && element.name != 'new'
-          ? element.name
+          ? _name(element.name)
           : '`<constructor>`';
       return '$namespace/$className#$constructorName().';
     }
 
     if (element is MethodElement) {
-      final className = element.enclosingElement?.name;
-      return '$namespace/$className#${element.name}().';
+      final className = _name(element.enclosingElement?.name);
+      return '$namespace/$className#${_name(element.name)}().';
     }
 
     if (element is TopLevelFunctionElement || element is LocalFunctionElement) {
-      return '$namespace/${element.name}().';
+      return '$namespace/${_name(element.name)}().';
     }
 
-    if (element is TopLevelVariableElement || element is PrefixElement) {
-      return '$namespace/${element.name}.';
+    if (element is TopLevelVariableElement) {
+      return '$namespace/${_name(element.name)}.';
     }
 
     if (element is TypeParameterElement) {
       final encEle = element.enclosingElement;
-      if (encEle == null) return '$namespace/[${element.name}]';
-      return '${_getDescriptor(encEle)}[${element.name}]';
+      if (encEle == null) return '$namespace/[${_name(element.name)}]';
+      return '${_enclosingDescriptor(encEle)}[${_name(element.name)}]';
     }
 
     // only generate symbols for named parameters, all others are 'local x'
@@ -287,12 +303,12 @@
       // is not indexable, so do not generate a symbol for it
       if (encEle is GenericFunctionTypeElement) return null;
 
-      return '${_getDescriptor(encEle)}(${element.name})';
+      return '${_enclosingDescriptor(encEle)}(${_name(element.name)})';
     }
 
     if (element is PropertyAccessorElement) {
       final parent = element.enclosingElement;
-      final parentName = parent is LibraryElement ? null : parent.name;
+      final parentName = parent is LibraryElement ? null : _name(parent.name);
 
       var prefix = '';
       if (element is GetterElement) {
@@ -304,13 +320,13 @@
       return [
         '$namespace/',
         if (parentName != null) '$parentName#',
-        '`$prefix${element.variable.name}`.',
+        '${_escaped('$prefix${_name(element.variable.name, escape: false)}')}.',
       ].join();
     }
 
     if (element is FieldElement) {
       final encEle = element.enclosingElement;
-      return '${_getDescriptor(encEle)}${element.name}.';
+      return '${_enclosingDescriptor(encEle)}${_name(element.name)}.';
     }
 
     display(
@@ -323,6 +339,29 @@
     return null;
   }
 
+  /// The descriptor of an enclosing element. No descriptor (a generic function
+  /// type, a positional function-typed parameter, ...) means the nested
+  /// element cannot be addressed globally either: it becomes local.
+  String _enclosingDescriptor(Element encEle) {
+    final descriptor = _getDescriptor(encEle);
+    if (descriptor == null) throw const _NamelessElement();
+    return descriptor;
+  }
+
+  /// A descriptor name per the SCIP grammar: a simple identifier as is,
+  /// anything else (operators `==`, `[]=`, `<=`, `~/`, ...) backtick-escaped.
+  /// A missing or empty name has no global symbol ([_NamelessElement]).
+  String _name(String? name, {bool escape = true}) {
+    if (name == null || name.isEmpty) throw const _NamelessElement();
+    return escape ? _escaped(name) : name;
+  }
+
+  static final _simpleIdentifier = RegExp(r'^[A-Za-z0-9_+\-$]+$');
+
+  String _escaped(String name) => _simpleIdentifier.hasMatch(name)
+      ? name
+      : '`${name.replaceAll('`', '``')}`';
+
   String _localSymbolFor(Element ele) {
     _localElementRegistry.putIfAbsent(
       ele,
@@ -353,3 +392,10 @@
     }
   }
 }
+
+/// Thrown by [SymbolGenerator._getDescriptor] when a descriptor would need
+/// the name of an element that has none; [SymbolGenerator.symbolFor] then
+/// emits a `local N` symbol instead of a `null`-containing global one.
+class _NamelessElement implements Exception {
+  const _NamelessElement();
+}
```

## 4. Dartdoc links are not references (`lib/src/scip_visitor.dart`)

Upstream visits the `CommentReference` nodes of doc comments like code, so
`/// See [foo].` emits a reference occurrence for `foo`. A public declaration
named only in another declaration's dartdoc then looked used from its own
package (`internal_refs_only`) and became an unexport candidate instead of a
deletion candidate (19 rows on the Workiva run; opentracing's
`lib/src/ext/constants.dart` links its constants from each other's docs). A doc
link documents a symbol, it does not use it: deleting `foo` leaves a dangling
link (a dartdoc warning), not a compile error. The visitor now returns at a
`CommentReference` without descending, so it emits no occurrence for it or for
the identifiers inside it (`[Foo.bar]`, `[new Foo]`). `Comment` visits only its
references, so nothing else in a doc comment is affected.

Upstreamable as an option at most: code navigation wants doc links as
references, dead-code analysis does not.

```diff
--- a/lib/src/scip_visitor.dart
+++ b/lib/src/scip_visitor.dart
@@ -47,6 +47,10 @@
 
   @override
   void visitNode(AstNode node) {
+    // A dartdoc link (`/// See [foo].`) names a symbol but does not use it:
+    // no occurrence for it or anything inside it.
+    if (node is CommentReference) return;
+
     // [visitDeclaration] on the [GeneralizingAstVisitor] does not match parameters
     // even though the parameter node extends [Declaration]. This is a workaround
     // to correctly parse all [Declaration] ast nodes.
```

## 5. `--sdk-path`: the Dart SDK the analyzer uses (`bin/scip_dart.dart`, `lib/src/flags.dart`, `lib/src/indexer.dart`)

A Flutter package resolves `package:flutter` into the Flutter SDK
(`flutter pub get` writes a package config pointing at
`<flutterRoot>/packages/flutter` and `bin/cache/pkg/sky_engine`, whose
`_embedder.yaml` supplies `dart:ui`). The analyzer takes `dart:core` and friends
from the SDK running scip-dart; when that is not the Flutter SDK's own Dart SDK,
the framework is analyzed against the wrong core libraries. `--sdk-path` is
passed to `AnalysisContextCollection(sdkPath:)`; absent, upstream behaviour is
unchanged. sentei passes `--sdk-path <flutterRoot>/bin/cache/dart-sdk` for
Flutter packages (a no-op when `dart` on PATH is Flutter's). Upstreamable.

```diff
--- a/bin/scip_dart.dart
+++ b/bin/scip_dart.dart
@@ -44,6 +44,12 @@
                   'instead of local symbols',
             )
+            ..addOption(
+              'sdk-path',
+              help:
+                  'Dart SDK the analyzer resolves dart: libraries from '
+                  '(default: the SDK running scip-dart)',
+            )
             ..addFlag(
               'version',
--- a/lib/src/flags.dart
+++ b/lib/src/flags.dart
@@ -12,10 +12,16 @@
   bool get privateSymbols => _privateSymbols;
   bool _privateSymbols = false;
 
+  /// Dart SDK for the analyzer (`--sdk-path`), e.g. the Flutter SDK's
+  /// `bin/cache/dart-sdk`; null: the SDK running scip-dart.
+  String? get sdkPath => _sdkPath;
+  String? _sdkPath;
+
   void init(ArgResults results) {
     _verbose = results['verbose'] as bool? ?? false;
     _performance = results['performance'] as bool? ?? false;
     _privateSymbols = results['private-symbols'] as bool? ?? false;
+    _sdkPath = results['sdk-path'] as String?;
   }
--- a/lib/src/indexer.dart
+++ b/lib/src/indexer.dart
@@ -40,6 +40,7 @@
   final collection = AnalysisContextCollection(
     includedPaths: [...allPackageRoots, dirPath],
+    sdkPath: Flags.instance.sdkPath,
   );
```

## 6. Pub workspaces: one run for many packages (`bin/scip_dart.dart`, `lib/src/indexer.dart`)

In a pub workspace (root pubspec `workspace:`, members `resolution: workspace`)
pub resolves every member once, at the root. sentei ran scip-dart per member,
and each run built a full analysis context collection for the whole
workspace resolution: ~15 s per member, 9.5 min for the 37 packages of
flame-engine/flame. `--package <dir>=<output>` (repeatable) indexes several
packages in one process: the positional directory is then the workspace root
(its package config resolves every member), one `AnalysisContextCollection`
is built, and each package gets its own `Index`, written to its own output,
equal to what a run on that package alone produces: its documents are its own
files (nested packages excluded) relative to its own dir, file symbols carry
its own pubspec's name and version, `metadata.projectRoot` is its dir, and the
external symbols are those its documents reference. Resolved units are
dropped after each package; the element model is shared. flame: one run of
~40–65 s instead of ~9.5 min. A package's snapshot equals the one of a run
on it alone (a test checks fixtures/org-dart's acme_core; also checked on
flame-engine/tiled.dart), and the existing fixture snapshots are unchanged. Without `--package`, `indexPackage`
is `indexPackages` over one target. Documents are now sorted by path (upstream
used the analyzer's file order); the snapshots sort them anyway.

Upstreamable as a feature (monorepo indexing).

## 7. Every analysis context's files (`lib/src/indexer.dart`)

Upstream indexes `collection.contextFor(root).contextRoot.analyzedFiles()`.
The collection's included paths are the package root plus every package's
`lib/` from the package config, and for a workspace member listed by path in
the root pubspec (`workspace: [packages/tiled]`, as in flame-engine's
tiled.dart, gamepads and forge2d) the analyzer gives the member's `lib/` a
context of its own, while `contextFor(member)` returns the workspace root's
context, which excludes it: 0 `lib/` documents, status ok, every consumer
reference "version skew" (451 rows). Members matched by a glob
(`packages/**`) happened to work. The files to index are now the analyzed
Dart files of every context that overlaps a target package, filtered by the
package's dir (nested packages still excluded), and each file is resolved in
the context that analyzes it (`collection.contextFor(file)`). Verified with
analyzer 14.4 on tiled.dart: 0 → 28 `lib/` documents. The adapter also fails a
package whose index has no `lib/` document although `lib/` has Dart files.

Upstreamable: a correctness bug for any pub workspace listed by path.

Patches 6 and 7 in one diff (the second rewrites the loop the first
restructured):

```diff
--- a/bin/scip_dart.dart
+++ b/bin/scip_dart.dart
@@ -9,6 +9,7 @@ import 'package:package_config/package_config.dart';
 import 'package:pubspec_parse/pubspec_parse.dart';
 import 'package:path/path.dart' as p;
 import 'package:scip_dart/src/flags.dart';
+import 'package:scip_dart/src/indexer.dart' show PackageTarget, indexPackages;
 import 'package:scip_dart/src/pubspec_indexer.dart';
 import 'package:scip_dart/src/version.dart';
 
@@ -51,6 +52,14 @@ Future<void> main(List<String> args) async {
                   'Dart SDK the analyzer resolves dart: libraries from '
                   '(default: the SDK running scip-dart)',
             )
+            ..addMultiOption(
+              'package',
+              help:
+                  'Index several packages in one run, as <dir>=<output> '
+                  '(repeatable): the positional directory is then the pub '
+                  'workspace root whose package config resolves them all, and '
+                  'each package gets its own index, as if indexed alone',
+            )
             ..addFlag(
               'version',
               defaultsTo: false,
@@ -92,6 +101,38 @@ Future<void> main(List<String> args) async {
     exit(1);
   }
 
+  final packages = result['package'] as List<String>;
+  if (packages.isNotEmpty) {
+    if (result['index-pubspec'] as bool) {
+      stderr.writeln(
+        'ERROR: --index-pubspec cannot be combined with --package',
+      );
+      exit(64);
+    }
+    final targets = <PackageTarget>[];
+    final outputs = <PackageTarget, String>{};
+    for (final spec in packages) {
+      final eq = spec.indexOf('=');
+      if (eq <= 0 || eq == spec.length - 1) {
+        stderr.writeln('ERROR: --package expects <dir>=<output>, got "$spec"');
+        exit(64);
+      }
+      final dir = spec.substring(0, eq);
+      final file = File(p.join(dir, 'pubspec.yaml'));
+      if (!file.existsSync()) {
+        stderr.writeln('ERROR: Unable to locate pubspec.yaml in $dir');
+        exit(1);
+      }
+      final target = PackageTarget(dir, Pubspec.parse(file.readAsStringSync()));
+      targets.add(target);
+      outputs[target] = spec.substring(eq + 1);
+    }
+    await indexPackages(packageRoot, packageConfig, targets, (target, index) {
+      File(outputs[target]!).writeAsBytesSync(index.writeToBuffer());
+    });
+    return;
+  }
+
   final pubspecFile = File(p.join(packageRoot, 'pubspec.yaml'));
   if (!pubspecFile.existsSync()) {
     stderr.writeln('ERROR: Unable to locate pubspec.yaml');
--- a/lib/src/indexer.dart
+++ b/lib/src/indexer.dart
@@ -12,93 +12,159 @@ import 'package:scip_dart/src/scip_visitor.dart';
 import 'package:scip_dart/src/utils.dart';
 import 'package:scip_dart/src/version.dart';
 
+/// One package to index: its documents are relative to [root], its file
+/// symbols carry [pubspec]'s name and version.
+class PackageTarget {
+  final String root;
+  final Pubspec pubspec;
+  PackageTarget(this.root, this.pubspec);
+}
+
 Future<Index> indexPackage(
   String root,
   PackageConfig packageConfig,
   Pubspec pubspec,
 ) async {
-  final dirPath = p.normalize(p.absolute(root));
-
-  final metadata = Metadata(
-    projectRoot: Uri.file(dirPath).toString(),
-    textDocumentEncoding: TextEncoding.UTF8,
-    toolInfo: ToolInfo(
-      name: 'scip-dart',
-      version: scipDartVersion,
-      arguments: [],
-    ),
-  );
+  late Index index;
+  await indexPackages(root, packageConfig, [
+    PackageTarget(root, pubspec),
+  ], (_, i) => index = i);
+  return index;
+}
+
+/// Indexes every package of [targets] with one analysis context collection
+/// rooted at [collectionRoot] (a pub workspace root, whose package config
+/// resolves every member), calling [onIndex] once per target, in order, with
+/// an index equal to what [indexPackage] on that target alone produces: its
+/// documents are the target's own files (nested packages excluded), relative
+/// to the target's root. The element model is shared; resolved units are
+/// dropped after each target.
+Future<void> indexPackages(
+  String collectionRoot,
+  PackageConfig packageConfig,
+  List<PackageTarget> targets,
+  void Function(PackageTarget target, Index index) onIndex,
+) async {
+  final rootPath = p.normalize(p.absolute(collectionRoot));
 
   final allPackageRoots = packageConfig.packages
       .map((package) => p.normalize(package.packageUriRoot.toFilePath()))
       .toList();
 
-  final nestedPackages = (await pubspecPathsFor(root))
-      .map((path) => p.dirname(path))
-      .where((path) => path != root)
-      .toList();
-
-  if (Flags.instance.verbose) print('Ignoring subdirectories: $nestedPackages');
+  final targetRoots = [
+    for (final t in targets) p.normalize(p.absolute(t.root)),
+  ];
 
   final collection = AnalysisContextCollection(
-    includedPaths: [...allPackageRoots, dirPath],
+    includedPaths: {...allPackageRoots, rootPath, ...targetRoots}.toList(),
     sdkPath: Flags.instance.sdkPath,
   );
 
-  if (Flags.instance.performance) print('Analyzing Source');
-  final st = Stopwatch()..start();
-
-  final context = collection.contextFor(dirPath);
-  final resolvedUnitFutures = context.contextRoot
-      .analyzedFiles()
-      .where((file) => p.extension(file) == '.dart')
-      // only index dart files of the current dart package, to index nested
-      // packages, scip indexing can simply be re-run for that nested package
-      .where(
-        (file) => !nestedPackages.any(
-          (nested) => p.isWithin(p.normalize(p.absolute(nested)), file),
+  // Every analyzed Dart file of every context that overlaps a target. A
+  // package's `lib/` is also in [allPackageRoots], and the analyzer may give
+  // it a context of its own (a pub workspace member listed by path, e.g.
+  // `workspace: [packages/x]`), so the context `contextFor(root)` returns
+  // need not analyze it.
+  bool overlaps(String contextRoot) => targetRoots.any(
+    (t) =>
+        t == contextRoot ||
+        p.isWithin(contextRoot, t) ||
+        p.isWithin(t, contextRoot),
+  );
+  final analyzedFiles = <String>{
+    for (final context in collection.contexts)
+      if (overlaps(p.normalize(context.contextRoot.root.path)))
+        ...context.contextRoot.analyzedFiles().where(
+          (file) => p.extension(file) == '.dart',
         ),
-      )
-      .map(context.currentSession.getResolvedUnit);
-
-  final resolvedUnits = await Future.wait(resolvedUnitFutures);
-
-  if (Flags.instance.performance) {
-    print('Analyzing Source took: ${st.elapsedMilliseconds}ms');
-    st.reset();
-    print('Parsing Ast');
-  }
-
-  final documents = resolvedUnits.whereType<ResolvedUnitResult>().map((
-    resUnit,
-  ) {
-    final relativePath = p.relative(resUnit.path, from: dirPath);
-
-    final visitor = ScipVisitor(
-      relativePath,
-      dirPath,
-      resUnit.lineInfo,
-      resUnit.diagnostics,
-      packageConfig,
-      pubspec,
+  };
+
+  for (var i = 0; i < targets.length; i++) {
+    final target = targets[i];
+    final dirPath = targetRoots[i];
+
+    final metadata = Metadata(
+      projectRoot: Uri.file(dirPath).toString(),
+      textDocumentEncoding: TextEncoding.UTF8,
+      toolInfo: ToolInfo(
+        name: 'scip-dart',
+        version: scipDartVersion,
+        arguments: [],
+      ),
     );
-    resUnit.unit.accept(visitor);
 
-    return Document(
-      language: Language.Dart.name,
-      relativePath: relativePath,
-      occurrences: visitor.occurrences,
-      symbols: visitor.symbols,
+    final nestedPackages = (await pubspecPathsFor(dirPath))
+        .map((path) => p.normalize(p.absolute(p.dirname(path))))
+        .where((path) => path != dirPath)
+        .toList();
+
+    if (Flags.instance.verbose) {
+      print('Ignoring subdirectories: $nestedPackages');
+    }
+
+    if (Flags.instance.performance) print('Analyzing Source ($dirPath)');
+    final st = Stopwatch()..start();
+
+    // only index dart files of the current dart package, to index nested
+    // packages, scip indexing can simply be re-run for that nested package
+    final files =
+        analyzedFiles
+            .where((file) => p.isWithin(dirPath, file))
+            .where(
+              (file) =>
+                  !nestedPackages.any((nested) => p.isWithin(nested, file)),
+            )
+            .toList()
+          ..sort();
+
+    final resolvedUnits = await Future.wait(
+      files.map(
+        (file) =>
+            collection.contextFor(file).currentSession.getResolvedUnit(file),
+      ),
     );
-  }).toList();
 
-  if (Flags.instance.performance) {
-    print('Parsing Ast took: ${st.elapsedMilliseconds}ms');
+    if (Flags.instance.performance) {
+      print('Analyzing Source took: ${st.elapsedMilliseconds}ms');
+      st.reset();
+      print('Parsing Ast');
+    }
+
+    globalExternalSymbols = [];
+    final documents = resolvedUnits.whereType<ResolvedUnitResult>().map((
+      resUnit,
+    ) {
+      final relativePath = p.relative(resUnit.path, from: dirPath);
+
+      final visitor = ScipVisitor(
+        relativePath,
+        dirPath,
+        resUnit.lineInfo,
+        resUnit.diagnostics,
+        packageConfig,
+        target.pubspec,
+      );
+      resUnit.unit.accept(visitor);
+
+      return Document(
+        language: Language.Dart.name,
+        relativePath: relativePath,
+        occurrences: visitor.occurrences,
+        symbols: visitor.symbols,
+      );
+    }).toList();
+
+    if (Flags.instance.performance) {
+      print('Parsing Ast took: ${st.elapsedMilliseconds}ms');
+    }
+
+    onIndex(
+      target,
+      Index(
+        metadata: metadata,
+        documents: documents,
+        externalSymbols: globalExternalSymbols,
+      ),
+    );
   }
-
-  return Index(
-    metadata: metadata,
-    documents: documents,
-    externalSymbols: globalExternalSymbols,
-  );
 }
```

## 8. Resolve by library, so parts see their library (`lib/src/indexer.dart`)

Upstream resolves every file with `getResolvedUnit`, all in parallel. For a
part, the analyzer must find its library first; for a name-based
`part of foo;` it can only find a library it already knows, so whether a part
was resolved in its library depended on request order. When the part came
first it was resolved alone ("Undefined class", `InvalidType`), and every
reference from it into the library's other files was lost: flame-engine/oxygen
(`part of oxygen;` everywhere) had no reference from `EntityManager` to
`ComponentManager` members and got 6 false DEPRECATE rows (fail-open).
Patch 6's sorted file order happened to put oxygen's library first; a part
directory that sorts before the library (`lib/_parts/` in fixtures/org-dart)
still lost them. Files are now resolved library by library: each library
file with `getResolvedLibrary`, whose units include its parts (URI-based or
name-based alike); a file no indexed library includes (a part of an outside
library, an orphan part) falls back to `getResolvedLibraryContaining`, then to
`getResolvedUnit`. Documents are unchanged otherwise (fixture snapshots
identical except the name-based parts' recovered references). Cost: about
15-20% more CPU on flame than per-file resolution under the same load
(analyzer 14.4), for a result that no longer depends on scheduling.

Upstreamable: a correctness bug for any library with name-based parts.

```diff
--- a/lib/src/indexer.dart
+++ b/lib/src/indexer.dart
@@ -117,12 +117,7 @@ Future<void> indexPackages(
             .toList()
           ..sort();
 
-    final resolvedUnits = await Future.wait(
-      files.map(
-        (file) =>
-            collection.contextFor(file).currentSession.getResolvedUnit(file),
-      ),
-    );
+    final resolvedUnits = await _resolveByLibrary(collection, files);
 
     if (Flags.instance.performance) {
       print('Analyzing Source took: ${st.elapsedMilliseconds}ms');
@@ -168,3 +163,54 @@ Future<void> indexPackages(
     );
   }
 }
+
+/// Resolves [files] library by library, in [files] order: each library file
+/// with `getResolvedLibrary`, whose units include its parts, so a part is
+/// always analysed in its library's context. Resolving a part on its own
+/// (`getResolvedUnit`, in parallel with everything else) only works when the
+/// analyzer can find its library from the part: for a name-based
+/// `part of foo;` it often cannot, and the part then resolves without its
+/// library ("Undefined class", `InvalidType`), losing every reference between
+/// the library's files. A file no library of [files] includes (a part of an
+/// outside library, an orphan part) falls back to the library containing it,
+/// then to resolving it alone.
+Future<List<ResolvedUnitResult>> _resolveByLibrary(
+  AnalysisContextCollection collection,
+  List<String> files,
+) async {
+  final wanted = files.toSet();
+  final units = <String, ResolvedUnitResult>{};
+  void take(SomeResolvedLibraryResult result) {
+    if (result is! ResolvedLibraryResult) return;
+    for (final unit in result.units) {
+      if (wanted.contains(unit.path)) units.putIfAbsent(unit.path, () => unit);
+    }
+  }
+
+  await Future.wait(
+    files.map((file) async {
+      final session = collection.contextFor(file).currentSession;
+      final kind = session.getFile(file);
+      if (kind is FileResult && kind.isLibrary) {
+        take(await session.getResolvedLibrary(file));
+      }
+    }),
+  );
+  final leftover = files.where((file) => !units.containsKey(file)).toList();
+  if (Flags.instance.performance && leftover.isNotEmpty) {
+    print('Resolving ${leftover.length} file(s) outside the indexed libraries');
+  }
+  await Future.wait(
+    leftover.map((file) async {
+      final session = collection.contextFor(file).currentSession;
+      take(await session.getResolvedLibraryContaining(file));
+      if (units.containsKey(file)) return;
+      final unit = await session.getResolvedUnit(file);
+      if (unit is ResolvedUnitResult) units[file] = unit;
+    }),
+  );
+  return [
+    for (final file in files)
+      if (units[file] case final unit?) unit,
+  ];
+}
```

## 9. Operator expressions are references (`lib/src/scip_visitor.dart`)

The visitor emitted references for declarations, identifiers, named types,
import prefixes and named arguments only. An operator expression names
nothing: `a + b` calls `+` of `a`'s type (or of an extension on it) without
an identifier, so no occurrence pointed at the operator and an operator used
only so looked unused, together with its extension: `sokobros/BlockOperators`
(`+` used in `turn_manager.dart`) came out private_dead, flame's
`Vector2Extension` `&`/`%` and `QuaternionExtension` `/` had no reference. Now
a reference occurrence is emitted at the operator token for the element the
analyzer resolved: `BinaryExpression` (`a + b`, `a == b`; `a != b` resolves to
`==`), `PrefixExpression` (`-a` is `unary-`, `~a`, `++a` is `+`),
`PostfixExpression` (`a++`), compound `AssignmentExpression` (`a += b`), and
`IndexExpression` at its `[`: `a[i]` reads `[]`, `a[i] = v` writes `[]=`
(the assignment carries it as its write element; the index expression has
none then), `a[i] += v` / `a[i]++` both. `!a`, `a!`, `&&`, `||`, `??` and plain
`=` resolve to no element and emit nothing. Operators declared in `dart:`
libraries (`int +`, `Object ==`) are skipped: they are never an org package's
code and are on nearly every line.

Upstreamable (the SDK skip as an option): code navigation wants operator
references too.

```diff
--- a/lib/src/scip_visitor.dart
+++ b/lib/src/scip_visitor.dart
@@ -68,11 +68,87 @@ class ScipVisitor extends GeneralizingAstVisitor {
       _visitImportPrefixReference(node);
     } else if (node is NamedArgument) {
       _visitNamedArgument(node);
+    } else if (node is BinaryExpression) {
+      // `a + b`, `a == b`, `a != b` (resolves to `==`), `a & b`, ...
+      _visitOperator(
+        node,
+        node.element,
+        node.operator.offset,
+        node.operator.length,
+      );
+    } else if (node is PrefixExpression) {
+      // `-a` (`unary-`), `~a`, `++a` (`+`); `!a` has no element.
+      _visitOperator(
+        node,
+        node.element,
+        node.operator.offset,
+        node.operator.length,
+      );
+    } else if (node is PostfixExpression) {
+      // `a++` (`+`); `a!` has no element.
+      _visitOperator(
+        node,
+        node.element,
+        node.operator.offset,
+        node.operator.length,
+      );
+    } else if (node is AssignmentExpression) {
+      // `a += b` (`+`); a plain `=` has no element.
+      _visitOperator(
+        node,
+        node.element,
+        node.operator.offset,
+        node.operator.length,
+      );
+    } else if (node is IndexExpression) {
+      _visitIndexExpression(node);
     }
 
     super.visitNode(node);
   }
 
+  /// A user-defined operator applied by an expression: a reference at the
+  /// operator token. Nothing names the operator (or its extension), so
+  /// without this `a + b` kept no member of `a`'s type (or extension) alive.
+  /// Operators of `dart:` libraries (`int +`, `Object ==`) are skipped: they
+  /// are never an org package's code and are on nearly every line.
+  void _visitOperator(AstNode node, Element? element, int offset, int length) {
+    if (element == null || element.source == null) return;
+    if (element.library?.isInSdk == true) return;
+    _registerAsReference(element, node, offset: offset, length: length);
+  }
+
+  /// `a[i]` references `[]`; as an assignment target (`a[i] = v`) `[]=`, and
+  /// both when compound (`a[i] += v`, `a[i]++`): the assignment carries them
+  /// as its read and write elements, the index expression has none then.
+  /// The reference is at the `[` token.
+  void _visitIndexExpression(IndexExpression node) {
+    final parent = node.parent;
+    final bracket = node.leftBracket;
+    if (parent is CompoundAssignmentExpression &&
+        _assignmentTarget(parent) == node) {
+      _visitOperator(node, parent.readElement, bracket.offset, bracket.length);
+      if (parent.writeElement != parent.readElement) {
+        _visitOperator(
+          node,
+          parent.writeElement,
+          bracket.offset,
+          bracket.length,
+        );
+      }
+      return;
+    }
+    _visitOperator(node, node.element, bracket.offset, bracket.length);
+  }
+
+  static Expression? _assignmentTarget(CompoundAssignmentExpression e) =>
+      switch (e) {
+        AssignmentExpression a => a.leftHandSide,
+        PrefixExpression p => p.operand,
+        PostfixExpression p => p.operand,
+        _ => null,
+      };
+
   void _visitDeclaration(Declaration node) {
     final element = _symbolGenerator.elementFor(node);
     if (element == null) return;
```

## 10. Files the analyzer excludes are indexed too (`lib/src/indexer.dart`)

Upstream (and patch 7) index `contextRoot.analyzedFiles()`, which honours
`analyzer: exclude:` in `analysis_options.yaml`. Packages exclude generated
bindings and test fixtures from analysis (dart-lang: cronet_http
`lib/src/jni/jni_bindings.dart`, dwds `test/integration/fixtures/context.dart`,
199 files in ok packages): those files were silently not indexed, and every
reference in them vanished (fail-open: what only they use looked dead, and
consumer references to their declarations looked like version skew). Every
`.dart` file under the package's conventional dirs (`lib`, `bin`, `test`,
`example`, `tool`, `benchmark`, `web`, `integration_test`, `test_driver`;
dot dirs, `build/` dirs, symlinked dirs and nested packages skipped) is now
indexed as well. A file no context analyzes is resolved in the context with
the deepest root containing it (`contextFor` throws for an excluded file;
the context's session resolves any file of its root on request, verified
with analyzer 14.4: an excluded library resolves with its imports and its
references are the same as when it is not excluded).

For the caller, scip-dart writes one line per package to stderr when it
indexed such files or could not resolve some file:
`sentei-scip-dart: {"package": <abs dir>, "excludedIndexed": [...], "unresolved": [...]}`
(package-relative POSIX paths). The adapter reports the first as an `info:`
diagnostic and makes the package `partial` for the second (a file whose
references are unknown: fail closed). Nothing is written when nothing is
excluded, so the output of other packages is unchanged. dart-surface lists
the same files for its per-file checks (`main`, directives).

Upstreamable behind a flag (an indexer that follows the analyzer's excludes
is a legitimate choice for IDE-like use; a dead-code tool must not).

Diff against the state after patch 9:

```diff
--- a/lib/src/indexer.dart
+++ b/lib/src/indexer.dart
@@ -1,5 +1,9 @@
 // Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.
 
+import 'dart:convert';
+import 'dart:io';
+
+import 'package:analyzer/dart/analysis/analysis_context.dart';
 import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
 import 'package:analyzer/dart/analysis/results.dart';
 import 'package:path/path.dart' as p;
@@ -107,17 +111,41 @@ Future<void> indexPackages(
 
     // only index dart files of the current dart package, to index nested
     // packages, scip indexing can simply be re-run for that nested package
-    final files =
-        analyzedFiles
-            .where((file) => p.isWithin(dirPath, file))
-            .where(
-              (file) =>
-                  !nestedPackages.any((nested) => p.isWithin(nested, file)),
-            )
-            .toList()
-          ..sort();
+    final analyzed = analyzedFiles
+        .where((file) => p.isWithin(dirPath, file))
+        .where(
+          (file) => !nestedPackages.any((nested) => p.isWithin(nested, file)),
+        )
+        .toSet();
+    // Files the analyzer skips (`analyzer: exclude:` in analysis_options.yaml)
+    // are still code of the package: generated bindings, test fixtures. Their
+    // references must not vanish, so every Dart file of the package's
+    // conventional dirs is indexed, excluded or not (sentei patch 10).
+    final extra = conventionDartFiles(dirPath, nestedPackages)
+        .where((file) => !analyzed.contains(file))
+        .toSet();
+    final files = [...analyzed, ...extra]..sort();
 
     final resolvedUnits = await _resolveByLibrary(collection, files);
+    final resolvedPaths = {for (final unit in resolvedUnits) unit.path};
+    final unresolved = files.where((f) => !resolvedPaths.contains(f)).toList();
+    if (extra.isNotEmpty || unresolved.isNotEmpty) {
+      // One machine-readable line per package for the caller (sentei's
+      // adapter): files indexed beyond the analyzer's analyzedFiles(), and
+      // files that could not be resolved (their references are unknown).
+      stderr.writeln(
+        'sentei-scip-dart: ${jsonEncode({
+          'package': dirPath,
+          'excludedIndexed': [
+            for (final f in extra)
+              if (resolvedPaths.contains(f)) p.posix.joinAll(p.split(p.relative(f, from: dirPath))),
+          ]..sort(),
+          'unresolved': [
+            for (final f in unresolved) p.posix.joinAll(p.split(p.relative(f, from: dirPath))),
+          ]..sort(),
+        })}',
+      );
+    }
 
     if (Flags.instance.performance) {
       print('Analyzing Source took: ${st.elapsedMilliseconds}ms');
@@ -164,6 +192,73 @@ Future<void> indexPackages(
   }
 }
 
+/// Top-level dirs of a pub package whose Dart files are always indexed,
+/// whatever the analyzer excludes.
+const conventionDirs = [
+  'lib',
+  'bin',
+  'test',
+  'example',
+  'tool',
+  'benchmark',
+  'web',
+  'integration_test',
+  'test_driver',
+];
+
+/// Every `.dart` file under [dirPath]'s [conventionDirs], absolute and
+/// normalized, except in dot dirs, `build/` dirs, symlinked dirs and
+/// [nestedPackages].
+List<String> conventionDartFiles(String dirPath, List<String> nestedPackages) {
+  final out = <String>[];
+  void walk(Directory dir) {
+    final path = p.normalize(dir.path);
+    if (nestedPackages.any((n) => n == path || p.isWithin(n, path))) return;
+    final List<FileSystemEntity> entries;
+    try {
+      entries = dir.listSync(followLinks: false);
+    } on FileSystemException {
+      return;
+    }
+    for (final e in entries) {
+      final name = p.basename(e.path);
+      if (e is Directory) {
+        if (name.startsWith('.') || name == 'build') continue;
+        walk(e);
+      } else if (name.endsWith('.dart') &&
+          (e is File || (e is Link && File(e.path).existsSync()))) {
+        out.add(p.normalize(e.path));
+      }
+    }
+  }
+
+  for (final d in conventionDirs) {
+    final dir = Directory(p.join(dirPath, d));
+    if (dir.existsSync()) walk(dir);
+  }
+  return out;
+}
+
+/// The context that analyzes [file], or, for a file no context analyzes
+/// (excluded by analysis_options.yaml), the context with the deepest root
+/// containing it: the analyzer resolves any file of its root on request.
+/// Null when no context root contains the file (it is then left unresolved).
+AnalysisContext? _contextFor(AnalysisContextCollection collection, String file) {
+  try {
+    return collection.contextFor(file);
+  } on StateError {
+    AnalysisContext? best;
+    for (final c in collection.contexts) {
+      final root = p.normalize(c.contextRoot.root.path);
+      if (root != file && !p.isWithin(root, file)) continue;
+      if (best == null || root.length > best.contextRoot.root.path.length) {
+        best = c;
+      }
+    }
+    return best;
+  }
+}
+
 /// Resolves [files] library by library, in [files] order: each library file
 /// with `getResolvedLibrary`, whose units include its parts, so a part is
 /// always analysed in its library's context. Resolving a part on its own
@@ -189,7 +284,8 @@ Future<List<ResolvedUnitResult>> _resolveByLibrary(
 
   await Future.wait(
     files.map((file) async {
-      final session = collection.contextFor(file).currentSession;
+      final session = _contextFor(collection, file)?.currentSession;
+      if (session == null) return;
       final kind = session.getFile(file);
       if (kind is FileResult && kind.isLibrary) {
         take(await session.getResolvedLibrary(file));
@@ -202,7 +298,8 @@ Future<List<ResolvedUnitResult>> _resolveByLibrary(
   }
   await Future.wait(
     leftover.map((file) async {
-      final session = collection.contextFor(file).currentSession;
+      final session = _contextFor(collection, file)?.currentSession;
+      if (session == null) return;
       take(await session.getResolvedLibraryContaining(file));
       if (units.containsKey(file)) return;
       final unit = await session.getResolvedUnit(file);
```

## 11. A file outside the package config gets its enclosing package (`lib/src/symbol_generator.dart`)

A relative import can reach a file that no package of the package config
contains: dart-lang/native's `pkgs/jnigen/android_test_runner` (its own
package, nested in jnigen) imports
`../../test/jackson_core_test/runtime_test_registrant.dart` of jnigen, which
is not one of its dependencies. Upstream threw for any element declared
there ("Could not find package for …. Have you run pub get?",
`symbol_generator.dart:252`), scip-dart exited 255 and the package was
`failed`. Now the package of such a file is the one of the nearest
enclosing `pubspec.yaml` (name from it, version from it as for any
package), so the symbol is exactly the one that package's own index
defines and the reference links (verified on a copy of the native clone:
exit 0, the three `registerTests()` references carry
`scip-dart pub jnigen 1.0.1-wip test/…/registerTests().`, the symbol jnigen's
index defines). With no enclosing pubspec either, the element gets a
`local N` symbol (nothing could define it globally). Each such file is
logged once on stderr (`WARN: <path> is in no package of the package
config; …`, printed whatever `--verbose` says); the adapter lists them in an
`info:` diagnostic. Fail closed: the reference now links where it used to
kill the whole index.

Upstreamable: a crash on valid code.

```diff
--- a/lib/src/symbol_generator.dart
+++ b/lib/src/symbol_generator.dart
@@ -1,7 +1,10 @@
 // Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.
 
+import 'dart:io';
+
 import 'package:analyzer/dart/ast/ast.dart';
 import 'package:analyzer/dart/element/element.dart';
+import 'package:path/path.dart' as p;
 import 'package:pubspec_parse/pubspec_parse.dart';
 import 'package:package_config/package_config.dart';
 import 'package:scip_dart/src/flags.dart';
@@ -163,6 +166,10 @@ class SymbolGenerator {
       // named parameter of a generic function type. No global symbol can
       // address it, so it is document-local.
       return _localSymbolFor(element);
+    } on _NoPackage {
+      // Declared in a file that belongs to no pub package at all: no global
+      // symbol could match its definition anywhere, so it is document-local.
+      return _localSymbolFor(element);
     }
     if (descriptor == null) return null;
 
@@ -170,6 +177,57 @@ class SymbolGenerator {
     return ['scip-dart', _getPackage(element), descriptor].join(' ');
   }
 
+  /// The pub package declaring [sourcePath], as `(name, root)` with `root`
+  /// the package dir ending in a separator: its package in the package
+  /// config, else (sentei patch 11) the package of the nearest enclosing
+  /// `pubspec.yaml`. A file outside every package of the package config is
+  /// reachable by a relative import: dart-lang/native's
+  /// jnigen/android_test_runner imports `../../test/.../x.dart` of jnigen,
+  /// which is not one of its dependencies, and upstream threw ("Could not
+  /// find package for ..."), failing the whole package. With its own
+  /// package's name and version the symbol is the one that package's index
+  /// defines, so the reference links. Null (no pubspec either): [_NoPackage].
+  ({String name, String root})? _packageOf(String sourcePath) {
+    final package = _packageConfig.packageOf(Uri.file(sourcePath));
+    if (package != null) {
+      return (name: package.name, root: package.root.toFilePath());
+    }
+    final found = _enclosingPubspec(p.dirname(p.normalize(sourcePath)));
+    if (_reportedOutside.add(sourcePath)) {
+      stderr.writeln(
+        'WARN: $sourcePath is in no package of the package config; '
+        '${found == null ? 'no enclosing pubspec.yaml either: its symbols are local' : 'symbols use the enclosing package ${found.name} at ${found.root}'}',
+      );
+    }
+    return found;
+  }
+
+  /// Files [_packageOf] warned about (once each).
+  static final _reportedOutside = <String>{};
+
+  /// Nearest `pubspec.yaml` at or above [dir] with a name, by dir (cached).
+  static final _pubspecAbove = <String, ({String name, String root})?>{};
+
+  static ({String name, String root})? _enclosingPubspec(String dir) {
+    if (_pubspecAbove.containsKey(dir)) return _pubspecAbove[dir];
+    ({String name, String root})? found;
+    final file = File(p.join(dir, 'pubspec.yaml'));
+    if (file.existsSync()) {
+      try {
+        final name = Pubspec.parse(file.readAsStringSync()).name;
+        found = (name: name, root: dir.endsWith(p.separator) ? dir : '$dir${p.separator}');
+      } on Object {
+        found = null;
+      }
+    }
+    if (found == null) {
+      final parent = p.dirname(dir);
+      found = parent == dir ? null : _enclosingPubspec(parent);
+    }
+    _pubspecAbove[dir] = found;
+    return found;
+  }
+
   String fileSymbolFor(String path) {
     return [
       'scip-dart',
@@ -199,18 +257,13 @@ class SymbolGenerator {
       return 'pub $packageName $packageVersion';
     }
 
-    final package = _packageConfig.packageOf(
-      Uri.file(element.source!.fullName),
-    );
-    if (package == null) {
-      // this should only happen if the source references a package that is not defined
-      // in the pubspec (as a main or transitive dep)
-      throw Exception('Unable to find package within packageConfig');
-    }
+    // Not in the package config: the nearest enclosing pubspec's package
+    // (patch 11). [_getDescriptor] ran first and threw [_NoPackage] when
+    // there is none, so the element is local and never gets here.
+    final package = _packageOf(element.source!.fullName);
+    if (package == null) throw const _NoPackage();
 
-    final packageVersion = PackageVersionCache.versionFor(
-      package.root.toFilePath(),
-    );
+    final packageVersion = PackageVersionCache.versionFor(package.root);
     return 'pub ${package.name} $packageVersion';
   }
 
@@ -247,14 +300,10 @@ class SymbolGenerator {
     if (_isInSdk(element)) {
       filePath = _pathForSdkElement(element);
     } else {
-      final config = _packageConfig.packageOf(Uri.file(sourcePath));
-      if (config == null) {
-        throw Exception(
-          'Could not find package for $sourcePath. Have you run pub get?',
-        );
-      }
+      final package = _packageOf(sourcePath);
+      if (package == null) throw const _NoPackage();
 
-      filePath = sourcePath.substring(config.root.toFilePath().length);
+      filePath = sourcePath.substring(package.root.length);
     }
 
     final namespace = _escapeNamespacePath(filePath);
@@ -401,3 +450,11 @@ class SymbolGenerator {
 class _NamelessElement implements Exception {
   const _NamelessElement();
 }
+
+/// Thrown by [SymbolGenerator._getDescriptor] for an element declared in a
+/// file that belongs to no pub package (not in the package config, no
+/// enclosing pubspec.yaml); [SymbolGenerator.symbolFor] then emits a
+/// `local N` symbol instead of failing the whole index (sentei patch 11).
+class _NoPackage implements Exception {
+  const _NoPackage();
+}
```

## 12. A variable's enclosing range covers its type annotation (`lib/src/scip_visitor.dart`)

The `enclosing_range` of a definition is its declaration node. For a
top-level variable or a field that node is the `VariableDeclaration`,
which starts at the variable's name: the type annotation, modifiers and
metadata belong to the surrounding `TopLevelVariableDeclaration` /
`FieldDeclaration`. sentei attributes a reference to the innermost
definition whose enclosing range contains it, so the type in
`final Map<String, BinaryOperatorBuilder> _builders = …;` was a use by the
file (or class), not by `_builders`: in flame-engine's jenny
(`operators/_common.dart:39`) the reachable `_builders` did not keep its
private typedef alive, which came out private_dead (the file is under
`lib/src/`, not a seed). The enclosing range of such a variable now starts
at its declaration (doc comment, metadata, `static`/`final`/`late`, type);
with several variables in one declaration each range starts there and the
first, innermost by position, gets the type. Local variables are unchanged
(document-local symbols). Snapshots: every field and top-level variable's
`enclosing` starts earlier; nothing else changes.

Upstreamable: SCIP defines `enclosing_range` as the range of the whole
definition, type included.

```diff
--- a/lib/src/scip_visitor.dart
+++ b/lib/src/scip_visitor.dart
@@ -310,8 +310,29 @@ class ScipVisitor extends GeneralizingAstVisitor {
         symbol: symbol,
         symbolRoles: SymbolRole.Definition.value,
         diagnostics: meta.diagnostics,
-        enclosingRange: _lineInfo.getRange(node.offset, node.length),
+        enclosingRange: _enclosingRange(node),
       ),
     );
   }
+
+  /// The source range a definition encloses: the declaration node, except
+  /// that a top-level variable or field (a [VariableDeclaration], which
+  /// starts at its name) also covers what precedes it in its declaration:
+  /// doc comment, metadata, modifiers and the type annotation. A reference
+  /// in `final Map<K, V> _x = ...;`'s type is a use by `_x`, not by the file
+  /// or class around it (sentei patch 12). With several variables in one
+  /// declaration (`int a = 1, b = 2;`) each range starts at the declaration;
+  /// the first variable gets the type (the innermost range wins).
+  List<int> _enclosingRange(AstNode node) {
+    var start = node.offset;
+    if (node is VariableDeclaration) {
+      final list = node.parent;
+      final decl = list?.parent;
+      if (list is VariableDeclarationList &&
+          (decl is TopLevelVariableDeclaration || decl is FieldDeclaration)) {
+        start = decl!.offset;
+      }
+    }
+    return _lineInfo.getRange(start, node.end - start);
+  }
 }
```

## 13. The parts of every indexed library are documents, build_runner's cache output included (`lib/src/indexer.dart`)

A `build_to: cache` builder (over_react's) does not write `x.over_react.g.dart`
next to its library but to `.dart_tool/build/generated/<package>/<path>`, and
the analyzer resolves `part 'x.over_react.g.dart';` to that file when the
source-side one does not exist (analyzer `PackageConfigWorkspace.findFile`;
the unit's path is the generated file's). The files to index come from the
analysis contexts and the conventional dirs (patch 10), neither of which
walks a dot dir, and `_resolveByLibrary` kept only the units of those files:
the generated part was resolved with its library and then dropped. Every
reference inside it was lost, and nothing said so (the part is not missing,
so dart-surface reports no missing part either): on the Workiva run
over_react_test indexed `ok` with none of its 13 generated parts (its
`PropsMetaCollection`, `JsBackedMap`, `UiProps` uses of over_react and react
gone); a declaration used only from such a part came out dead (fail-open).

Now `_resolveByLibrary` also returns the parts of the libraries it resolved
from the package's files that are not among those files. A part inside the
package dir (nested packages excluded) becomes a document at its real
package-relative path, e.g.
`.dart_tool/build/generated/over_react_test/lib/src/over_react_test/wrapper_component.over_react.g.dart`
(its declarations get symbols under that path, the ones the library's
references already carried). A part outside the package dir cannot be a
document of it (a pub workspace member's generated parts sit under the
workspace root's `.dart_tool/`, since the analyzer's workspace root is the
directory of the package config; or a script's `part '../../shared/x.dart'`):
it is listed as unindexed. The stderr report line gains two keys, written
whenever any list is non-empty:
`sentei-scip-dart: {"package", "excludedIndexed", "unresolved", "generatedParts", "unindexedParts"}`.
The adapter writes an `info:` line for `generatedParts` and makes the package
`partial`, with a `cause:` line, for `unindexedParts` (fail closed). Ingest
marks the documents generated through GENERATED_GLOBS (`**/*.g.dart`,
`**/generated/**`), so nothing declared in them gets a verdict, while their
references count. Verified on a copy of the Workiva over_react_test clone
(with its build_runner output): 37 → 50 documents, the 13 parts indexed, 0
unindexed. The existing fixture snapshots are unchanged; fixture
`dart-gen` (a part committed only under `.dart_tool/build/generated/`) keeps
`splitSettingPairs` alive, private_dead with the fork before this patch.

Upstreamable: a correctness bug for any package with `build_to: cache` parts.

Diff against the state after patch 12:

```diff
--- a/lib/src/indexer.dart
+++ b/lib/src/indexer.dart
@@ -126,23 +126,55 @@ Future<void> indexPackages(
         .toSet();
     final files = [...analyzed, ...extra]..sort();
 
-    final resolvedUnits = await _resolveByLibrary(collection, files);
-    final resolvedPaths = {for (final unit in resolvedUnits) unit.path};
+    final resolved = await _resolveByLibrary(collection, files);
+    final resolvedPaths = {for (final unit in resolved.units) unit.path};
     final unresolved = files.where((f) => !resolvedPaths.contains(f)).toList();
-    if (extra.isNotEmpty || unresolved.isNotEmpty) {
+    // Parts of the indexed libraries that are not among [files] (sentei patch
+    // 13): build_runner's `build_to: cache` output under
+    // `.dart_tool/build/generated/<package>/`, which the analyzer resolves a
+    // `part 'x.g.dart';` to when no `x.g.dart` sits next to the library (a
+    // dot dir, so never walked). A reference inside such a part is a use like
+    // any other: the part is a document of the package, at its real path.
+    // A part outside the package (a pub workspace member's generated parts
+    // live under the workspace root's `.dart_tool/`) cannot be a document of
+    // this package: reported as unindexed, its references are unknown.
+    final generatedParts = <ResolvedUnitResult>[];
+    final unindexedParts = <String>[];
+    for (final unit in resolved.parts) {
+      if (resolvedPaths.contains(unit.path)) continue;
+      if (nestedPackages.any((nested) => p.isWithin(nested, unit.path))) {
+        continue; // the nested package's own index covers it
+      }
+      if (p.isWithin(dirPath, unit.path)) {
+        generatedParts.add(unit);
+        resolvedPaths.add(unit.path);
+      } else {
+        unindexedParts.add(unit.path);
+      }
+    }
+    final resolvedUnits = [...resolved.units, ...generatedParts]
+      ..sort((a, b) => a.path.compareTo(b.path));
+    String rel(String f) =>
+        p.posix.joinAll(p.split(p.relative(f, from: dirPath)));
+    if (extra.isNotEmpty ||
+        unresolved.isNotEmpty ||
+        generatedParts.isNotEmpty ||
+        unindexedParts.isNotEmpty) {
       // One machine-readable line per package for the caller (sentei's
-      // adapter): files indexed beyond the analyzer's analyzedFiles(), and
-      // files that could not be resolved (their references are unknown).
+      // adapter): files indexed beyond the analyzer's analyzedFiles(), files
+      // that could not be resolved (their references are unknown), parts
+      // indexed from outside the package's walked dirs (patch 13), and parts
+      // that could not be indexed as documents of the package.
       stderr.writeln(
         'sentei-scip-dart: ${jsonEncode({
           'package': dirPath,
           'excludedIndexed': [
             for (final f in extra)
-              if (resolvedPaths.contains(f)) p.posix.joinAll(p.split(p.relative(f, from: dirPath))),
-          ]..sort(),
-          'unresolved': [
-            for (final f in unresolved) p.posix.joinAll(p.split(p.relative(f, from: dirPath))),
+              if (resolvedPaths.contains(f)) rel(f),
           ]..sort(),
+          'unresolved': [for (final f in unresolved) rel(f)]..sort(),
+          'generatedParts': [for (final u in generatedParts) rel(u.path)]..sort(),
+          'unindexedParts': [for (final f in unindexedParts) rel(f)]..sort(),
         })}',
       );
     }
@@ -269,16 +301,28 @@ AnalysisContext? _contextFor(AnalysisContextCollection collection, String file)
 /// the library's files. A file no library of [files] includes (a part of an
 /// outside library, an orphan part) falls back to the library containing it,
 /// then to resolving it alone.
-Future<List<ResolvedUnitResult>> _resolveByLibrary(
+///
+/// Also returns the parts of the libraries of [files] that are not in
+/// [files] themselves, sorted by path (sentei patch 13): the analyzer
+/// resolves a `part 'x.g.dart';` whose file is missing next to the library
+/// to build_runner's `.dart_tool/build/generated/<package>/…/x.g.dart`, which
+/// no walk of the package's dirs finds.
+Future<({List<ResolvedUnitResult> units, List<ResolvedUnitResult> parts})>
+_resolveByLibrary(
   AnalysisContextCollection collection,
   List<String> files,
 ) async {
   final wanted = files.toSet();
   final units = <String, ResolvedUnitResult>{};
-  void take(SomeResolvedLibraryResult result) {
+  final parts = <String, ResolvedUnitResult>{};
+  void take(SomeResolvedLibraryResult result, {bool ownLibrary = false}) {
     if (result is! ResolvedLibraryResult) return;
     for (final unit in result.units) {
-      if (wanted.contains(unit.path)) units.putIfAbsent(unit.path, () => unit);
+      if (wanted.contains(unit.path)) {
+        units.putIfAbsent(unit.path, () => unit);
+      } else if (ownLibrary && unit.isPart) {
+        parts.putIfAbsent(unit.path, () => unit);
+      }
     }
   }
 
@@ -288,7 +332,7 @@ Future<List<ResolvedUnitResult>> _resolveByLibrary(
       if (session == null) return;
       final kind = session.getFile(file);
       if (kind is FileResult && kind.isLibrary) {
-        take(await session.getResolvedLibrary(file));
+        take(await session.getResolvedLibrary(file), ownLibrary: true);
       }
     }),
   );
@@ -306,8 +350,14 @@ Future<List<ResolvedUnitResult>> _resolveByLibrary(
       if (unit is ResolvedUnitResult) units[file] = unit;
     }),
   );
-  return [
-    for (final file in files)
-      if (units[file] case final unit?) unit,
-  ];
+  return (
+    units: [
+      for (final file in files)
+        if (units[file] case final unit?) unit,
+    ],
+    parts: [
+      for (final path in parts.keys.toList()..sort())
+        if (!units.containsKey(path)) parts[path]!,
+    ],
+  );
 }
```

## 14. Extension types: the representation field and the primary constructor are definitions (`lib/src/scip_visitor.dart`)

`extension type JConstructorId._fromPointer(JMethodIDPtr pointer)` declares
three things: the type, the primary constructor `_fromPointer` and the
representation field `pointer` (the declaring parameter is also a field).
The analyzer's AST has a `PrimaryConstructorDeclaration` for the constructor,
which is not a `Declaration` node, and a plain formal parameter for the
field, so upstream defined only the type (plus the parameter as a local
symbol). References resolved to the field and constructor elements anyway
(`JConstructorId#pointer.`, `JConstructorId#_fromPointer().`,
`Plain#` `` `<constructor>` ``). A reference to a symbol no document defines
looks like a name removed at HEAD: dart-lang reported 397 false
version-skew rows on jni's `JConstructorId#pointer.` referenced from
ok_http (346) and cronet_http (51). Now:

- a `PrimaryConstructorDeclaration` registers its constructor element as a
  definition at its name (the type name when unnamed, like upstream's
  unnamed constructors), enclosing the primary constructor (name and
  parameter list);
- a formal parameter whose element is a declaring `FieldFormalParameterElement`
  (not the `this.x` form, which upstream already handles as a reference)
  registers its field as a definition at the parameter's name (the field's
  own fragment has no name offset), enclosing the parameter. The parameter
  stays a local definition at the same range.

`_registerAsDefinition` takes an optional name offset/length for the second
case. Covers any declaring parameter, so class primary constructors (a
language feature not enabled in Dart 3.13) get their fields too when they
land. Snapshots: new definitions on extension types only (fixture:
`dart-lib-x/lib/src/handle.dart`, used from acme_app). Upstreamable.

Diff against the file with patches 1–13 applied (line numbers as in the
vendored file, header included):

```diff
--- a/lib/src/scip_visitor.dart
+++ b/lib/src/scip_visitor.dart
@@ -61,4 +61,6 @@ class ScipVisitor extends GeneralizingAstVisitor {
     } else if (node is FormalParameter) {
       _visitFormalParameter(node);
+    } else if (node is PrimaryConstructorDeclaration) {
+      _visitPrimaryConstructor(node);
     } else if (node is SimpleIdentifier) {
       _visitSimpleIdentifier(node);
@@ -159,8 +161,39 @@ class ScipVisitor extends GeneralizingAstVisitor {
   }
 
+  /// A primary constructor (`extension type E._(int p)`, `extension type
+  /// E(int p)`) is not a [Declaration] node, so upstream defined no symbol
+  /// for it while `E._(1)` / `E(1)` referenced `E#_().` / `E#<constructor>().`
+  /// (sentei patch 14). Defined at its name (the type name when unnamed).
+  void _visitPrimaryConstructor(PrimaryConstructorDeclaration node) {
+    final element = node.declaredFragment?.element;
+    if (element == null) return;
+    _registerAsDefinition(element, node);
+  }
+
   void _visitFormalParameter(FormalParameter node) {
     final element = _symbolGenerator.elementFor(node);
     if (element == null) return;
 
+    // A declaring parameter of a primary constructor (an extension type's
+    // representation, `extension type E(int p)`) also declares the field
+    // `p`, which `e.p` references as `E#p.`: define the field at the
+    // parameter's name as well (sentei patch 14). The parameter itself
+    // stays a (local) definition below.
+    if (node is! FieldFormalParameter &&
+        element is FieldFormalParameterElement &&
+        element.isDeclaring) {
+      // The field's fragment has no name offset: use the parameter's name.
+      final field = element.field;
+      final name = node.name;
+      if (field != null && name != null) {
+        _registerAsDefinition(
+          field,
+          node,
+          offset: name.offset,
+          length: name.length,
+        );
+      }
+    }
+
     // if the parameter is a `this.someFieldOnThClass`, we need to register
     // it as a reference to said field, as well as a declaration of a parameter.
@@ -286,11 +319,15 @@ class ScipVisitor extends GeneralizingAstVisitor {
     AstNode node, {
     List<Relationship>? relationships,
+    int? offset,
+    int? length,
   }) {
     final symbol = _symbolGenerator.symbolFor(element);
     if (symbol == null) return null;
+    final nameOffset = offset ?? element.nameOffset;
+    final nameLength = length ?? element.nameLength;
 
     final meta = getSymbolMetadata(
       element,
-      element.nameOffset,
+      nameOffset,
       _analysisErrors,
     );
@@ -307,5 +344,5 @@ class ScipVisitor extends GeneralizingAstVisitor {
     occurrences.add(
       Occurrence(
-        range: _lineInfo.getRange(element.nameOffset, element.nameLength),
+        range: _lineInfo.getRange(nameOffset, nameLength),
         symbol: symbol,
         symbolRoles: SymbolRole.Definition.value,
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
