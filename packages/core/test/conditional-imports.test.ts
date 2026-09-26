// Dart conditional imports (sidecar `conditionalImports`, written by the dart-surface
// adapter): the index resolves every use against the default target; ingest lends
// those uses to the alternatives' same-named declarations, or (no target document to
// match on) makes the alternative reachable whenever the importing document is.
// Hand-made SCIP + sidecar: no Dart toolchain needed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeOrg } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { ingestOrg, repoSlug, type ExportsSidecar, type IngestCounts, type IngestDiscoverInput, type RepoIndexFile } from '../src/ingest.ts';
import { IndexSchema } from '../src/scip/scip_pb.ts';

const PKG = 'pub:acme/fa:fa';
const S = 'scip-dart pub fa 1.0.0 lib/';
const mod = (file: string): string => `${S}${file.split('/').slice(1, -1).map((d) => `${d}/`).join('')}\`${file.split('/').at(-1)}\`/`;

interface Occ { range: number[]; symbol: string; roles?: number; enclosing?: number[] }

/**
 * lib/fa.dart (entry) `start()` -> lib/src/storage.dart `createStorage()`, which calls
 * `createPlatform()` of the default target lib/src/unsupported.dart
 * (`import 'unsupported.dart' if (dart.library.io) 'desktop.dart' if (dart.library.js_interop) 'web.dart'`).
 * desktop.dart: `createPlatform()` -> `_helper()`; `_deadInDesktop()` used by nothing.
 * web.dart: `createPlatform` declared with another descriptor kind (a getter `createPlatform.`) -> `_webHelper()`.
 * ext.dart: the alternative of a directive whose default is `dart:io` (no document to match).
 */
const DOCS: Record<string, Occ[]> = {
  'lib/fa.dart': [
    { range: [0, 0, 0], symbol: mod('lib/fa.dart'), roles: 1 },
    { range: [1, 5, 10], symbol: `${mod('lib/fa.dart')}start().`, roles: 1, enclosing: [1, 0, 3, 1] },
    { range: [2, 2, 15], symbol: `${mod('lib/src/storage.dart')}createStorage().` },
  ],
  'lib/src/storage.dart': [
    { range: [0, 0, 0], symbol: mod('lib/src/storage.dart'), roles: 1 },
    { range: [1, 8, 21], symbol: `${mod('lib/src/storage.dart')}createStorage().`, roles: 1, enclosing: [1, 0, 3, 1] },
    { range: [2, 4, 18], symbol: `${mod('lib/src/unsupported.dart')}createPlatform().` },
  ],
  'lib/src/unsupported.dart': [
    { range: [0, 0, 0], symbol: mod('lib/src/unsupported.dart'), roles: 1 },
    { range: [0, 5, 19], symbol: `${mod('lib/src/unsupported.dart')}createPlatform().`, roles: 1, enclosing: [0, 0, 0, 40] },
  ],
  'lib/src/desktop.dart': [
    { range: [0, 0, 0], symbol: mod('lib/src/desktop.dart'), roles: 1 },
    { range: [0, 5, 19], symbol: `${mod('lib/src/desktop.dart')}createPlatform().`, roles: 1, enclosing: [0, 0, 2, 1] },
    { range: [1, 2, 9], symbol: `${mod('lib/src/desktop.dart')}_helper().` },
    { range: [3, 5, 12], symbol: `${mod('lib/src/desktop.dart')}_helper().`, roles: 1, enclosing: [3, 0, 4, 1] },
    { range: [5, 5, 19], symbol: `${mod('lib/src/desktop.dart')}_deadInDesktop().`, roles: 1, enclosing: [5, 0, 6, 1] },
  ],
  'lib/src/web.dart': [
    { range: [0, 0, 0], symbol: mod('lib/src/web.dart'), roles: 1 },
    { range: [0, 8, 22], symbol: `${mod('lib/src/web.dart')}createPlatform.`, roles: 1, enclosing: [0, 0, 2, 1] },
    { range: [1, 2, 12], symbol: `${mod('lib/src/web.dart')}_webHelper().` },
    { range: [3, 5, 15], symbol: `${mod('lib/src/web.dart')}_webHelper().`, roles: 1, enclosing: [3, 0, 4, 1] },
  ],
  'lib/src/ext.dart': [
    { range: [0, 0, 0], symbol: mod('lib/src/ext.dart'), roles: 1 },
    { range: [0, 5, 13], symbol: `${mod('lib/src/ext.dart')}extThing().`, roles: 1, enclosing: [0, 0, 1, 1] },
    { range: [2, 5, 16], symbol: `${mod('lib/src/ext.dart')}_extPrivate().`, roles: 1, enclosing: [2, 0, 3, 1] },
  ],
};

const CONDITIONAL: NonNullable<ExportsSidecar['conditionalImports']> = [
  {
    file: 'lib/src/storage.dart', line: 0, col: 0, target: 'lib/src/unsupported.dart',
    alternatives: ['lib/src/desktop.dart', 'lib/src/web.dart', 'package:other/other.dart'],
  },
  { file: 'lib/fa.dart', line: 0, col: 0, target: 'dart:io', alternatives: ['lib/src/ext.dart'] },
];

