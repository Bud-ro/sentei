import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { blankComments, runWitness, stringLiterals, type WitnessDiscoverInput } from '../src/witness.ts';

// A hand-built org: library P (npm:@acme/lib or pub:lib_pub) with one consumer C
// whose package dir is <repo>/pkg. Every symbol gets a witness_pending finding.

interface OrgSpec {
  manager?: 'npm' | 'pub';
  /** Consumer files, relative to the consumer package dir. */
  files?: Record<string, string>;
  /** Symbols of P: name + defining file (default src/index.ts) + symbol_exports rows [entry, exportedAs]. */
  symbols: Array<{ name: string; file?: string; line?: number; exports?: Array<[string, string]> }>;
  /** Library (P) files, relative to P's dir (the acme/lib repo root). */
  libFiles?: Record<string, string>;
  policy?: Record<string, unknown>;
  keep?: string[];
  /** Consumer checkout does not exist on disk. */
  missingCheckout?: boolean;
  /** The consumer declares P only as a dev dependency (package_deps.dev = 1). */
  devDep?: boolean;
  /** Leave out the analyze marker (run_params analyzed_at). */
  notAnalyzed?: boolean;
}

interface Org {
  db: DatabaseSync;
  discover: WitnessDiscoverInput;
  ids: Record<string, number>;
  log: string[];
}

