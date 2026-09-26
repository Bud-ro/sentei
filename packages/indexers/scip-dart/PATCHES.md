# Patches to scip-dart

Vendored from <https://github.com/Workiva/scip-dart> at tag `1.7.0`,
commit `8d017a25874efb8513617e85e508a573692cbb63` (Apache-2.0, see `LICENSE`).
sentei's adapter (`packages/cli/src/indexers/scip-dart.ts`) reports this copy as
`1.7.0+sentei.9` (sentei.2: dart-surface gained `entrySymbols`; sentei.3: the sidecar gained `shorthandRefs`; sentei.4: patch 3 below, manager-prefixed output file names, and dart-surface's Dart entry conventions; sentei.5: the adapter treats ignored nested manifests as not ours, and missing parts outside `lib/`/`bin/` no longer make a package partial; sentei.6: the adapter sets `entrySymbols[].kind` to `runtime`; sentei.7: patch 4 below, and dart-surface's `--pub-get-failed`; sentei.8: patch 5 below, dart-surface's `--sdk-path`/`--package-name`, and Flutter packages resolved with `flutter pub get`; sentei.9: patches 6 to 8 below, pub workspaces resolved once at the root, and a package with `lib/` code but no `lib/` document fails): bump the `+sentei.N` patch level whenever this directory or dart-surface changes output.

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
