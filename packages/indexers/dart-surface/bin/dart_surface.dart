// Export-surface sidecar for one pub package (sentei, PLAN.md §6.3 step 5, §6.6).
//
// SCIP carries no export information, so the Dart adapter
// (packages/cli/src/indexers/scip-dart.ts) runs this next to scip-dart and
// writes its output as `<slug>.exports.json`. Output (stdout, JSON) is the
// sidecar shape of packages/cli/src/indexers/types.ts `ExportsSidecar` (incl.
// `entrySymbols`, see [Surface.entrySymbols]), plus three adapter-only keys the
// adapter strips before writing the sidecar:
//   - `unresolvedOrgModules`: org (or own relative) import/export URIs that do
//     not resolve; references through them vanish silently → status partial;
//   - `missingParts`: `part` directives whose file does not exist (typically a
//     `*.g.dart` build_runner output that was never generated): the library is
//     incomplete and references inside the part are unknown → status partial
//     when the library is under lib/ or bin/ (elsewhere, and in test/docs files
//     the policy does not count, the adapter only warns);
//   - `diagnostics`: `warn:`/`info:` lines (other analyzer errors; never change status);
//   - `unresolvedOwnUris`: with `--pub-get-failed`, how many of the package's
//     own `package:<self>/...` import/export URIs did not resolve. They are left
//     out of `unresolved` and `unresolvedOrgModules`: without a package config
//     that maps the package itself, none of them can resolve, so they say
//     nothing beyond "pub get failed" (the adapter reports that once).
//
// Positions: 0-based line, 0-based UTF-16 column; files repo-relative POSIX.
import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/analysis_context.dart';
import 'package:analyzer/dart/analysis/analysis_context_collection.dart';
import 'package:analyzer/dart/analysis/results.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/element/element.dart';
import 'package:analyzer/diagnostic/diagnostic.dart';
import 'package:args/args.dart';
import 'package:path/path.dart' as p;
import 'package:yaml/yaml.dart';

/// Cap on analyzer errors copied into `diagnostics` (the count is always reported).
const maxReportedDiagnostics = 20;

Future<void> main(List<String> argv) async {
  final parser = ArgParser()
    ..addOption('repo-root', mandatory: true, help: 'Repo root (paths in the output are relative to it)')
    ..addOption('package-root', mandatory: true, help: 'Package dir (holds pubspec.yaml)')
    ..addOption('package-id', mandatory: true, help: 'e.g. pub:acme_x')
    ..addOption('package-name', help: "The package's pub name (default: the last ':' segment of --package-id)")
    ..addMultiOption('entry', help: 'Entry file, repo-relative POSIX (repeatable)')
    ..addOption('org-packages', defaultsTo: '', help: 'Comma-separated pub names of all org packages')
    ..addFlag('pub-get-failed', negatable: false, help: 'pub get failed for this package: own package: URIs that do not resolve are counted, not listed')
    ..addMultiOption('nested', help: 'Dir of a package, or of an ignored manifest, nested inside this one (its files are not ours)')
    ..addOption('sdk-path', help: "Dart SDK the analyzer resolves dart: libraries from (a Flutter package: the Flutter SDK's bin/cache/dart-sdk)")
    ..addFlag('help', abbr: 'h', negatable: false);
  final ArgResults args;
  try {
    args = parser.parse(argv);
  } on FormatException catch (e) {
    stderr.writeln('dart_surface: ${e.message}\n${parser.usage}');
    exit(64);
  }
  if (args['help'] as bool) {
    stdout.writeln('usage: dart_surface [options]\n${parser.usage}');
    return;
  }
  final surface = Surface(
    repoRoot: p.normalize(p.absolute(args['repo-root'] as String)),
    packageRoot: p.normalize(p.absolute(args['package-root'] as String)),
    packageId: args['package-id'] as String,
    entries: args['entry'] as List<String>,
    orgPackages: (args['org-packages'] as String).split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toSet(),
    nested: (args['nested'] as List<String>).map((d) => p.normalize(p.absolute(d))).toList(),
    pubGetFailed: args['pub-get-failed'] as bool,
    sdkPath: args['sdk-path'] as String?,
    packageNameOverride: args['package-name'] as String?,
  );
  final out = await surface.compute();
  stdout.writeln(const JsonEncoder.withIndent('  ').convert(out));
}

