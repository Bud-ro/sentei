import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { blankComments, blankStrings, runWitness, stringLiterals, type WitnessDiscoverInput } from '../src/witness.ts';

// A hand-built org: library P (npm:acme/lib:@acme/lib or pub:acme/lib:lib_pub) with one consumer C
// whose package dir is <repo>/pkg. Every symbol gets a witness_pending finding.

interface OrgSpec {
  manager?: 'npm' | 'pub';
  /** Consumer files, relative to the consumer package dir. */
  files?: Record<string, string>;
  /**
   * Symbols of P: name + defining file (default src/index.ts) + symbol_exports rows
   * [entry, exportedAs] (default [['src/index.ts', name]]).
   */
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
  /** P's visibility (default private). */
  visibility?: 'private' | 'published-private' | 'published-public';
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
  const P = `${manager}:acme/lib:${libName}`;
  const C = `${manager}:acme/app:${appName}`;
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
  run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/lib', '.', ?, ?, ?)", P, manager, libName, spec.visibility ?? 'private');
  run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/app', 'pkg', ?, ?, 'private')", C, manager, appName);
  // Another org package nested inside the consumer's dir: its files must be skipped.
  const nestedName = manager === 'npm' ? '@acme/nested' : 'nested_pub';
  run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/app', 'pkg/nested', ?, ?, 'private')", `${manager}:acme/app:${nestedName}`, manager, nestedName);
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
    // Default: exported under its own name from the root entry (every real candidate has
    // symbol_exports rows; a symbol with none is never vouched for by an import).
    for (const [entry, as] of s.exports ?? [['src/index.ts', s.name]]) {
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
          { packageId: `${manager}:acme/app:${nestedName}`, path: 'pkg/nested' },
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

  it('a published P passes as deprecation_candidate (same evidence), and a hit downgrades it like a deletion', () => {
    const org = buildOrg({
      visibility: 'published-public',
      symbols: [{ name: 'deadFn' }, { name: 'namedFn' }],
      files: { 'src/main.ts': "import { liveFn } from '@acme/lib';\nliveFn(namedFn);\n" },
    });
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expect(findings(org, org.ids['deadFn']!)).toEqual([{ verdict: 'deprecation_candidate', reasons: ['no_refs'] }]);
    expect(witnessOk(org, org.ids['deadFn']!)).toBe(true);
    expectMismatch(org, org.ids['namedFn']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:2']);
  });

  it('published-private is private (deletion) only with trustPrivateRegistry', () => {
    for (const [trust, verdict] of [[true, 'deletion_candidate'], [false, 'deprecation_candidate']] as const) {
      const org = buildOrg({ visibility: 'published-private', policy: { trustPrivateRegistry: trust }, symbols: [{ name: 'deadFn' }] });
      witness(org);
      expect(findings(org, org.ids['deadFn']!)).toEqual([{ verdict, reasons: ['no_refs'] }]);
    }
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

  it('downgrades a named hit in an importing file, with consumer:file:line; comments never count', () => {
    const org = buildOrg({
      symbols: [{ name: 'deadFn' }],
      files: { 'src/main.ts': "import { liveFn } from '@acme/lib';\n\n// deadFn is gone\nconst x = liveFn(deadFn); /* deadFn */\n" },
    });
    expect(witness(org)).toEqual({ checked: 1, passed: 0, mismatched: 1 });
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:4']);
    expect(org.log.some((l) => l.includes('mismatch npm:acme/lib:@acme/lib#deadFn'))).toBe(true);
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
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:1',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:2',
    ]);
    expectMismatch(on, on.ids['docOnly']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/docs/example.ts:1']);
  });

  it('scans test files of a consumer whose dependency on P is dev-only (docs stay skipped)', () => {
    const files = {
      'src/lib.test.ts': "import { testOnly } from '@acme/lib';\ntestOnly();\n",
      'docs/example.ts': "import { docOnly } from '@acme/lib';\n",
    };
    const org = buildOrg({ symbols: [{ name: 'testOnly' }, { name: 'docOnly' }, { name: 'unnamed' }], files, devDep: true });
    expect(witness(org)).toEqual({ checked: 3, passed: 2, mismatched: 1 });
    expectMismatch(org, org.ids['testOnly']!, [
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:1',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:2',
    ]);
    expectPass(org, org.ids['docOnly']!);
    expectPass(org, org.ids['unnamed']!);
  });

  it('scans consumers\' test files for a test-support symbol (exported through a `testing` entry), not for others', () => {
    const files = {
      'src/lib.test.ts': "import { fakeServer, realFn } from '@acme/lib';\nimport { fakeServer as f } from '@acme/lib/testing';\nfakeServer(); realFn();\n",
    };
    const org = buildOrg({
      symbols: [{ name: 'fakeServer', exports: [['src/testing.ts', 'fakeServer'], ['src/index.ts', 'fakeServer']] }, { name: 'realFn' }],
      files,
      libFiles: { 'package.json': JSON.stringify({ name: '@acme/lib', exports: { '.': './src/index.ts', './testing': './src/testing.ts' } }) },
    });
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['fakeServer']!, [
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:1',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:2',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/lib.test.ts:3',
    ]);
    // Negative: a normal symbol named only in a consumer's test file still passes.
    expectPass(org, org.ids['realFn']!);
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
      files: { 'src/main.ts': "import {\n  liveFn,\n  deadFn,\n} from '@acme/lib';\n" },
    });
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:3']);
  });

