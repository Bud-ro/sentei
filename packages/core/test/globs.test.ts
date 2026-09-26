import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { matchGlob } from '../src/glob.ts';
import { DOCS_GLOBS, GENERATED_GLOBS, inSurfaceDir, SCRIPT_GLOBS, SURFACE_DIRS, TEST_GLOBS } from '../src/globs.ts';

// analyze.sql spells the test/docs globs as SQLite GLOB conditions (it is loaded
// verbatim). Parse them back and compare with the TypeScript lists the witness uses.

const SQL = readFileSync(new URL('../sql/analyze.sql', import.meta.url), 'utf8');
const BASENAME = "substr(file, length(rtrim(file, replace(file, '/', ''))) + 1)";

function viewGlobs(view: string): string[] {
  const start = SQL.indexOf(`CREATE VIEW ${view} `);
  expect(start, view).toBeGreaterThanOrEqual(0);
  const body = SQL.slice(start, SQL.indexOf(';', start));
  const out: string[] = [];
  const total = body.split(" GLOB '").length - 1;
  for (const line of body.split('\n')) {
    // `WHERE <surface exemption>` then `AND (<glob>` / `OR <glob>` ... `OR <glob>)`.
    const cond = line.replace(/^\s*(?:WHERE|OR)\s+/, '').replace(/^\s*AND\s+\(/, '').replace(/\);?$/, '');
    let m: RegExpExecArray | null;
    if ((m = /^(.*) GLOB '([^']*)'$/.exec(cond))) {
      if (m[1] === BASENAME && !m[2]!.includes('/')) out.push(`**/${m[2]}`);
      else if (m[1] === "('/' || file)" && /^\*\/[^*/]+\/\*$/.test(m[2]!)) out.push(`**/${m[2]!.slice(2, -2)}/**`);
      else throw new Error(`${view}: unrecognised GLOB condition: ${cond}`);
    }
  }
  expect(out.length, `${view}: every GLOB condition parsed`).toBe(total);
  return out;
}

