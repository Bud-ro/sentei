// M3: the scip-dart adapter on a temp copy of fixtures/org-dart (plus one broken
// consumer), and the pubspec_overrides.yaml source-link writer.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { parseDescriptors, parseScipSymbol, readScipIndex } from '@sentei/core/scip';
import { snapshotScip } from '@sentei/core/scip/snapshot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BUILD_RUNNER_TIMEOUT_MS,
  buildRunner,
  DART_SURFACE_DIR,
  flutterReason,
  missingGeneratedParts,
  OVERRIDES_HEADER,
  ownLibDartFiles,
  parseOverrideConflicts,
  parseYamlBlock,
  pubGet,
  pubspecWorkspaceKeys,
  pubWorkspaceOf,
  SCIP_DART_DIR,
  scipDart,
  setFlutterSdkForTests,
  workspaceRootOf,
  writeOverrides,
} from '../src/indexers/scip-dart.ts';
import type { DiscoverFile, DiscoveredPackage, DiscoveredRepo, ExportsSidecar, IndexerInput, OrgPackage } from '../src/indexers/types.ts';
import { scipTypescript } from '../src/indexers/scip-typescript.ts';
import { index, type RepoIndex } from '../src/stages/index.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/org-dart');
const HAS_DART = spawnSync('dart', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!HAS_DART) console.warn('[index-dart.test] SKIPPING scip-dart indexing tests: `dart` is not on PATH');
const HAS_FLUTTER = spawnSync('flutter', ['--version', '--machine'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!HAS_FLUTTER) console.warn('[index-dart.test] SKIPPING Flutter indexing tests (fixtures/org-dart flutter-*): `flutter` is not on PATH');

/** Copy options that never carry pub state left in the fixture by a manual run. */
const NO_PUB_STATE = {
  recursive: true,
  filter: (src: string) => !['.dart_tool', 'pubspec.lock', 'pubspec_overrides.yaml'].includes(path.basename(src)),
};

function readJson<T>(...p: string[]): T {
  return JSON.parse(readFileSync(path.join(...p), 'utf8')) as T;
}

function pubPackage(name: string, entryPoints: string[], deps: DiscoveredPackage['deps'] = []): DiscoveredPackage {
  return { packageId: `pub:${name}`, path: '.', manager: 'pub', name, version: '1.0.0', entryPoints, deps };
}

function repoOf(tmp: string, name: string, pkg: DiscoveredPackage): DiscoveredRepo {
  return { repo: `acme/${name}`, localPath: path.join(tmp, 'repos', name), defaultBranch: 'main', headSha: null, packages: [pkg] };
}

const orgDep = (name: string, constraint: string) => ({ name, manager: 'pub', constraint, resolvedPackageId: `pub:${name}` });

describe.skipIf(!HAS_DART)('index stage with scip-dart on fixtures/org-dart', () => {
  let tmp: string;
  let work: string;
  const lines: string[] = [];

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-index-dart-')));
    cpSync(path.join(FIXTURE, 'repos'), path.join(tmp, 'repos'), NO_PUB_STATE);
    // A test's main is run by the test runner: never an entry symbol.
    mkdirSync(path.join(tmp, 'repos/dart-lib-x/test'), { recursive: true });
    writeFileSync(path.join(tmp, 'repos/dart-lib-x/test/x_test.dart'), "import 'package:acme_x/acme_x.dart';\n\nvoid main() => print(usedFn());\n");
    // A consumer whose org import does not resolve (partial) and that shows a
    // name acme_x does not export (version skew, status unchanged).
    const bad = path.join(tmp, 'repos', 'dart-bad');
    mkdirSync(path.join(bad, 'bin'), { recursive: true });
    writeFileSync(
      path.join(bad, 'pubspec.yaml'),
      'name: acme_bad\nversion: 1.0.0\npublish_to: none\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  acme_x: ^1.0.0\n',
    );
    writeFileSync(
      path.join(bad, 'bin', 'main.dart'),
      [
        "import 'package:acme_x/acme_x.dart' show usedFn, removedFn;",
        "import 'package:acme_x/nope.dart';",
        'void main() => print(usedFn());',
        '',
      ].join('\n'),
    );
    work = path.join(tmp, 'work');
    mkdirSync(work);
    const discover: DiscoverFile = {
      org: 'acme',
      repos: [
        repoOf(tmp, 'dart-app', pubPackage('acme_app', ['bin/main.dart', 'bin/shapes.dart'], [orgDep('acme_pub', '^1.0.0'), orgDep('acme_x', 'path:../dart-lib-x')])),
        repoOf(tmp, 'dart-bad', pubPackage('acme_bad', ['bin/main.dart'], [orgDep('acme_x', '^1.0.0')])),
        repoOf(tmp, 'dart-lib-pub', pubPackage('acme_pub', ['lib/acme_pub.dart'])),
        repoOf(tmp, 'dart-lib-x', pubPackage('acme_x', ['lib/acme_x.dart', 'lib/builder.dart', 'lib/syntax.dart'])),
      ],
    };
    writeFileSync(path.join(work, 'discover.json'), JSON.stringify(discover, null, 2));
    const ctx = { work, dbPath: '', db: undefined as unknown as DatabaseSync, log: (l: string) => lines.push(l) };
    await index(ctx, { install: false });
  }, 600_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const ix = (repo: string) => readJson<RepoIndex>(work, 'index', `acme__${repo}`, 'index.json');
  const sidecar = (repo: string, pkg: string) => readJson<ExportsSidecar>(work, 'index', `acme__${repo}`, `pub__${pkg}.exports.json`);

  it('writes a non-empty .scip file per fixture package, all ok', () => {
    for (const [repo, pkg] of [['dart-app', 'acme_app'], ['dart-lib-pub', 'acme_pub'], ['dart-lib-x', 'acme_x']]) {
      const scip = path.join(work, 'index', `acme__${repo}`, `pub__${pkg}.scip`);
      expect(existsSync(scip), scip).toBe(true);
      expect(statSync(scip).size, scip).toBeGreaterThan(0);
      const r = ix(repo!);
      expect(r.status, `${repo}: ${JSON.stringify(r.packages[0]?.diagnostics)}`).toBe('ok');
      expect(r.packages[0]).toMatchObject({
        packageId: `pub:${pkg}`,
        indexer: 'scip-dart',
        indexerVersion: '1.7.0+sentei.9',
        status: 'ok',
        scip: `pub__${pkg}.scip`,
        exports: `pub__${pkg}.exports.json`,
      });
      expect(existsSync(path.join(work, 'index', `acme__${repo}`, `pub__${pkg}.log`))).toBe(true);
    }
  });

  it('source-links org deps with pubspec_overrides.yaml in the consumer only', () => {
    const overrides = readFileSync(path.join(tmp, 'repos/dart-app/pubspec_overrides.yaml'), 'utf8');
    expect(overrides).toBe(
      `${OVERRIDES_HEADER}\ndependency_overrides:\n  acme_pub:\n    path: ../dart-lib-pub\n  acme_x:\n    path: ../dart-lib-x\n`,
    );
    expect(readFileSync(path.join(tmp, 'repos/dart-app/pubspec.yaml'), 'utf8')).toBe(
      readFileSync(path.join(FIXTURE, 'repos/dart-app/pubspec.yaml'), 'utf8'),
    );
    expect(existsSync(path.join(tmp, 'repos/dart-app/.sentei-backup'))).toBe(false);
    expect(existsSync(path.join(tmp, 'repos/dart-lib-x/pubspec_overrides.yaml'))).toBe(false);
    expect(existsSync(path.join(tmp, 'repos/dart-lib-pub/pubspec_overrides.yaml'))).toBe(false);
    expect(ix('dart-app').packages[0]!.diagnostics).toContain(
      'info: pubspec_overrides.yaml: acme_pub -> ../dart-lib-pub, acme_x -> ../dart-lib-x',
    );
  });

  it('lists exactly the acme_x export surface, following export, export show, and part', () => {
    const s = sidecar('dart-lib-x', 'acme_x');
    expect(s).toMatchObject({
      packageId: 'pub:acme_x',
      entryPoints: ['lib/acme_x.dart', 'lib/builder.dart', 'lib/syntax.dart'],
      missingEntryPoints: [],
      unresolved: [],
      unresolvedImports: [],
      flags: [],
      namespaceMemberRefs: [],
      unindexedImports: [],
    });
    const rows = s.exports.map((e) => [e.exportedAs, e.name, e.file, e.line, e.col]);
    expect(rows).toEqual([
      ['IntTimes', 'IntTimes', 'lib/acme_x.dart', 29, 10],
      ['Shown', 'Shown', 'lib/src/shown.dart', 3, 6],
      ['docOnly', 'docOnly', 'lib/acme_x.dart', 37, 4],
      ['implUnused', 'implUnused', 'lib/src/impl.dart', 6, 4],
      ['implUsed', 'implUsed', 'lib/src/impl.dart', 3, 4],
      ['partUnused', 'partUnused', 'lib/src/part_a.dart', 8, 4],
      ['partUsed', 'partUsed', 'lib/src/part_a.dart', 5, 4],
      ['shownOnly', 'shownOnly', 'lib/src/impl.dart', 10, 4],
      ['unusedFn', 'unusedFn', 'lib/acme_x.dart', 15, 4],
      ['usedFn', 'usedFn', 'lib/acme_x.dart', 12, 4],
      ['acmeBuilder', 'acmeBuilder', 'lib/builder.dart', 5, 7],
      ['Mapper', 'Mapper', 'lib/syntax.dart', 36, 8],
      ['Vec', 'Vec', 'lib/syntax.dart', 9, 6],
      ['labelOf', 'labelOf', 'lib/syntax.dart', 39, 7],
    ]);
    for (const e of s.exports) expect(e.entry).toBe(e.file.startsWith('lib/src/') ? 'lib/acme_x.dart' : e.file);
    // `export 'src/shown.dart' show Shown;` (line 7): the shown name is a site, not a use.
    const shown = s.exports.find((e) => e.name === 'Shown')!;
    expect(shown.sites).toEqual([{ file: 'lib/acme_x.dart', line: 6, col: 'export \'src/shown.dart\' show '.length }]);
    for (const e of s.exports.filter((x) => x.name !== 'Shown')) expect(e.sites).toEqual([]);
  });

  it('bin entries are listed, export nothing, and record their main as an entry symbol', () => {
    const s = sidecar('dart-app', 'acme_app');
    expect(s.entryPoints).toEqual(['bin/main.dart', 'bin/shapes.dart']);
    expect(s.exports).toEqual([]);
    expect(s.unresolvedImports).toEqual([]);
    // `void main() {` on line 10: the runtime calls it, nothing references it.
    expect(s.entrySymbols).toEqual([
      { name: 'main', file: 'bin/clock.dart', line: 4, col: 5, kind: 'runtime' },
      { name: 'main', file: 'bin/main.dart', line: 9, col: 5, kind: 'runtime' },
      { name: 'main', file: 'bin/shapes.dart', line: 4, col: 5, kind: 'runtime' },
    ]);
    expect(sidecar('dart-bad', 'acme_bad').entrySymbols).toEqual([{ name: 'main', file: 'bin/main.dart', line: 2, col: 5, kind: 'runtime' }]);
  });

  it('records Dart entry conventions: main outside lib/ (not tests), build.yaml builder factories, dart_dev config', () => {
    // Positions are the declarations' names, as SCIP defines them (ingest matches on them).
    expect(sidecar('dart-lib-x', 'acme_x').entrySymbols).toEqual([
      { name: 'main', file: 'benchmark/bench.dart', line: 5, col: 5, kind: 'runtime' }, // runnable script, not a discover entry
      { name: 'acmeBuilder', file: 'lib/builder.dart', line: 5, col: 7, kind: 'runtime' }, // build.yaml builder_factories
      { name: 'config', file: 'tool/dart_dev/config.dart', line: 5, col: 6, kind: 'runtime' }, // dart_dev convention
    ]); // test/x_test.dart's main is not one
    const lib = readScipIndex(path.join(work, 'index/acme__dart-lib-x/pub__acme_x.scip'));
    const defs = new Set(
      lib.documents.flatMap((d) => d.occurrences.filter((o) => (o.symbolRoles & 1) === 1).map((o) => `${d.relativePath}:${o.range[0]}:${o.range[1]} ${o.symbol}`)),
    );
    expect(defs).toContain('benchmark/bench.dart:5:5 scip-dart pub acme_x 1.0.0 benchmark/`bench.dart`/main().');
    expect(defs).toContain('lib/builder.dart:5:7 scip-dart pub acme_x 1.0.0 lib/`builder.dart`/acmeBuilder().');
    expect(defs).toContain('tool/dart_dev/config.dart:5:6 scip-dart pub acme_x 1.0.0 tool/dart_dev/`config.dart`/config.');
  });

  it('emits only valid SCIP symbols: operators backticked, nameless elements and import prefixes local (fork patch 3)', () => {
    const symbolsOf = (file: string) => {
      const idx = readScipIndex(path.join(work, 'index', file));
      return idx.documents.flatMap((d) => d.occurrences.map((o) => ({ file: d.relativePath, def: (o.symbolRoles & 1) === 1, symbol: o.symbol, line: o.range[0]! })));
    };
    const all = [...symbolsOf('acme__dart-lib-x/pub__acme_x.scip'), ...symbolsOf('acme__dart-app/pub__acme_app.scip')];
    for (const { symbol } of all) {
      expect(symbol).not.toMatch(/\bnull\b/);
      const p = parseScipSymbol(symbol);
      if (p.local) continue;
      const ds = parseDescriptors(p.descriptors); // throws on a malformed symbol
      for (const d of ds) expect(d.name, symbol).not.toBe('');
    }
    const syntax = all.filter((o) => o.file === 'lib/syntax.dart');
    const defsAt = (line: number) => syntax.filter((o) => o.def && o.line === line).map((o) => o.symbol);
    const X = 'scip-dart pub acme_x 1.0.0 lib/`syntax.dart`/';
    expect(defsAt(17)).toEqual([`${X}Vec#\`==\`().`, 'local 1']); // operator == (and its parameter)
    expect(defsAt(24)).toEqual([`${X}Vec#\`[]\`().`, 'local 2']); // operator []
    expect(defsAt(6)).toEqual(['local 0']); // import prefix `p`: not a declaration
    expect(defsAt(29)).toEqual(['local 3']); // unnamed extension
    expect(defsAt(30)).toEqual(['local 4']); // its getter
    expect(defsAt(36)).toEqual([`${X}Mapper#`, 'local 5']); // typedef; T of the generic function type
    // Every operator anywhere is backticked.
    for (const { symbol } of all) expect(symbol).not.toMatch(/#(==|\[\]=?|<=?|>=?|[%*\/~^|&])\(\)\./);
  });

  it('records no occurrence for a dartdoc [Name] link (fork patch 4)', () => {
    const lib = readScipIndex(path.join(work, 'index/acme__dart-lib-x/pub__acme_x.scip'));
    const entry = lib.documents.find((d) => d.relativePath === 'lib/acme_x.dart')!;
    const docOnly = 'scip-dart pub acme_x 1.0.0 lib/`acme_x.dart`/docOnly().';
    // `  /// Twice the value. See [docOnly].` on line 32: a doc link, not a use.
    const line = readFileSync(path.join(FIXTURE, 'repos/dart-lib-x/lib/acme_x.dart'), 'utf8').split('\n')[31]!;
    expect(line).toContain('[docOnly]');
    expect(entry.occurrences.filter((o) => o.range[0] === 31)).toEqual([]);
    expect(entry.occurrences.filter((o) => o.symbol === docOnly).map((o) => [o.range[0], o.symbolRoles & 1])).toEqual([[37, 1]]);
  });

  it('gives private declarations global symbols (patched scip-dart), consumer refs carry the lib symbols', () => {
    const lib = readScipIndex(path.join(work, 'index/acme__dart-lib-x/pub__acme_x.scip'));
    const entry = lib.documents.find((d) => d.relativePath === 'lib/acme_x.dart')!;
    const island = 'scip-dart pub acme_x 1.0.0 lib/`acme_x.dart`/_islandA().';
    expect(entry.symbols.map((s) => s.symbol)).toContain(island);
    expect(entry.occurrences.some((o) => o.symbol === island && (o.symbolRoles & 1) === 1)).toBe(true);
    expect(entry.occurrences.some((o) => o.symbol === island && (o.symbolRoles & 1) === 0)).toBe(true); // from _islandB

    const app = readScipIndex(path.join(work, 'index/acme__dart-app/pub__acme_app.scip'));
    const refs = new Set(app.documents.flatMap((d) => d.occurrences.map((o) => o.symbol)));
    expect(refs).toContain('scip-dart pub acme_x 1.0.0 lib/`acme_x.dart`/usedFn().');
    expect(refs).toContain('scip-dart pub acme_x 1.0.0 lib/src/`part_a.dart`/partUsed().');
    expect(refs).toContain('scip-dart pub acme_pub 1.0.0 lib/`acme_pub.dart`/pubUsed().'); // hosted constraint, source-linked
  });

  it('an unresolved org import makes the consumer partial; a missing shown name is version skew', () => {
    const r = ix('dart-bad');
    expect(r.status).toBe('partial');
    expect(r.packages[0]!.diagnostics).toContain("error: unresolved org module 'package:acme_x/nope.dart' at bin/main.dart:2:8");
    expect(r.packages[0]!.diagnostics).toContain(
      "warn: 'removedFn' is not exported by org module 'package:acme_x/acme_x.dart' at bin/main.dart:1:50",
    );
    expect(r.packages[0]!.diagnostics.some((d) => /^warn: \d+ Dart analyzer error diagnostic/.test(d))).toBe(true);
    expect(sidecar('dart-bad', 'acme_bad').unresolvedImports).toEqual([
      { module: 'package:acme_x/acme_x.dart', name: 'removedFn', file: 'bin/main.dart', line: 0, col: 49 },
    ]);
    expect(lines.some((l) => l.includes('pub:acme_bad: partial'))).toBe(true);
  });
});

describe.skipIf(!HAS_DART || !HAS_FLUTTER)(`index stage with scip-dart on the Flutter packages of fixtures/org-dart${HAS_FLUTTER ? '' : ' (skipped: `flutter` is not on PATH)'}`, () => {
  let tmp: string;
  let work: string;
  const flutterDep = { name: 'flutter', manager: 'pub', constraint: 'sdk:flutter', resolvedPackageId: null };

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-index-flutter-')));
    for (const r of ['flutter-widgets', 'flutter-app']) cpSync(path.join(FIXTURE, 'repos', r), path.join(tmp, 'repos', r), NO_PUB_STATE);
    work = path.join(tmp, 'work');
    mkdirSync(work);
    const discover: DiscoverFile = {
      org: 'acme',
      repos: [
        repoOf(tmp, 'flutter-app', pubPackage('acme_flutter_app', ['lib/main.dart'], [flutterDep, orgDep('acme_widgets', 'path:../flutter-widgets')])),
        repoOf(tmp, 'flutter-widgets', pubPackage('acme_widgets', ['lib/acme_widgets.dart'], [flutterDep])),
      ],
    };
    writeFileSync(path.join(work, 'discover.json'), JSON.stringify(discover, null, 2));
    await index({ work, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} }, { install: false });
  }, 600_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const ix = (repo: string) => readJson<RepoIndex>(work, 'index', `acme__${repo}`, 'index.json');
  const sidecar = (repo: string, pkg: string) => readJson<ExportsSidecar>(work, 'index', `acme__${repo}`, `pub__${pkg}.exports.json`);

  it('resolves both with flutter pub get; package:flutter and dart:ui resolve (no analyzer errors)', () => {
    for (const [repo, pkg] of [['flutter-widgets', 'acme_widgets'], ['flutter-app', 'acme_flutter_app']] as const) {
      const p = ix(repo).packages[0]!;
      expect(p.status, `${repo}: ${JSON.stringify(p.diagnostics)}`).toBe('ok');
      expect(p.packageId).toBe(`pub:${pkg}`);
      expect(p.diagnostics).toContain('info: ran flutter pub get --offline');
      expect(p.diagnostics.some((d) => d.startsWith('info: Flutter package (depends on flutter); Flutter SDK '))).toBe(true);
      expect(p.diagnostics.filter((d) => d.startsWith('warn:') || d.startsWith('error:'))).toEqual([]);
      const log = readFileSync(path.join(work, 'index', `acme__${repo}`, `pub__${pkg}.log`), 'utf8');
      expect(log).toMatch(/\$ dart run scip_dart --private-symbols --sdk-path \S+[\/\\]bin[\/\\]cache[\/\\]dart-sdk /);
    }
    // Flutter's package config points into the SDK (no pub-cache copy of flutter).
    const config = readJson<{ packages: Array<{ name: string; rootUri: string }> }>(tmp, 'repos/flutter-app/.dart_tool/package_config.json');
    expect(config.packages.find((x) => x.name === 'flutter')?.rootUri).toMatch(/\/packages\/flutter\/?$/);
    expect(config.packages.find((x) => x.name === 'sky_engine')?.rootUri).toMatch(/\/bin\/cache\/pkg\/sky_engine\/?$/);
  });

  it('exports both widgets; lib/main.dart main is a runtime entry symbol', () => {
    expect(sidecar('flutter-widgets', 'acme_widgets').exports.map((e) => [e.exportedAs, e.file, e.line, e.col])).toEqual([
      ['AcmeBanner', 'lib/acme_widgets.dart', 14, 6],
      ['AcmeButton', 'lib/acme_widgets.dart', 4, 6],
    ]);
    const app = sidecar('flutter-app', 'acme_flutter_app');
    expect(app.exports.map((e) => e.exportedAs)).toEqual(['main']);
    expect(app.entrySymbols).toEqual([{ name: 'main', file: 'lib/main.dart', line: 5, col: 5, kind: 'runtime' }]);
  });

  it('consumer references carry acme_widgets symbols and resolve into the Flutter framework', () => {
    const app = readScipIndex(path.join(work, 'index/acme__flutter-app/pub__acme_flutter_app.scip'));
    const refs = new Set(app.documents.flatMap((d) => d.occurrences.map((o) => o.symbol)));
    expect(refs).toContain('scip-dart pub acme_widgets 1.0.0 lib/`acme_widgets.dart`/AcmeButton#`<constructor>`().');
    expect([...refs].some((r) => /^scip-dart pub flutter \S+ lib\/src\/widgets\/`binding\.dart`\/runApp\(\)\.$/.test(r)), [...refs].join('\n')).toBe(true);
    expect([...refs].some((r) => /^scip-dart pub flutter \S+ lib\/src\/material\/`app\.dart`\/MaterialApp#/.test(r))).toBe(true);
    const lib = readScipIndex(path.join(work, 'index/acme__flutter-widgets/pub__acme_widgets.scip'));
    const libRefs = new Set(lib.documents.flatMap((d) => d.occurrences.map((o) => o.symbol)));
    expect([...libRefs].some((r) => /^scip-dart pub flutter \S+ lib\/src\/widgets\/`framework\.dart`\/StatelessWidget#$/.test(r))).toBe(true);
  });
});

describe('pub workspace detection', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-ws-detect-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function write(files: Record<string, string>): void {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), body);
    }
  }
  const pkgAt = (p: string, name: string): DiscoveredPackage => ({ packageId: `pub:${name}`, path: p, manager: 'pub', name, entryPoints: [], deps: [] });

  it('reads the two workspace keys of a pubspec', () => {
    expect(pubspecWorkspaceKeys('name: ws\nworkspace:\n  - a\n')).toEqual({ root: true, member: false });
    expect(pubspecWorkspaceKeys('name: a\nresolution: workspace # since Dart 3.6\n')).toEqual({ root: false, member: true });
    expect(pubspecWorkspaceKeys("name: a\nresolution: 'workspace'\nworkspace: [b]\n")).toEqual({ root: true, member: true });
    // Only top-level keys count.
    expect(pubspecWorkspaceKeys('name: a\nmelos:\n  workspace: x\n  resolution: workspace\n')).toEqual({ root: false, member: false });
  });

  it('resolves members at the outermost root, and lists the discovered packages it resolves', () => {
    write({
      'ws/pubspec.yaml': 'name: ws\nworkspace:\n  - a\n  - inner\n',
      'ws/a/pubspec.yaml': 'name: a\nresolution: workspace\n',
      'ws/inner/pubspec.yaml': 'name: inner\nresolution: workspace\nworkspace:\n  - b\n',
      'ws/inner/b/pubspec.yaml': 'name: b\nresolution: workspace\n',
      'ws/lone/pubspec.yaml': 'name: lone\n',
      'stray/pubspec.yaml': 'name: stray\nresolution: workspace\n',
    });
    const repo: DiscoveredRepo = {
      repo: 'acme/ws', localPath: path.join(root, 'ws'), headSha: null,
      packages: [pkgAt('.', 'ws'), pkgAt('a', 'a'), pkgAt('inner', 'inner'), pkgAt('inner/b', 'b'), pkgAt('lone', 'lone'), { ...pkgAt('.', 'ws_npm'), manager: 'npm' }],
    };
    const ws = pubWorkspaceOf(repo, repo.packages[3]!)!;
    expect(ws.root).toBe(path.join(root, 'ws'));
    expect(ws.rootPath).toBe('.');
    expect(ws.packages.map((p) => p.path)).toEqual(['.', 'a', 'inner', 'inner/b']);
    expect(pubWorkspaceOf(repo, repo.packages[0]!)?.root).toBe(ws.root);
    expect(pubWorkspaceOf(repo, repo.packages[2]!)?.root).toBe(ws.root); // a nested root that is itself a member
    expect(pubWorkspaceOf(repo, repo.packages[4]!)).toBeUndefined(); // not a member
    // The root need not be a discovered package.
    const onlyMember: DiscoveredRepo = { ...repo, packages: [pkgAt('a', 'a')] };
    expect(pubWorkspaceOf(onlyMember, onlyMember.packages[0]!)).toMatchObject({ root: ws.root, packages: [{ path: 'a' }] });
    // A member with no root above it inside the repo is left to pub.
    const stray: DiscoveredRepo = { repo: 'acme/stray', localPath: path.join(root, 'stray'), headSha: null, packages: [pkgAt('.', 'stray')] };
    expect(pubWorkspaceOf(stray, stray.packages[0]!)).toBeUndefined();
    expect(workspaceRootOf(path.join(root, 'ws'), path.join(root, 'ws', 'lone'), () => ({ root: false, member: false }))).toBeUndefined();
  });

  it('counts the Dart files under lib/, not those of a package nested in it', () => {
    write({
      'libcount/pubspec.yaml': 'name: libcount\n',
      'libcount/lib/a.dart': '',
      'libcount/lib/src/b.dart': '',
      'libcount/lib/src/notes.md': '',
      'libcount/lib/.hidden/c.dart': '',
      'libcount/lib/nested/pubspec.yaml': 'name: nested\n',
      'libcount/lib/nested/lib/d.dart': '',
    });
    const repo: DiscoveredRepo = { repo: 'acme/libcount', localPath: path.join(root, 'libcount'), headSha: null, packages: [pkgAt('.', 'libcount')] };
    expect(ownLibDartFiles(repo, repo.packages[0]!)).toBe(2);
    expect(ownLibDartFiles({ ...repo, localPath: path.join(root, 'nothing-here') }, repo.packages[0]!)).toBe(0);
  });
});

