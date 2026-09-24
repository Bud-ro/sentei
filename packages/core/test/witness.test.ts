import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { runWitness, type WitnessDiscoverInput } from '../src/witness.ts';

// A hand-built org: library P (npm:@acme/lib or pub:lib_pub) with one consumer C
// whose package dir is <repo>/pkg. Every symbol gets a witness_pending finding.

interface OrgSpec {
  manager?: 'npm' | 'pub';
  /** Consumer files, relative to the consumer package dir. */
  files?: Record<string, string>;
  /** Symbols of P: name + defining file (default src/index.ts). */
  symbols: Array<{ name: string; file?: string }>;
  policy?: Record<string, unknown>;
  keep?: string[];
  /** Consumer checkout does not exist on disk. */
  missingCheckout?: boolean;
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
  run('INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id) VALUES (?, ?, ?, ?)', C, libName, manager, P);
  for (const [k, v] of Object.entries(spec.policy ?? {})) run('INSERT OR REPLACE INTO policy (key, value) VALUES (?, ?)', k, JSON.stringify(v));
  for (const k of spec.keep ?? []) run('INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, ?)', P, k);

  const ids: Record<string, number> = {};
  for (const s of spec.symbols) {
    const file = s.file ?? 'src/index.ts';
    const r = db
      .prepare('INSERT INTO symbols (symbol_str, package_id, file, name, is_exported) VALUES (?, ?, ?, ?, 1)')
      .run(`sym ${P} ${file} ${s.name}`, P, file, s.name);
    const id = Number(r.lastInsertRowid);
    ids[`${file}#${s.name}`] = id;
    ids[s.name] ??= id;
    run("INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, 'needs_review', ?, '[]')", id, JSON.stringify(['no_refs', 'witness_pending']));
  }

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

  it('an ignored manifest that does not depend on P is not scanned', () => {
    const org = buildOrg({ symbols: [{ name: 'deadFn' }] });
    withIgnored(org, [
      { path: 'examples/other', deps: [null, 'npm:@acme/app'], files: { 'src/x.ts': IMPORTS } },
      { path: 'templates/none', deps: [], files: { 'src/x.ts': IMPORTS } },
    ]);
    witness(org);
    expectPass(org, org.ids['deadFn']!);
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
