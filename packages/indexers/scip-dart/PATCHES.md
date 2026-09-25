# Patches to scip-dart

Vendored from <https://github.com/Workiva/scip-dart> at tag `1.7.0`,
commit `8d017a25874efb8513617e85e508a573692cbb63` (Apache-2.0, see `LICENSE`).
sentei's adapter (`packages/cli/src/indexers/scip-dart.ts`) reports this copy as
`1.7.0+sentei.7` (sentei.2: dart-surface gained `entrySymbols`; sentei.3: the sidecar gained `shorthandRefs`; sentei.4: patch 3 below, manager-prefixed output file names, and dart-surface's Dart entry conventions; sentei.5: the adapter treats ignored nested manifests as not ours, and missing parts outside `lib/`/`bin/` no longer make a package partial; sentei.6: the adapter sets `entrySymbols[].kind` to `runtime`; sentei.7: patch 4 below, and dart-surface's `--pub-get-failed`): bump the `+sentei.N` patch level whenever this directory or dart-surface changes output.

Kept from upstream: `bin/`, `lib/`, `pubspec.yaml`, `LICENSE`, `README.md`.
Dropped (not needed to run): tests/snapshots, `tool/`, CI config, `Makefile`,
`analysis_options.yaml`, `CHANGELOG.md`, and upstream's `pubspec.lock`. The
`pubspec.lock` here is sentei's own, resolved for the trimmed dependency set and
checked in so the analyzer version is pinned (docs/DESIGN.md, M3).

Diffs are against the upstream commit, paths relative to this directory.
Each modified file (`pubspec.yaml`, `bin/scip_dart.dart`, `lib/src/flags.dart`,
`lib/src/symbol_generator.dart`, `lib/src/scip_visitor.dart`) also starts with a
one-line "Modified by sentei" notice (Apache-2.0 §4(b)) plus, in the Dart files,
a blank line after it; the diffs below leave that header out, so their new-side
line numbers are offset by it.

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