describe.skipIf(!HAS_DART)('scip-dart on a pub workspace (fixtures/org-dart dart-workspace)', () => {
  let tmp: string;
  let work: string;
  const WS = 'repos/dart-workspace';

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-index-ws-')));
    for (const r of ['dart-workspace', 'dart-lib-x']) cpSync(path.join(FIXTURE, 'repos', r), path.join(tmp, 'repos', r), NO_PUB_STATE);
    // A member override an older sentei wrote: pub refuses to override a workspace package.
    writeFileSync(
      path.join(tmp, WS, 'packages/acme_core/pubspec_overrides.yaml'),
      `${OVERRIDES_HEADER}\ndependency_overrides:\n  acme_tools:\n    path: ../acme_tools\n`,
    );
    work = path.join(tmp, 'work');
    mkdirSync(work);
    const at = (p: string, name: string, entryPoints: string[], deps: DiscoveredPackage['deps'] = []): DiscoveredPackage => ({
      ...pubPackage(name, entryPoints, deps),
      path: p,
    });
    const discover: DiscoverFile = {
      org: 'acme',
      repos: [
        {
          repo: 'acme/dart-workspace', localPath: path.join(tmp, WS), defaultBranch: 'main', headSha: null,
          packages: [
            at('.', 'acme_ws', []),
            at('packages/acme_core', 'acme_core', ['packages/acme_core/lib/acme_core.dart']),
            at('packages/acme_tools', 'acme_tools', ['packages/acme_tools/bin/acme_tools.dart'], [orgDep('acme_core', '^1.0.0'), orgDep('acme_x', '^1.0.0')]),
          ],
        },
        repoOf(tmp, 'dart-lib-x', pubPackage('acme_x', ['lib/acme_x.dart', 'lib/builder.dart', 'lib/syntax.dart'])),
      ],
    };
    writeFileSync(path.join(work, 'discover.json'), JSON.stringify(discover, null, 2));
    await index({ work, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} }, { install: false });
  }, 600_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  const ix = () => readJson<RepoIndex>(work, 'index/acme__dart-workspace/index.json');
  const docs = (pkg: string) => readScipIndex(path.join(work, 'index/acme__dart-workspace', `pub__${pkg}.scip`)).documents.map((d) => d.relativePath).sort();

  it('resolves once at the root: every package ok, source links only there and only for org deps outside the workspace', () => {
    expect(ix().packages.map((p) => [p.packageId, p.status])).toEqual([
      ['pub:acme_ws', 'ok'],
      ['pub:acme_core', 'ok'],
      ['pub:acme_tools', 'ok'],
    ]);
    expect(readFileSync(path.join(tmp, WS, 'pubspec_overrides.yaml'), 'utf8')).toBe(
      `${OVERRIDES_HEADER}\ndependency_overrides:\n  acme_x:\n    path: ../dart-lib-x\n`,
    );
    for (const m of ['acme_core', 'acme_tools']) expect(existsSync(path.join(tmp, WS, 'packages', m, 'pubspec_overrides.yaml')), m).toBe(false);
    expect(existsSync(path.join(tmp, WS, 'packages/acme_tools/.dart_tool/package_config.json'))).toBe(false);
    expect(existsSync(path.join(tmp, WS, '.dart_tool/package_config.json'))).toBe(true);
    const tools = ix().packages[2]!.diagnostics;
    expect(tools).toContain('info: pub workspace member (root .): resolved once at the workspace root for 3 package(s)');
    expect(tools).toContain('info: ran dart pub get --offline at the workspace root .');
    expect(tools.some((d) => d.startsWith('info: removed the pubspec_overrides.yaml an earlier sentei run wrote in workspace member'))).toBe(true);
  });

  it('indexes every package in one scip-dart run, each with its own member-relative documents (lib/ of members listed by path)', () => {
    expect(docs('acme_ws')).toEqual([]);
    expect(docs('acme_core')).toEqual([
      'lib/_parts/engine.dart', 'lib/_parts/helper.dart', 'lib/acme_core.dart',
      'lib/src/storage.dart', 'lib/src/storage_io.dart', 'lib/src/storage_stub.dart', 'lib/src/storage_web.dart', 'lib/src/vec.dart',
    ]);
    expect(docs('acme_tools')).toEqual(['bin/acme_tools.dart', 'lib/src/cli.dart']);
    const runs = (pkg: string) => readFileSync(path.join(work, 'index/acme__dart-workspace', `pub__${pkg}.log`), 'utf8')
      .split('\n').filter((l) => l.startsWith('$ dart run scip_dart'));
    const run = runs('acme_core');
    expect(run).toHaveLength(1);
    expect(run[0]).toContain('one run for the 3 package(s) of the workspace');
    expect(runs('acme_tools')).toEqual(run);
    expect(ix().packages[1]!.diagnostics).toContain('info: indexed in one scip-dart run with the 3 package(s) of the pub workspace at .');
  });

  it('computes every export surface in one dart-surface run (--batch), each as a run on the package alone', () => {
    const runs = (pkg: string) => readFileSync(path.join(work, 'index/acme__dart-workspace', `pub__${pkg}.log`), 'utf8')
      .split('\n').filter((l) => l.startsWith('$ dart run dart_surface'));
    expect(runs('acme_core')).toHaveLength(1);
    expect(runs('acme_core')[0]).toMatch(/^\$ dart run dart_surface --batch .*one run for the 3 package\(s\) of the workspace/);
    expect(runs('acme_ws')).toEqual(runs('acme_core'));
    expect(ix().packages[2]!.diagnostics).toContain('info: export surface from one dart-surface run with the 3 package(s) of the pub workspace at .');
    // The same sidecar as dart-surface on acme_core alone.
    const r = spawnSync('dart', [
      'run', 'dart_surface', '--repo-root', path.join(tmp, WS), '--package-root', path.join(tmp, WS, 'packages/acme_core'),
      '--package-id', 'pub:acme_core', '--org-packages', 'acme_core,acme_tools,acme_ws,acme_x', '--entry', 'packages/acme_core/lib/acme_core.dart',
    ], { cwd: DART_SURFACE_DIR, encoding: 'utf8', shell: process.platform === 'win32' });
    expect(r.status, r.stderr).toBe(0);
    const alone = JSON.parse(r.stdout) as ExportsSidecar & { diagnostics: string[] };
    const batched = readJson<ExportsSidecar>(work, 'index/acme__dart-workspace/pub__acme_core.exports.json');
    for (const key of ['exports', 'entryPoints', 'entrySymbols', 'conditionalImports', 'unresolved', 'unresolvedImports'] as const) {
      expect(batched[key], key).toEqual(alone[key]);
    }
  }, 300_000);

  it('resolves name-based parts (`part of acme_core;`) in their library: references between parts survive (fork patch 8)', () => {
    const core = readScipIndex(path.join(work, 'index/acme__dart-workspace/pub__acme_core.scip'));
    const engine = core.documents.find((d) => d.relativePath === 'lib/_parts/engine.dart')!;
    const refs = engine.occurrences.filter((o) => (o.symbolRoles & 1) === 0).map((o) => o.symbol);
    expect(refs).toContain('scip-dart pub acme_core 1.0.0 lib/_parts/`helper.dart`/_Helper#`<constructor>`().');
    expect(refs).toContain('scip-dart pub acme_core 1.0.0 lib/_parts/`helper.dart`/_Helper#step().');
  });

  it('operator expressions reference the operator, also of an extension (fork patch 9)', () => {
    const occ = (pkg: string, file: string) => readScipIndex(path.join(work, 'index/acme__dart-workspace', `pub__${pkg}.scip`))
      .documents.find((d) => d.relativePath === file)!
      .occurrences.filter((o) => (o.symbolRoles & 1) === 0)
      .map((o) => `${o.range[0]}:${o.range[1]} ${o.symbol.split(' ').pop()}`);
    // `final a = Vec2(1, 2) & Vec2(3, 4);` and `print((a % 2)[0]);` in acme_tools' lib/src/cli.dart.
    expect(occ('acme_tools', 'lib/src/cli.dart')).toEqual(expect.arrayContaining([
      '6:23 lib/src/`vec.dart`/Vec2Ops#`&`().',
      '7:11 lib/src/`vec.dart`/Vec2Ops#`%`().',
      '7:15 lib/src/`vec.dart`/Vec2Ops#`[]`().',
    ]));
    // `v + d` inside acme_core: the private extension `_Shift` is used only so.
    expect(occ('acme_core', 'lib/src/vec.dart')).toContain('30:33 lib/src/`vec.dart`/_Shift#+().');
  });

  it('lists every conditional import with its default target and alternatives (sidecar conditionalImports)', () => {
    const side = (pkg: string) => readJson<ExportsSidecar>(work, 'index/acme__dart-workspace', `pub__${pkg}.exports.json`);
    expect(side('acme_core').conditionalImports).toEqual([
      {
        file: 'packages/acme_core/lib/src/storage.dart', line: 4, col: 7,
        target: 'packages/acme_core/lib/src/storage_stub.dart',
        alternatives: ['packages/acme_core/lib/src/storage_io.dart', 'packages/acme_core/lib/src/storage_web.dart'],
      },
    ]);
    expect(side('acme_tools').conditionalImports).toEqual([]);
  });

  it('a bin/ library that only re-exports main records that main, at its declaration, as a runtime entry symbol', () => {
    // bin/acme_tools.dart is `export 'package:acme_tools/src/cli.dart';` (over_react_codemod's executables).
    const s = readJson<ExportsSidecar>(work, 'index/acme__dart-workspace/pub__acme_tools.exports.json');
    expect(s.entrySymbols).toEqual([{ name: 'main', file: 'packages/acme_tools/lib/src/cli.dart', line: 5, col: 5, kind: 'runtime' }]);
  });

  it('a package of a workspace run gets the index a run on it alone produces', () => {
    const alone = path.join(tmp, 'acme_core-alone.scip');
    const r = spawnSync('dart', ['run', 'scip_dart', '--private-symbols', '--output', alone, path.join(tmp, WS, 'packages/acme_core')], {
      cwd: SCIP_DART_DIR, encoding: 'utf8', shell: process.platform === 'win32',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(snapshotScip(readScipIndex(path.join(work, 'index/acme__dart-workspace/pub__acme_core.scip')))).toBe(snapshotScip(readScipIndex(alone)));
  }, 300_000);
});

