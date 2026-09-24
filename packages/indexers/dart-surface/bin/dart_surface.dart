// Export-surface sidecar for one pub package (sentei, PLAN.md §6.3 step 5, §6.6).
//
// SCIP carries no export information, so the Dart adapter
// (packages/cli/src/indexers/scip-dart.ts) runs this next to scip-dart and
// writes its output as `<slug>.exports.json`. Output (stdout, JSON) is the
// sidecar shape of packages/cli/src/indexers/types.ts `ExportsSidecar` (incl.
// `entrySymbols`: top-level `main` of bin/** and lib/*.dart entries), plus two
// adapter-only keys the adapter strips before writing the sidecar:
//   - `unresolvedOrgModules`: org (or own relative) import/export URIs that do
//     not resolve; references through them vanish silently → status partial;
//   - `diagnostics`: `warn:` lines (analyzer errors; never change status).
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

/// Cap on analyzer errors copied into `diagnostics` (the count is always reported).
const maxReportedDiagnostics = 20;

Future<void> main(List<String> argv) async {
  final parser = ArgParser()
    ..addOption('repo-root', mandatory: true, help: 'Repo root (paths in the output are relative to it)')
    ..addOption('package-root', mandatory: true, help: 'Package dir (holds pubspec.yaml)')
    ..addOption('package-id', mandatory: true, help: 'e.g. pub:acme_x')
    ..addMultiOption('entry', help: 'Entry file, repo-relative POSIX (repeatable)')
    ..addOption('org-packages', defaultsTo: '', help: 'Comma-separated pub names of all org packages')
    ..addMultiOption('nested', help: 'Dir of a package nested inside this one (its files are not ours)')
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

  Surface({
    required this.repoRoot,
    required this.packageRoot,
    required this.packageId,
    required this.entries,
    required this.orgPackages,
    required this.nested,
  });

  final diagnostics = <String>[];
  final unresolved = <String>{};
  final unresolvedImports = <Map<String, Object>>[];
  final unresolvedOrgModules = <Map<String, Object>>[];

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
    final collection = AnalysisContextCollection(includedPaths: [packageRoot]);
    context = collection.contextFor(packageRoot);
    final session = context.currentSession;

    final entryPoints = <String>[];
    final missingEntryPoints = <String>[];
    final records = <ExportRecord>[];
    final entrySymbols = <Map<String, Object>>[];

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
      // The runtime calls `main` of a program entry (bin/**, or lib/main.dart in
      // Flutter); nothing in code references it.
      if (isBin || isLibTop) {
        for (final fn in lib.element.topLevelFunctions) {
          final fragment = fn.firstFragment;
          if (fn.name != 'main' || fragment.nameOffset == null) continue;
          if (!isOwnFile(fragment.libraryFragment.source.fullName)) continue;
          entrySymbols.add({'name': 'main', ...position(fragment.libraryFragment, fragment.nameOffset!).toJson()});
        }
      }
      // bin/ entries are programs: they export nothing (their files are still seeds).
      if (isBin) continue;
      records.addAll(await _exportsOf(entry, lib.element));
    }

    await _checkOwnFiles();

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
      'entrySymbols': entrySymbols,
      'unresolvedOrgModules': unresolvedOrgModules,
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
      if (unitResult is UnitElementResult && parsed is ParsedUnitResult) {
        final fragment = unitResult.fragment;
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
      final errors = await session.getErrors(file);
      if (errors is ErrorsResult) {
        for (final d in errors.diagnostics) {
          if (d.severity != Severity.error) continue;
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