const roots: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string): void {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

function buildOrg(spec: OrgSpec): Org {
  const manager = spec.manager ?? 'npm';
  const libName = manager === 'npm' ? '@acme/lib' : 'lib_pub';
  const appName = manager === 'npm' ? '@acme/app' : 'app_pub';
  const P = `${manager}:${libName}`;
  const C = `${manager}:${appName}`;
  const root = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-witness-'));
  roots.push(root);
  const libDir = join(root, 'lib');
  const appDir = join(root, 'app');
  mkdirSync(libDir, { recursive: true });
  for (const [rel, text] of Object.entries(spec.libFiles ?? {})) write(libDir, rel, text);
  if (!spec.missingCheckout) {
    mkdirSync(join(appDir, 'pkg'), { recursive: true });
    for (const [rel, text] of Object.entries(spec.files ?? {})) write(appDir, `pkg/${rel}`, text);
  }

  const db = openDb(':memory:');
  dbs.push(db);
  const run = (sql: string, ...p: Array<string | number | null>): void => {
    db.prepare(sql).run(...p);
  };
  run("INSERT INTO repos (repo, index_status) VALUES ('acme/lib', 'ok'), ('acme/app', 'ok')");
  run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/lib', '.', ?, ?, 'private')", P, manager, libName);
  run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/app', 'pkg', ?, ?, 'private')", C, manager, appName);
  // Another org package nested inside the consumer's dir: its files must be skipped.
  const nestedName = manager === 'npm' ? '@acme/nested' : 'nested_pub';
  run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/app', 'pkg/nested', ?, ?, 'private')", `${manager}:${nestedName}`, manager, nestedName);
  run('INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id, dev) VALUES (?, ?, ?, ?, ?)', C, libName, manager, P, spec.devDep ? 1 : 0);
  for (const [k, v] of Object.entries(spec.policy ?? {})) run('INSERT OR REPLACE INTO policy (key, value) VALUES (?, ?)', k, JSON.stringify(v));
  for (const k of spec.keep ?? []) run('INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, ?)', P, k);

  const ids: Record<string, number> = {};
  for (const s of spec.symbols) {
    const file = s.file ?? 'src/index.ts';
    const r = db
      .prepare('INSERT INTO symbols (symbol_str, package_id, file, line, name, is_exported) VALUES (?, ?, ?, ?, ?, 1)')
      .run(`sym ${P} ${file} ${s.name}`, P, file, s.line ?? null, s.name);
    const id = Number(r.lastInsertRowid);
    ids[`${file}#${s.name}`] = id;
    ids[s.name] ??= id;
    for (const [entry, as] of s.exports ?? []) {
      run('INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, ?, ?)', id, entry, as);
    }
    run("INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, 'needs_review', ?, '[]')", id, JSON.stringify(['no_refs', 'witness_pending']));
  }
  db.exec(analyzeSql());
  if (!spec.notAnalyzed) run("INSERT INTO run_params (key, value) VALUES ('analyzed_at', '0')");

  const discover: WitnessDiscoverInput = {
    repos: [
      { repo: 'acme/lib', localPath: libDir, packages: [{ packageId: P, path: '.' }] },
      {
        repo: 'acme/app',
        localPath: appDir,
        packages: [
          { packageId: C, path: 'pkg' },
          { packageId: `${manager}:${nestedName}`, path: 'pkg/nested' },
        ],
      },
    ],
  };
  return { db, discover, ids, log: [] };
}

function witness(org: Org): ReturnType<typeof runWitness> {
  return runWitness({ db: org.db, discover: org.discover, now: 1_800_000_000, log: (l) => org.log.push(l) });
}

function findings(org: Org, id: number): Array<{ verdict: string; reasons: string[] }> {
  return (org.db.prepare('SELECT verdict, reasons FROM findings WHERE symbol_id = ? ORDER BY verdict').all(id) as Array<{ verdict: string; reasons: string }>)
    .map((r) => ({ verdict: r.verdict, reasons: JSON.parse(r.reasons) as string[] }));
}

function witnessOk(org: Org, id: number): boolean {
  return org.db.prepare('SELECT 1 FROM witness_ok WHERE symbol_id = ?').get(id) !== undefined;
}

function expectPass(org: Org, id: number): void {
  expect(findings(org, id)).toEqual([{ verdict: 'deletion_candidate', reasons: ['no_refs'] }]);
  expect(witnessOk(org, id)).toBe(true);
}

function expectMismatch(org: Org, id: number, reasons: string[]): void {
  expect(findings(org, id)).toEqual([{ verdict: 'needs_review', reasons: ['no_refs', ...reasons] }]);
  expect(witnessOk(org, id)).toBe(false);
}

describe('runWitness', () => {
  it('passes a symbol no consumer names: witness_ok + deletion_candidate', () => {
    const org = buildOrg({
      symbols: [{ name: 'deadFn' }],
      files: { 'src/main.ts': "import { liveFn } from '@acme/lib';\nliveFn();\n" },
    });
    expect(witness(org)).toEqual({ checked: 1, passed: 1, mismatched: 0 });
    expectPass(org, org.ids['deadFn']!);
    expect(org.db.prepare('SELECT checked_at FROM witness_ok').get()).toEqual({ checked_at: 1_800_000_000 });
  });

  it('keeps blocked_by and the base reasons, dropping witness_pending', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    const id = org.ids['deadFn']!;
    org.db.prepare('DELETE FROM findings WHERE symbol_id = ?').run(id);
    org.db
      .prepare("INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, 'needs_review', ?, ?)")
      .run(id, JSON.stringify(['only_test_refs', 'witness_pending']), JSON.stringify(['x']));
    witness(org);
    expect(org.db.prepare('SELECT verdict, reasons, blocked_by FROM findings').all()).toEqual([
      { verdict: 'deletion_candidate', reasons: '["only_test_refs"]', blocked_by: '["x"]' },
    ]);
  });

  it('ignores needs_review rows that are not witness_pending', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    const id = org.ids['deadFn']!;
    org.db.prepare('DELETE FROM findings WHERE symbol_id = ?').run(id);
    org.db.prepare("INSERT INTO findings (symbol_id, verdict, reasons) VALUES (?, 'needs_review', '[\"version_skew\"]')").run(id);
    expect(witness(org)).toEqual({ checked: 0, passed: 0, mismatched: 0 });
    expect(witnessOk(org, id)).toBe(false);
  });

  it('downgrades a named hit in an importing file, with consumer:file:line', () => {
    const org = buildOrg({
      symbols: [{ name: 'deadFn' }],
      files: { 'src/main.ts': "import { liveFn } from '@acme/lib';\n\n// deadFn is gone\nconst x = liveFn();\n" },
    });
    expect(witness(org)).toEqual({ checked: 1, passed: 0, mismatched: 1 });
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:@acme/app:pkg/src/main.ts:3']);
    expect(org.log.some((l) => l.includes('mismatch npm:@acme/lib#deadFn'))).toBe(true);
  });

  it('passes when the same name appears only in files that do not import P', () => {
    const org = buildOrg({
      symbols: [{ name: 'deadFn' }],
      files: {
        'src/local.ts': "import { deadFn } from '@acme/lib-other';\nfunction deadFn2() {}\nconst deadFn = 1;\n",
        'src/main.ts': "import { liveFn } from '@acme/lib';\nliveFn();\n",
        // Nested org package inside the consumer dir: not part of C.
        'nested/src/x.ts': "import { deadFn } from '@acme/lib';\n",
        // Skipped directories.
        'node_modules/@acme/lib/index.ts': "export { deadFn } from '@acme/lib';\n",
        'dist/main.js': "const { deadFn } = require('@acme/lib');\n",
        // Not a code file.
        'README.md': "import { deadFn } from '@acme/lib';\n",
      },
    });
    witness(org);
    expectPass(org, org.ids['deadFn']!);
  });

  it('matches whole identifiers only', () => {
    const org = buildOrg({
      symbols: [{ name: 'dead' }],
      files: { 'src/main.ts': "import { deadly, undead } from '@acme/lib';\nconst dead_ = deadly + undead;\n" },
    });
    witness(org);
    expectPass(org, org.ids['dead']!);
  });

  it('skips test files unless countTestsAsConsumers, and docs unless countDocsAsConsumers', () => {
    const files = {
      'src/lib.test.ts': "import { testOnly } from '@acme/lib';\ntestOnly();\n",
      'docs/example.ts': "import { docOnly } from '@acme/lib';\n",
    };
    const off = buildOrg({ symbols: [{ name: 'testOnly' }, { name: 'docOnly' }], files });
    expect(witness(off)).toEqual({ checked: 2, passed: 2, mismatched: 0 });

    const on = buildOrg({
      symbols: [{ name: 'testOnly' }, { name: 'docOnly' }],
      files,
      policy: { countTestsAsConsumers: true, countDocsAsConsumers: true },
    });
    expect(witness(on)).toEqual({ checked: 2, passed: 0, mismatched: 2 });
    expectMismatch(on, on.ids['testOnly']!, [
      'witness_mismatch:npm:@acme/app:pkg/src/lib.test.ts:1',
      'witness_mismatch:npm:@acme/app:pkg/src/lib.test.ts:2',
    ]);
    expectMismatch(on, on.ids['docOnly']!, ['witness_mismatch:npm:@acme/app:pkg/docs/example.ts:1']);
  });

  it('scans test files of a consumer whose dependency on P is dev-only (docs stay skipped)', () => {
    const files = {
      'src/lib.test.ts': "import { testOnly } from '@acme/lib';\ntestOnly();\n",
      'docs/example.ts': "import { docOnly } from '@acme/lib';\n",
    };
    const org = buildOrg({ symbols: [{ name: 'testOnly' }, { name: 'docOnly' }, { name: 'unnamed' }], files, devDep: true });
    expect(witness(org)).toEqual({ checked: 3, passed: 2, mismatched: 1 });
    expectMismatch(org, org.ids['testOnly']!, [
      'witness_mismatch:npm:@acme/app:pkg/src/lib.test.ts:1',
      'witness_mismatch:npm:@acme/app:pkg/src/lib.test.ts:2',
    ]);
    expectPass(org, org.ids['docOnly']!);
    expectPass(org, org.ids['unnamed']!);
  });

  it('refuses to run on a DB analyze has not processed, but accepts an analyzed DB with no findings', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }], notAnalyzed: true });
    expect(() => witness(org)).toThrow(/not been analyzed; run analyze first/);
    const none = buildOrg({ symbols: [] });
    expect(witness(none)).toEqual({ checked: 0, passed: 0, mismatched: 0 });
  });

  it('detects a multi-line import statement', () => {
    const org = buildOrg({
      symbols: [{ name: 'deadFn' }],
      files: { 'src/main.ts': "import {\n  liveFn,\n  deadFn,\n} from '@acme/lib/sub';\n" },
    });
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:@acme/app:pkg/src/main.ts:3']);
  });

  it('detects require(), import(), side-effect import and export-from forms', () => {
    const org = buildOrg({
      symbols: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }],
      files: {
        'src/req.cjs': "const lib = require( '@acme/lib' );\nlib.a();\n",
        'src/dyn.ts': "const m = await import('@acme/lib/deep/x.js');\nm.b();\n",
        'src/side.ts': "import '@acme/lib/register';\nglobalThis.c;\n",
        'src/re.ts': "export { d } from \"@acme/lib\";\n",
        'src/scoped.ts': "import { e } from '@acme/library';\n", // different package: no mention
      },
    });
    expect(witness(org)).toEqual({ checked: 5, passed: 1, mismatched: 4 });
    expectMismatch(org, org.ids['a']!, ['witness_mismatch:npm:@acme/app:pkg/src/req.cjs:2']);
    expectMismatch(org, org.ids['b']!, ['witness_mismatch:npm:@acme/app:pkg/src/dyn.ts:2']);
    expectMismatch(org, org.ids['c']!, ['witness_mismatch:npm:@acme/app:pkg/src/side.ts:2']);
    expectMismatch(org, org.ids['d']!, ['witness_mismatch:npm:@acme/app:pkg/src/re.ts:1']);
    expectPass(org, org.ids['e']!);
  });

  it('caps mismatch reasons at 5, sorted', () => {
    const org = buildOrg({
      symbols: [{ name: 'x' }],
      files: { 'src/main.ts': `import { x } from '@acme/lib';\n${'x;\n'.repeat(9)}` },
    });
    witness(org);
    expectMismatch(org, org.ids['x']!, [1, 2, 3, 4, 5].map((n) => `witness_mismatch:npm:@acme/app:pkg/src/main.ts:${n}`));
  });

  it('detects pub package: imports and ignores other packages', () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'deadWidget' }, { name: 'otherWidget' }, { name: 'interpWidget' }],
      files: {
        'lib/main.dart': "import 'package:lib_pub/widgets.dart';\n\nvoid main() => deadWidget();\nfinal s = '$interpWidget';\n",
        'lib/other.dart': "import 'package:lib_pub_extra/x.dart';\nvoid f() => otherWidget();\n",
        'test/widget_test.dart': "import 'package:lib_pub/widgets.dart';\nvoid t() => otherWidget();\n",
      },
    });
    expect(witness(org)).toEqual({ checked: 3, passed: 1, mismatched: 2 });
    expectMismatch(org, org.ids['deadWidget']!, ['witness_mismatch:pub:app_pub:pkg/lib/main.dart:3']);
    expectMismatch(org, org.ids['interpWidget']!, ['witness_mismatch:pub:app_pub:pkg/lib/main.dart:4']);
    expectPass(org, org.ids['otherWidget']!);
  });

  it('matches `default` only via a default import of the defining module (subpath rule)', () => {
    const org = buildOrg({
      symbols: [
        { name: 'default', file: 'src/anon.ts' },
        { name: 'default', file: 'src/unused-anon.ts' },
      ],
      files: { 'src/main.ts': "import * as W from '@acme/lib';\nimport anon from '@acme/lib/anon';\nexport default anon;\nW.x();\n" },
    });
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['src/anon.ts#default']!, ['witness_mismatch:npm:@acme/app:pkg/src/main.ts:2']);
    expectPass(org, org.ids['src/unused-anon.ts#default']!);
  });

  it('`default`: bare specifier, require, import(), { default as } and index files all count', () => {
    const org = buildOrg({
      symbols: [
        { name: 'default', file: 'src/a.ts' },
        { name: 'default', file: 'src/b.ts' },
        { name: 'default', file: 'src/c.ts' },
        { name: 'default', file: 'src/d/index.ts' },
        { name: 'default', file: 'src/e.ts' },
      ],
      files: {
        'src/1.ts': "const b = require('@acme/lib/b');\nconst c = await import('@acme/lib/c.js');\n",
        'src/2.ts': "import { default as D, other } from '@acme/lib/d';\n",
        'src/3.ts': "import type Lib, { y } from '@acme/lib';\n", // no subpath: over-approximates every default
      },
    });
    expect(witness(org)).toEqual({ checked: 5, passed: 0, mismatched: 5 });
    expectMismatch(org, org.ids['src/b.ts#default']!, [
      'witness_mismatch:npm:@acme/app:pkg/src/1.ts:1',
      'witness_mismatch:npm:@acme/app:pkg/src/3.ts:1',
    ]);
    expectMismatch(org, org.ids['src/c.ts#default']!, [
      'witness_mismatch:npm:@acme/app:pkg/src/1.ts:2',
      'witness_mismatch:npm:@acme/app:pkg/src/3.ts:1',
    ]);
    expectMismatch(org, org.ids['src/d/index.ts#default']!, [
      'witness_mismatch:npm:@acme/app:pkg/src/2.ts:1',
      'witness_mismatch:npm:@acme/app:pkg/src/3.ts:1',
    ]);
  });

  it('searches every export alias: an `export { a as b }` consumer names only b', () => {
    const org = buildOrg({
      symbols: [
        { name: 'internalName', exports: [['src/index.ts', 'publicName']] },
        { name: 'otherInternal', exports: [['src/index.ts', 'otherPublic']] },
      ],
      files: { 'src/main.ts': "import { publicName } from '@acme/lib';\n\npublicName();\n" },
    });
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['internalName']!, [
      'witness_mismatch:npm:@acme/app:pkg/src/main.ts:1',
      'witness_mismatch:npm:@acme/app:pkg/src/main.ts:3',
    ]);
    expectPass(org, org.ids['otherInternal']!);
  });

  it('applies the default-import rule to a named symbol exported as default, from the entry file of that alias', () => {
    const org = buildOrg({
      symbols: [
        // export default cloudflarePagesBuildPlugin, in src/adapter/cloudflare-pages/index.ts
        { name: 'pagesPlugin', file: 'src/adapter/cloudflare-pages/plugin.ts', exports: [['src/adapter/cloudflare-pages/index.ts', 'default']] },
        { name: 'workersPlugin', file: 'src/adapter/cloudflare-workers/plugin.ts', exports: [['src/adapter/cloudflare-workers/index.ts', 'default']] },
        { name: 'bunPlugin', file: 'src/adapter/bun/plugin.ts', exports: [['src/adapter/bun/index.ts', 'default']] },
        { name: 'nodePlugin', file: 'src/adapter/node/plugin.ts', exports: [['src/adapter/node/index.ts', 'default']] },
      ],
      files: {
        'src/a.ts': "import build from '@acme/lib/cloudflare-pages';\nbuild();\n", // subpath = parent dir of the index entry
        'src/b.ts': "import build from '@acme/lib/adapter/cloudflare-workers';\n", // subpath = entry minus src/ and /index.ts
        'src/c.ts': "import { bunPlugin as x } from '@acme/lib/other';\n", // named import of the declared name
        'src/d.ts': "import nodeBuild from '@acme/lib/node-server';\n", // unrelated subpath
      },
    });
    expect(witness(org)).toEqual({ checked: 4, passed: 1, mismatched: 3 });
    expectMismatch(org, org.ids['pagesPlugin']!, ['witness_mismatch:npm:@acme/app:pkg/src/a.ts:1']);
    expectMismatch(org, org.ids['workersPlugin']!, ['witness_mismatch:npm:@acme/app:pkg/src/b.ts:1']);
    expectMismatch(org, org.ids['bunPlugin']!, ['witness_mismatch:npm:@acme/app:pkg/src/c.ts:1']);
    expectPass(org, org.ids['nodePlugin']!);
  });

  it('a default import via the bare specifier matches every default export of P', () => {
    const org = buildOrg({
      symbols: [
        { name: 'app', file: 'src/app.ts', exports: [['src/index.ts', 'default']] },
        { name: 'named', file: 'src/app.ts', exports: [['src/index.ts', 'named']] },
      ],
      files: { 'src/main.ts': "import lib from '@acme/lib';\nlib.fetch();\n" },
    });
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['app']!, ['witness_mismatch:npm:@acme/app:pkg/src/main.ts:1']);
    expectPass(org, org.ids['named']!);
  });

  it('a default import via an exports-map key resolving to the entry file matches', () => {
    const org = buildOrg({
      symbols: [
        { name: 'cf', file: 'src/adapter/cloudflare/impl.ts', exports: [['src/adapter/cloudflare/index.ts', 'default']] },
        { name: 'dn', file: 'src/adapter/deno/impl.ts', exports: [['src/adapter/deno/index.ts', 'default']] },
        { name: 'pl', file: 'src/plugins/x/main.ts', exports: [['src/plugins/x/main.ts', 'default']] },
        { name: 'pm', file: 'src/plugins/y/main.ts', exports: [['src/plugins/y/main.ts', 'default']] },
      ],
      libFiles: {
        'package.json': JSON.stringify({
          name: '@acme/lib',
          exports: {
            '.': './dist/index.js',
            './cf': { types: './dist/types/adapter/cloudflare/index.d.ts', import: './dist/adapter/cloudflare/index.js' },
            './p/*': './dist/plugins/*/main.js',
          },
        }),
      },
      files: {
        'src/a.ts': "import cf from '@acme/lib/cf';\n",
        'src/b.ts': "import x from '@acme/lib/p/x';\n", // pattern key with * = x
      },
    });
    witness(org);
    expectMismatch(org, org.ids['cf']!, ['witness_mismatch:npm:@acme/app:pkg/src/a.ts:1']);
    expectPass(org, org.ids['dn']!);
    expectMismatch(org, org.ids['pl']!, ['witness_mismatch:npm:@acme/app:pkg/src/b.ts:1']);
    expectPass(org, org.ids['pm']!);
  });

  it('skips the extended test/docs dirs (mocks, fixtures, e2e, examples, specs, stories…)', () => {
    const imp = "import { deadFn } from '@acme/lib';\n";
    const org = buildOrg({
      symbols: [{ name: 'deadFn' }],
      files: {
        'src/mocks/m.ts': imp, '__mocks__/m.ts': imp, 'fixtures/f.ts': imp, 'src/__fixtures__/f.ts': imp, 'e2e/e.ts': imp,
        'test-integration/t.ts': imp, 'src/__schemas__/s.ts': imp, 'src/a.spec.ts': imp, 'src/b_test.ts': imp,
        'src/C.stories.tsx': imp, 'examples/x.ts': imp, 'example/y.ts': imp, 'demo/z.ts': imp,
      },
    });
    witness(org);
    expectPass(org, org.ids['deadFn']!);
  });

  it('outside git: scans a build/ dir holding a manifest (a real package), skips build output', () => {
    const org = buildOrg({
      symbols: [{ name: 'usedInBuildPkg' }, { name: 'onlyInDist' }],
      files: {
        'build/package.json': '{"name":"@acme/vite-build"}',
        'build/src/x.ts': "import { usedInBuildPkg } from '@acme/lib';\n",
        'dist/out.js': "import { onlyInDist } from '@acme/lib';\n",
      },
    });
    witness(org);
    expectMismatch(org, org.ids['usedInBuildPkg']!, ['witness_mismatch:npm:@acme/app:pkg/build/src/x.ts:1']);
    expectPass(org, org.ids['onlyInDist']!);
  });

  it('in a git checkout: follows .gitignore instead of skipping build/dist by name', () => {
    const org = buildOrg({
      symbols: [{ name: 'usedInBuild' }, { name: 'onlyInIgnored' }],
      files: {
        'build/x.ts': "import { usedInBuild } from '@acme/lib';\n", // no manifest, but not ignored
        'out/y.js': "import { onlyInIgnored } from '@acme/lib';\n",
      },
    });
    const appDir = org.discover.repos[1]!.localPath;
    write(appDir, '.gitignore', 'out/\n');
    execFileSync('git', ['init', '-q'], { cwd: appDir, stdio: 'ignore' });
    witness(org);
    expectMismatch(org, org.ids['usedInBuild']!, ['witness_mismatch:npm:@acme/app:pkg/build/x.ts:1']);
    expectPass(org, org.ids['onlyInIgnored']!);
  });

  it('fails closed when a consumer checkout is missing', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }], missingCheckout: true });
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:@acme/app:checkout missing']);
  });

  it('fails closed when a consumer is absent from discover.json', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    org.discover.repos = org.discover.repos.filter((r) => r.repo !== 'acme/app');
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:@acme/app:checkout missing']);
  });

  it('lets the keep trigger throw on a pending row of a kept package, rolling back', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }], keep: ['deadFn'] });
    expect(() => witness(org)).toThrow(/keep rule/);
    // Rolled back: the pending row is intact and no witness_ok was written.
    expect(findings(org, org.ids['deadFn']!)).toEqual([{ verdict: 'needs_review', reasons: ['no_refs', 'witness_pending'] }]);
    expect(witnessOk(org, org.ids['deadFn']!)).toBe(false);
  });
});

