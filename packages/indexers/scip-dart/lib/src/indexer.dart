// Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.

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
    final files =
        analyzedFiles
            .where((file) => p.isWithin(dirPath, file))
            .where(
              (file) =>
                  !nestedPackages.any((nested) => p.isWithin(nested, file)),
            )
            .toList()
          ..sort();

    final resolvedUnits = await Future.wait(
      files.map(
        (file) =>
            collection.contextFor(file).currentSession.getResolvedUnit(file),
      ),
    );

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