class Pos {
  final String file;
  final int line;
  final int col;
  Pos(this.file, this.line, this.col);
  Map<String, Object> toJson() => {'file': file, 'line': line, 'col': col};
  String get key => '$file\u0000$line\u0000$col';
  String get display => '$file:${line + 1}:${col + 1}';
}

class ExportRecord {
  final String entry;
  final String exportedAs;
  final String name;
  final Pos pos;
  final List<Pos> sites = [];
  ExportRecord(this.entry, this.exportedAs, this.name, this.pos);
  Map<String, Object> toJson() => {
        'entry': entry,
        'exportedAs': exportedAs,
        'name': name,
        ...pos.toJson(),
        'sites': [for (final s in sites) s.toJson()],
      };
}

class Surface {
  final String repoRoot;
  final String packageRoot;
  final String packageId;
  final List<String> entries;
  final Set<String> orgPackages;
  final List<String> nested;

  /// `dart pub get` failed for this package (see [unresolvedOwnUris]).
  final bool pubGetFailed;

  /// Dart SDK for the analyzer; null: the SDK running dart-surface.
  final String? sdkPath;

  Surface({
    required this.repoRoot,
    required this.packageRoot,
    required this.packageId,
    required this.entries,
    required this.orgPackages,
    required this.nested,
    this.pubGetFailed = false,
    this.sdkPath,
    this.packageNameOverride,
  });

  final diagnostics = <String>[];
  final unresolved = <String>{};
  final unresolvedImports = <Map<String, Object>>[];
  final unresolvedOrgModules = <Map<String, Object>>[];
  final missingParts = <Map<String, Object>>[];

  /// Own `package:<self>/...` directive URIs that did not resolve after a
  /// failed pub get: the package config does not map the package itself (it
  /// may come from an enclosing package, or not exist), so every such URI
  /// fails for that one reason. Counted instead of listed. After a successful
  /// pub get an unresolved own URI is a missing file and is listed as usual.
  /// Keyed by file and URI (an export directive is seen twice).
  final unresolvedOwnUris = <String>{};

  /// See [unresolvedOwnUris]: true (and counted) when [uriText] is an own
  /// `package:` URI whose failure pub get already explains.
  bool _ownUriUnresolvable(String file, String uriText) {
    if (!pubGetFailed || _packageOf(uriText) != packageName) return false;
    unresolvedOwnUris.add('$file\u0000$uriText');
    return true;
  }

  /// Declarations the runtime or a tool invokes by convention, with no
  /// reference in code (the sidecar's `entrySymbols`), keyed by position:
  ///   - `main` of a `lib/*.dart` entry (Flutter's lib/main.dart);
  ///   - `main` of every library outside `lib/` (bin/, tool/, benchmark/,
  ///     example/, web/, root scripts, ...): these are run directly
  ///     (`dart run`, `dart <file>`), declared there or re-exported (its
  ///     export namespace, see [_addMain]). Test files are dropped by the adapter;
  ///   - build.yaml builder factories (see [_buildYamlFactories]);
  ///   - dart_dev's `tool/dart_dev/config.dart` top-level `config`.
  final entrySymbols = <String, Map<String, Object>>{};

  /// The package's pub name: the last `:` segment of the id (`pub:acme_x`, or
  /// `pub:<repo>:acme_x` → `acme_x`). `--package-name` overrides it.
  String get packageName => packageNameOverride ?? packageId.substring(packageId.lastIndexOf(':') + 1);

  /// `--package-name`: the pub name when the id does not end in it.
  final String? packageNameOverride;

  void addEntrySymbol(Element element, String why) {
    final decl = declarationOf(element);
    if (decl == null) return;
    final fragment = decl.firstFragment;
    final file = fragment.libraryFragment!.source.fullName;
    if (!isOwnFile(file)) return;
    final pos = position(fragment.libraryFragment!, fragment.nameOffset!);
    entrySymbols.putIfAbsent(pos.key, () => {'name': decl.name ?? why, ...pos.toJson()});
  }

  late final AnalysisContext context;

  String repoRel(String abs) => p.posix.joinAll(p.split(p.relative(abs, from: repoRoot)));