describe('test/docs/generated/script globs: analyze.sql and globs.ts agree', () => {
  it('test_files spells exactly TEST_GLOBS', () => {
    expect(viewGlobs('test_files')).toEqual([...TEST_GLOBS]);
  });

  it('doc_files spells exactly DOCS_GLOBS', () => {
    expect(viewGlobs('doc_files')).toEqual([...DOCS_GLOBS]);
  });

  it('generated_files spells exactly GENERATED_GLOBS', () => {
    expect(viewGlobs('generated_files')).toEqual([...GENERATED_GLOBS]);
  });

  it('script_files spells exactly SCRIPT_GLOBS', () => {
    expect(viewGlobs('script_files')).toEqual([...SCRIPT_GLOBS]);
  });

  it('the views and matchGlob classify sample paths identically', () => {
    const paths = [
      'src/a.test.ts', 'b.spec.js', 'lib/f_test.dart', 'pkg/x_test.go', 'src/Button.stories.tsx', 'test/c.ts', 'src/test/d.ts',
      'src/__tests__/e.ts', 'src/mocks/h.ts', '__mocks__/m.ts', 'fixtures/f.ts', 'a/__fixtures__/f.ts', 'e2e/run.ts',
      'test-integration/i.ts', 'src/__schemas__/s.ts', 'docs/g.ts', 'examples/x/y.ts', 'src/example/z.ts', 'demo/d.ts',
      'src/testing/i.ts', 'src/latest/j.ts', 'x.test/k.ts', 'src/mocksy/a.ts', 'src/spec.ts', 'src/demos/a.ts', 'src/index.ts',
      'lib/a.g.dart', 'lib/src/b.pb.dart', 'c.pbenum.dart', 'lib/d.pbjson.dart', 'lib/e.pbserver.dart', 'lib/f.freezed.dart',
      'test/g.mocks.dart', 'lib/h.over_react.g.dart', 'src/i.generated.ts', 'generated/j.ts', 'src/__generated__/k.ts',
      'lib/g.dart', 'lib/pb.dart', 'src/generator/l.ts', 'src/generated.ts', 'lib/x.g.dart.bak',
      'playground/p.ts', 'src/playgrounds/q.ts', 'bench/r.ts', 'benchmark/s.ts', 'x/benchmarks/t.ts', 'sandbox/u.ts',
      'scripts/v.ts', 'tool/w.dart', 'src/tools/x.ts', 'src/scripting/y.ts', 'src/toolsy/z.ts', 'scripts.ts',
      // Round 3 additions (honojs): test support and tool configs.
      'src/mocks.ts', 'src/types.test-d.ts', 'src/test-utils.ts', 'test-utils/setup.ts', 'src/helper/testing/index.ts',
      'src/api.mock.ts', 'src/mocksy.ts', 'src/my-test-utils.ts', 'script/build.ts', 'vitest.config.ts', 'packages/a/vite.config.mts',
      'eslint.config.mjs', 'vitest.workspace.ts', 'src/config.ts', 'src/configure.ts', 'src/workspace.ts', 'src/scripted/a.ts',
    ];
    const db = openDb(':memory:');
    try {
      db.exec("INSERT INTO repos (repo) VALUES ('acme/a')");
      db.exec("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:acme/a:a', 'acme/a', '.', 'npm', 'a', 'private')");
      const ins = db.prepare("INSERT INTO documents (package_id, file) VALUES ('npm:acme/a:a', ?)");
      for (const p of paths) ins.run(p);
      db.exec(analyzeSql());
      const inView = (v: string): string[] =>
        (db.prepare(`SELECT file FROM ${v} ORDER BY file`).all() as Array<{ file: string }>).map((r) => r.file);
      const byGlob = (gs: readonly string[]): string[] => paths.filter((p) => gs.some((g) => matchGlob(g, p))).sort();
      expect(inView('test_files')).toEqual(byGlob(TEST_GLOBS));
      expect(inView('doc_files')).toEqual(byGlob(DOCS_GLOBS));
      expect(inView('generated_files')).toEqual(byGlob(GENERATED_GLOBS));
      expect(inView('script_files')).toEqual(byGlob(SCRIPT_GLOBS));
      expect(inView('script_files')).toEqual([
        'bench/r.ts', 'benchmark/s.ts', 'eslint.config.mjs', 'packages/a/vite.config.mts', 'playground/p.ts', 'sandbox/u.ts',
        'script/build.ts', 'scripts/v.ts', 'src/playgrounds/q.ts', 'src/tools/x.ts', 'tool/w.dart', 'vitest.config.ts',
        'vitest.workspace.ts', 'x/benchmarks/t.ts',
      ]);
      expect(inView('test_files').filter((f) => f.startsWith('src/') || f.startsWith('test-utils/'))).toEqual([
        'src/Button.stories.tsx', 'src/__schemas__/s.ts', 'src/__tests__/e.ts', 'src/a.test.ts', 'src/api.mock.ts',
        'src/helper/testing/index.ts', 'src/mocks.ts', 'src/mocks/h.ts', 'src/test-utils.ts', 'src/test/d.ts',
        'src/testing/i.ts', 'src/types.test-d.ts', 'test-utils/setup.ts',
      ]);
      expect(inView('generated_files')).toEqual([
        'c.pbenum.dart', 'generated/j.ts', 'lib/a.g.dart', 'lib/d.pbjson.dart', 'lib/e.pbserver.dart', 'lib/f.freezed.dart',
        'lib/h.over_react.g.dart', 'lib/src/b.pb.dart', 'src/__generated__/k.ts', 'src/i.generated.ts', 'test/g.mocks.dart',
      ]);
      expect(inView('doc_files')).toEqual(['demo/d.ts', 'docs/g.ts', 'examples/x/y.ts', 'src/example/z.ts']);
    } finally {
      db.close();
    }
  });

  it('fix round 1 globs: tests/, type-tests/, Cypress / Playwright, Flutter test dirs, setup files', () => {
    const tests = [
      'packages/stack/tests/whole-stack/fixture.ts', 'tests/helpers.ts', 'type-tests/positive.ts', 'internal/testdata/a.ts',
      'spec/a.ts', 'cypress/support/e2e.ts', 'playwright/auth.ts', 'test_driver/app.dart', 'integration_test/app_test.dart',
      'integration_test/robot.dart', 'src/db.fixture.ts', 'src/app.e2e.ts', 'vitest.setup.ts', 'jest.setup.js', 'src/setupTests.ts',
    ];
    const not = ['src/latest.ts', 'src/contests/a.ts', 'src/testsuite.ts', 'src/specs.ts', 'src/inspect/a.ts', 'src/fixture.ts', 'src/setup.ts', 'vitest.config.ts'];
    for (const p of tests) expect(TEST_GLOBS.some((g) => matchGlob(g, p)), p).toBe(true);
    for (const p of not) expect(TEST_GLOBS.some((g) => matchGlob(g, p)), p).toBe(false);
  });
});