  it('detects require(), import(), side-effect import and export-from forms', () => {
    const org = buildOrg({
      symbols: [
        { name: 'a' }, { name: 'b', exports: [['src/deep/x.ts', 'b']] }, { name: 'c', exports: [['src/register.ts', 'c']] },
        { name: 'd' }, { name: 'e' },
      ],
      files: {
        'src/req.cjs': "const lib = require( '@acme/lib' );\nlib.a();\n",
        'src/dyn.ts': "const m = await import('@acme/lib/deep/x.js');\nm.b();\n",
        'src/side.ts': "import '@acme/lib/register';\nglobalThis.c;\n",
        'src/re.ts': "export { d } from \"@acme/lib\";\n",
        'src/scoped.ts': "import { e } from '@acme/library';\n", // different package: no mention
      },
    });
    expect(witness(org)).toEqual({ checked: 5, passed: 1, mismatched: 4 });
    expectMismatch(org, org.ids['a']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/req.cjs:2']);
    expectMismatch(org, org.ids['b']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/dyn.ts:2']);
    expectMismatch(org, org.ids['c']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/side.ts:2']);
    expectMismatch(org, org.ids['d']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/re.ts:1']);
    expectPass(org, org.ids['e']!);
  });

  it('caps mismatch reasons at 5, sorted', () => {
    const org = buildOrg({
      symbols: [{ name: 'x' }],
      files: { 'src/main.ts': `import { x } from '@acme/lib';\n${'x;\n'.repeat(9)}` },
    });
    witness(org);
    expectMismatch(org, org.ids['x']!, [1, 2, 3, 4, 5].map((n) => `witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:${n}`));
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
    expectMismatch(org, org.ids['deadWidget']!, ['witness_mismatch:pub:acme/app:app_pub:pkg/lib/main.dart:3']);
    expectMismatch(org, org.ids['interpWidget']!, ['witness_mismatch:pub:acme/app:app_pub:pkg/lib/main.dart:4']);
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
    expectMismatch(org, org.ids['src/anon.ts#default']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:2']);
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
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/1.ts:1',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/3.ts:1',
    ]);
    expectMismatch(org, org.ids['src/c.ts#default']!, [
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/1.ts:2',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/3.ts:1',
    ]);
    expectMismatch(org, org.ids['src/d/index.ts#default']!, [
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/2.ts:1',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/3.ts:1',
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
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:1',
      'witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:3',
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
        'src/c.ts': "import { bunPlugin as x } from '@acme/lib/bun';\n", // named import of the declared name
        'src/d.ts': "import nodeBuild from '@acme/lib/node-server';\n", // unrelated subpath
      },
    });
    expect(witness(org)).toEqual({ checked: 4, passed: 1, mismatched: 3 });
    expectMismatch(org, org.ids['pagesPlugin']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/a.ts:1']);
    expectMismatch(org, org.ids['workersPlugin']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/b.ts:1']);
    expectMismatch(org, org.ids['bunPlugin']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/c.ts:1']);
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
    expectMismatch(org, org.ids['app']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/main.ts:1']);
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
    expectMismatch(org, org.ids['cf']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/a.ts:1']);
    expectPass(org, org.ids['dn']!);
    expectMismatch(org, org.ids['pl']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/b.ts:1']);
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
    expectMismatch(org, org.ids['usedInBuildPkg']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/build/src/x.ts:1']);
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
    expectMismatch(org, org.ids['usedInBuild']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/build/x.ts:1']);
    expectPass(org, org.ids['onlyInIgnored']!);
  });

  it('fails closed when a consumer checkout is missing', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }], missingCheckout: true });
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:acme/app:@acme/app:checkout missing']);
  });

  it('fails closed when a consumer is absent from discover.json', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    org.discover.repos = org.discover.repos.filter((r) => r.repo !== 'acme/app');
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:npm:acme/app:@acme/app:checkout missing']);
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
    // P builds import text (transform.ts), so a quoted name in any own file is a hit
    // (an auto-imports / preset list of names).
    expectMismatch(org, org.ids['HeadStream']!, ['witness_mismatch:self-string:src/tags.ts:1']);
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

  it('a quoted name needs a package that builds import text (sentry, MedleyRouter vs unctx)', () => {
    // No own file builds import text: quoted names are data (round-3 negatives).
    const plain = buildOrg({
      symbols: [{ name: 'sentry', file: 'src/a.ts' }, { name: 'MedleyRouter', file: 'src/b.ts' }],
      libFiles: {
        'src/sentry.ts': "export const mw = (c) => { c.set('sentry', 1); };\n",
        'src/router.ts': "export class R { name = 'MedleyRouter'; }\n",
        'src/msg.ts': "console.warn(`import { sentry } from '@acme/lib' is deprecated`);\n", // a message: not codegen
      },
    });
    witness(plain);
    expectPass(plain, plain.ids['sentry']!);
    expectPass(plain, plain.ids['MedleyRouter']!);

    const org = buildOrg({
      symbols: [
        { name: 'executeAsync', file: 'src/c.ts' },
        { name: 'built', file: 'src/c.ts' },
        { name: 'withAsyncContext', file: 'src/c.ts' },
      ],
      libFiles: {
        // unctx's exact template: the module is `${JSON.stringify(…)}`, not a quoted string.
        'src/transform.ts': [
          'const helperName = "executeAsync";',
          'export const gen = (imports, m) => `import { ${imports.map(i => `${i} as __${i}`).join(", ")} } from ${JSON.stringify(m)};`;',
          'export const opts = { asyncFunctions: ["withAsyncContext"] };',
        ].join('\n'),
        // A quoted name in a file with no codegen literal of its own still counts.
        'src/ast.ts': "const n = 'built';\n",
      },
    });
    witness(org);
    expectMismatch(org, org.ids['executeAsync']!, ['witness_mismatch:self-string:src/transform.ts:1']);
    expectMismatch(org, org.ids['withAsyncContext']!, ['witness_mismatch:self-string:src/transform.ts:3']);
    expectMismatch(org, org.ids['built']!, ['witness_mismatch:self-string:src/ast.ts:1']);
  });

  it('package-wide codegen: names quoted in another own file are hits, as whole words only (capnp-es)', () => {
    const org = buildOrg({
      symbols: [
        { name: 'getFloat32Mask', file: 'src/serialization/mask.ts' },
        { name: 'BoolList', file: 'src/serialization/pointers/list/list.ts' },
        { name: 'getUint8', file: 'src/serialization/mask.ts' },
        { name: 'Struct', file: 'src/serialization/pointers/struct.ts', line: 0 },
      ],
      libFiles: {
        // The template lives in generators/struct.ts ...
        'src/compiler/generators/struct.ts': 'export const header = (m) => `import * as $ from ${JSON.stringify(m)};`;\n',
        // ... the names in constants.ts.
        'src/compiler/constants.ts': [
          'export const ConcreteListType = { 1: "$.BoolList" };',
          'export const Primitives = { 9: { byteLength: 4, getter: "getFloat32", mask: "getFloat32Mask" } };',
          "export const u8 = 'getUint8s';", // not a whole word
        ].join('\n'),
        // S's own definition line is never a hit, even though it quotes the name.
        'src/serialization/pointers/struct.ts': "export class Struct { static readonly _capnp = { displayName: 'Struct' }; }\n",
      },
    });
    witness(org);
    expectMismatch(org, org.ids['BoolList']!, ['witness_mismatch:self-string:src/compiler/constants.ts:1']);
    expectMismatch(org, org.ids['getFloat32Mask']!, ['witness_mismatch:self-string:src/compiler/constants.ts:2']);
    expectPass(org, org.ids['getUint8']!);
    expectPass(org, org.ids['Struct']!);
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
      org.db.prepare("INSERT INTO documents (package_id, file) VALUES ('pub:acme/lib:lib_pub', ?)").run(f);
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
    org.db.prepare("INSERT INTO documents (package_id, file, is_generated) VALUES ('npm:acme/lib:@acme/lib', 'src/person.capnp.ts', 1)").run();
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
    const ins = org.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:acme/app:@acme/nested', 'npm:acme/lib:@acme/lib', ?)");
    for (const f of ['pkg/nested/bench/run.ts', 'pkg/nested/docs/x.ts']) ins.run(f);
    witness(org);
    expectMismatch(org, org.ids['benched']!, [
      'witness_mismatch:npm:acme/app:@acme/nested:pkg/nested/bench/run.ts:1',
      'witness_mismatch:npm:acme/app:@acme/nested:pkg/nested/bench/run.ts:2',
    ]);
    // docs files do not count (countDocsAsConsumers off); other.ts is not a witness_files row.
    expectPass(org, org.ids['documented']!);
    expectPass(org, org.ids['quiet']!);

    // A self row (an own .vue component importing own code relatively): no import of P needed.
    const sfc = buildOrg({ symbols: [{ name: 'CardProps' }, { name: 'unnamed' }], libFiles: { 'components/Card.vue': "<script setup lang=\"ts\">\nimport { CardProps } from '../src/index';\n</script>\n" } });
    sfc.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:acme/lib:@acme/lib', 'npm:acme/lib:@acme/lib', 'components/Card.vue')").run();
    witness(sfc);
    expectMismatch(sfc, sfc.ids['CardProps']!, ['witness_mismatch:self:components/Card.vue:2']);
    expectPass(sfc, sfc.ids['unnamed']!);

    // Self rows from own files importing P by name (ingest: unindexedImports targeting P):
    // an own file outside the program, and an INDEXED own file whose self-import SCIP could
    // not resolve: both scanned (the indexed-file rules do not apply to witness_files).
    const selfImp = buildOrg({
      symbols: [{ name: 'defineBuildConfig' }, { name: 'nodeRunner' }, { name: 'untouched' }],
      libFiles: {
        'build.config.ts': "import { defineBuildConfig } from '@acme/lib';\nexport default defineBuildConfig({});\n",
        'src/runner.ts': "export const load = () => import('@acme/lib/runners/node').then((m) => m.nodeRunner);\n",
      },
    });
    const selfIns = selfImp.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:acme/lib:@acme/lib', 'npm:acme/lib:@acme/lib', ?)");
    for (const f of ['build.config.ts', 'src/runner.ts']) selfIns.run(f);
    const m = Number(selfImp.db.prepare("INSERT INTO symbols (symbol_str, package_id, file, name, kind) VALUES ('mod r', 'npm:acme/lib:@acme/lib', 'src/runner.ts', 'src/runner.ts', 'file')").run().lastInsertRowid);
    selfImp.db.prepare("INSERT INTO documents (package_id, file, module_symbol_id) VALUES ('npm:acme/lib:@acme/lib', 'src/runner.ts', ?)").run(m);
    witness(selfImp);
    expectMismatch(selfImp, selfImp.ids['defineBuildConfig']!, ['witness_mismatch:self:build.config.ts:1', 'witness_mismatch:self:build.config.ts:2']);
    expectMismatch(selfImp, selfImp.ids['nodeRunner']!, ['witness_mismatch:self:src/runner.ts:1']);
    expectPass(selfImp, selfImp.ids['untouched']!);

    // A listed file that is gone from the checkout fails closed.
    const gone = buildOrg({ symbols: [{ name: 'x' }] });
    gone.db.prepare("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES ('npm:acme/app:@acme/nested', 'npm:acme/lib:@acme/lib', 'pkg/nested/bench/gone.ts')").run();
    witness(gone);
    expectMismatch(gone, gone.ids['x']!, ['witness_mismatch:npm:acme/app:@acme/nested:checkout missing']);
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
      { path: 'examples/demo', deps: ['npm:acme/lib:@acme/lib', null], files: { 'src/x.ts': IMPORTS, 'node_modules/y/i.ts': IMPORTS } },
    ]);
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:ignored:acme/lib/examples/demo/package.json:examples/demo/src/x.ts:2 (used by ignored manifest acme/lib:examples/demo/package.json)']);
    expectPass(org, org.ids['otherFn']!);
  });

  it('an ignored manifest whose dep names several org packages (ambiguous) is scanned for every candidate', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    const lib = org.discover.repos.find((r) => r.repo === 'acme/lib')!;
    write(lib.localPath, 'examples/demo/src/x.ts', IMPORTS);
    lib.ignoredManifests = [{
      path: 'examples/demo',
      manifest: 'examples/demo/package.json',
      deps: [{ resolvedPackageId: null, candidates: ['npm:acme/lib:@acme/lib', 'npm:acme/fork:@acme/lib'] }],
    }];
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, ['witness_mismatch:ignored:acme/lib/examples/demo/package.json:examples/demo/src/x.ts:2 (used by ignored manifest acme/lib:examples/demo/package.json)']);
  });

  it('an ignored manifest that does not depend on P is not scanned (as an ignored consumer)', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    withIgnored(org, [
      { path: 'examples/other', deps: [null, 'npm:acme/app:@acme/app'], files: { 'src/x.ts': IMPORTS } },
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
      { path: 'examples/gone', deps: ['npm:acme/lib:@acme/lib'] },
      { path: 'fixtures/bad', deps: [], depsUnknown: true, files: { 'a.ts': IMPORTS } },
    ]);
    witness(org);
    expectMismatch(org, org.ids['deadFn']!, [
      'witness_mismatch:ignored:acme/lib/examples/gone/package.json:checkout missing (used by ignored manifest acme/lib:examples/gone/package.json)',
      'witness_mismatch:ignored:acme/lib/fixtures/bad/package.json:fixtures/bad/a.ts:2 (used by ignored manifest acme/lib:fixtures/bad/package.json)',
    ]);
  });

  it('skips test/docs files in an ignored dir under the same policy and org packages nested in it', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    withIgnored(org, [{
      path: 'examples/demo',
      deps: ['npm:acme/lib:@acme/lib'],
      files: { 'src/x.test.ts': IMPORTS, 'docs/d.ts': IMPORTS, 'real/src/x.ts': IMPORTS },
    }]);
    org.discover.repos.find((r) => r.repo === 'acme/lib')!.packages.push({ packageId: 'npm:acme/lib:@acme/real', path: 'examples/demo/real' });
    witness(org);
    expectPass(org, org.ids['deadFn']!);
  });
});