  bool isOwnFile(String abs) {
    final f = p.normalize(abs);
    if (!p.isWithin(packageRoot, f)) return false;
    final rel = p.split(p.relative(f, from: packageRoot));
    if (rel.any((s) => s == '.dart_tool' || s == 'build' || (s.startsWith('.') && s != '.' && s != '..'))) return false;
    return !nested.any((d) => d == f || p.isWithin(d, f));
  }

  Pos position(LibraryFragment fragment, int offset) {
    final loc = fragment.lineInfo.getLocation(offset);
    return Pos(repoRel(fragment.source.fullName), loc.lineNumber - 1, loc.columnNumber - 1);
  }

  Pos positionIn(String file, CompilationUnit unit, int offset) {
    final loc = unit.lineInfo.getLocation(offset);
    return Pos(repoRel(file), loc.lineNumber - 1, loc.columnNumber - 1);
  }

  Future<Map<String, Object>> compute() async {
    final collection = AnalysisContextCollection(includedPaths: [packageRoot], sdkPath: sdkPath);
    context = collection.contextFor(packageRoot);
    final session = context.currentSession;

    final entryPoints = <String>[];
    final missingEntryPoints = <String>[];
    final records = <ExportRecord>[];

    for (final entry in entries) {
      final abs = p.normalize(p.join(repoRoot, p.joinAll(p.posix.split(entry))));
      if (!File(abs).existsSync() || !isOwnFile(abs)) {
        missingEntryPoints.add(entry);
        continue;
      }
      entryPoints.add(entry);
      final relToPkg = p.posix.joinAll(p.split(p.relative(abs, from: packageRoot)));
      final isBin = relToPkg.startsWith('bin/');
      final isLibTop = relToPkg.startsWith('lib/') && !relToPkg.substring(4).contains('/');
      if (!isBin && !relToPkg.startsWith('lib/')) continue;
      final uri = session.uriConverter.pathToUri(abs);
      if (uri == null) {
        missingEntryPoints.add(entry);
        entryPoints.remove(entry);
        continue;
      }
      final lib = await session.getLibraryByUri(uri.toString());
      if (lib is! LibraryElementResult) {
        // A part file directly under lib/: its declarations belong to its library.
        diagnostics.add('info: entry $entry is not a library (${lib.runtimeType}); it exports nothing');
        continue;
      }
      // The runtime calls `main` of lib/main.dart (Flutter); nothing in code
      // references it. (bin/** is covered by the scan of files outside lib/.)
      if (isLibTop) _addMain(lib.element);
      // bin/ entries are programs: they export nothing (their files are still seeds).
      if (isBin) continue;
      records.addAll(await _exportsOf(entry, lib.element));
    }

    await _checkOwnFiles();
    await _buildYamlFactories();
    await _dartDevConfig();

    if (missingEntryPoints.isNotEmpty) {
      diagnostics.add('warn: entry point(s) not found, export surface unknown: ${missingEntryPoints.join(', ')}');
    }
    if (unresolved.isNotEmpty) {
      diagnostics.add('warn: unresolved export directives: ${(unresolved.toList()..sort()).join(', ')}');
    }

    records.sort((a, b) {
      int c;
      if ((c = a.entry.compareTo(b.entry)) != 0) return c;
      if ((c = a.exportedAs.compareTo(b.exportedAs)) != 0) return c;
      if ((c = a.pos.file.compareTo(b.pos.file)) != 0) return c;
      if ((c = a.pos.line - b.pos.line) != 0) return c;
      return a.pos.col - b.pos.col;
    });
    return {
      'packageId': packageId,
      'entryPoints': entryPoints,
      'missingEntryPoints': missingEntryPoints,
      'exports': [for (final r in records) r.toJson()],
      'unresolved': unresolved.toList()..sort(),
      'unresolvedImports': unresolvedImports,
      'flags': <Object>[],
      'namespaceMemberRefs': <Object>[],
      'unindexedImports': <Object>[],
      'entrySymbols': entrySymbols.values.toList()..sort(_byPosition),
      'unresolvedOrgModules': unresolvedOrgModules,
      'missingParts': missingParts,
      'unresolvedOwnUris': unresolvedOwnUris.length,
      'diagnostics': diagnostics,
    };
  }