describe('runWitness: self-witness (generated imports of P in P itself)', () => {
  it('a P file with a code template or AST-builder literal naming P, and naming S, is a `self` hit', () => {
    const org = buildOrg({
      symbols: [
        { name: 'IslandWrapper', file: 'src/components/island.ts' },
        { name: 'Unmentioned', file: 'src/components/other.ts' },
        { name: 'OnlyImported', file: 'src/components/other.ts' },
        { name: 'InTemplate', file: 'src/components/other.ts' },
      ],
      libFiles: {
        // A code generator: writes `import { IslandWrapper } from '@acme/lib/components'`.
        'src/gen.ts': [
          "import { parse } from 'parser';",
          'export function gen(ast) {',
          "  ast.unshift(importDeclaration([spec('IslandWrapper')], stringLiteral('@acme/lib/components')));",
          '}',
        ].join('\n'),
        // The statement itself inside a template literal.
        'src/tpl.ts': "export const code = `import { InTemplate } from '@acme/lib/components'`;\n",
        // A real self-import by name: P is its own consumer (the indexer may not have seen it).
        'src/real.ts': "import { OnlyImported } from '@acme/lib/components';\nexport {\n  OnlyImported,\n} from '@acme/lib';\n",
        // Test files are skipped (policy).
        'src/gen.test.ts': "const s = '@acme/lib'; Unmentioned;\n",
      },
    });
    expect(witness(org)).toEqual({ checked: 4, passed: 1, mismatched: 3 });
    expectMismatch(org, org.ids['IslandWrapper']!, ['witness_mismatch:self:src/gen.ts:3']);
    expectMismatch(org, org.ids['InTemplate']!, ['witness_mismatch:self:src/tpl.ts:1']);
    expectPass(org, org.ids['Unmentioned']!);
    expectMismatch(org, org.ids['OnlyImported']!, ['witness_mismatch:self:src/real.ts:1', 'witness_mismatch:self:src/real.ts:3']);
  });

  it('only code templates qualify: plugin names and messages do not; multi-line templates do', () => {
    const org = buildOrg({
      symbols: [{ name: 'bunPlugin' }, { name: 'getAuth' }, { name: 'Wrapper' }, { name: 'Other' }, { name: 'documented', file: 'src/doc.ts', line: 5 }],
      libFiles: {
        // Vite plugin name: P's name in a string, no import keyword.
        'src/bun.ts': "export const bunPlugin = () => ({\n  name: '@acme/lib/bun',\n});\n",
        // Deprecation message: mentions P and even `import` but in two separate literals.
        'src/dep.ts': "warn('@acme/lib', 'use @other/lib instead of the import');\nexport const getAuth = 1;\n",
        // Multi-line template writing an import of P.
        'src/gen.ts': 'export const out = (x) => `\n// generated\nimport { Wrapper } from "@acme/lib/components";\n${x}\n`;\n',
        // A JSDoc code fence is a comment: not a template, and not a self-import either. The
        // definition line (line 6) is not a use.
        'src/doc.ts': "/**\n * ```ts\n * import { documented } from '@acme/lib';\n * ```\n */\nexport const documented = `${1}`;\n",
        // A longer package name is not P (but the import clause quotes Other: self-string).
        'src/other.ts': "const code = `import { Other } from '@acme/lib-extra'`;\n",
      },
    });
    expect(witness(org)).toEqual({ checked: 5, passed: 3, mismatched: 2 });
    expectPass(org, org.ids['documented']!);
    expectPass(org, org.ids['bunPlugin']!);
    expectPass(org, org.ids['getAuth']!);
    expectMismatch(org, org.ids['Wrapper']!, ['witness_mismatch:self:src/gen.ts:3']);
    expectMismatch(org, org.ids['Other']!, ['witness_mismatch:self-string:src/other.ts:1']);
  });

  it('searches export aliases in self files and fails closed when P\'s checkout is missing', () => {
    const org = buildOrg({
      symbols: [{ name: 'impl', exports: [['src/index.ts', 'Island']] }],
      libFiles: { 'src/gen.ts': "const code = \"import { Island } from '@acme/lib'\";\n" },
    });
    witness(org);
    expectMismatch(org, org.ids['impl']!, ['witness_mismatch:self:src/gen.ts:1']);

    const gone = buildOrg({ symbols: [{ name: 'impl' }] });
    gone.discover.repos = gone.discover.repos.filter((r) => r.repo !== 'acme/lib');
    witness(gone);
    expectMismatch(gone, gone.ids['impl']!, ['witness_mismatch:self:checkout missing']);
  });

  it('pub: a `package:` string that is not an import directive', () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'Generated' }, { name: 'Plain' }, { name: 'Plain2', file: 'lib/plain2.dart', line: 1 }],
      libFiles: {
        'lib/builder.dart': "import 'package:lib_pub/src/x.dart';\nfinal out = \"import 'package:lib_pub/gen.dart' show Generated;\";\n",
        'lib/plain.dart': "import 'package:lib_pub/src/x.dart';\nvoid f() => Plain();\n",
        // Declares Plain2 on line 2 of a file importing its own package: not a use.
        'lib/plain2.dart': "import 'package:lib_pub/src/x.dart';\nclass Plain2 {}\n",
      },
    });
    witness(org);
    expectMismatch(org, org.ids['Generated']!, ['witness_mismatch:self:lib/builder.dart:2']);
    // The import directive is no code template, but the file imports P by name and names
    // Plain: P is its own consumer.
    expectMismatch(org, org.ids['Plain']!, ['witness_mismatch:self:lib/plain.dart:2']);
    expectPass(org, org.ids['Plain2']!);
  });
});

