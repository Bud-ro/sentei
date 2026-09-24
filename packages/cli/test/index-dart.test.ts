// M3: the scip-dart adapter on a temp copy of fixtures/org-dart (plus one broken
// consumer), and the pubspec_overrides.yaml source-link writer.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readScipIndex } from '@sentei/core/scip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERRIDES_HEADER, parseYamlBlock, writeOverrides } from '../src/indexers/scip-dart.ts';
import type { DiscoverFile, DiscoveredPackage, DiscoveredRepo, ExportsSidecar, IndexerInput, OrgPackage } from '../src/indexers/types.ts';
import { index, type RepoIndex } from '../src/stages/index.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/org-dart');
const HAS_DART = spawnSync('dart', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!HAS_DART) console.warn('[index-dart.test] SKIPPING scip-dart indexing tests: `dart` is not on PATH');

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
        repoOf(tmp, 'dart-app', pubPackage('acme_app', ['bin/main.dart'], [orgDep('acme_pub', '^1.0.0'), orgDep('acme_x', 'path:../dart-lib-x')])),
        repoOf(tmp, 'dart-bad', pubPackage('acme_bad', ['bin/main.dart'], [orgDep('acme_x', '^1.0.0')])),
        repoOf(tmp, 'dart-lib-pub', pubPackage('acme_pub', ['lib/acme_pub.dart'])),
        repoOf(tmp, 'dart-lib-x', pubPackage('acme_x', ['lib/acme_x.dart'])),
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
  const sidecar = (repo: string, pkg: string) => readJson<ExportsSidecar>(work, 'index', `acme__${repo}`, `${pkg}.exports.json`);

  it('writes a non-empty .scip file per fixture package, all ok', () => {
    for (const [repo, pkg] of [['dart-app', 'acme_app'], ['dart-lib-pub', 'acme_pub'], ['dart-lib-x', 'acme_x']]) {
      const scip = path.join(work, 'index', `acme__${repo}`, `${pkg}.scip`);
      expect(existsSync(scip), scip).toBe(true);
      expect(statSync(scip).size, scip).toBeGreaterThan(0);
      const r = ix(repo!);
      expect(r.status, `${repo}: ${JSON.stringify(r.packages[0]?.diagnostics)}`).toBe('ok');
      expect(r.packages[0]).toMatchObject({
        packageId: `pub:${pkg}`,
        indexer: 'scip-dart',
        indexerVersion: '1.7.0+sentei.3',
        status: 'ok',
        scip: `${pkg}.scip`,
        exports: `${pkg}.exports.json`,
      });
      expect(existsSync(path.join(work, 'index', `acme__${repo}`, `${pkg}.log`))).toBe(true);
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
      entryPoints: ['lib/acme_x.dart'],
      missingEntryPoints: [],
      unresolved: [],
      unresolvedImports: [],
      flags: [],
      namespaceMemberRefs: [],
      unindexedImports: [],
      entrySymbols: [],
    });
    const rows = s.exports.map((e) => [e.exportedAs, e.name, e.file, e.line, e.col]);
    expect(rows).toEqual([
      ['IntTimes', 'IntTimes', 'lib/acme_x.dart', 29, 10],
      ['Shown', 'Shown', 'lib/src/shown.dart', 3, 6],
      ['implUnused', 'implUnused', 'lib/src/impl.dart', 6, 4],
      ['implUsed', 'implUsed', 'lib/src/impl.dart', 3, 4],
      ['partUnused', 'partUnused', 'lib/src/part_a.dart', 8, 4],
      ['partUsed', 'partUsed', 'lib/src/part_a.dart', 5, 4],
      ['shownOnly', 'shownOnly', 'lib/src/impl.dart', 10, 4],
      ['unusedFn', 'unusedFn', 'lib/acme_x.dart', 15, 4],
      ['usedFn', 'usedFn', 'lib/acme_x.dart', 12, 4],
    ]);
    for (const e of s.exports) expect(e.entry).toBe('lib/acme_x.dart');
    // `export 'src/shown.dart' show Shown;` (line 7): the shown name is a site, not a use.
    const shown = s.exports.find((e) => e.name === 'Shown')!;
    expect(shown.sites).toEqual([{ file: 'lib/acme_x.dart', line: 6, col: 'export \'src/shown.dart\' show '.length }]);
    for (const e of s.exports.filter((x) => x.name !== 'Shown')) expect(e.sites).toEqual([]);
  });

  it('bin entries are listed, export nothing, and record their main as an entry symbol', () => {
    const s = sidecar('dart-app', 'acme_app');
    expect(s.entryPoints).toEqual(['bin/main.dart']);
    expect(s.exports).toEqual([]);
    expect(s.unresolvedImports).toEqual([]);
    // `void main() {` on line 10: the runtime calls it, nothing references it.
    expect(s.entrySymbols).toEqual([{ name: 'main', file: 'bin/main.dart', line: 9, col: 5 }]);
    expect(sidecar('dart-lib-x', 'acme_x').entrySymbols).toEqual([]); // a lib entry without main
    expect(sidecar('dart-bad', 'acme_bad').entrySymbols).toEqual([{ name: 'main', file: 'bin/main.dart', line: 2, col: 5 }]);
  });

  it('gives private declarations global symbols (patched scip-dart), consumer refs carry the lib symbols', () => {
    const lib = readScipIndex(path.join(work, 'index/acme__dart-lib-x/acme_x.scip'));
    const entry = lib.documents.find((d) => d.relativePath === 'lib/acme_x.dart')!;
    const island = 'scip-dart pub acme_x 1.0.0 lib/`acme_x.dart`/_islandA().';
    expect(entry.symbols.map((s) => s.symbol)).toContain(island);
    expect(entry.occurrences.some((o) => o.symbol === island && (o.symbolRoles & 1) === 1)).toBe(true);
    expect(entry.occurrences.some((o) => o.symbol === island && (o.symbolRoles & 1) === 0)).toBe(true); // from _islandB

    const app = readScipIndex(path.join(work, 'index/acme__dart-app/acme_app.scip'));
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
