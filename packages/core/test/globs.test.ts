import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { matchGlob } from '../src/glob.ts';
import { BUILD_CACHE_DIRS, DOCS_GLOBS, GENERATED_GLOBS, inBuildCacheDir, inSurfaceDir, inVendoredDir, SCRIPT_GLOBS, SURFACE_DIRS, TEST_GLOBS, VENDORED_GLOBS } from '../src/globs.ts';

// analyze.sql spells the test/docs globs as SQLite GLOB conditions (it is loaded
// verbatim). Parse them back and compare with the TypeScript lists the witness uses.

const SQL = readFileSync(new URL('../sql/analyze.sql', import.meta.url), 'utf8');
const BASENAME = "substr(file, length(rtrim(file, replace(file, '/', ''))) + 1)";
// vendored_files matches the package-relative path.
const PKGREL = "('/' || substr(d.file, length(CASE WHEN p.path IN ('.', '') THEN '' ELSE p.path || '/' END) + 1))";

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
      else if ((m[1] === "('/' || file)" || m[1] === "('/' || rel)" || m[1] === PKGREL) && /^\*\/[^*/]+\/\*$/.test(m[2]!)) out.push(`**/${m[2]!.slice(2, -2)}/**`);
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

  it('vendored_files spells exactly VENDORED_GLOBS, on the package-relative path', () => {
    expect(viewGlobs('vendored_files')).toEqual([...VENDORED_GLOBS]);
    const start = SQL.indexOf('CREATE VIEW vendored_files ');
    const body = SQL.slice(start, SQL.indexOf(';', start));
    expect(body.split(`${PKGREL} GLOB '`).length - 1).toBe(VENDORED_GLOBS.length);
    // generated_files includes it
    const g = SQL.indexOf('CREATE VIEW generated_files ');
    expect(SQL.slice(g, SQL.indexOf(';', g))).toContain('FROM vendored_files');
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
      'lib/a.g.dart', 'lib/src/b.pb.dart', 'c.pbenum.dart', 'lib/d.pbjson.dart', 'lib/e.pbserver.dart', 'lib/f.freezed.dart', 'lib/v1/api.pbgrpc.dart',
      'test/g.mocks.dart', 'lib/h.over_react.g.dart', 'src/i.generated.ts', 'generated/j.ts', 'src/__generated__/k.ts',
      'lib/g.dart', 'lib/pb.dart', 'src/generator/l.ts', 'src/generated.ts', 'lib/x.g.dart.bak',
      'lib/src/objective_c_bindings_generated.dart', 'lib/generated_bindings.dart', 'lib/src/generated_dart.ts',
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
        'lib/h.over_react.g.dart', 'lib/src/b.pb.dart', 'lib/src/objective_c_bindings_generated.dart', 'lib/v1/api.pbgrpc.dart', 'src/__generated__/k.ts',
        'src/i.generated.ts', 'test/g.mocks.dart',
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

  it('fix round 8a globs: test_utils / test_util / testutils files, in the view and the witness alike', () => {
    const tests = ['typescript/utils/test_utils.ts', 'src/test_util.js', 'testutils.ts', 'pkg/src/testutils.mts'];
    const not = ['src/utils.ts', 'src/my_test_utils_extra/a.ts', 'src/test_utilsx.ts', 'src/attest_utils.ts', 'src/testutil/a.ts'];
    for (const p of tests) expect(TEST_GLOBS.some((g) => matchGlob(g, p)), p).toBe(true);
    for (const p of not) expect(TEST_GLOBS.some((g) => matchGlob(g, p)), p).toBe(false);
    const db = openDb(':memory:');
    try {
      db.exec("INSERT INTO repos (repo) VALUES ('acme/a')");
      db.exec("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:acme/a:a', 'acme/a', '.', 'npm', 'a', 'private')");
      db.exec("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('pub:acme/a:p', 'acme/a', 'dart', 'pub', 'p', 'published-public')");
      const ins = db.prepare("INSERT INTO documents (package_id, file) VALUES ('npm:acme/a:a', ?)");
      for (const p of [...tests, ...not]) ins.run(p);
      // A pub package's lib/ is its surface: lib/test_utils.dart stays library code.
      db.exec("INSERT INTO documents (package_id, file) VALUES ('pub:acme/a:p', 'dart/lib/test_utils.dart')");
      db.exec(analyzeSql());
      const inView = (db.prepare('SELECT file FROM test_files ORDER BY file').all() as Array<{ file: string }>).map((r) => r.file);
      expect(inView).toEqual([...tests].sort());
    } finally {
      db.close();
    }
  });

  it('fix round 8d globs: tests-e2e / e2e-tests dirs are tests; Docusaurus blog / versioned_docs are docs, .vitepress/ (theme and config code) is not', () => {
    const tests = ['packages/cli/tests-e2e/helpers.ts', 'e2e-tests/run.ts'];
    const docs = ['www/blog/2023-01-17-post.mdx', 'www/versioned_docs/version-10.x/setup.mdx'];
    const not = ['packages/db-collection-e2e/src/suite.ts', 'src/tests-e2e.ts', 'src/blogger/a.ts', 'src/blog.ts', 'src/vitepress/a.ts', 'versioned_docs.ts', 'site/.vitepress/config.ts', '.vitepress/theme/index.ts'];
    for (const p of tests) expect(TEST_GLOBS.some((g) => matchGlob(g, p)), p).toBe(true);
    for (const p of docs) expect(DOCS_GLOBS.some((g) => matchGlob(g, p)), p).toBe(true);
    for (const p of not) expect([...TEST_GLOBS, ...DOCS_GLOBS].some((g) => matchGlob(g, p)), p).toBe(false);
    const db = openDb(':memory:');
    try {
      db.exec("INSERT INTO repos (repo) VALUES ('acme/a')");
      db.exec("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:acme/a:a', 'acme/a', '.', 'npm', 'a', 'private')");
      const ins = db.prepare("INSERT INTO documents (package_id, file) VALUES ('npm:acme/a:a', ?)");
      for (const p of [...tests, ...docs, ...not]) ins.run(p);
      db.exec(analyzeSql());
      const inView = (v: string): string[] => (db.prepare(`SELECT file FROM ${v} ORDER BY file`).all() as Array<{ file: string }>).map((r) => r.file);
      expect(inView('test_files')).toEqual([...tests].sort());
      expect(inView('doc_files')).toEqual([...docs].sort());
    } finally {
      db.close();
    }
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

describe('VENDORED_GLOBS: vendored code below the package root is generated code', () => {
  const pkgPath: Record<string, string> = {
    'pub:acme/r:root': '.', 'pub:acme/r:mcp': 'pkgs/mcp', 'pub:acme/r:forked': 'third_party/forked', 'npm:acme/r:web': 'vendor/web',
  };
  const docs: Array<[string, string, boolean]> = [
    // below the package root: vendored
    ['pub:acme/r:root', 'third_party/lsp/lib/protocol.dart', true],
    ['pub:acme/r:root', 'lib/src/vendored/x.dart', true],
    ['pub:acme/r:mcp', 'pkgs/mcp/lib/src/third_party/language_server_protocol/lib/json_parsing.dart', true],
    ['pub:acme/r:mcp', 'pkgs/mcp/tool/vendor/a.dart', true],
    ['pub:acme/r:forked', 'third_party/forked/lib/src/vendor/v.dart', true],
    ['npm:acme/r:web', 'vendor/web/src/vendor/jquery.js', true],
    // the package's OWN root is under such a dir: org code (negative)
    ['pub:acme/r:forked', 'third_party/forked/lib/forked.dart', false],
    ['pub:acme/r:forked', 'third_party/forked/lib/src/impl.dart', false],
    ['npm:acme/r:web', 'vendor/web/src/index.ts', false],
    // names that only look alike (negative)
    ['pub:acme/r:root', 'lib/src/vendors/a.dart', false],
    ['pub:acme/r:root', 'lib/src/third_party.dart', false],
    ['pub:acme/r:root', 'lib/src/my_vendor/a.dart', false],
    ['pub:acme/r:mcp', 'pkgs/mcp/lib/src/vendored_thing.dart', false],
  ];

  it('inVendoredDir and the vendored_files / generated_files views agree', () => {
    for (const [id, f, want] of docs) expect(inVendoredDir(f, pkgPath[id]!), f).toBe(want);
    // A file outside the package path is never vendored by it.
    expect(inVendoredDir('other/vendor/x.dart', 'pkgs/mcp')).toBe(false);
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
      const want = docs.filter(([, , v]) => v).map(([, f]) => f).sort();
      expect(inView('vendored_files')).toEqual(want);
      expect(inView('generated_files')).toEqual(want);
    } finally {
      db.close();
    }
  });
});

describe('doc_files for a promoted consumer (Phase 3 decision 3): docs globs on the package-relative path', () => {
  it('its root under example/ is not docs; its own docs/ and example/ are; other packages keep repo-relative globs (negative)', () => {
    const db = openDb(':memory:');
    try {
      db.exec("INSERT INTO repos (repo) VALUES ('acme/s')");
      const pkg = db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES (?, 'acme/s', ?, ?, ?, 'private')");
      pkg.run('pub:acme/s:app', 'example/app', 'pub', 'app'); // promoted
      pkg.run('npm:acme/s:site', 'docs/site', 'npm', 'site'); // promoted, under docs/
      pkg.run('npm:acme/s:demo', 'examples/demo', 'npm', 'demo'); // NOT promoted: repo-relative globs
      db.exec("INSERT INTO promoted_packages (package_id, reason) VALUES ('pub:acme/s:app', 'example app depends on x'), ('npm:acme/s:site', 'r')");
      const ins = db.prepare('INSERT INTO documents (package_id, file) VALUES (?, ?)');
      const appFiles = ['example/app/bin/main.dart', 'example/app/lib/main.dart', 'example/app/docs/a.dart', 'example/app/example/b.dart', 'example/app/test/c_test.dart'];
      for (const f of appFiles) ins.run('pub:acme/s:app', f);
      for (const f of ['docs/site/src/a.ts', 'docs/site/demo/b.ts']) ins.run('npm:acme/s:site', f);
      ins.run('npm:acme/s:demo', 'examples/demo/src/c.ts');
      db.exec(analyzeSql());
      const inView = (v: string): string[] =>
        (db.prepare(`SELECT file FROM ${v} ORDER BY file`).all() as Array<{ file: string }>).map((r) => r.file);
      expect(inView('doc_files')).toEqual([
        'docs/site/demo/b.ts', 'example/app/docs/a.dart', 'example/app/example/b.dart', 'examples/demo/src/c.ts',
      ]);
      // Test globs are unchanged: a promoted package's tests stay tests.
      expect(inView('test_files')).toEqual(['example/app/test/c_test.dart']);
    } finally {
      db.close();
    }
  });
});

describe('BUILD_CACHE_DIRS', () => {
  it('names package-manager and build-tool state dirs at any depth, never a source dir', () => {
    expect(BUILD_CACHE_DIRS).toContain('.nx');
    for (const f of ['.nx/cache/1/lib/commonjs/a.js', 'pkgs/a/.turbo/x.js', '.yarn/cache/z.zip', '.pnpm-store/v3/f.js',
      'node_modules/m/i.js', '.cache/b.js', 'web/.parcel-cache/c.js', '.nx/workspace-data/d.json']) {
      expect(inBuildCacheDir(f), f).toBe(true);
    }
    // A file named like a cache dir, a look-alike dir, other dot dirs: not caches.
    for (const f of ['src/.cache', 'src/cache/a.ts', '.vitepress/config.ts', 'nx/x.ts', 'my.nx/a.ts']) {
      expect(inBuildCacheDir(f), f).toBe(false);
    }
  });
});