describe('runWitness: P as its own consumer, and quoted names (self-string)', () => {
  it('own files importing P by name are scanned (codeup actions/), relative importers and comments are not', () => {
    const org = buildOrg({
      symbols: [
        { name: 'defineAction', file: 'src/action.ts', line: 0 },
        { name: 'relOnly', file: 'src/action.ts', line: 1 },
        { name: 'inComment', file: 'src/action.ts', line: 2 },
      ],
      libFiles: {
        'src/action.ts': 'export function defineAction() {}\nexport function relOnly() {}\nexport function inComment() {}\n',
        // Outside src/, unindexed: imports the package by name.
        'actions/unjs/eslint.ts': 'import { defineAction } from "@acme/lib";\n\nexport default defineAction({});\n',
        // Imports relatively: indexed, so the indexer's answer stands.
        'src/other.ts': "import { relOnly } from './action';\nrelOnly();\n",
        // Names P and S only in a comment.
        'src/doc.ts': "/** @example import { inComment } from '@acme/lib' */\nexport const x = 1;\n",
      },
    });
    expect(witness(org)).toEqual({ checked: 3, passed: 2, mismatched: 1 });
    expectMismatch(org, org.ids['defineAction']!, [
      'witness_mismatch:self:actions/unjs/eslint.ts:1',
      'witness_mismatch:self:actions/unjs/eslint.ts:3',
    ]);
    expectPass(org, org.ids['relOnly']!);
    expectPass(org, org.ids['inComment']!);
  });

  it('a literal equal to a name of S, or quoting it in an import-clause shape, is a self-string hit', () => {
    const org = buildOrg({
      symbols: [
        { name: 'executeAsync', file: 'src/ctx.ts' },
        { name: 'HeadStream', file: 'src/head.ts' },
        { name: 'impl', file: 'src/x.ts', exports: [['src/index.ts', 'aliased']] },
        { name: 'withCtx', file: 'src/x.ts' },
        { name: 'listed', file: 'src/x.ts' },
        { name: 'executeAsyncModeOnly', file: 'src/x.ts' },
        { name: 'interpolated', file: 'src/x.ts' },
        { name: 'commented', file: 'src/x.ts' },
        { name: 'gone', file: 'src/x.ts' },
      ],
      libFiles: {
        // unctx: the transform names the helper in a string and generates the import with
        // a variable module path (not P), so the codegen rule cannot see it.
        'src/transform.ts': [
          'export const plugin = {',
          '  helperName: "executeAsync",',
          '  code: (x, mod) => `import { ${x} as __${x} } from "${mod}"`,',
          '};',
        ].join('\n'),
        'src/tags.ts': "export const tags = ['HeadStream'];\nconst mode = 'executeAsyncMode';\n",
        'src/alias.ts': 'const out = `export { aliased as default }`;\n',
        'src/gen.ts': "const a = 'import { withCtx } from \"x\"';\nconst b = 'a, listed, b';\nconst c = `${interpolated}`;\n// 'commented'\n",
        'src/gone.test.ts': "const t = 'gone';\n",
      },
    });
    witness(org);
    expectMismatch(org, org.ids['executeAsync']!, ['witness_mismatch:self-string:src/transform.ts:2']);
    // A bare quoted name in a file with no codegen-shaped literal is not a hit (round 3).
    expectPass(org, org.ids['HeadStream']!);
    expectMismatch(org, org.ids['impl']!, ['witness_mismatch:self-string:src/alias.ts:1']);
    expectMismatch(org, org.ids['withCtx']!, ['witness_mismatch:self-string:src/gen.ts:1']);
    expectMismatch(org, org.ids['listed']!, ['witness_mismatch:self-string:src/gen.ts:2']);
    expectPass(org, org.ids['executeAsyncModeOnly']!); // 'executeAsyncMode' is not it either
    expectPass(org, org.ids['interpolated']!);
    expectPass(org, org.ids['commented']!);
    expectPass(org, org.ids['gone']!); // test files are skipped
  });

  it('module specifiers are never quoted names (@hono/casbin#casbin)', () => {
    const org = buildOrg({
      symbols: [{ name: 'casbin', file: 'src/index.ts' }, { name: 'dep', file: 'src/index.ts' }, { name: 'lazy', file: 'src/index.ts' }],
      libFiles: {
        // A codegen literal in the same file, so a bare quoted name WOULD qualify.
        'src/index.ts': [
          "import { Enforcer } from 'casbin';",
          "export * from 'dep';",
          "const l = require('lazy');",
          "const m = import('lazy');",
          'const code = `import { x } from "y"`;',
        ].join('\n'),
      },
    });
    witness(org);
    expectPass(org, org.ids['casbin']!);
    expectPass(org, org.ids['dep']!);
    expectPass(org, org.ids['lazy']!);
  });

  it('a bare quoted name needs a codegen-shaped literal in the same file (sentry, MedleyRouter vs unctx)', () => {
    const org = buildOrg({
      symbols: [
        { name: 'sentry', file: 'src/a.ts' },
        { name: 'MedleyRouter', file: 'src/b.ts' },
        { name: 'executeAsync', file: 'src/c.ts' },
        { name: 'built', file: 'src/c.ts' },
      ],
      libFiles: {
        'src/sentry.ts': "export const mw = (c) => { c.set('sentry', 1); };\n",
        'src/router.ts': "export class R { name = 'MedleyRouter'; }\n",
        // unctx: the transform builds import text (with a variable module path).
        'src/transform.ts': 'const helperName = "executeAsync";\nexport const gen = (x, mod) => `import { ${x} } from "${mod}"`;\n',
        // An AST-builder call qualifies the file too.
        'src/ast.ts': "const n = 'built';\nt.importDeclaration([], t.stringLiteral('x'));\n",
      },
    });
    witness(org);
    expectPass(org, org.ids['sentry']!);
    expectPass(org, org.ids['MedleyRouter']!);
    expectMismatch(org, org.ids['executeAsync']!, ['witness_mismatch:self-string:src/transform.ts:1']);
    expectMismatch(org, org.ids['built']!, ['witness_mismatch:self-string:src/ast.ts:1']);
  });

  it('codegen: only names inside the qualifying literal / builder call are hits (ClerkAuthVariables)', () => {
    const org = buildOrg({
      symbols: [
        { name: 'clerkMiddleware', file: 'src/index.ts' },
        { name: 'ClerkAuthVariables', file: 'src/index.ts' },
        { name: 'Wrapped', file: 'src/index.ts' },
        { name: 'Near', file: 'src/index.ts' },
      ],
      libFiles: {
        'src/gen.ts': [
          'type X = ClerkAuthVariables;',
          "export const tpl = `import { clerkMiddleware } from '@acme/lib'`;",
          'const Near = 1;',
          "t.importDeclaration([spec('Wrapped')], t.stringLiteral('@acme/lib'));",
        ].join('\n'),
      },
    });
    witness(org);
    expectMismatch(org, org.ids['clerkMiddleware']!, ['witness_mismatch:self:src/gen.ts:2']);
    expectMismatch(org, org.ids['Wrapped']!, ['witness_mismatch:self:src/gen.ts:4']);
    expectPass(org, org.ids['ClerkAuthVariables']!);
    expectPass(org, org.ids['Near']!);
  });

  it('self consumer: indexed own files and directive lines do not count; self-string skips other languages and the definition line', () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [
        { name: 'MockClient', file: 'lib/src/mock_client.dart', line: 0 },
        { name: 'UsedUnindexed', file: 'lib/src/x.dart', line: 0 },
        { name: 'component', file: 'lib/src/tags.dart', line: 0 },
        { name: 'viewerApp', file: 'lib/src/x.dart', line: 1 },
      ],
      libFiles: {
        // Indexed: the indexer saw these uses.
        'lib/mock.dart': "export 'package:lib_pub/src/mock_client.dart' show MockClient;\n",
        'lib/src/user.dart': "import 'package:lib_pub/src/mock_client.dart';\nfinal c = MockClient();\n",
        // Unindexed (tool/ is outside lib/): a real use, but directive lines never count.
        'bin/run.dart': "import 'package:lib_pub/src/x.dart'\n    show UsedUnindexed;\nexport 'package:lib_pub/src/mock_client.dart' show MockClient;\nvoid main() => UsedUnindexed();\n",
        // Definition line naming itself: opentracing `component = 'component'`; a codegen
        // literal in the file would otherwise qualify the bare name.
        'lib/src/tags.dart': "const component = 'component';\nfinal s = \"import 'package:other/x.dart';\";\n",
        // A vendored JS bundle in a pub package is not read by self-string.
        'lib/static/viewer.js': "const code = `import { viewerApp } from 'x'`;\n",
      },
    });
    for (const f of ['lib/mock.dart', 'lib/src/user.dart', 'lib/src/tags.dart']) {
      org.db.prepare("INSERT INTO documents (package_id, file) VALUES ('pub:lib_pub', ?)").run(f);
    }
    witness(org);
    expectPass(org, org.ids['MockClient']!);
    expectMismatch(org, org.ids['UsedUnindexed']!, ['witness_mismatch:self:bin/run.dart:4']);
    expectPass(org, org.ids['component']!);
    expectPass(org, org.ids['viewerApp']!);
  });

  it('generated files of P (documents.is_generated, GENERATED_GLOBS) are never self-scanned (capnp-es)', () => {
    const org = buildOrg({
      symbols: [{ name: 'Person', file: 'src/schema.ts' }, { name: 'Address', file: 'src/schema.ts' }, { name: 'Real', file: 'src/schema.ts' }],
      libFiles: {
        // Sidecar-listed generated file: quotes names, imports P by name, has a template.
        'src/person.capnp.ts': "import { Struct } from '@acme/lib';\nexport const n = { displayName: 'Person' };\nconst t = `import { Person } from '@acme/lib'`;\nPerson;\n",
        // Unindexed, generated by path.
        'src/address.generated.ts': "import { Address } from '@acme/lib';\nAddress();\n",
        // Control: a real unindexed own importer.
        'tools/run.ts': "import { Real } from '@acme/lib';\nReal();\n",
      },
    });
    org.db.prepare("INSERT INTO documents (package_id, file, is_generated) VALUES ('npm:@acme/lib', 'src/person.capnp.ts', 1)").run();
    // An indexed, generated document is skipped by is_generated even though it is indexed.
    witness(org);
    expectPass(org, org.ids['Person']!);
    expectPass(org, org.ids['Address']!);
    expectMismatch(org, org.ids['Real']!, ['witness_mismatch:self:tools/run.ts:1', 'witness_mismatch:self:tools/run.ts:2']);
  });

  it('scans witness_files rows (scoped unindexed imports) as consumer files, under the test/docs policy', () => {
    const org = buildOrg({
      symbols: [{ name: 'benched' }, { name: 'documented' }, { name: 'quiet' }],
      files: {
        // @acme/nested declares no dependency on P; its bench file imports it.
        'nested/bench/run.ts': "import { benched } from '@acme/lib';\nbenched();\n",
        'nested/docs/x.ts': "import { documented } from '@acme/lib';\ndocumented();\n",
        'nested/bench/other.ts': "import { quiet } from '@acme/lib';\n",
      },
    });
    const ins = org.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:@acme/nested', 'npm:@acme/lib', ?)");
    for (const f of ['pkg/nested/bench/run.ts', 'pkg/nested/docs/x.ts']) ins.run(f);
    witness(org);
    expectMismatch(org, org.ids['benched']!, [
      'witness_mismatch:npm:@acme/nested:pkg/nested/bench/run.ts:1',
      'witness_mismatch:npm:@acme/nested:pkg/nested/bench/run.ts:2',
    ]);
    // docs files do not count (countDocsAsConsumers off); other.ts is not a witness_files row.
    expectPass(org, org.ids['documented']!);
    expectPass(org, org.ids['quiet']!);

    // A self row (an own .vue component importing own code relatively): no import of P needed.
    const sfc = buildOrg({ symbols: [{ name: 'CardProps' }, { name: 'unnamed' }], libFiles: { 'components/Card.vue': "<script setup lang=\"ts\">\nimport { CardProps } from '../src/index';\n</script>\n" } });
    sfc.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:@acme/lib', 'npm:@acme/lib', 'components/Card.vue')").run();
    witness(sfc);
    expectMismatch(sfc, sfc.ids['CardProps']!, ['witness_mismatch:self:components/Card.vue:2']);
    expectPass(sfc, sfc.ids['unnamed']!);

    // A listed file that is gone from the checkout fails closed.
    const gone = buildOrg({ symbols: [{ name: 'x' }] });
    gone.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:@acme/nested', 'npm:@acme/lib', 'pkg/nested/bench/gone.ts')").run();
    witness(gone);
    expectMismatch(gone, gone.ids['x']!, ['witness_mismatch:npm:@acme/nested:checkout missing']);
  });

  it('the codegen template case: the quoted helper name is a self-string hit (names outside the template are not self hits)', () => {
    const org = buildOrg({
      symbols: [{ name: 'executeAsync', file: 'src/ctx.ts' }, { name: 'executeAsyncMode', file: 'src/ctx.ts' }],
      libFiles: {
        'src/transform.ts': 'const helperName = "executeAsync";\nexport const out = (x) => `import { ${x} as __${x} } from "@acme/lib"`;\n',
      },
    });
    witness(org);
    expectMismatch(org, org.ids['executeAsync']!, ['witness_mismatch:self-string:src/transform.ts:1']);
    expectPass(org, org.ids['executeAsyncMode']!);
  });

  it('fails closed on a missing checkout of P (one self reason: the self steps share a key)', () => {
    const org = buildOrg({ symbols: [{ name: 'impl' }] });
    org.discover.repos = org.discover.repos.filter((r) => r.repo !== 'acme/lib');
    witness(org);
    expectMismatch(org, org.ids['impl']!, ['witness_mismatch:self:checkout missing']);
  });
});