describe('build_runner for missing generated parts', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-build-runner-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function pkg(name: string, pubspecText: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    for (const [f, body] of Object.entries({ 'pubspec.yaml': pubspecText, ...files })) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), body);
    }
    return dir;
  }
  const withRunner = 'name: gen\ndev_dependencies:\n  build_runner: ^2.4.0\n';
  const lib = {
    'lib/model.dart': "part 'model.g.dart';\npart \"model.freezed.dart\";\npart 'handwritten.dart';\n",
    'lib/handwritten.dart': "part of 'model.dart';\n",
    'lib/src/ok.dart': "part 'ok.g.dart';\n",
    'lib/src/ok.g.dart': "part of 'ok.dart';\n",
    'example/pubspec.yaml': 'name: example\n',
    'example/lib/e.dart': "part 'e.g.dart';\n", // a nested package: not ours
    'web/demo.dart': "part 'demo.over_react.g.dart';\n",
    // A codemod's test input: a string, not a directive (over_react_codemod).
    'test/codemod_test.dart': "const input = '''\npart '$name.over_react.g.dart';\n''';\n",
  };

  it('lists own missing *.g.dart / *.freezed.dart parts only', () => {
    const dir = pkg('list', withRunner, lib);
    expect(missingGeneratedParts(dir)).toEqual([
      "lib/model.dart: 'model.freezed.dart'",
      "lib/model.dart: 'model.g.dart'",
      "web/demo.dart: 'demo.over_react.g.dart'",
    ]);
  });

  it('records nothing when no generated part is missing', async () => {
    const dir = pkg('none', withRunner, { 'lib/a.dart': 'int a() => 1;\n' });
    const calls: string[][] = [];
    const diagnostics: string[] = [];
    expect(await buildRunner(dir, diagnostics, [], 'dart', async (_c, a) => (calls.push(a), { code: 0, signal: null, stdout: '', stderr: '' }))).toBeUndefined();
    expect(calls).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('skips a package that does not depend on build_runner', async () => {
    const dir = pkg('nodep', 'name: nodep\n', lib);
    const diagnostics: string[] = [];
    expect(await buildRunner(dir, diagnostics, [], 'dart', async () => { throw new Error('must not run'); })).toBe('skipped');
    expect(diagnostics).toEqual([
      "info: build_runner: skipped (3 generated part(s) missing, e.g. lib/model.dart: 'model.freezed.dart'; build_runner is not a dependency)",
    ]);
  });

  it('runs `dart run build_runner build --delete-conflicting-outputs` in the package, time-boxed, and reports what is still missing', async () => {
    const dir = pkg('runs', withRunner, lib);
    const calls: Array<[string, string[], string, number | undefined]> = [];
    const diagnostics: string[] = [];
    const log: string[] = [];
    const outcome = await buildRunner(dir, diagnostics, log, '/sdk/bin/dart', async (cmd, args, cwd, timeoutMs) => {
      calls.push([cmd, args, cwd, timeoutMs]);
      writeFileSync(path.join(dir, 'lib/model.g.dart'), "part of 'model.dart';\n");
      writeFileSync(path.join(dir, 'lib/model.freezed.dart'), "part of 'model.dart';\n");
      return { code: 0, signal: null, stdout: '[INFO] Succeeded after 1.2s', stderr: '' };
    });
    expect(outcome).toBe('ran');
    expect(calls).toEqual([['/sdk/bin/dart', ['run', 'build_runner', 'build', '--delete-conflicting-outputs'], dir, BUILD_RUNNER_TIMEOUT_MS]]);
    expect(BUILD_RUNNER_TIMEOUT_MS).toBe(600_000);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^info: build_runner: ran \(3 generated part\(s\) missing, e\.g\. lib\/model\.dart: 'model\.freezed\.dart'; 1 still missing; [\d.]+ s\)$/);
    expect(log.join('\n')).toContain('[INFO] Succeeded after 1.2s');
  });

  it('reports a failing or timed-out build_runner as failed', async () => {
    const dir = pkg('fails', withRunner, lib);
    const failed: string[] = [];
    expect(await buildRunner(dir, failed, [], 'dart', async () => ({ code: 78, signal: null, stdout: '', stderr: 'Could not find package "build_runner".\n' }))).toBe('failed');
    expect(failed).toEqual([
      "warn: build_runner: failed (3 generated part(s) missing, e.g. lib/model.dart: 'model.freezed.dart'; exited with 78: Could not find package \"build_runner\".)",
    ]);
    const slow: string[] = [];
    expect(await buildRunner(dir, slow, [], 'dart', async () => ({ code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }), 1000)).toBe('failed');
    expect(slow[0]).toMatch(/; timed out after 1 s\)$/);
  });
});

