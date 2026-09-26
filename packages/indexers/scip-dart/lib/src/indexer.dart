// Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.

import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context.dart';
import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:path/path.dart' as p;
import 'package:package_config/package_config.dart';
import 'package:pubspec_parse/pubspec_parse.dart';
import 'package:scip_dart/src/flags.dart';

import 'package:scip_dart/src/gen/scip.pb.dart';
import 'package:scip_dart/src/scip_visitor.dart';
import 'package:scip_dart/src/utils.dart';
import 'package:scip_dart/src/version.dart';

/// One package to index: its documents are relative to [root], its file
/// symbols carry [pubspec]'s name and version.
class PackageTarget {
  final String root;
  final Pubspec pubspec;
  PackageTarget(this.root, this.pubspec);
}

Future<Index> indexPackage(
  String root,
  PackageConfig packageConfig,
  Pubspec pubspec,
) async {
  late Index index;
  await indexPackages(root, packageConfig, [
    PackageTarget(root, pubspec),
  ], (_, i) => index = i);
  return index;
}

/// Indexes every package of [targets] with one analysis context collection
/// rooted at [collectionRoot] (a pub workspace root, whose package config
/// resolves every member), calling [onIndex] once per target, in order, with
/// an index equal to what [indexPackage] on that target alone produces: its
/// documents are the target's own files (nested packages excluded), relative
/// to the target's root. The element model is shared; resolved units are
/// dropped after each target.
Future<void> indexPackages(
  String collectionRoot,
  PackageConfig packageConfig,
  List<PackageTarget> targets,
  void Function(PackageTarget target, Index index) onIndex,
) async {
  final rootPath = p.normalize(p.absolute(collectionRoot));

  final allPackageRoots = packageConfig.packages
      .map((package) => p.normalize(package.packageUriRoot.toFilePath()))
      .toList();

  final targetRoots = [
    for (final t in targets) p.normalize(p.absolute(t.root)),
  ];

  final collection = AnalysisContextCollection(
    includedPaths: {...allPackageRoots, rootPath, ...targetRoots}.toList(),
    sdkPath: Flags.instance.sdkPath,
  );

  // Every analyzed Dart file of every context that overlaps a target. A
  // package's `lib/` is also in [allPackageRoots], and the analyzer may give
  // it a context of its own (a pub workspace member listed by path, e.g.
  // `workspace: [packages/x]`), so the context `contextFor(root)` returns
  // need not analyze it.
  bool overlaps(String contextRoot) => targetRoots.any(
    (t) =>
        t == contextRoot ||
        p.isWithin(contextRoot, t) ||
        p.isWithin(t, contextRoot),
  );
  final analyzedFiles = <String>{
    for (final context in collection.contexts)
      if (overlaps(p.normalize(context.contextRoot.root.path)))
        ...context.contextRoot.analyzedFiles().where(
          (file) => p.extension(file) == '.dart',
        ),
  };

  for (var i = 0; i < targets.length; i++) {
    final target = targets[i];
    final dirPath = targetRoots[i];

    final metadata = Metadata(
      projectRoot: Uri.file(dirPath).toString(),
      textDocumentEncoding: TextEncoding.UTF8,
      toolInfo: ToolInfo(
        name: 'scip-dart',
        version: scipDartVersion,
        arguments: [],
      ),
    );

    final nestedPackages = (await pubspecPathsFor(dirPath))
        .map((path) => p.normalize(p.absolute(p.dirname(path))))
        .where((path) => path != dirPath)
        .toList();

    if (Flags.instance.verbose) {
      print('Ignoring subdirectories: $nestedPackages');
    }

    if (Flags.instance.performance) print('Analyzing Source ($dirPath)');
    final st = Stopwatch()..start();

    // only index dart files of the current dart package, to index nested
    // packages, scip indexing can simply be re-run for that nested package
    final analyzed = analyzedFiles
        .where((file) => p.isWithin(dirPath, file))
        .where(
          (file) => !nestedPackages.any((nested) => p.isWithin(nested, file)),
        )
        .toSet();
    // Files the analyzer skips (`analyzer: exclude:` in analysis_options.yaml)
    // are still code of the package: generated bindings, test fixtures. Their
    // references must not vanish, so every Dart file of the package's
    // conventional dirs is indexed, excluded or not (sentei patch 10).
    final extra = conventionDartFiles(dirPath, nestedPackages)
        .where((file) => !analyzed.contains(file))
        .toSet();
    final files = [...analyzed, ...extra]..sort();

    final resolved = await _resolveByLibrary(collection, files);
    final resolvedPaths = {for (final unit in resolved.units) unit.path};
    final unresolved = files.where((f) => !resolvedPaths.contains(f)).toList();
    // Parts of the indexed libraries that are not among [files] (sentei patch
    // 13): build_runner's `build_to: cache` output under
    // `.dart_tool/build/generated/<package>/`, which the analyzer resolves a
    // `part 'x.g.dart';` to when no `x.g.dart` sits next to the library (a
    // dot dir, so never walked). A reference inside such a part is a use like
    // any other: the part is a document of the package, at its real path.
    // A part outside the package (a pub workspace member's generated parts
    // live under the workspace root's `.dart_tool/`) cannot be a document of
    // this package: reported as unindexed, its references are unknown.
    final generatedParts = <ResolvedUnitResult>[];
    final unindexedParts = <String>[];
    for (final unit in resolved.parts) {
      if (resolvedPaths.contains(unit.path)) continue;
      if (nestedPackages.any((nested) => p.isWithin(nested, unit.path))) {
        continue; // the nested package's own index covers it
      }
      if (p.isWithin(dirPath, unit.path)) {
        generatedParts.add(unit);
        resolvedPaths.add(unit.path);
      } else {
        unindexedParts.add(unit.path);
      }
    }
    final resolvedUnits = [...resolved.units, ...generatedParts]
      ..sort((a, b) => a.path.compareTo(b.path));
    String rel(String f) =>
        p.posix.joinAll(p.split(p.relative(f, from: dirPath)));
    if (extra.isNotEmpty ||
        unresolved.isNotEmpty ||
        generatedParts.isNotEmpty ||
        unindexedParts.isNotEmpty) {
      // One machine-readable line per package for the caller (sentei's
      // adapter): files indexed beyond the analyzer's analyzedFiles(), files
      // that could not be resolved (their references are unknown), parts
      // indexed from outside the package's walked dirs (patch 13), and parts
      // that could not be indexed as documents of the package.
      stderr.writeln(
        'sentei-scip-dart: ${jsonEncode({
          'package': dirPath,
          'excludedIndexed': [
            for (final f in extra)
              if (resolvedPaths.contains(f)) rel(f),
          ]..sort(),
          'unresolved': [for (final f in unresolved) rel(f)]..sort(),
          'generatedParts': [for (final u in generatedParts) rel(u.path)]..sort(),
          'unindexedParts': [for (final f in unindexedParts) rel(f)]..sort(),
        })}',
      );
    }

    if (Flags.instance.performance) {
      print('Analyzing Source took: ${st.elapsedMilliseconds}ms');
      st.reset();
      print('Parsing Ast');
    }

    globalExternalSymbols = [];
    final documents = resolvedUnits.whereType<ResolvedUnitResult>().map((
      resUnit,
    ) {
      final relativePath = p.relative(resUnit.path, from: dirPath);

      final visitor = ScipVisitor(
        relativePath,
        dirPath,
        resUnit.lineInfo,
        resUnit.diagnostics,
        packageConfig,
        target.pubspec,
      );
      resUnit.unit.accept(visitor);

      return Document(
        language: Language.Dart.name,
        relativePath: relativePath,
        occurrences: visitor.occurrences,
        symbols: visitor.symbols,
      );
    }).toList();

    if (Flags.instance.performance) {
      print('Parsing Ast took: ${st.elapsedMilliseconds}ms');
    }

    onIndex(
      target,
      Index(
        metadata: metadata,
        documents: documents,
        externalSymbols: globalExternalSymbols,
      ),
    );
  }
}