describe('blankComments', () => {
  it('blanks comments, keeps strings, templates, lines and offsets', () => {
    const src = "a(); // x\nconst u = 'http://y'; /* b\nc */ d(`//${e}`);\n";
    const out = blankComments(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe("a();     \nconst u = 'http://y';     \n     d(`//${e}`);\n");
  });
});

describe('stringLiterals (loose scanner for the self-witness)', () => {
  it('skips comments, keeps quotes single-line, spans templates and skips ${…}', () => {
    const src = [
      "// 'not a string'",
      "/* `nor this` */ const a = 'x', b = \"y\\\"z\";",
      'const t = `line1',
      "line2 ${ { k: '`' }.k } end`;",
      "const bad = 'unterminated",
      "const ok = 'next';",
    ].join('\n');
    expect(stringLiterals(src).map((l) => l.text)).toEqual([
      "'x'", '"y\\"z"', "`line1\nline2 ${ { k: '`' }.k } end`", "'unterminated", "'next'",
    ]);
    expect(stringLiterals("final s = '''a\n'b'\n''';\nfinal t = \"c\";", true).map((l) => l.text)).toEqual(["'''a\n'b'\n'''", '"c"']);
  });
});

describe('runWitness: ignored manifests (examples/templates/fixtures)', () => {
  // Ignored manifests live in the library repo acme/lib (localPath <root>/lib).
  function withIgnored(
    org: Org,
    manifests: Array<{ path: string; deps: Array<string | null>; depsUnknown?: boolean; files?: Record<string, string> }>,
  ): void {
    const lib = org.discover.repos.find((r) => r.repo === 'acme/lib')!;
    lib.ignoredManifests = manifests.map((m) => {
      for (const [rel, text] of Object.entries(m.files ?? {})) write(lib.localPath, `${m.path}/${rel}`, text);
      return {
        path: m.path,
        manifest: `${m.path}/package.json`,
        deps: m.deps.map((resolvedPackageId) => ({ resolvedPackageId })),
        ...(m.depsUnknown !== undefined ? { depsUnknown: m.depsUnknown } : {}),
      };
    });
  }
  const IMPORTS = "import { liveFn } from '@acme/lib';\nliveFn(deadFn);\n";

  it('an ignored manifest depending on P is scanned: a hit downgrades with the ignored:<repo>/<manifest> consumer', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }, { name: 'otherFn' }] });
    withIgnored(org, [
      { path: 'examples/demo', deps: ['npm:@acme/lib', null], files: { 'src/x.ts': IMPORTS, 'node_modules/y/i.ts': IMPORTS } },
    ]);
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:ignored:acme/lib/examples/demo/package.json:examples/demo/src/x.ts:2']);
    expectPass(org, org.ids['otherFn']!);
  });

  it('an ignored manifest that does not depend on P is not scanned (as an ignored consumer)', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    withIgnored(org, [
      { path: 'examples/other', deps: [null, 'npm:@acme/app'], files: { 'src/x.ts': IMPORTS } },
      { path: 'templates/none', deps: [], files: { 'src/x.ts': IMPORTS } },
    ]);
    witness(org);
    // Both dirs sit inside P's own repo dir, though: templates/ (not docs) is P's own code
    // importing P by name, so the self consumer sees it; examples/ is docs.
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:self:templates/none/src/x.ts:2']);
  });

  it('fails closed: a missing ignored-manifest dir is a mismatch; unknown deps are scanned for every package', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    withIgnored(org, [
      { path: 'examples/gone', deps: ['npm:@acme/lib'] },
      { path: 'fixtures/bad', deps: [], depsUnknown: true, files: { 'a.ts': IMPORTS } },
    ]);
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, [
      'witness_mismatch:ignored:acme/lib/examples/gone/package.json:checkout missing',
      'witness_mismatch:ignored:acme/lib/fixtures/bad/package.json:fixtures/bad/a.ts:2',
    ]);
  });

  it('skips test/docs files in an ignored dir under the same policy and org packages nested in it', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    withIgnored(org, [{
      path: 'examples/demo',
      deps: ['npm:@acme/lib'],
      files: { 'src/x.test.ts': IMPORTS, 'docs/d.ts': IMPORTS, 'real/src/x.ts': IMPORTS },
    }]);
    org.discover.repos.find((r) => r.repo === 'acme/lib')!.packages.push({ packageId: 'npm:@acme/real', path: 'examples/demo/real' });
    witness(org);
    expectPass(org, org.ids['deadFn']!);
  });
});