  /// The declaration a namespace entry stands for: a synthetic getter/setter
  /// maps to its variable; anything without a source name is skipped.
  Element? declarationOf(Element element) {
    var e = element;
    if (e is PropertyAccessorElement) {
      if (e.isOriginVariable) {
        e = e.variable;
      } else if (!e.isOriginDeclaration) {
        return null;
      }
    }
    if (e is PropertyInducingElement && !e.isOriginDeclaration) return null;
    if (e is MultiplyDefinedElement) return null;
    final fragment = e.firstFragment;
    if (fragment.nameOffset == null || fragment.libraryFragment == null) return null;
    return e;
  }

  String declKey(Element decl) {
    final f = decl.firstFragment;
    return '${f.libraryFragment!.source.fullName}\u0000${f.nameOffset}';
  }

  Future<List<ExportRecord>> _exportsOf(String entry, LibraryElement library) async {
    final byKey = <String, List<ExportRecord>>{};
    final records = <ExportRecord>[];
    final seen = <String>{};
    library.exportNamespace.definedNames2.forEach((key, element) {
      final decl = declarationOf(element);
      if (decl == null) return;
      final fragment = decl.firstFragment;
      final file = fragment.libraryFragment!.source.fullName;
      if (!isOwnFile(file)) return; // re-exported from another package
      final exportedAs = key.endsWith('=') ? key.substring(0, key.length - 1) : key;
      final k = declKey(decl);
      if (!seen.add('$exportedAs\u0000$k')) return;
      final r = ExportRecord(entry, exportedAs, decl.name ?? exportedAs,
          position(fragment.libraryFragment!, fragment.nameOffset!));
      records.add(r);
      (byKey[k] ??= []).add(r);
    });

    // Sites: identifiers in show/hide combinators of the export directives on the
    // chain from the entry through the package's own libraries. SCIP records them as
    // references from the directive's file; they are not uses.
    final visited = <LibraryElement>{};
    final queue = <LibraryElement>[library];
    while (queue.isNotEmpty) {
      final lib = queue.removeLast();
      if (!visited.add(lib)) continue;
      for (final fragment in lib.fragments) {
        final file = fragment.source.fullName;
        if (!isOwnFile(file)) continue;
        final exports = fragment.libraryExports;
        if (exports.isEmpty) continue;
        final parsed = context.currentSession.getParsedUnit(file);
        if (parsed is! ParsedUnitResult) continue;
        final directives = {
          for (final d in parsed.unit.directives.whereType<ExportDirective>()) d.exportKeyword.offset: d,
        };
        for (final exp in exports) {
          final target = exp.exportedLibrary;
          final uriText = _uriText(exp.uri);
          if (target == null || target.isOriginNotExistingFile) {
            if (_ownUriUnresolvable(file, uriText)) continue;
            unresolved.add("${repoRel(file)}: export '$uriText'");
            continue;
          }
          if (target.firstFragment.source.fullName.isNotEmpty && isOwnFile(target.firstFragment.source.fullName)) {
            queue.add(target);
          }
          final directive = directives[exp.exportKeywordOffset];
          if (directive == null) continue;
          for (final combinator in directive.combinators) {
            final names = switch (combinator) {
              ShowCombinator c => c.shownNames,
              HideCombinator c => c.hiddenNames,
            };
            for (final id in names) {
              for (final key in [id.name, '${id.name}=']) {
                final el = target.exportNamespace.get2(key);
                if (el == null) continue;
                final decl = declarationOf(el);
                if (decl == null) continue;
                final site = positionIn(file, parsed.unit, id.offset);
                for (final r in byKey[declKey(decl)] ?? const <ExportRecord>[]) {
                  if (!r.sites.any((s) => s.key == site.key)) r.sites.add(site);
                }
              }
            }
          }
        }
      }
    }
    return records;
  }

  String _uriText(DirectiveUri uri) => uri is DirectiveUriWithRelativeUriString ? uri.relativeUriString : '?';

  /// `package:<name>/...` → name, else null.
  String? _packageOf(String uri) {
    if (!uri.startsWith('package:')) return null;
    final rest = uri.substring('package:'.length);
    final slash = rest.indexOf('/');
    return slash <= 0 ? null : rest.substring(0, slash);
  }