describe('runWitness: round 4 (entry vouching, messages, indexed consumer files)', () => {
  const LIB_MANIFEST = JSON.stringify({
    name: '@acme/lib',
    module: './dist/index.mjs',
    exports: { '.': './dist/index.mjs', './bun': './dist/adapter/bun.mjs', './react': './dist/react.mjs' },
  });

  it('a default import via the bare specifier binds only the root entry\'s default (@hono/vite-dev-server)', () => {
    const org = buildOrg({
      symbols: [
        { name: 'devServer', file: 'src/dev-server.ts', exports: [['src/index.ts', 'default']] },
        { name: 'bunAdapter', file: 'src/adapter/bun.ts', exports: [['src/adapter/bun.ts', 'default']] },
      ],
      libFiles: { 'package.json': LIB_MANIFEST },
      files: { 'vite.config.ts': "import dev from '@acme/lib';\nexport default dev();\n" },
    });
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['devServer']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/vite.config.ts:1']);
    expectPass(org, org.ids['bunAdapter']!);
  });

  it('an import vouches only for symbols its specifier reaches (symbol_exports entries); unexported ones never', () => {
    const org = buildOrg({
      symbols: [
        { name: 'useHead', file: 'src/react.ts', exports: [['src/react.ts', 'useHead']] },
        { name: 'defineThing', file: 'src/thing.ts', exports: [['src/index.ts', 'defineThing']] },
        { name: 'notExported', file: 'src/thing.ts', exports: [] },
      ],
      libFiles: { 'package.json': LIB_MANIFEST },
      files: {
        'src/a.ts': "import { useHead, defineThing, notExported } from '@acme/lib/react';\n",
        'src/b.ts': "import { defineThing } from '@acme/lib';\nnotExported();\n",
      },
    });
    expect(witness(org)).toEqual({ checked: 3, passed: 1, mismatched: 2 });
    expectMismatch(org, org.ids['useHead']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/a.ts:1']);
    expectMismatch(org, org.ids['defineThing']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/b.ts:1']);
    expectPass(org, org.ids['notExported']!);
  });

  it('deprecation / warning messages are not codegen, nor self-string hits (clerk-auth)', () => {
    const org = buildOrg({
      symbols: [
        { name: 'getAuth', file: 'src/clerk-auth.ts', line: 18 },
        { name: 'clerkMiddleware', file: 'src/clerk-auth.ts', line: 36 },
        { name: 'Prefixed', file: 'src/other.ts' },
        { name: 'Logged', file: 'src/other.ts' },
      ],
      libFiles: {
        'src/clerk-auth.ts': [
          "import { deprecated } from '@clerk/shared/deprecated'",
          'export const getAuth = ((c) => {',
          '  deprecated(',
          "    '@acme/lib',",
          "    'Use `@clerk/hono` instead.\\n\\n- import { clerkMiddleware, getAuth } from \"@acme/lib\"\\n+ import { clerkMiddleware, getAuth } from \"@clerk/hono\"'",
          '  )',
          '})',
        ].join('\n'),
        'src/other.ts': [
          "export const MSG = '[deprecated] import { Prefixed } from \"@acme/lib\"';",
          "this.logger.warn({ hint: `import { Logged } from '@acme/lib'` });",
        ].join('\n'),
      },
    });
    expect(witness(org)).toEqual({ checked: 4, passed: 4, mismatched: 0 });
  });

  it('an indexed consumer file: member access and identifiers SCIP resolved to another symbol are not hits', () => {
    const org = buildOrg({
      symbols: [{ name: 'findByTestId' }, { name: 'findByText' }, { name: 'queryAll' }, { name: 'getBy' }],
      files: {
        'src/t.ts': [
          "import { screen, render } from '@acme/lib';", // 1
          "await screen.findByTestId('x'); screen?.findByTestId('y');", // 2: member access
          'const r = findByText;', // 3: SCIP says this is another findByText
          'const q = queryAll;', // 4: SCIP has nothing here: counts
          'const g = getBy;', // 5: SCIP has S itself (and another getBy): counts
          'const s = { ...findByTestId };', // 6: a spread is not member access, but SCIP resolved it elsewhere
        ].join('\n'),
      },
    });
    const { db, ids } = org;
    const run = (sql: string, ...p: Array<string | number>): number => Number(db.prepare(sql).run(...p).lastInsertRowid);
    const mod = run("INSERT INTO symbols (symbol_str, package_id, file, name, kind) VALUES ('mod t', 'npm:acme/app:@acme/app', 'pkg/src/t.ts', 'pkg/src/t.ts', 'file')");
    run("INSERT INTO documents (package_id, file, module_symbol_id) VALUES ('npm:acme/app:@acme/app', 'pkg/src/t.ts', ?)", mod);
    const occ = (symbolId: number, line: number): void => {
      run(`INSERT INTO occurrences (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id)
        VALUES (?, 'npm:acme/app:@acme/app', 'npm:acme/lib:@acme/lib', 'pkg/src/t.ts', ?, 10, 8, ?)`, symbolId, line, mod);
    };
    for (const [name, line] of [['findByText', 2], ['getBy', 4], ['findByTestId', 5]] as const) {
      const other = run("INSERT INTO symbols (symbol_str, package_id, file, name) VALUES (?, 'npm:acme/lib:@acme/lib', 'src/queries.ts', ?)", `ScreenQueries#${name}`, name);
      occ(other, line);
    }
    occ(ids['getBy']!, 4);
    witness(org);
    expectPass(org, ids['findByTestId']!);
    expectPass(org, ids['findByText']!);
    expectMismatch(org, ids['queryAll']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/t.ts:4']);
    expectMismatch(org, ids['getBy']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/t.ts:5']);
  });

  it('the same member access in an unindexed consumer file still counts (the current rule)', () => {
    const org = buildOrg({
      symbols: [{ name: 'findByTestId' }],
      files: { 'src/t.ts': "import { screen } from '@acme/lib';\nscreen.findByTestId('x');\n" },
    });
    witness(org);
    expectMismatch(org, org.ids['findByTestId']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/t.ts:2']);
  });
});

// A mixed repo: pub package acme_js_app at the root (Dart, reads the JS bundle through
// @JS) and npm package acme-js-src in js_src/ (the bundle's source). No dependency either way.
describe('runWitness: same-repo packages of the other manager', () => {
  const PUB = 'pub:acme/mixed:acme_js_app';
  const NPM = 'npm:acme/mixed:acme-js-src';

  function buildMixed(
    files: Record<string, string>,
    symbols: Array<{ pkg: string; name: string; file: string; verdict: string; reasons: string[]; exportedAs?: string }>,
  ): Org {
    const root = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-witness-mixed-'));
    roots.push(root);
    for (const [rel, text] of Object.entries(files)) write(root, rel, text);
    const db = openDb(':memory:');
    dbs.push(db);
    const run = (sql: string, ...p: Array<string | number | null>): number => Number(db.prepare(sql).run(...p).lastInsertRowid);
    run("INSERT INTO repos (repo, index_status) VALUES ('acme/mixed', 'ok')");
    run("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/mixed', '.', 'pub', 'acme_js_app', 'private')", PUB);
    run("INSERT INTO packages (package_id, repo, path, manager, name, visibility, is_library) VALUES (?, 'acme/mixed', 'js_src', 'npm', 'acme-js-src', 'private', 1)", NPM);
    const ids: Record<string, number> = {};
    for (const s of symbols) {
      const id = run('INSERT INTO symbols (symbol_str, package_id, file, line, name, is_exported) VALUES (?, ?, ?, 0, ?, 1)', `sym ${s.name}`, s.pkg, s.file, s.name);
      ids[s.name] = id;
      run('INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, ?, ?)', id, s.file, s.exportedAs ?? s.name);
      run("INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, '[]')", id, s.verdict, JSON.stringify(s.reasons));
    }
    db.exec(analyzeSql());
    run("INSERT INTO run_params (key, value) VALUES ('analyzed_at', '0')");
    return {
      db,
      ids,
      log: [],
      discover: { repos: [{ repo: 'acme/mixed', localPath: root, packages: [{ packageId: PUB, path: '.' }, { packageId: NPM, path: 'js_src' }] }] },
    };
  }

  const DART_MAIN = [
    "import 'dart:js_interop';",
    '',
    "@JS('acmeBridge.start')",
    'external JSString _start();',
    '',
    '@JS()',
    'external JSString acmeLegacyStart();',
    '',
    'void main() => print(_start().toDart + acmeLegacyStart().toDart);',
    '',
  ].join('\n');

  it('a Dart @JS use downgrades the npm package\'s would-be deletion and its unexport; other names pass', () => {
    const org = buildMixed({
      'bin/main.dart': DART_MAIN,
      // No JS interop: a Dart name here cannot reach the bundle.
      'bin/other.dart': 'void main() => print(jsOnlyUnused);\nconst jsOnlyUnused = 1;\n',
      // A built copy of the bundle inside the pub package: JS, not the pub package's language.
      'lib/js/bundle.js': 'var jsOnlyUnused = 1; var acmeBridge = {};\n',
      'js_src/src/index.ts': 'const acmeBridge = {};\nexport default acmeBridge;\nexport function acmeLegacyStart() {}\nexport function jsOnlyUnused() {}\n',
    }, [
      { pkg: NPM, name: 'acmeBridge', file: 'js_src/src/index.ts', verdict: 'unexport_candidate', reasons: ['internal_refs_only'], exportedAs: 'default' },
      { pkg: NPM, name: 'acmeLegacyStart', file: 'js_src/src/index.ts', verdict: 'needs_review', reasons: ['no_refs', 'witness_pending'] },
      { pkg: NPM, name: 'jsOnlyUnused', file: 'js_src/src/index.ts', verdict: 'needs_review', reasons: ['no_refs', 'witness_pending'] },
    ]);
    expect(witness(org)).toEqual({ checked: 3, passed: 1, mismatched: 2 });
    expect(findings(org, org.ids['acmeBridge']!)).toEqual([
      { verdict: 'needs_review', reasons: ['internal_refs_only', `witness_mismatch:${PUB}:bin/main.dart:3`] },
    ]);
    expectMismatch(org, org.ids['acmeLegacyStart']!, [`witness_mismatch:${PUB}:bin/main.dart:7`, `witness_mismatch:${PUB}:bin/main.dart:9`]);
    expectPass(org, org.ids['jsOnlyUnused']!);
  });

  it('leaves an unexport alone when no file of the other manager names it', () => {
    const org = buildMixed({ 'bin/main.dart': DART_MAIN, 'js_src/src/index.ts': 'const helper = 1;\nexport { helper };\n' }, [
      { pkg: NPM, name: 'helper', file: 'js_src/src/index.ts', verdict: 'unexport_candidate', reasons: ['internal_refs_only'] },
    ]);
    expect(witness(org)).toEqual({ checked: 0, passed: 0, mismatched: 0 });
    expect(org.log).toContain('[witness] unexports: 1 checked, 0 downgraded to needs_review');
    expect(findings(org, org.ids['helper']!)).toEqual([{ verdict: 'unexport_candidate', reasons: ['internal_refs_only'] }]);
  });

  it('JS files of the npm package witness a pub symbol only when its file exports Dart to JS', () => {
    const org = buildMixed({
      'lib/interop.dart': "import 'dart:js_interop';\n@JSExport()\nclass DartApi { void dartExported() {} }\nvoid dartUnused() {}\n",
      // A Dart wrapper named like the JS function it wraps (no JS export): not a use.
      'lib/wrap.dart': "import 'dart:js_interop';\n@JS('lib.getByRole')\nexternal JSAny getByRole();\n",
      'js_src/src/call.ts': 'declare const api: { dartExported(): void };\napi.dartExported();\nexport function getByRole() {}\n',
    }, [
      { pkg: PUB, name: 'getByRole', file: 'lib/wrap.dart', verdict: 'needs_review', reasons: ['no_refs', 'witness_pending'] },
      { pkg: PUB, name: 'dartExported', file: 'lib/interop.dart', verdict: 'needs_review', reasons: ['no_refs', 'witness_pending'] },
      { pkg: PUB, name: 'dartUnused', file: 'lib/interop.dart', verdict: 'needs_review', reasons: ['no_refs', 'witness_pending'] },
    ]);
    witness(org);
    expectMismatch(org, org.ids['dartExported']!, [`witness_mismatch:${NPM}:js_src/src/call.ts:1`, `witness_mismatch:${NPM}:js_src/src/call.ts:2`]);
    expectPass(org, org.ids['dartUnused']!);
    expectPass(org, org.ids['getByRole']!);
  });
});

describe('runWitness: extension members (Phase 2 fix round 3)', () => {
  const P = 'pub:acme/lib:lib_pub';
  const C = 'pub:acme/app:app_pub';
  /** Make S a Dart extension (or another kind) with SCIP children `members`. */
  function withMembers(org: Org, owner: string, kind: string, members: string[]): void {
    org.db.prepare('UPDATE symbols SET kind = ? WHERE symbol_id = ?').run(kind, org.ids[owner]!);
    for (const m of members) {
      org.db.prepare(
        "INSERT INTO symbols (symbol_str, package_id, file, name, kind, parent_symbol_id) VALUES (?, ?, 'lib/svg.dart', ?, 'method', ?)",
      ).run(`sym ${owner}#${m}`, P, m, org.ids[owner]!);
    }
  }

  it('an extension used only through a member (`x.loadSvg()`) is a hit naming the member (flame_svg SvgLoader)', () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'SvgLoader', file: 'lib/svg.dart' }, { name: 'SvgCache', file: 'lib/svg.dart' }],
      files: {
        'lib/main.dart': [
          "import 'package:lib_pub/svg.dart';", // 1
          'void main() async {', // 2
          "  final svg = await game.loadSvg('a.svg');", // 3: the member, on a receiver
          '  // cache.clearSvg();', // 4: a comment never counts
          '}', // 5
        ].join('\n'),
        // No import of P: a member name here is not a use of P.
        'lib/other.dart': "void f() => x.loadSvg('b');\n",
      },
    });
    withMembers(org, 'SvgLoader', 'extension', ['loadSvg', 'clearSvg']);
    // A class's members are not searched: a class is named where it is used.
    withMembers(org, 'SvgCache', 'class', ['loadSvg']);
    expect(witness(org)).toEqual({ checked: 2, passed: 1, mismatched: 1 });
    expectMismatch(org, org.ids['SvgLoader']!, [`witness_mismatch:${C}:pkg/lib/main.dart:3 (member loadSvg)`]);
    expectPass(org, org.ids['SvgCache']!);
  });

  it('skips Object member names, names under 3 characters and private members; a line naming S is S\'s own hit', () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'Fmt', file: 'lib/svg.dart' }, { name: 'Both', file: 'lib/svg.dart' }],
      files: {
        'lib/main.dart': [
          "import 'package:lib_pub/svg.dart';", // 1
          'final a = 3.toString() + 4.hashCode.toString() + a.runtimeType.toString();', // 2: Object members
          'final id = 1; final x2 = id + 1;', // 3: short names
          'final p = _pad;', // 4: private member
          'final b = Both(1).render();', // 5: S's own name and a member on one line
        ].join('\n'),
      },
    });
    withMembers(org, 'Fmt', 'extension', ['toString', 'hashCode', 'noSuchMethod', 'runtimeType', 'id', 'x2', '_pad']);
    withMembers(org, 'Both', 'extension', ['render']);
    witness(org);
    expectPass(org, org.ids['Fmt']!);
    expectMismatch(org, org.ids['Both']!, [`witness_mismatch:${C}:pkg/lib/main.dart:5`]);
  });

  it('a member name on an unrelated class: over-inclusive in unindexed files, SCIP decides in indexed ones', () => {
    const lines = [
      "import 'package:lib_pub/svg.dart';", // 1
      "final a = other.loadSvg('x');", // 2: in indexed.dart, SCIP resolved this to another class's member
      "final b = svg.loadSvg('y');", // 3: SCIP has nothing here: counts (fail closed)
    ].join('\n');
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'SvgLoader', file: 'lib/svg.dart' }],
      files: { 'lib/indexed.dart': lines, 'lib/plain.dart': lines },
    });
    withMembers(org, 'SvgLoader', 'extension', ['loadSvg']);
    const run = (sql: string, ...p: Array<string | number>): number => Number(org.db.prepare(sql).run(...p).lastInsertRowid);
    const mod = run("INSERT INTO symbols (symbol_str, package_id, file, name, kind) VALUES ('mod i', ?, 'pkg/lib/indexed.dart', 'indexed.dart', 'file')", C);
    run("INSERT INTO documents (package_id, file, module_symbol_id) VALUES (?, 'pkg/lib/indexed.dart', ?)", C, mod);
    const other = run("INSERT INTO symbols (symbol_str, package_id, file, name, kind) VALUES ('Other#loadSvg', ?, 'lib/other.dart', 'loadSvg', 'method')", P);
    run(`INSERT INTO occurrences (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id)
      VALUES (?, ?, ?, 'pkg/lib/indexed.dart', 1, 16, 8, ?)`, other, C, P, mod);
    witness(org);
    expectMismatch(org, org.ids['SvgLoader']!, [
      `witness_mismatch:${C}:pkg/lib/indexed.dart:3 (member loadSvg)`,
      `witness_mismatch:${C}:pkg/lib/plain.dart:2 (member loadSvg)`,
      `witness_mismatch:${C}:pkg/lib/plain.dart:3 (member loadSvg)`,
    ]);
  });
});