/// Top-level dirs of a pub package whose Dart files are always indexed,
/// whatever the analyzer excludes.
const conventionDirs = [
  'lib',
  'bin',
  'test',
  'example',
  'tool',
  'benchmark',
  'web',
  'integration_test',
  'test_driver',
];

/// Every `.dart` file under [dirPath]'s [conventionDirs], absolute and
/// normalized, except in dot dirs, `build/` dirs, symlinked dirs and
/// [nestedPackages].
List<String> conventionDartFiles(String dirPath, List<String> nestedPackages) {
  final out = <String>[];
  void walk(Directory dir) {
    final path = p.normalize(dir.path);
    if (nestedPackages.any((n) => n == path || p.isWithin(n, path))) return;
    final List<FileSystemEntity> entries;
    try {
      entries = dir.listSync(followLinks: false);
    } on FileSystemException {
      return;
    }
    for (final e in entries) {
      final name = p.basename(e.path);
      if (e is Directory) {
        if (name.startsWith('.') || name == 'build') continue;
        walk(e);
      } else if (name.endsWith('.dart') &&
          (e is File || (e is Link && File(e.path).existsSync()))) {
        out.add(p.normalize(e.path));
      }
    }
  }

  for (final d in conventionDirs) {
    final dir = Directory(p.join(dirPath, d));
    if (dir.existsSync()) walk(dir);
  }
  return out;
}