  /// Consumer checks over every own file (libraries and parts), plus analyzer errors.
  Future<void> _checkOwnFiles() async {
    final session = context.currentSession;
    final files = context.contextRoot.analyzedFiles().where((f) => f.endsWith('.dart') && isOwnFile(f)).toList()
      ..sort();
    var errorCount = 0;
    final reported = <String>[];
    for (final file in files) {
      final unitResult = await session.getUnitElement(file);
      final parsed = session.getParsedUnit(file);
      final errors = await session.getErrors(file);
      final errorList = errors is ErrorsResult ? errors.diagnostics : const <Diagnostic>[];
      final missingPartOffsets = <int>{};
      if (unitResult is UnitElementResult && parsed is ParsedUnitResult) {
        final fragment = unitResult.fragment;
        // A program outside lib/ (the library's defining file, not a part).
        final relToPkg = p.posix.joinAll(p.split(p.relative(file, from: packageRoot)));
        if (!relToPkg.startsWith('lib/') && fragment.element.firstFragment.source.fullName == file) {
          _addMain(fragment.element);
        }
        // A part whose file does not exist: the library is incomplete.
        for (final d in parsed.unit.directives.whereType<PartDirective>()) {
          final missing = errorList.any((e) =>
              e.offset == d.uri.offset && _missingUriCodes.contains(e.diagnosticCode.lowerCaseName));
          if (!missing) continue;
          missingPartOffsets.add(d.uri.offset);
          missingParts.add({
            'uri': d.uri.stringValue ?? d.uri.toSource(),
            ...positionIn(file, parsed.unit, d.uri.offset).toJson(),
          });
        }
        final imports = {
          for (final d in parsed.unit.directives.whereType<ImportDirective>()) d.importKeyword.offset: d,
        };
        final exports = {
          for (final d in parsed.unit.directives.whereType<ExportDirective>()) d.exportKeyword.offset: d,
        };
        for (final imp in fragment.libraryImports) {
          if (imp.isSynthetic) continue;
          _checkDirective(file, parsed.unit, imp.uri, imp.importedLibrary, imports[imp.importKeywordOffset]);
        }
        for (final exp in fragment.libraryExports) {
          _checkDirective(file, parsed.unit, exp.uri, exp.exportedLibrary, exports[exp.exportKeywordOffset]);
        }
      }
      if (errors is ErrorsResult) {
        for (final d in errors.diagnostics) {
          if (d.severity != Severity.error) continue;
          if (missingPartOffsets.contains(d.offset)) continue; // reported as a missing part
          errorCount++;
          if (reported.length < maxReportedDiagnostics) {
            final loc = errors.lineInfo.getLocation(d.offset);
            reported.add('warn: ${repoRel(file)}:${loc.lineNumber}:${loc.columnNumber} '
                '${d.diagnosticCode.lowerCaseName}: ${d.message}');
          }
        }
      }
    }
    if (errorCount > 0) {
      diagnostics.add('warn: $errorCount Dart analyzer error diagnostic(s) in the package (status unaffected)');
      diagnostics.addAll(reported);
    }
  }

  static int _byPosition(Map<String, Object> a, Map<String, Object> b) {
    final c = (a['file'] as String).compareTo(b['file'] as String);
    if (c != 0) return c;
    final l = (a['line'] as int) - (b['line'] as int);
    return l != 0 ? l : (a['col'] as int) - (b['col'] as int);
  }

  /// Analyzer codes for a directive URI whose file does not exist.
  static const _missingUriCodes = {'uri_has_not_been_generated', 'uri_does_not_exist'};

  /// The `main` the runtime calls when [library] is run: the one in its
  /// export namespace, declared in the library or re-exported
  /// (`bin/foo.dart` = `export 'package:foo/src/foo.dart';`, Workiva's
  /// executables), recorded at its declaration when that is one of this
  /// package's files. Nothing references a re-exported main either: without
  /// it everything the program reaches looked unreachable.
  void _addMain(LibraryElement library) {
    final main = library.exportNamespace.get2('main');
    if (main is TopLevelFunctionElement) {
      addEntrySymbol(main, 'main');
      return;
    }
    for (final fn in library.topLevelFunctions) {
      if (fn.name == 'main') addEntrySymbol(fn, 'main');
    }
  }