describe('runWitness: unexports used by ignored manifests and docs files (Phase 2 fix round 3)', () => {
  function unexport(org: Org, name: string, verdict = 'unexport_candidate', reasons = ['internal_refs_only']): void {
    org.db.prepare('DELETE FROM findings WHERE symbol_id = ?').run(org.ids[name]!);
    org.db.prepare("INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, '[]')").run(org.ids[name]!, verdict, JSON.stringify(reasons));
  }
  const findingsOf = (org: Org, name: string): Array<{ verdict: string; reasons: string[] }> => findings(org, org.ids[name]!);

  it('an ignored manifest depending on P that names an unexport moves it to needs_review with a note; others stay', () => {
    const org = buildOrg({ visibility: 'published-public', symbols: [{ name: 'Query' }, { name: 'System' }, { name: 'Internal' }] });
    // Published: the unexport is spelled deprecation_candidate [internal_refs_only].
    unexport(org, 'Query', 'deprecation_candidate');
    unexport(org, 'System', 'deprecation_candidate', ['internal_refs_only', 'only_test_refs']);
    unexport(org, 'Internal', 'deprecation_candidate');
    const lib = org.discover.repos.find((r) => r.repo === 'acme/lib')!;
    write(lib.localPath, 'example/src/main.ts', "import * as oxygen from '@acme/lib';\nnew oxygen.Query(); new oxygen.System();\n");
    // An ignored manifest that does not depend on P (and not a docs dir): not scanned.
    write(lib.localPath, 'other/src/main.ts', "import * as oxygen from '@acme/lib';\noxygen.Internal;\n");
    lib.ignoredManifests = [
      { path: 'example', manifest: 'example/package.json', deps: [{ resolvedPackageId: 'npm:acme/lib:@acme/lib' }] },
      { path: 'other', manifest: 'other/package.json', deps: [] },
    ];
    const counts = witness(org);
    const note = 'witness_mismatch:ignored:acme/lib/example/package.json:example/src/main.ts:2 (used by ignored manifest acme/lib:example/package.json)';
    expect(findingsOf(org, 'Query')).toEqual([{ verdict: 'needs_review', reasons: ['internal_refs_only', note] }]);
    expect(findingsOf(org, 'System')).toEqual([{ verdict: 'needs_review', reasons: ['internal_refs_only', 'only_test_refs', note] }]);
    expect(findingsOf(org, 'Internal')).toEqual([{ verdict: 'deprecation_candidate', reasons: ['internal_refs_only'] }]);
    expect(counts).toEqual({ checked: 2, passed: 0, mismatched: 2 });
    expect(org.log).toContain('[witness] unexports: 3 checked, 2 downgraded to needs_review');
  });

  it('docs/example files of consumers and of P name an unexport whatever countDocsAsConsumers says; other files are not re-read', () => {
    const org = buildOrg({
      // pendingFn stays witness_pending: its scan of C's files runs first (the docs scan must not reuse it).
      symbols: [{ name: 'pendingFn' }, { name: 'shownInDocs' }, { name: 'usedInCode' }, { name: 'ownExample' }],
      files: {
        'docs/usage.ts': "import * as lib from '@acme/lib';\nlib.shownInDocs();\n",
        // A regular consumer file: the index saw it (the unexport's own evidence).
        'src/app.ts': "import { usedInCode } from '@acme/lib';\nusedInCode();\n",
        // A test file in a docs dir: skipped under countTestsAsConsumers = false.
        'docs/usage.test.ts': "import { usedInCode } from '@acme/lib';\nusedInCode();\n",
      },
      // P's own example file importing P by name, outside the index.
      libFiles: { 'examples/basic.ts': "import * as lib from '@acme/lib';\nlib.ownExample();\n" },
    });
    for (const n of ['shownInDocs', 'usedInCode', 'ownExample']) unexport(org, n);
    witness(org);
    expect(findingsOf(org, 'shownInDocs')).toEqual([{
      verdict: 'needs_review',
      reasons: ['internal_refs_only', 'witness_mismatch:npm:acme/app:@acme/app:pkg/docs/usage.ts:2 (used in a docs/example file)'],
    }]);
    expect(findingsOf(org, 'usedInCode')).toEqual([{ verdict: 'unexport_candidate', reasons: ['internal_refs_only'] }]);
    expectPass(org, org.ids['pendingFn']!);
    expect(findingsOf(org, 'ownExample')).toEqual([{
      verdict: 'needs_review',
      reasons: ['internal_refs_only', 'witness_mismatch:self:examples/basic.ts:2 (used in a docs/example file)'],
    }]);
  });

  it('an extension unexport used through a member in an ignored example carries both notes (reported once)', () => {
    const org = buildOrg({ manager: 'pub', symbols: [{ name: 'SvgLoader', file: 'lib/svg.dart' }] });
    unexport(org, 'SvgLoader');
    org.db.prepare("UPDATE symbols SET kind = 'extension' WHERE symbol_id = ?").run(org.ids['SvgLoader']!);
    org.db.prepare("INSERT INTO symbols (symbol_str, package_id, file, name, kind, parent_symbol_id) VALUES ('m', 'pub:acme/lib:lib_pub', 'lib/svg.dart', 'loadSvg', 'method', ?)")
      .run(org.ids['SvgLoader']!);
    const lib = org.discover.repos.find((r) => r.repo === 'acme/lib')!;
    // Inside P's dir and under example/: the ignored-manifest step reports it, P's docs step does not repeat it.
    write(lib.localPath, 'example/lib/main.dart', "import 'package:lib_pub/svg.dart';\nfinal s = game.loadSvg('a');\n");
    lib.ignoredManifests = [{ path: 'example', manifest: 'example/pubspec.yaml', deps: [{ resolvedPackageId: 'pub:acme/lib:lib_pub' }] }];
    witness(org);
    expect(findingsOf(org, 'SvgLoader')).toEqual([{
      verdict: 'needs_review',
      reasons: [
        'internal_refs_only',
        'witness_mismatch:ignored:acme/lib/example/pubspec.yaml:example/lib/main.dart:2 (member loadSvg; used by ignored manifest acme/lib:example/pubspec.yaml)',
      ],
    }]);
  });

  it('an ignored manifest in ANOTHER repo is named <org>/<repo>:<manifest> in the note (Phase 2 fix round 4)', () => {
    // Workiva: opentracing `ScopeManager` used by w_module's `example/` app; a bare
    // `example/pubspec.yaml` did not say which repo.
    const org = buildOrg({ manager: 'pub', symbols: [{ name: 'ScopeManager', file: 'lib/scope.dart' }] });
    unexport(org, 'ScopeManager');
    const app = org.discover.repos.find((r) => r.repo === 'acme/app')!;
    write(app.localPath, 'example/lib/main.dart', "import 'package:lib_pub/scope.dart';\nfinal m = ScopeManager();\n");
    app.ignoredManifests = [{ path: 'example', manifest: 'example/pubspec.yaml', deps: [{ resolvedPackageId: 'pub:acme/lib:lib_pub' }] }];
    witness(org);
    expect(findingsOf(org, 'ScopeManager')).toEqual([{
      verdict: 'needs_review',
      reasons: [
        'internal_refs_only',
        'witness_mismatch:ignored:acme/app/example/pubspec.yaml:example/lib/main.dart:2 (used by ignored manifest acme/app:example/pubspec.yaml)',
      ],
    }]);
  });
});