describe('SURFACE_DIRS: nothing under a pub package lib/ is a test, docs or script file', () => {
  const docs: Array<[string, string]> = [
    // pub package at the repo root
    ['pub:acme/r:rootpkg', 'lib/src/wire_test.dart'],
    ['pub:acme/r:rootpkg', 'lib/mocks/fake_clock.dart'],
    ['pub:acme/r:rootpkg', 'lib/src/example/usage.dart'],
    ['pub:acme/r:rootpkg', 'lib/testing/harness.dart'],
    ['pub:acme/r:rootpkg', 'lib/src/tool/x.dart'],
    ['pub:acme/r:rootpkg', 'lib/src/gen.g.dart'],
    ['pub:acme/r:rootpkg', 'test/a_test.dart'],
    ['pub:acme/r:rootpkg', 'test/lib/b_test.dart'],
    ['pub:acme/r:rootpkg', 'example/lib/main.dart'],
    // pub package in a subdir: its own lib/ only
    ['pub:acme/r:nested', 'pkgs/nested/lib/mocks/m.dart'],
    ['pub:acme/r:nested', 'pkgs/nested/test/mocks/m.dart'],
    // npm: no surface dir; src/ is not exempt
    ['npm:acme/r:web', 'web/lib/mocks/m.ts'],
    ['npm:acme/r:web', 'web/src/__tests__/a.ts'],
    ['npm:acme/r:web', 'web/src/a.test.ts'],
  ];
  const pkgPath: Record<string, string> = { 'pub:acme/r:rootpkg': '.', 'pub:acme/r:nested': 'pkgs/nested', 'npm:acme/r:web': 'web' };

  it('globs.ts and analyze.sql state the same rule', () => {
    expect(SURFACE_DIRS).toEqual({ pub: ['lib'], npm: [] });
    const start = SQL.indexOf('CREATE VIEW surface_files ');
    const body = SQL.slice(start, SQL.indexOf(';', start));
    expect(body).toContain("WHERE p.manager = 'pub'");
    expect(body).toContain("|| 'lib/'");
  });

  it('the views and inSurfaceDir agree; pub lib/ files are never test/docs/script, generated still applies (negative)', () => {
    const db = openDb(':memory:');
    try {
      db.exec("INSERT INTO repos (repo) VALUES ('acme/r')");
      const pkg = db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/r', ?, ?, ?, 'private')");
      for (const [id, path] of Object.entries(pkgPath)) pkg.run(id, path, id.slice(0, 3), id.slice(id.lastIndexOf(':') + 1));
      const ins = db.prepare('INSERT INTO documents (package_id, file) VALUES (?, ?)');
      for (const [id, f] of docs) ins.run(id, f);
      db.exec(analyzeSql());
      const inView = (v: string): string[] =>
        (db.prepare(`SELECT file FROM ${v} ORDER BY file`).all() as Array<{ file: string }>).map((r) => r.file);
      const surface = docs.filter(([id, f]) => inSurfaceDir(f, id.slice(0, 3), pkgPath[id]!)).map(([, f]) => f).sort();
      expect(inView('surface_files')).toEqual(surface);
      expect(surface).toEqual([
        'lib/mocks/fake_clock.dart', 'lib/src/example/usage.dart', 'lib/src/gen.g.dart', 'lib/src/tool/x.dart',
        'lib/src/wire_test.dart', 'lib/testing/harness.dart', 'pkgs/nested/lib/mocks/m.dart',
      ]);
      // Without the exemption every one of these would match a glob.
      expect(inView('test_files')).toEqual([
        'pkgs/nested/test/mocks/m.dart', 'test/a_test.dart', 'test/lib/b_test.dart', 'web/lib/mocks/m.ts', 'web/src/__tests__/a.ts',
        'web/src/a.test.ts',
      ]);
      expect(inView('doc_files')).toEqual(['example/lib/main.dart']);
      expect(inView('script_files')).toEqual([]);
      expect(inView('generated_files')).toEqual(['lib/src/gen.g.dart']);
    } finally {
      db.close();
    }
  });
});