  /// build_runner loads builders by name: for each `builders.<b>` (and
  /// `post_process_builders.<b>`) in the package's build.yaml, the
  /// `builder_factories` (`builder_factory`) are top-level functions of the
  /// `import:` library. Nothing in code references them.
  Future<void> _buildYamlFactories() async {
    final file = File(p.join(packageRoot, 'build.yaml'));
    if (!file.existsSync()) return;
    Object? doc;
    try {
      doc = loadYaml(file.readAsStringSync());
    } on Exception catch (e) {
      diagnostics.add('warn: build.yaml does not parse, builder factories unknown: ${e.toString().split('\n').first}');
      return;
    }
    if (doc is! Map) return;
    for (final section in ['builders', 'post_process_builders']) {
      final builders = doc[section];
      if (builders is! Map) continue;
      for (final MapEntry(key: name, value: b) in builders.entries) {
        if (b is! Map) continue;
        final import = b['import'];
        final factories = <String>[
          if (b['builder_factories'] is List) ...(b['builder_factories'] as List).whereType<String>(),
          if (b['builder_factory'] is String) b['builder_factory'] as String,
        ];
        if (import is! String || factories.isEmpty) continue;
        final uri = Uri.tryParse(import);
        if (uri == null || uri.scheme != 'package' || uri.pathSegments.isEmpty || uri.pathSegments.first != packageName) {
          diagnostics.add('info: build.yaml $section.$name imports $import (not this package); its factories are not ours');
          continue;
        }
        final lib = await context.currentSession.getLibraryByUri(import);
        if (lib is! LibraryElementResult) {
          diagnostics.add('warn: build.yaml $section.$name: $import does not resolve; builder factories ${factories.join(', ')} unknown');
          continue;
        }
        for (final f in factories) {
          final element = lib.element.exportNamespace.get2(f) ?? _topLevel(lib.element, f);
          if (element == null) {
            diagnostics.add('warn: build.yaml $section.$name: $f is not declared in $import');
            continue;
          }
          addEntrySymbol(element, f);
        }
      }
    }
  }

  /// A top-level function or variable named [name] declared in [library].
  Element? _topLevel(LibraryElement library, String name) {
    for (final e in [...library.topLevelFunctions, ...library.topLevelVariables]) {
      if (e.name == name) return e;
    }
    return null;
  }

  /// dart_dev (Workiva's task runner) reads the top-level `config` of
  /// tool/dart_dev/config.dart: `dart run dart_dev` generates a run script that
  /// imports that library and passes `config` to the runner.
  Future<void> _dartDevConfig() async {
    final file = p.join(packageRoot, 'tool', 'dart_dev', 'config.dart');
    if (!File(file).existsSync() || !isOwnFile(file)) return;
    final unit = await context.currentSession.getUnitElement(file);
    if (unit is! UnitElementResult) return;
    final element = _topLevel(unit.fragment.element, 'config');
    if (element != null) addEntrySymbol(element, 'config');
  }

  void _checkDirective(
    String file,
    CompilationUnit unit,
    DirectiveUri uri,
    LibraryElement? target,
    NamespaceDirective? directive,
  ) {
    final text = _uriText(uri);
    final pkg = _packageOf(text);
    final relative = !text.contains(':');
    // Org packages (incl. this one) and relative URIs: unresolved means
    // references through the directive vanish from the index.
    if (!relative && (pkg == null || !orgPackages.contains(pkg))) return;
    final at = directive == null ? null : positionIn(file, unit, directive.uri.offset);
    if (target == null || target.isOriginNotExistingFile) {
      if (_ownUriUnresolvable(file, text)) return;
      unresolvedOrgModules.add({
        'module': text,
        if (at != null) ...at.toJson() else ...{'file': repoRel(file), 'line': 0, 'col': 0},
      });
      return;
    }
    if (relative || directive == null) return;
    // A shown name the org library does not export: version skew.
    for (final c in directive.combinators.whereType<ShowCombinator>()) {
      for (final id in c.shownNames) {
        final ns = target.exportNamespace;
        if (ns.get2(id.name) != null || ns.get2('${id.name}=') != null) continue;
        unresolvedImports.add({'module': text, 'name': id.name, ...positionIn(file, unit, id.offset).toJson()});
      }
    }
  }
}