describe('runWitness: text hygiene (Phase 2 fix round 4)', () => {
  const C = 'pub:acme/app:app_pub';
  /** Mark consumer files (relative to the consumer package dir) as indexed documents of `consumer`. */
  function indexed(org: Org, consumer: string, files: string[]): void {
    for (const f of files) {
      const r = org.db.prepare("INSERT INTO symbols (symbol_str, package_id, file, name, kind) VALUES (?, ?, ?, ?, 'file')").run(`mod ${f}`, consumer, `pkg/${f}`, f);
      org.db.prepare('INSERT INTO documents (package_id, file, module_symbol_id) VALUES (?, ?, ?)').run(consumer, `pkg/${f}`, Number(r.lastInsertRowid));
    }
  }

  it('a doc-comment import of P is no import: the file is not scanned (indexed or not)', () => {
    // react_testing_library: `/// import 'package:react/react.dart'` in a doc comment.
    const src = "/// import 'package:lib_pub/lib_pub.dart';\n/* import 'package:lib_pub/lib_pub.dart'; */\nvoid f(x) => isElement(x);\n";
    const org = buildOrg({ manager: 'pub', symbols: [{ name: 'isElement', file: 'lib/lib_pub.dart' }], files: { 'lib/a.dart': src, 'lib/b.dart': src } });
    indexed(org, C, ['lib/a.dart']);
    witness(org);
    expectPass(org, org.ids['isElement']!);
  });

  it("in an INDEXED file a string literal naming S is not a hit (matchState['isElement']); a real use still is", () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'isElement', file: 'lib/lib_pub.dart' }, { name: 'isUsed', file: 'lib/lib_pub.dart' }],
      files: {
        'lib/is_checked.dart': [
          "import 'package:lib_pub/lib_pub.dart';", // 1
          "final a = matchState['isElement'];", // 2: a map key
          'final b = """isElement', // 3: a multi-line string
          '""";', // 4
          'final c = isUsed(a);', // 5: a real use
        ].join('\n'),
      },
    });
    indexed(org, C, ['lib/is_checked.dart']);
    witness(org);
    expectPass(org, org.ids['isElement']!);
    expectMismatch(org, org.ids['isUsed']!, [`witness_mismatch:${C}:pkg/lib/is_checked.dart:5`]);
  });

  it("in an indexed file, interpolations and @JS('…') names still count; a raw string does not interpolate", () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [
        { name: 'inBraces', file: 'lib/lib_pub.dart' }, { name: 'inDollar', file: 'lib/lib_pub.dart' },
        { name: 'jsName', file: 'lib/lib_pub.dart' }, { name: 'inRaw', file: 'lib/lib_pub.dart' },
      ],
      files: {
        'lib/i.dart': [
          "import 'package:lib_pub/lib_pub.dart';", // 1
          "final a = 'x ${inBraces(1)} y';", // 2
          'final b = "$inDollar";', // 3
          "@JS('jsName')", // 4
          'external void f();', // 5
          "final c = r'$inRaw';", // 6
        ].join('\n'),
      },
    });
    indexed(org, C, ['lib/i.dart']);
    witness(org);
    expectMismatch(org, org.ids['inBraces']!, [`witness_mismatch:${C}:pkg/lib/i.dart:2`]);
    expectMismatch(org, org.ids['inDollar']!, [`witness_mismatch:${C}:pkg/lib/i.dart:3`]);
    expectMismatch(org, org.ids['jsName']!, [`witness_mismatch:${C}:pkg/lib/i.dart:4`]);
    expectPass(org, org.ids['inRaw']!);
  });

  it('in an UNINDEXED file a string naming S still hits (no SCIP there)', () => {
    const org = buildOrg({
      manager: 'pub',
      symbols: [{ name: 'isElement', file: 'lib/lib_pub.dart' }],
      files: { 'lib/plain.dart': "import 'package:lib_pub/lib_pub.dart';\nfinal a = matchState['isElement'];\n" },
    });
    witness(org);
    expectMismatch(org, org.ids['isElement']!, [`witness_mismatch:${C}:pkg/lib/plain.dart:2`]);
  });

  it('npm: an indexed file quoting S is no hit; a template interpolation naming S is', () => {
    const org = buildOrg({
      symbols: [{ name: 'queryAll' }, { name: 'getBy' }],
      files: { 'src/t.ts': "import * as lib from '@acme/lib';\nconst k = 'queryAll';\nconst m = `${getBy}`;\n" },
    });
    indexed(org, 'npm:acme/app:@acme/app', ['src/t.ts']);
    witness(org);
    expectPass(org, org.ids['queryAll']!);
    expectMismatch(org, org.ids['getBy']!, ['witness_mismatch:npm:acme/app:@acme/app:pkg/src/t.ts:3']);
  });
});

describe('blankStrings', () => {
  it('blanks literals except specifiers, @JS names and interpolations; keeps offsets', () => {
    const src = "import 'package:p/p.dart';\n@JS('a.b')\nfinal x = m['k'] + '${f(1)} $g \\$h' + r'$i' + '''\nz''';\n";
    const out = blankStrings(src, true);
    expect(out.length).toBe(src.length);
    expect(out).toBe(`import 'package:p/p.dart';\n@JS('a.b')\nfinal x = m[   ] + \x20\${f(1)} $g      + r     +    \n    ;\n`);
    const js = "import x from 'p';\nconst a = 'k' + `t ${v} u` + require('q');\n";
    expect(blankStrings(js)).toBe("import x from 'p';\nconst a =     +    ${v}    + require('q');\n");
  });
});