describe('Flutter package detection', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-flutter-detect-')));
  });
  afterAll(() => {
    setFlutterSdkForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  function pkgWith(name: string, pubspecText: string, deps: DiscoveredPackage['deps'] = []): OrgPackage {
    const repo = repoOf(root, name, pubPackage(name, [`lib/${name}.dart`], deps));
    mkdirSync(repo.localPath, { recursive: true });
    writeFileSync(path.join(repo.localPath, 'pubspec.yaml'), pubspecText);
    return { repo, pkg: repo.packages[0]! };
  }
  function input(target: OrgPackage, all: OrgPackage[]): IndexerInput {
    const byId = new Map(all.map((o) => [o.pkg.packageId, o]));
    return { repo: target.repo, pkg: target.pkg, lookup: (id) => byId.get(id), orgPackages: all, options: { install: false, maxOldSpaceMb: 0 } };
  }
  const head = (name: string) => `name: ${name}\nversion: 1.0.0\npublish_to: none\n`;

  it('environment.flutter, Flutter SDK deps (dev too), sdk: flutter, and org deps that are Flutter packages', () => {
    const env = pkgWith('env', `${head('env')}environment:\n  sdk: ^3.0.0\n  flutter: ">=3.10.0"\n`);
    const dev = pkgWith('dev', `${head('dev')}dev_dependencies:\n  flutter_test:\n    sdk: flutter\n`, [
      { name: 'flutter_test', manager: 'pub', constraint: 'sdk:flutter', resolvedPackageId: null },
    ]);
    const sdkOnly = pkgWith('sdkonly', `${head('sdkonly')}dependency_overrides:\n  flutter_gen:\n    sdk: flutter\n`);
    const pure = pkgWith('pure', `${head('pure')}environment:\n  sdk: ^3.0.0\n# flutter: no\nflutter:\n  assets: []\n`);
    const viaDep = pkgWith('viadep', `${head('viadep')}dependencies:\n  env: ^1.0.0\n`, [orgDep('env', '^1.0.0')]);
    const all = [env, dev, sdkOnly, pure, viaDep];
    expect(flutterReason(input(env, all))).toBe('environment.flutter');
    expect(flutterReason(input(dev, all))).toBe('depends on flutter_test');
    expect(flutterReason(input(sdkOnly, all))).toBe('an sdk: flutter dependency');
    expect(flutterReason(input(pure, all))).toBeUndefined(); // a top-level `flutter:` section alone is not enough
    expect(flutterReason(input(viaDep, all))).toBe('org dependency env: environment.flutter');
  });

  it('without `flutter` on PATH a Flutter package is partial with a clear error, and nothing is indexed', async () => {
    const app = pkgWith('noflutter', `${head('noflutter')}dependencies:\n  flutter:\n    sdk: flutter\n`, [
      { name: 'flutter', manager: 'pub', constraint: 'sdk:flutter', resolvedPackageId: null },
    ]);
    setFlutterSdkForTests({});
    try {
      const out = path.join(root, 'out-noflutter');
      mkdirSync(out);
      const r = await scipDart.run(input(app, [app]), out);
      expect(r.status).toBe('partial');
      expect(r.diagnostics).toEqual([
        'error: Flutter package (depends on flutter) but `flutter` is not on PATH: not resolved; install the Flutter SDK to index it',
      ]);
      expect(existsSync(r.scipFile)).toBe(false);
      expect(existsSync(r.exportsFile)).toBe(false);
      expect(existsSync(path.join(app.repo.localPath, '.dart_tool'))).toBe(false); // no pub get ran
    } finally {
      setFlutterSdkForTests(undefined);
    }
  });
});