describe('ingestOrg: sidecar conditionalImports', () => {
  let root: string;
  let workDir: string;
  let db: DatabaseSync;
  let logs: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sentei-cond-'));
    workDir = join(root, 'work');
    logs = [];
    db = openDb(':memory:');
    db.prepare("INSERT INTO repos (repo) VALUES ('acme/fa')").run();
    db.prepare(`INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('${PKG}', 'acme/fa', '.', 'pub', 'fa', 'private')`).run();
    db.prepare("INSERT OR REPLACE INTO policy (key, value) VALUES ('minAgeDays', '0')").run();
    const dir = join(workDir, 'index', repoSlug('acme/fa'));
    mkdirSync(dir, { recursive: true });
    const idx = create(IndexSchema, {
      documents: Object.entries(DOCS).map(([path, occs]) => ({
        relativePath: path,
        occurrences: occs.map((o) => ({ range: o.range, symbol: o.symbol, symbolRoles: o.roles ?? 0, enclosingRange: o.enclosing ?? [] })),
      })),
    });
    writeFileSync(join(dir, 'fa.scip'), toBinary(IndexSchema, idx));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      repo: 'acme/fa', headSha: 'abc', status: 'ok',
      packages: [{ packageId: PKG, indexer: 'scip-dart', indexerVersion: '1', status: 'ok', scip: 'fa.scip', exports: 'fa.exports.json', diagnostics: [] }],
    } satisfies RepoIndexFile));
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function run(conditionalImports?: ExportsSidecar['conditionalImports']): IngestCounts {
    const sidecar: ExportsSidecar = {
      packageId: PKG, entryPoints: ['lib/fa.dart'], unresolved: [],
      // `start` is a runtime entry (a seed that never gets a verdict itself).
      exports: [], entrySymbols: [{ file: 'lib/fa.dart', line: 1, col: 5, name: 'start' }],
      ...(conditionalImports !== undefined ? { conditionalImports } : {}),
    };
    writeFileSync(join(workDir, 'index', repoSlug('acme/fa'), 'fa.exports.json'), JSON.stringify(sidecar));
    const discover: IngestDiscoverInput = { repos: [{ repo: 'acme/fa', packages: [{ packageId: PKG, path: '.', entryPoints: ['lib/fa.dart'] }] }] };
    const counts = ingestOrg({ db, workDir, discover, log: (l) => logs.push(l) });
    analyzeOrg({ db, now: 1_800_000_000, log: () => {} });
    return counts;
  }
  const privateDead = (): string[] => (db.prepare(`SELECT s.file || ' ' || s.name AS n FROM findings f JOIN symbols s USING (symbol_id)
    WHERE f.verdict = 'private_dead' ORDER BY s.file, s.name`).all() as Array<{ n: string }>).map((r) => r.n);

  it('without the sidecar field, every alternative is private_dead (the gap)', () => {
    run();
    expect(privateDead()).toEqual([
      'lib/src/desktop.dart _deadInDesktop',
      'lib/src/desktop.dart _helper',
      'lib/src/desktop.dart createPlatform',
      'lib/src/ext.dart _extPrivate',
      'lib/src/ext.dart extThing',
      'lib/src/web.dart _webHelper',
      'lib/src/web.dart createPlatform',
    ]);
  });

  it("lends the target's uses to the alternatives' twins; what only the alternative uses follows; the rest stays dead", () => {
    const c = run(CONDITIONAL);
    // desktop's createPlatform (same descriptor) and web's getter (same name) are used
    // where unsupported's is; their helpers follow; ext.dart (default dart:io) is kept
    // whole. Only desktop's truly unused _deadInDesktop is still private_dead.
    expect(privateDead()).toEqual(['lib/src/desktop.dart _deadInDesktop']);
    expect(c.conditionalImports).toBe(3);
    expect(c.conditionalMirroredSymbols).toBe(2);
    // The package: alternative is outside the repo: skipped silently, not unmatched.
    expect(c.unmatchedConditionalImports).toBe(0);
    // The use is copied at the same position, from the same enclosing declaration.
    const occ = db.prepare(`SELECT o.file, o.line, o.col, e.name AS enclosing FROM occurrences o JOIN symbols s USING (symbol_id)
      JOIN symbols e ON e.symbol_id = o.enclosing_symbol_id WHERE s.file = 'lib/src/desktop.dart' AND s.name = 'createPlatform' AND (o.role & 1) = 0`).all();
    expect(occ).toEqual([{ file: 'lib/src/storage.dart', line: 2, col: 4, enclosing: 'createStorage' }]);
    // ext.dart: an edge from the importing document's module symbol and top-level declarations.
    const ext = db.prepare(`SELECT f.name AS "from", t.name AS "to" FROM edges e JOIN symbols f ON f.symbol_id = e.from_symbol_id
      JOIN symbols t ON t.symbol_id = e.to_symbol_id WHERE t.file = 'lib/src/ext.dart' ORDER BY 1, 2`).all();
    expect(ext).toEqual([
      { from: 'lib/fa.dart', to: '_extPrivate' },
      { from: 'lib/fa.dart', to: 'extThing' },
      { from: 'start', to: '_extPrivate' },
      { from: 'start', to: 'extThing' },
    ]);
  });

  it('warns about an importing file or alternative that is not an indexed document', () => {
    const c = run([
      { file: 'lib/src/storage.dart', line: 0, col: 0, target: 'lib/src/unsupported.dart', alternatives: ['lib/src/missing.dart'] },
      { file: 'lib/gone.dart', line: 0, col: 0, target: 'lib/src/unsupported.dart', alternatives: ['lib/src/desktop.dart'] },
    ]);
    expect(c.unmatchedConditionalImports).toBe(2);
    expect(c.conditionalImports).toBe(0);
    expect(logs.some((l) => l.includes('2 conditional import(s) not applied') && l.includes('lib/src/missing.dart'))).toBe(true);
  });
});