/// The context that analyzes [file], or, for a file no context analyzes
/// (excluded by analysis_options.yaml), the context with the deepest root
/// containing it: the analyzer resolves any file of its root on request.
/// Null when no context root contains the file (it is then left unresolved).
AnalysisContext? _contextFor(AnalysisContextCollection collection, String file) {
  try {
    return collection.contextFor(file);
  } on StateError {
    AnalysisContext? best;
    for (final c in collection.contexts) {
      final root = p.normalize(c.contextRoot.root.path);
      if (root != file && !p.isWithin(root, file)) continue;
      if (best == null || root.length > best.contextRoot.root.path.length) {
        best = c;
      }
    }
    return best;
  }
}

/// Resolves [files] library by library, in [files] order: each library file
/// with `getResolvedLibrary`, whose units include its parts, so a part is
/// always analysed in its library's context. Resolving a part on its own
/// (`getResolvedUnit`, in parallel with everything else) only works when the
/// analyzer can find its library from the part: for a name-based
/// `part of foo;` it often cannot, and the part then resolves without its
/// library ("Undefined class", `InvalidType`), losing every reference between
/// the library's files. A file no library of [files] includes (a part of an
/// outside library, an orphan part) falls back to the library containing it,
/// then to resolving it alone.
///
/// Also returns the parts of the libraries of [files] that are not in
/// [files] themselves, sorted by path (sentei patch 13): the analyzer
/// resolves a `part 'x.g.dart';` whose file is missing next to the library
/// to build_runner's `.dart_tool/build/generated/<package>/…/x.g.dart`, which
/// no walk of the package's dirs finds.
Future<({List<ResolvedUnitResult> units, List<ResolvedUnitResult> parts})>
_resolveByLibrary(
  AnalysisContextCollection collection,
  List<String> files,
) async {
  final wanted = files.toSet();
  final units = <String, ResolvedUnitResult>{};
  final parts = <String, ResolvedUnitResult>{};
  void take(SomeResolvedLibraryResult result, {bool ownLibrary = false}) {
    if (result is! ResolvedLibraryResult) return;
    for (final unit in result.units) {
      if (wanted.contains(unit.path)) {
        units.putIfAbsent(unit.path, () => unit);
      } else if (ownLibrary && unit.isPart) {
        parts.putIfAbsent(unit.path, () => unit);
      }
    }
  }

  await Future.wait(
    files.map((file) async {
      final session = _contextFor(collection, file)?.currentSession;
      if (session == null) return;
      final kind = session.getFile(file);
      if (kind is FileResult && kind.isLibrary) {
        take(await session.getResolvedLibrary(file), ownLibrary: true);
      }
    }),
  );
  final leftover = files.where((file) => !units.containsKey(file)).toList();
  if (Flags.instance.performance && leftover.isNotEmpty) {
    print('Resolving ${leftover.length} file(s) outside the indexed libraries');
  }
  await Future.wait(
    leftover.map((file) async {
      final session = _contextFor(collection, file)?.currentSession;
      if (session == null) return;
      take(await session.getResolvedLibraryContaining(file));
      if (units.containsKey(file)) return;
      final unit = await session.getResolvedUnit(file);
      if (unit is ResolvedUnitResult) units[file] = unit;
    }),
  );
  return (
    units: [
      for (final file in files)
        if (units[file] case final unit?) unit,
    ],
    parts: [
      for (final path in parts.keys.toList()..sort())
        if (!units.containsKey(path)) parts[path]!,
    ],
  );
}