describe('pubspec_overrides.yaml writer', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-overrides-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function input(): IndexerInput {
    const repo = (name: string, pkg: DiscoveredPackage): DiscoveredRepo => repoOf(root, name, pkg);
    const lib = repo('lib', pubPackage('acme_lib', ['lib/acme_lib.dart']));
    const app = repo('app', pubPackage('acme_app', ['bin/main.dart'], [orgDep('acme_lib', '^2.0.0'), { name: 'http', manager: 'pub', constraint: '^1.0.0', resolvedPackageId: null }]));
    for (const r of [lib, app]) mkdirSync(r.localPath, { recursive: true });
    const byId = new Map<string, OrgPackage>([lib, app].map((r) => [r.packages[0]!.packageId, { repo: r, pkg: r.packages[0]! }]));
    return {
      repo: app,
      pkg: app.packages[0]!,
      lookup: (id) => byId.get(id),
      orgPackages: [...byId.values()],
      options: { install: false, maxOldSpaceMb: 0 },
    };
  }

  it('merges into an existing file, backs the original up once, and is idempotent', () => {
    const inp = input();
    const dir = inp.repo.localPath;
    const file = path.join(dir, 'pubspec_overrides.yaml');
    const original = [
      '# user overrides',
      'dependency_overrides:',
      '  http:',
      "    git: {url: 'https://example.com/http.git', ref: main} # pinned",
      '  acme_lib: 1.2.3',
      '',
    ].join('\n');
    writeFileSync(file, original);
    const d1: string[] = [];
    writeOverrides(inp, dir, d1);
    const merged = readFileSync(file, 'utf8');
    expect(merged).toBe(
      `${OVERRIDES_HEADER}\ndependency_overrides:\n  http:\n    git: {url: 'https://example.com/http.git', ref: main}\n  acme_lib:\n    path: ../lib\n`,
    );
    expect(readFileSync(path.join(dir, '.sentei-backup/pubspec_overrides.yaml'), 'utf8')).toBe(original);
    expect(d1).toContain('info: backed up existing pubspec_overrides.yaml to .sentei-backup/pubspec_overrides.yaml');
    expect(d1).toContain('info: replaced existing dependency_overrides entry for acme_lib');

    // Second run: our own file is neither backed up again nor changed.
    const d2: string[] = [];
    writeOverrides(inp, dir, d2);
    expect(readFileSync(file, 'utf8')).toBe(merged);
    expect(readFileSync(path.join(dir, '.sentei-backup/pubspec_overrides.yaml'), 'utf8')).toBe(original);
    expect(d2).toEqual(['info: pubspec_overrides.yaml: acme_lib -> ../lib']);

    // Excluding the link (pub rejected it) gives the user's entry back.
    const links = writeOverrides(inp, dir, [], new Set(['acme_lib']));
    expect(links.size).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    // And linking again works from the backup.
    writeOverrides(inp, dir, []);
    expect(readFileSync(file, 'utf8')).toBe(merged);
  });

  it('an excluded link leaves the other links and removes a file only we wrote', () => {
    const inp = input();
    const dir = inp.repo.localPath;
    const file = path.join(dir, 'pubspec_overrides.yaml');
    rmSync(file, { force: true });
    rmSync(path.join(dir, '.sentei-backup'), { recursive: true, force: true });
    writeOverrides(inp, dir, []);
    expect(readFileSync(file, 'utf8')).toBe(`${OVERRIDES_HEADER}\ndependency_overrides:\n  acme_lib:\n    path: ../lib\n`);
    writeOverrides(inp, dir, [], new Set(['acme_lib']));
    expect(existsSync(file)).toBe(false);
  });

  it('writes nothing for a package without org deps', () => {
    const inp = input();
    const lib = inp.lookup('pub:acme_lib')!;
    const d: string[] = [];
    writeOverrides({ ...inp, repo: lib.repo, pkg: lib.pkg }, lib.repo.localPath, d);
    expect(existsSync(path.join(lib.repo.localPath, 'pubspec_overrides.yaml'))).toBe(false);
    expect(d).toEqual([]);
  });

  it('refuses YAML it cannot round-trip', () => {
    expect(parseYamlBlock('dependency_overrides:\n  - x\n')).toBeUndefined();
    expect(parseYamlBlock('a: |\n  text\n')).toBeUndefined();
    expect(parseYamlBlock('a:\n  b: "x # y"  # c\n')).toEqual({ a: { b: '"x # y"' } });
  });
});

describe('pub get conflict with a source link', () => {
  // Real `dart pub get` output from the first Workiva run (Dart 3.11.3).
  const W_FLUX_CODEMOD = [
    'Resolving dependencies...',
    'Because every version of codemod from path depends on analyzer ^14.0.0 and w_flux_codemod depends on analyzer ^5.13.0, codemod from path is forbidden.',
    'So, because w_flux_codemod depends on codemod from path, version solving failed.',
    '',
    '',
    'You can try the following suggestion to make the pubspec resolve:',
    '* Consider downgrading your constraint on analyzer: dart pub add analyzer:^14.0.0',
    '',
  ].join('\n');
  const OVER_REACT_PLUGIN = [
    'Resolving dependencies...',
    'Because every version of over_react from path depends on analyzer >=10.0.0 <15.0.0 and over_react_analyzer_plugin depends on',
    '  analyzer >=5.11.0 <7.0.0, over_react from path is forbidden.',
    'So, because over_react_analyzer_plugin depends on over_react from path, version solving failed.',
  ].join('\n');

  it('names the overridden dep, the constraining package and pub\'s reason', () => {
    expect(parseOverrideConflicts(W_FLUX_CODEMOD, new Set(['codemod', 'workiva_analysis_options']))).toEqual([
      {
        dep: 'codemod',
        pkg: 'w_flux_codemod',
        detail: 'every version of codemod from path depends on analyzer ^14.0.0 and w_flux_codemod depends on analyzer ^5.13.0',
      },
    ]);
    expect(parseOverrideConflicts(OVER_REACT_PLUGIN, new Set(['dart_dev', 'dependency_validator', 'over_react', 'workiva_analysis_options']))).toEqual([
      {
        dep: 'over_react',
        pkg: 'over_react_analyzer_plugin',
        detail: 'every version of over_react from path depends on analyzer >=10.0.0 <15.0.0 and over_react_analyzer_plugin depends on analyzer >=5.11.0 <7.0.0',
      },
    ]);
  });

  it('retries up to three times, accumulating the rejected links, with one warn each', async () => {
    // over_react_analyzer_plugin: dropping over_react surfaced a second conflict (dependency_validator).
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-pubget-')));
    try {
      const names = ['over_react', 'dependency_validator', 'dart_dev', 'w_common', 'plugin'];
      const repos = new Map(names.map((n) => [n, repoOf(root, n, pubPackage(n, [`lib/${n}.dart`]))]));
      const plugin = repoOf(root, 'plugin', pubPackage('plugin', ['lib/plugin.dart'], names.slice(0, 4).map((n) => orgDep(n, '^1.0.0'))));
      repos.set('plugin', plugin);
      for (const r of repos.values()) mkdirSync(r.localPath, { recursive: true });
      const byId = new Map<string, OrgPackage>([...repos.values()].map((r) => [r.packages[0]!.packageId, { repo: r, pkg: r.packages[0]! }]));
      const inp: IndexerInput = { repo: plugin, pkg: plugin.packages[0]!, lookup: (id) => byId.get(id), orgPackages: [...byId.values()], options: { install: false, maxOldSpaceMb: 0 } };
      const conflict = (dep: string) =>
        `Because every version of ${dep} from path depends on analyzer >=10.0.0 and plugin depends on analyzer <7.0.0, ${dep} from path is forbidden.\n` +
        `So, because plugin depends on ${dep} from path, version solving failed.\n`;
      const overridesSeen: string[] = [];
      const fake = (outputs: string[]) => {
        let i = 0;
        return async (_cmd: string, _args: string[], cwd: string) => {
          overridesSeen.push(readFileSync(path.join(cwd, 'pubspec_overrides.yaml'), 'utf8'));
          const out = outputs[i++];
          return out === undefined ? { code: 0, signal: null, stdout: 'Got dependencies!\n', stderr: '' } : { code: 1, signal: null, stdout: '', stderr: out };
        };
      };
      const run = async (outputs: string[]) => {
        overridesSeen.length = 0;
        const diagnostics: string[] = [];
        const log: string[] = [];
        const links = writeOverrides(inp, plugin.localPath, []);
        const proc = await pubGet(inp, plugin.localPath, ['pub', 'get', '--offline'], links, diagnostics, log, fake(outputs));
        return { proc, diagnostics, log };
      };

      const two = await run([conflict('over_react'), conflict('dependency_validator')]);
      expect(two.proc.code).toBe(0);
      expect(two.diagnostics.filter((d) => d.startsWith('warn:'))).toEqual([
        "warn: over_react not source-linked: HEAD conflicts with plugin's constraint (every version of over_react from path depends on analyzer >=10.0.0 and plugin depends on analyzer <7.0.0)",
        "warn: dependency_validator not source-linked: HEAD conflicts with plugin's constraint (every version of dependency_validator from path depends on analyzer >=10.0.0 and plugin depends on analyzer <7.0.0)",
      ]);
      expect(overridesSeen).toHaveLength(3);
      expect(overridesSeen[1]).not.toMatch(/over_react:/);
      expect(overridesSeen[1]).toMatch(/dependency_validator:/);
      expect(overridesSeen[2]).not.toMatch(/over_react:|dependency_validator:/); // accumulated
      expect(overridesSeen[2]).toMatch(/dart_dev:[\s\S]*w_common:/);
      expect(two.log.filter((l) => l.startsWith('$ dart pub get'))).toEqual([
        `$ dart pub get --offline  (cwd ${plugin.localPath})`,
        `$ dart pub get --offline  (cwd ${plugin.localPath}; retry without over_react)`,
        `$ dart pub get --offline  (cwd ${plugin.localPath}; retry without over_react, dependency_validator)`,
      ]);

      // Four conflicts in a row: three retries, then the last failure stands.
      const many = await run([conflict('over_react'), conflict('dependency_validator'), conflict('dart_dev'), conflict('w_common')]);
      expect(many.proc.code).toBe(1);
      expect(overridesSeen).toHaveLength(4);
      expect(many.diagnostics.filter((d) => d.startsWith('warn:')).map((d) => d.split(' ')[1])).toEqual(['over_react', 'dependency_validator', 'dart_dev']);

      // The same conflict again (pub names an already-dropped link): no further retry.
      const again = await run([conflict('over_react'), conflict('over_react')]);
      expect(again.proc.code).toBe(1);
      expect(overridesSeen).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds nothing when no overridden dep is named, or when solving did not fail', () => {
    expect(parseOverrideConflicts(W_FLUX_CODEMOD, new Set(['workiva_analysis_options']))).toEqual([]);
    expect(parseOverrideConflicts('Because codemod requires SDK version ^3.13.0, version solving failed.', new Set(['codemod']))).toEqual([]);
    expect(parseOverrideConflicts('Could not find package codemod from path at ../x', new Set(['codemod']))).toEqual([]);
    // `codemod` must not match inside `w_flux_codemod from path`.
    expect(parseOverrideConflicts('Because w_flux_codemod from path is broken, version solving failed.', new Set(['codemod']))).toEqual([]);
  });
});

describe.skipIf(!HAS_DART)('scip-dart adapter on temp packages', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-dart-tmp-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function write(files: Record<string, string>): void {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), body);
    }
  }
  const pubspec = (name: string, version: string, deps = ''): string =>
    `name: ${name}\nversion: ${version}\npublish_to: none\nenvironment:\n  sdk: ^3.0.0\n${deps ? `dependencies:\n${deps}` : ''}`;
  function inputFor(repos: DiscoveredRepo[], repo: DiscoveredRepo): IndexerInput {
    const byId = new Map<string, OrgPackage>(repos.flatMap((r) => r.packages.map((p) => [p.packageId, { repo: r, pkg: p }] as const)));
    return { repo, pkg: repo.packages[0]!, lookup: (id) => byId.get(id), orgPackages: [...byId.values()], options: { install: false, maxOldSpaceMb: 0 } };
  }

  it('an npm and a pub package in the same dir write distinct output files', async () => {
    write({
      'dual/package.json': JSON.stringify({ name: 'dual', version: '1.0.0', type: 'module', types: 'src/index.ts' }),
      'dual/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true, types: [] }, include: ['src'] }),
      'dual/src/index.ts': 'export function fromTs(): number { return 1; }\n',
      'dual/pubspec.yaml': pubspec('dual', '1.0.0'),
      'dual/lib/dual.dart': 'int fromDart() => 1;\n',
    });
    const work = path.join(root, 'work-dual');
    mkdirSync(work);
    const repo: DiscoveredRepo = {
      repo: 'acme/dual', localPath: path.join(root, 'dual'), headSha: null,
      packages: [
        { packageId: 'npm:dual', path: '.', manager: 'npm', name: 'dual', entryPoints: ['src/index.ts'], deps: [] },
        { packageId: 'pub:dual', path: '.', manager: 'pub', name: 'dual', entryPoints: ['lib/dual.dart'], deps: [] },
      ],
    };
    writeFileSync(path.join(work, 'discover.json'), JSON.stringify({ org: 'acme', repos: [repo] } satisfies DiscoverFile));
    await index({ work, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} }, { install: false });
    const r = readJson<RepoIndex>(work, 'index/acme__dual/index.json');
    expect(r.packages.map((p) => [p.packageId, p.status, p.scip, p.exports])).toEqual([
      ['npm:dual', 'ok', 'npm__dual.scip', 'npm__dual.exports.json'],
      ['pub:dual', 'ok', 'pub__dual.scip', 'pub__dual.exports.json'],
    ]);
    const docs = (f: string) => readScipIndex(path.join(work, 'index/acme__dual', f)).documents.map((d) => d.relativePath).sort();
    expect(docs('npm__dual.scip')).toEqual(['src/index.ts']);
    expect(docs('pub__dual.scip')).toEqual(['lib/dual.dart']);
    expect(readJson<ExportsSidecar>(work, 'index/acme__dual/npm__dual.exports.json').packageId).toBe('npm:dual');
    expect(readJson<ExportsSidecar>(work, 'index/acme__dual/pub__dual.exports.json').packageId).toBe('pub:dual');
  }, 300_000);

  it('a missing generated part makes the package partial; one in a test file only warns', async () => {
    write({
      'gen/pubspec.yaml': pubspec('acme_gen', '1.0.0'),
      'gen/lib/acme_gen.dart': "part 'acme_gen.g.dart';\n\nint used() => _\$generated();\n",
      'gen/test/gen_test.dart': "import 'package:acme_gen/acme_gen.dart';\n\npart 'gen_test.g.dart';\n\nvoid main() => print(used());\n",
      'gentest/pubspec.yaml': pubspec('acme_gentest', '1.0.0'),
      'gentest/lib/acme_gentest.dart': 'int used() => 1;\n',
      'gentest/test/gen_test.dart': "part 'gen_test.over_react.g.dart';\n\nvoid main() {}\n",
    });
    const repos = ['gen', 'gentest'].map((d) => repoOf(root, d, pubPackage(`acme_${d}`, [`lib/acme_${d}.dart`])));
    for (const r of repos) r.localPath = path.join(root, r.repo.split('/')[1]!);
    const out = path.join(root, 'out-gen');
    mkdirSync(out);
    const gen = await scipDart.run(inputFor(repos, repos[0]!), out);
    expect(gen.status).toBe('partial');
    expect(gen.diagnostics).toContain(
      "error: missing generated part 'acme_gen.g.dart' at lib/acme_gen.dart:1:6: the library is incomplete, references inside the part are unknown (run build_runner before indexing)",
    );
    expect(gen.diagnostics.some((d) => d.startsWith("warn: missing part 'gen_test.g.dart' at test/gen_test.dart:3:6"))).toBe(true);
    // The missing parts are not also counted as plain analyzer errors (those never change status).
    expect(gen.diagnostics.some((d) => /uri_has_not_been_generated/.test(d))).toBe(false);

    const gentest = await scipDart.run(inputFor(repos, repos[1]!), out);
    expect(gentest.status, gentest.diagnostics.join('\n')).toBe('ok');
    expect(gentest.diagnostics.some((d) => d.startsWith("warn: missing part 'gen_test.over_react.g.dart' at test/gen_test.dart:1:6"))).toBe(true);
  }, 300_000);

  it('nothing under lib/ is a test file: a lib/ main stays an entry symbol, a missing part there makes it partial', async () => {
    // lib/mocks.dart matches `**/mocks.*`, lib/testing/ `**/testing/**`: core
    // SURFACE_DIRS exempts a pub package's lib/ from the test globs, as the SQL views do.
    write({
      'libtest/pubspec.yaml': pubspec('acme_libtest', '1.0.0'),
      'libtest/lib/mocks.dart': 'void main() {}\n',
      'libtest/lib/testing/fake.dart': "part 'fake.g.dart';\n\nint fake() => 1;\n",
    });
    const repos = [repoOf(root, 'libtest', pubPackage('acme_libtest', ['lib/mocks.dart']))];
    repos[0]!.localPath = path.join(root, 'libtest');
    const out = path.join(root, 'out-libtest');
    mkdirSync(out);
    const r = await scipDart.run(inputFor(repos, repos[0]!), out);
    expect(r.status).toBe('partial');
    expect(r.diagnostics.some((d) => d.startsWith("error: missing generated part 'fake.g.dart' at lib/testing/fake.dart:1:6"))).toBe(true);
    expect(readJson<ExportsSidecar>(r.exportsFile).entrySymbols).toEqual([{ name: 'main', file: 'lib/mocks.dart', line: 0, col: 5, kind: 'runtime' }]);
  }, 300_000);

  it('references user-defined operators at the operator token, index reads and writes too; SDK operators are skipped (fork patch 9)', async () => {
    write({
      'ops/pubspec.yaml': pubspec('acme_ops', '1.0.0'),
      'ops/lib/acme_ops.dart': [
        'class V {',
        '  V operator +(V o) => this;',
        '  V operator -() => this;',
        '  int operator [](int i) => i;',
        '  void operator []=(int i, int v) {}',
        '  @override',
        '  bool operator ==(Object o) => true;',
        '}',
        'void f(V a, V b) {',
        '  a + b;', // 9
        '  -a;', // 10
        '  a[0];', // 11
        '  a[0] = 1;', // 12
        '  a[0] += 1;', // 13
        '  a[0]++;', // 14
        '  var c = a;',
        '  c += b;', // 16
        '  a == b;', // 17
        '  a != b;', // 18
        '  1 + 2;', // 19
        '}',
        '',
      ].join('\n'),
    });
    const repos = [repoOf(root, 'ops', pubPackage('acme_ops', ['lib/acme_ops.dart']))];
    repos[0]!.localPath = path.join(root, 'ops');
    const out = path.join(root, 'out-ops');
    mkdirSync(out);
    const r = await scipDart.run(inputFor(repos, repos[0]!), out);
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    const refs = readScipIndex(r.scipFile).documents[0]!.occurrences
      .filter((o) => (o.symbolRoles & 1) === 0 && o.range[0]! >= 9)
      .map((o) => `${o.range[0]}:${o.range[1]} ${o.symbol.split(' ').pop()!.replace('lib/`acme_ops.dart`/', '')}`)
      .filter((s) => /V#/.test(s) && !/\(o\)|<constructor>/.test(s));
    expect(refs.sort()).toEqual([
      '10:2 V#-().', // unary minus: the definition's symbol too
      '11:3 V#`[]`().',
      '12:3 V#`[]=`().',
      '13:3 V#`[]=`().',
      '13:3 V#`[]`().',
      '14:3 V#`[]=`().',
      '14:3 V#`[]`().',
      '16:4 V#+().',
      '17:4 V#`==`().',
      '18:4 V#`==`().',
      '9:4 V#+().',
    ].sort());
    // `1 + 2` (line 19) and Object.== are SDK operators: no occurrence.
    const sdk = readScipIndex(r.scipFile).documents[0]!.occurrences.filter((o) => o.range[0] === 19 && o.symbol.includes('dart:core'));
    expect(sdk).toEqual([]);
  }, 300_000);

  it('resolves conditional directive URIs to repo paths, else keeps the package:/dart: URI', async () => {
    write({
      'cond/pubspec.yaml': pubspec('acme_cond', '1.0.0'),
      'cond/lib/acme_cond.dart': [
        "import 'dart:math' if (dart.library.io) 'src/io.dart' as impl;",
        "export 'package:acme_cond/src/io.dart' if (dart.library.js_interop) 'package:path/path.dart';",
        '',
        'num pick() => impl.max(1, 2);',
        '',
      ].join('\n'),
      'cond/lib/src/io.dart': 'num max(num a, num b) => a;\n',
    });
    const repos = [repoOf(root, 'cond', pubPackage('acme_cond', ['lib/acme_cond.dart']))];
    repos[0]!.localPath = path.join(root, 'cond');
    const out = path.join(root, 'out-cond');
    mkdirSync(out);
    const r = await scipDart.run(inputFor(repos, repos[0]!), out);
    expect(readJson<ExportsSidecar>(r.exportsFile).conditionalImports).toEqual([
      { file: 'lib/acme_cond.dart', line: 0, col: 7, target: 'dart:math', alternatives: ['lib/src/io.dart'] },
      { file: 'lib/acme_cond.dart', line: 1, col: 7, target: 'lib/src/io.dart', alternatives: ['package:path/path.dart'] },
    ]);
  }, 300_000);

  it('a package with Dart files under lib/ but no lib/ document in its index fails (never ok)', async () => {
    // flame-engine/tiled.dart: scip-dart indexed none of packages/tiled/lib, the
    // package came out ok, and its consumers produced 451 false version-skew rows.
    // Here the analyzer is told to skip lib/ (analysis_options exclude).
    write({
      'nolib/pubspec.yaml': pubspec('acme_nolib', '1.0.0'),
      'nolib/analysis_options.yaml': 'analyzer:\n  exclude:\n    - lib/**\n',
      'nolib/lib/acme_nolib.dart': 'int a() => 1;\n',
      'nolib/bin/main.dart': 'void main() {}\n',
    });
    const repos = [repoOf(root, 'nolib', pubPackage('acme_nolib', ['lib/acme_nolib.dart']))];
    repos[0]!.localPath = path.join(root, 'nolib');
    const out = path.join(root, 'out-nolib');
    mkdirSync(out);
    const r = await scipDart.run(inputFor(repos, repos[0]!), out);
    expect(r.status).toBe('failed');
    expect(r.diagnostics).toContain(
      'error: scip-dart indexed none of the 1 Dart file(s) under lib/ (the analyzer did not cover lib/); the index is incomplete',
    );
  }, 300_000);

  it('a missing part only makes the package partial in lib/ or bin/, not in web/ demo code', async () => {
    // over_react: 19 ungenerated `*.over_react.g.dart` parts under web/ made the whole package partial.
    write({
      'genweb/pubspec.yaml': pubspec('acme_genweb', '1.0.0'),
      'genweb/lib/acme_genweb.dart': 'int used() => 1;\n',
      'genweb/web/demo.dart': "import 'package:acme_genweb/acme_genweb.dart';\n\npart 'demo.over_react.g.dart';\n\nvoid main() => print(used());\n",
      'genbin/pubspec.yaml': pubspec('acme_genbin', '1.0.0'),
      'genbin/bin/tool.dart': "part 'tool.g.dart';\n\nvoid main() {}\n",
    });
    const repos = [
      repoOf(root, 'genweb', pubPackage('acme_genweb', ['lib/acme_genweb.dart'])),
      repoOf(root, 'genbin', pubPackage('acme_genbin', ['bin/tool.dart'])),
    ];
    for (const r of repos) r.localPath = path.join(root, r.repo.split('/')[1]!);
    const out = path.join(root, 'out-genweb');
    mkdirSync(out);
    const web = await scipDart.run(inputFor(repos, repos[0]!), out);
    expect(web.status, web.diagnostics.join('\n')).toBe('ok');
    expect(web.diagnostics).toContain(
      "warn: missing part 'demo.over_react.g.dart' at web/demo.dart:3:6 (not generated?); outside lib/ and bin/, references inside it are unknown",
    );
    expect(web.diagnostics.some((d) => d.startsWith('error:'))).toBe(false);
    const bin = await scipDart.run(inputFor(repos, repos[1]!), out);
    expect(bin.status).toBe('partial');
    expect(bin.diagnostics.some((d) => d.startsWith("error: missing generated part 'tool.g.dart' at bin/tool.dart:1:6"))).toBe(true);
  }, 300_000);

  it('records no entry symbols or exports inside an ignored nested manifest', async () => {
    // dpx: example/dpx_hello (its own pubspec, ignored by discover) has bin/*.dart
    // with `main`s scip-dart never indexes, so ingest could not match them.
    write({
      'withex/pubspec.yaml': pubspec('acme_withex', '1.0.0'),
      'withex/lib/acme_withex.dart': "export 'src/a.dart';\n",
      'withex/lib/src/a.dart': 'int a() => 1;\n',
      'withex/bin/withex.dart': 'void main() {}\n',
      'withex/example/hello/pubspec.yaml': pubspec('hello', '0.0.1'),
      'withex/example/hello/bin/hello.dart': "import 'package:hello/nope.dart';\n\nvoid main() {}\n",
      'withex/example/hello/lib/hello.dart': 'int h() => 1;\n',
      'withex/example/loose.dart': 'void main() {}\n', // not under the ignored manifest: still ours
    });
    const repo = repoOf(root, 'withex', pubPackage('acme_withex', ['lib/acme_withex.dart', 'bin/withex.dart']));
    repo.localPath = path.join(root, 'withex');
    repo.ignoredManifests = [{ path: 'example/hello' }];
    const out = path.join(root, 'out-withex');
    mkdirSync(out);
    const r = await scipDart.run(inputFor([repo], repo), out);
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    const s = readJson<ExportsSidecar>(r.exportsFile);
    expect(s.entrySymbols.map((e) => e.file)).toEqual(['bin/withex.dart', 'example/loose.dart']);
    expect(s.exports.map((e) => [e.exportedAs, e.file])).toEqual([['a', 'lib/src/a.dart']]);
    // Nothing from the ignored manifest leaks into diagnostics either (its unresolved import).
    expect(r.diagnostics.some((d) => d.includes('example/hello'))).toBe(false);
  }, 300_000);

  it('after a failed pub get, unresolved own package: URIs are one error, not unresolved exports', async () => {
    // over_react's app/over_react_redux/todo_client: pub get fails on an old SDK
    // bound, the enclosing package's config (which does not map todo_client) is
    // found instead, and every own `package:todo_client/...` directive failed.
    write({
      'outer/pubspec.yaml': pubspec('acme_outer', '1.0.0'),
      'outer/lib/acme_outer.dart': 'int o() => 1;\n',
      'outer/app/inner/pubspec.yaml': "name: acme_inner\nversion: 1.0.0\npublish_to: none\nenvironment:\n  sdk: '>=2.11.0 <3.0.0'\n",
      'outer/app/inner/lib/acme_inner.dart': "export 'package:acme_inner/src/a.dart';\n",
      'outer/app/inner/lib/src/a.dart': "import 'package:acme_inner/src/b.dart';\n\nint a() => b();\n",
      'outer/app/inner/lib/src/b.dart': 'int b() => 1;\n',
      // pub get succeeds: an own export of a file that does not exist stays unresolved.
      'selfmiss/pubspec.yaml': pubspec('acme_selfmiss', '1.0.0'),
      'selfmiss/lib/acme_selfmiss.dart': "export 'package:acme_selfmiss/src/missing.dart';\n",
    });
    const outer = repoOf(root, 'outer', pubPackage('acme_outer', ['lib/acme_outer.dart']));
    const inner = repoOf(root, 'inner', pubPackage('acme_inner', ['lib/acme_inner.dart']));
    const selfmiss = repoOf(root, 'selfmiss', pubPackage('acme_selfmiss', ['lib/acme_selfmiss.dart']));
    outer.localPath = path.join(root, 'outer');
    inner.localPath = path.join(root, 'outer/app/inner');
    selfmiss.localPath = path.join(root, 'selfmiss');
    const repos = [outer, inner, selfmiss];
    expect((await scipDart.prepare!(inputFor(repos, outer))).status).toBe('ok');
    const out = path.join(root, 'out-selfuri');
    mkdirSync(out);

    const r = await scipDart.run(inputFor(repos, inner), out);
    expect(r.status, r.diagnostics.join('\n')).toBe('partial');
    expect(r.diagnostics.some((d) => /^error: dart pub get --offline exited with 65/.test(d))).toBe(true);
    expect(r.diagnostics.filter((d) => d.startsWith('error: package unresolvable'))).toEqual([
      'error: package unresolvable (pub get failed): 2 own package: import/export URI(s) do not resolve',
    ]);
    expect(r.diagnostics.some((d) => d.includes('unresolved org module') || d.includes('unresolved export'))).toBe(false);
    const s = readJson<ExportsSidecar>(r.exportsFile);
    expect(s.unresolved).toEqual([]); // no dynamic_access at ingest
    expect(s).not.toHaveProperty('unresolvedOwnUris');

    const m = await scipDart.run(inputFor(repos, selfmiss), out);
    expect(m.status).toBe('partial');
    expect(m.diagnostics.some((d) => d.startsWith('error: package unresolvable'))).toBe(false);
    expect(readJson<ExportsSidecar>(m.exportsFile).unresolved).toEqual(["lib/acme_selfmiss.dart: export 'package:acme_selfmiss/src/missing.dart'"]);
  }, 300_000);

  it('retries pub get without a source link whose HEAD conflicts with the consumer, restoring the user override', async () => {
    // acme_lib HEAD depends on `shared` from hosted; the consumer pins `shared` by
    // path. The user's own override points acme_lib at an older copy with no deps.
    write({
      'shared1/pubspec.yaml': pubspec('shared', '1.0.0'),
      'shared1/lib/shared.dart': 'int s() => 1;\n',
      'lib/pubspec.yaml': pubspec('acme_lib', '2.0.0', '  shared: ^2.0.0\n'),
      'lib/lib/acme_lib.dart': 'int libFn() => 2;\n',
      'lib_old/pubspec.yaml': pubspec('acme_lib', '1.0.0'),
      'lib_old/lib/acme_lib.dart': 'int libFn() => 1;\n',
      'app/pubspec.yaml': pubspec('acme_app', '1.0.0', '  acme_lib: ^1.0.0\n  shared:\n    path: ../shared1\n'),
      'app/bin/main.dart': "import 'package:acme_lib/acme_lib.dart';\n\nvoid main() => print(libFn());\n",
      // The user's own overrides file: backed up, replaced by our link, restored on the retry.
      'app/pubspec_overrides.yaml': 'dependency_overrides:\n  acme_lib:\n    path: ../lib_old\n',
    });
    const lib = repoOf(root, 'lib', pubPackage('acme_lib', ['lib/acme_lib.dart'], [{ name: 'shared', manager: 'pub', constraint: '^2.0.0', resolvedPackageId: null }]));
    const app = repoOf(root, 'app', pubPackage('acme_app', ['bin/main.dart'], [orgDep('acme_lib', '^1.0.0')]));
    for (const r of [lib, app]) r.localPath = path.join(root, r.repo.split('/')[1]!);
    const prep = await scipDart.prepare!(inputFor([lib, app], app));
    expect(prep.diagnostics).toContain(
      "warn: acme_lib not source-linked: HEAD conflicts with acme_app's constraint " +
        '(every version of acme_lib from path depends on shared from hosted and acme_app depends on shared from path)',
    );
    expect(prep.diagnostics).toContain('info: replaced existing dependency_overrides entry for acme_lib');
    expect(prep.status, prep.diagnostics.join('\n')).toBe('ok');
    expect(prep.log.filter((l) => l.startsWith('$ dart pub get'))).toHaveLength(2);
    // Nothing left to link: the user's file is back as it was.
    expect(readFileSync(path.join(root, 'app/pubspec_overrides.yaml'), 'utf8')).toBe('dependency_overrides:\n  acme_lib:\n    path: ../lib_old\n');
    const config = readFileSync(path.join(root, 'app/.dart_tool/package_config.json'), 'utf8');
    expect(config).toMatch(/"rootUri": "\.\.\/\.\.\/lib_old\/?"/);
  }, 300_000);
});

describe('scip-typescript on js_src-style npm packages in a Dart repo', () => {
  // react_testing_library's js_src: JavaScript only, node_modules full of .d.ts.
  // scip-typescript's --infer-tsconfig saw those and wrote `{}` (no allowJs):
  // "no files got indexed", status failed.
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-jssrc-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function setup(name: string, files: Record<string, string>): IndexerInput {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name, f)), { recursive: true });
      writeFileSync(path.join(root, name, f), body);
    }
    const pkg: DiscoveredPackage = { packageId: `npm:${name}`, path: 'js_src', manager: 'npm', name, version: '1.0.0', entryPoints: ['js_src/src/index.js'], deps: [] };
    const repo: DiscoveredRepo = { repo: `acme/${name}`, localPath: path.join(root, name), headSha: null, packages: [pkg] };
    return { repo, pkg, lookup: () => undefined, orgPackages: [{ repo, pkg }], options: { install: false, maxOldSpaceMb: 2048 } };
  }
  const jsOnly = {
    'js_src/package.json': JSON.stringify({ name: 'x_src', version: '1.0.0', private: true, main: 'src/index.js' }),
    'js_src/babel.config.js': 'module.exports = {};\n',
    'js_src/src/index.js': 'export function render() { return 1; }\n',
    'js_src/node_modules/dep/index.d.ts': 'export declare const x: number;\n',
  };

  it('infers an allowJs tsconfig itself (node_modules not searched) and indexes the JavaScript', async () => {
    const inp = setup('jsonly', jsOnly);
    const out = path.join(root, 'out-jsonly');
    mkdirSync(out);
    const r = await scipTypescript.run(inp, out);
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    expect(readFileSync(path.join(root, 'jsonly/js_src/tsconfig.json'), 'utf8')).toBe('{"compilerOptions":{"allowJs":true}}');
    expect(r.diagnostics.find((d) => d.startsWith('info: no tsconfig.json'))).toMatch(/JavaScript sources only/);
    expect(readScipIndex(r.scipFile).documents.map((d) => d.relativePath)).toContain('src/index.js');
    expect(readJson<ExportsSidecar>(r.exportsFile).exports.map((e) => e.exportedAs)).toEqual(['render']);
  }, 120_000);

  it('upgrades a `{}` tsconfig left by an earlier run in a JavaScript-only package', async () => {
    const inp = setup('stale', { ...jsOnly, 'js_src/tsconfig.json': '{}' });
    const out = path.join(root, 'out-stale');
    mkdirSync(out);
    const r = await scipTypescript.run(inp, out);
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    expect(r.diagnostics).toContain(
      'info: tsconfig.json is {} but the package has JavaScript sources only (it would index nothing); rewrote it as {"compilerOptions":{"allowJs":true}}',
    );
    expect(readScipIndex(r.scipFile).documents.map((d) => d.relativePath)).toContain('src/index.js');
  }, 120_000);

  it('a package with no sources at all gets an empty index, status ok, and a warn', async () => {
    const inp = setup('nocode', {
      'js_src/package.json': JSON.stringify({ name: 'nocode', version: '1.0.0', private: true, scripts: { build: 'vite build' } }),
      'js_src/tsconfig.json': '{}',
      'js_src/README.md': '# bundle build\n',
      'js_src/node_modules/dep/index.js': 'module.exports = 1;\n',
    });
    expect(scipTypescript.detect(inp)).toBe(true);
    const out = path.join(root, 'out-nocode');
    mkdirSync(out);
    const r = await scipTypescript.run(inp, out);
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    expect(r.diagnostics).toContain('warn: tsconfig has no input files: the package has no TypeScript/JavaScript sources; wrote an empty index');
    const idx = readScipIndex(r.scipFile);
    expect(idx.documents).toEqual([]);
    expect(idx.metadata?.toolInfo?.name).toBe('scip-typescript');
    expect(idx.metadata?.projectRoot).toBe(pathToFileURL(path.join(root, 'nocode/js_src')).href);
    expect(readJson<ExportsSidecar>(r.exportsFile)).toMatchObject({ packageId: 'npm:nocode', exports: [], entryPoints: [] });
  });
});
