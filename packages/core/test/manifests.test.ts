import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALWAYS_SKIP_DIRS, DEFAULT_IGNORE_MANIFEST_DIRS, electronHtmlRefs, pubApplicationReason, readNpmPackage, inlineScriptRefs, webpackEntries, isIgnoredManifestPath, listFiles, pubWorkspaceEntries, workspaceMembership, npmVisibility, parsePubspecYaml, pubVisibility, readRepoManifests, readRepoManifestsWithIgnored,
  dockerfileTargets, runnerTargets, sourceForBuildOutput, stripJsonc, tsconfigOutDirs, urlReferencedFiles,
} from '../src/manifests.ts';

let root: string;
let warnings: string[];
const warn = (m: string): void => void warnings.push(m);

function write(rel: string, content = ''): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}
function pkgJson(rel: string, json: Record<string, unknown>): void {
  write(rel, JSON.stringify(json, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sentei-manifests-'));
  warnings = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listFiles', () => {
  it('outside git: skips dependency, build and VCS dirs (a bogus .git dir does not make it a checkout)', () => {
    for (const d of ['node_modules', '.dart_tool', 'build', 'dist', '.git', 'vendor', 'third_party']) write(`${d}/x/package.json`, '{}');
    write('pkgs/a/node_modules/b/package.json', '{}');
    write('pkgs/a/src/x.ts');
    expect(listFiles(root)).toEqual(['pkgs/a/src/x.ts']);
  });

  it('outside git: keeps a build/dist dir that holds a manifest (a package), skips build output', () => {
    write('dist/index.js');
    write('pkgs/a/dist/y.js');
    write('pkgs/a/build/z.js');
    write('build/package.json', '{}');
    write('build/src/x.ts');
    write('build/dist/out.js'); // the package's own output is still skipped
    write('pkgs/dist/pubspec.yaml', 'name: d');
    write('pkgs/dist/lib/d.dart');
    write('a-b.ts');
    write('a/c.ts');
    expect(listFiles(root)).toEqual(['a/c.ts', 'a-b.ts', 'build/package.json', 'build/src/x.ts', 'pkgs/dist/lib/d.dart', 'pkgs/dist/pubspec.yaml']);
  });

  it('in a git checkout: tracked + untracked-not-ignored files, .gitignore decides build output', () => {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: root, stdio: 'ignore' });
    };
    git('init', '-q');
    write('.gitignore', 'dist/\n*.log\n');
    write('dist/index.js'); // ignored output
    write('packages/build/package.json', '{"name":"@acme/vite-build"}');
    write('packages/build/src/index.ts');
    write('packages/build/dist/out.js'); // ignored by the dist/ pattern at any depth
    write('vendor/lib/x.ts'); // not a name skip in a checkout
    write('debug.log');
    write('gone.ts');
    write('a-b.ts');
    write('a/c.ts');
    git('add', '.gitignore', 'packages', 'gone.ts', 'a');
    rmSync(join(root, 'gone.ts')); // tracked, deleted from the work tree
    write('untracked.ts'); // untracked, not ignored
    write('node_modules/m/index.js');
    // Package-manager / build-tool state, tracked or not: never scanned (invertase's .nx/cache).
    for (const d of ['.nx/cache/1/lib/index.js', '.turbo/cache/x.js', '.yarn/plugins/p.cjs', 'packages/build/.pnpm-store/v3/f.js']) write(d);
    git('add', '-f', '.yarn');
    expect(listFiles(root)).toEqual([
      '.gitignore', 'a/c.ts', 'a-b.ts', 'packages/build/package.json', 'packages/build/src/index.ts', 'untracked.ts', 'vendor/lib/x.ts',
    ]);
  });

  it('ALWAYS_SKIP_DIRS holds installed deps, VCS metadata and package-manager / build-tool state', () => {
    expect([...ALWAYS_SKIP_DIRS].sort()).toEqual(['.dart_tool', '.git', '.nx', '.pnpm-store', '.turbo', '.yarn', 'node_modules']);
    for (const d of ['.nx', '.turbo', '.yarn', '.pnpm-store']) write(`${d}/x/package.json`, '{"name": "cached"}');
    write('pkgs/a/src/x.ts');
    expect(listFiles(root)).toEqual(['pkgs/a/src/x.ts']);
  });
});

describe('ignored manifest dirs', () => {
  it('the default list covers test-data dirs (test_fixtures, testdata, goldens, …)', () => {
    for (const d of ['test_fixtures', 'test_fixture', 'testdata', 'test_data', 'golden', 'goldens', 'fixtures', '__fixtures__', 'test', 'testing', 'test_packages']) {
      expect(DEFAULT_IGNORE_MANIFEST_DIRS, d).toContain(d);
    }
  });

  it('readRepoManifestsWithIgnored returns skipped manifests with their deps; malformed ones only warn', () => {
    pkgJson('package.json', { name: 'real', main: 'src/index.ts' });
    write('src/index.ts');
    pkgJson('examples/demo/package.json', {
      name: 'demo', dependencies: { real: '^1' }, peerDependencies: { real: '^2' }, devDependencies: { vitest: '^1' },
    });
    write('templates/app/pubspec.yaml', 'name: app\ndependencies:\n  real_pub:\n    path: ../..\ndev_dependencies:\n  test: any\n');
    write('fixtures/bad/package.json', '{ nope');
    pkgJson('gen/x/package.json', { dependencies: { real: '*' } });
    const r = readRepoManifestsWithIgnored(root, warn, listFiles(root), { ignoreManifest: (m) => m.startsWith('gen/') });
    expect(r.packages.map((p) => p.name)).toEqual(['real']);
    expect(r.ignored).toEqual([
      { path: 'examples/demo', manifest: 'examples/demo/package.json', manager: 'npm', name: 'demo', depsUnknown: false, byDir: true, consumerDir: true, deps: [
        { name: 'real', manager: 'npm', constraint: '^1' },
        { name: 'vitest', manager: 'npm', constraint: '^1', dev: true },
      ] },
      { path: 'fixtures/bad', manifest: 'fixtures/bad/package.json', manager: 'npm', name: null, deps: [], depsUnknown: true, byDir: true },
      { path: 'gen/x', manifest: 'gen/x/package.json', manager: 'npm', name: null, depsUnknown: false, deps: [
        { name: 'real', manager: 'npm', constraint: '*' },
      ] },
      { path: 'templates/app', manifest: 'templates/app/pubspec.yaml', manager: 'pub', name: 'app', depsUnknown: false, byDir: true, deps: [
        { name: 'real_pub', manager: 'pub', constraint: 'path:../..' },
        { name: 'test', manager: 'pub', constraint: 'any', dev: true },
      ] },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^fixtures\/bad\/package\.json \(ignored manifest\): cannot parse: .*; its deps are unknown$/);
    expect(readRepoManifests(root, () => {}, listFiles(root), { ignoreManifest: (m) => m.startsWith('gen/') })).toEqual(r.packages);
  });

  it('manifests under default ignore dirs (any depth) are skipped with one log line; their files are still listed', () => {
    pkgJson('package.json', { name: 'real', main: 'src/index.ts' });
    write('src/index.ts');
    for (const d of DEFAULT_IGNORE_MANIFEST_DIRS) pkgJson(`pkgs/${d}/x/package.json`, { name: `dup-${d}` });
    write('templates/vercel/pubspec.yaml', 'name: real\n');
    write('templates/vercel/lib/a.dart');
    write('examples/basic/src/main.ts');
    pkgJson('packages/testing/package.json', { name: 'testing' }); // ignored name, but a packages/ member
    write('packages/testing/index.ts');
    const logs: string[] = [];
    const pkgs = readRepoManifests(root, warn, listFiles(root), { log: (l) => logs.push(l) });
    expect(pkgs.map((p) => p.name)).toEqual(['real', 'testing']);
    expect(logs).toEqual([
      `skipped ${DEFAULT_IGNORE_MANIFEST_DIRS.length + 1} manifest(s) as not org packages (ignoreManifestDirs/ignoreManifests): `
        + 'pkgs/.mason/x/package.json, pkgs/__brick__/x/package.json, pkgs/__fixtures__/x/package.json, ...',
    ]);
    expect(warnings).toEqual([]);
    const files = listFiles(root);
    expect(files).toContain('templates/vercel/lib/a.dart');
    expect(files).toContain('examples/basic/src/main.ts');
    expect(files).toContain('pkgs/fixtures/x/package.json');
  });

  it('a manifest directly inside an ignore dir is skipped too; the file name itself is not a dir segment', () => {
    pkgJson('test/package.json', { name: 't' });
    pkgJson('example/package.json', { name: 'e' });
    expect(readRepoManifests(root, warn)).toEqual([]);
  });

  it('a package dir named like an ignore dir is kept when it is a monorepo member (pkgs/test, npm workspace packages/example)', () => {
    write('pubspec.yaml', 'name: _\npublish_to: none\nworkspace:\n  - pkgs/test\n  - pkgs/checks\n');
    write('pkgs/test/pubspec.yaml', 'name: test\nresolution: workspace\n');
    write('pkgs/test/lib/test.dart');
    write('pkgs/checks/pubspec.yaml', 'name: checks\nresolution: workspace\n');
    write('pkgs/checks/lib/checks.dart');
    write('pkgs/checks/example/pubspec.yaml', 'name: checks_example\n'); // a package's example app
    write('pkgs/checks/test/fixtures/pubspec.yaml', 'name: fx\n'); // ancestor `test`
    write('foo/test/fixtures/pubspec.yaml', 'name: fx2\n');
    pkgJson('js/package.json', { name: 'js-root', private: true, workspaces: ['packages/*'] });
    pkgJson('js/packages/example/package.json', { name: 'js-example', main: 'index.js' });
    write('js/packages/example/index.js');
    const r = readRepoManifestsWithIgnored(root, warn, listFiles(root));
    expect(r.packages.map((p) => p.manifest)).toEqual([
      'pubspec.yaml', 'js/package.json', 'js/packages/example/package.json', 'pkgs/checks/pubspec.yaml', 'pkgs/test/pubspec.yaml',
    ]);
    expect(r.ignored.map((m) => m.manifest)).toEqual([
      'foo/test/fixtures/pubspec.yaml', 'pkgs/checks/example/pubspec.yaml', 'pkgs/checks/test/fixtures/pubspec.yaml',
    ]);
  });

  it('a pub example app stays ignored even when the workspace lists it; a workspace member outside a package dir is kept', () => {
    write('pubspec.yaml', 'name: real\nworkspace:\n  - example # the example app\n  - "tools/*"\n  - pkgs/a/example\n');
    write('lib/real.dart');
    write('example/pubspec.yaml', 'name: real_example\nresolution: workspace\n');
    write('pkgs/a/pubspec.yaml', 'name: a\n');
    write('pkgs/a/example/pubspec.yaml', 'name: a_example\nresolution: workspace\n');
    write('pkgs/a/example/test_data/x/pubspec.yaml', 'name: data\nresolution: workspace\n'); // ancestor wins over membership
    write('tools/test/pubspec.yaml', 'name: test_tool\nresolution: workspace\n');
    write('tools/bench/pubspec.yaml', 'name: bench_tool\n'); // member by the `tools/*` glob alone
    write('other/example/pubspec.yaml', 'name: not_member\n'); // leaf match, not a member
    const r = readRepoManifestsWithIgnored(root, warn, listFiles(root));
    expect(r.packages.map((p) => p.manifest)).toEqual(['pubspec.yaml', 'pkgs/a/pubspec.yaml', 'tools/bench/pubspec.yaml', 'tools/test/pubspec.yaml']);
    expect(r.ignored.map((m) => m.manifest)).toEqual([
      'example/pubspec.yaml', 'other/example/pubspec.yaml', 'pkgs/a/example/pubspec.yaml', 'pkgs/a/example/test_data/x/pubspec.yaml',
    ]);
  });

  it('testing/ fixture packages (dartdoc) are ignored; a workspace member named testing is kept', () => {
    write('pubspec.yaml', 'name: dartdoc\nworkspace:\n  - tools/testing\n');
    write('lib/dartdoc.dart');
    write('testing/test_package/pubspec.yaml', 'name: test_package\n');
    write('testing/test_package/lib/a.dart');
    write('testing/test_package_bad/pubspec.yaml', 'name: test_package_bad\n');
    write('testing/pubspec.yaml', 'name: testing_root\n'); // leaf match, not a member
    write('tools/testing/pubspec.yaml', 'name: testing_tool\nresolution: workspace\n');
    write('pkgs/testing/pubspec.yaml', 'name: testing_pkg\n');
    write('pkgs/foo/test_packages/p/pubspec.yaml', 'name: p\n');
    const r = readRepoManifestsWithIgnored(root, warn, listFiles(root));
    expect(r.packages.map((p) => p.name)).toEqual(['dartdoc', 'testing_pkg', 'testing_tool']);
    expect(r.ignored.map((m) => m.manifest)).toEqual([
      'pkgs/foo/test_packages/p/pubspec.yaml', 'testing/pubspec.yaml',
      'testing/test_package/pubspec.yaml', 'testing/test_package_bad/pubspec.yaml',
    ]);
  });

  it('isIgnoredManifestPath: ancestors always, the leaf unless a monorepo member', () => {
    const dirs = new Set(DEFAULT_IGNORE_MANIFEST_DIRS);
    expect(isIgnoredManifestPath('pubspec.yaml', dirs)).toBe(false);
    expect(isIgnoredManifestPath('example/pubspec.yaml', dirs)).toBe(true);
    expect(isIgnoredManifestPath('foo/test/fixtures/pubspec.yaml', dirs)).toBe(true);
    expect(isIgnoredManifestPath('pkgs/test/pubspec.yaml', dirs)).toBe(false);
    expect(isIgnoredManifestPath('packages/example/package.json', dirs)).toBe(false);
    expect(isIgnoredManifestPath('pkgs/test/x/pubspec.yaml', dirs)).toBe(true);
    expect(isIgnoredManifestPath('tool/test/pubspec.yaml', dirs, () => true, () => false)).toBe(false);
    expect(isIgnoredManifestPath('tool/test/pubspec.yaml', dirs, () => true, () => true)).toBe(true);
    expect(isIgnoredManifestPath('pkgs/x/test/y/pubspec.yaml', dirs, () => true, () => false)).toBe(true);
  });

  it('pubWorkspaceEntries reads block and flow lists; workspaceMembership resolves them relative to the declaring manifest', () => {
    expect(pubWorkspaceEntries('name: x\nworkspace:\n  - a # c\n  - \'b/*\'\n\n  # gap\n  - "c"\ndev_dependencies:\n  - z\n')).toEqual(['a', 'b/*', 'c']);
    expect(pubWorkspaceEntries('workspace: [a, "b"]\n')).toEqual(['a', 'b']);
    expect(pubWorkspaceEntries('name: x\n')).toEqual([]);
    write('sub/pubspec.yaml', 'name: s\nworkspace:\n  - pkgs/*\n');
    pkgJson('web/package.json', { name: 'w', workspaces: { packages: ['apps/*', '!apps/skip'] } });
    write('lone/pubspec.yaml', 'name: l\nresolution: workspace\n');
    const member = workspaceMembership(root, listFiles(root));
    expect(['sub/pkgs/a', 'web/apps/b', 'lone'].map(member)).toEqual([true, true, true]);
    expect(['pkgs/a', 'sub/pkgs/a/b', 'web/apps', 'sub'].map(member)).toEqual([false, false, false, false]);
  });

  it('ignoreDirs replaces the default list; ignoreManifest rejects single manifests', () => {
    pkgJson('fixtures/a/package.json', { name: 'a' });
    pkgJson('gen/b/package.json', { name: 'b' });
    pkgJson('c/package.json', { name: 'c' });
    const logs: string[] = [];
    const pkgs = readRepoManifests(root, warn, listFiles(root), {
      ignoreDirs: ['gen'], ignoreManifest: (m) => m === 'c/package.json', log: (l) => logs.push(l),
    });
    expect(pkgs.map((p) => p.name)).toEqual(['a']);
    expect(logs).toEqual(['skipped 2 manifest(s) as not org packages (ignoreManifestDirs/ignoreManifests): c/package.json, gen/b/package.json']);
    expect(readRepoManifests(root, warn, listFiles(root), { ignoreDirs: [] }).map((p) => p.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('VS Code extension manifests', () => {
  it('a package.json with engines.vscode is not an org package: recorded as ignored, one log line', () => {
    pkgJson('package.json', { name: 'real', main: 'src/index.ts' });
    write('src/index.ts');
    pkgJson('packages/vscode/package.json', {
      name: 'hono-vscode', main: './out/extension.js', engines: { vscode: '^1.80.0', node: '>=18' }, dependencies: { real: '^1' },
    });
    pkgJson('packages/tool/package.json', { name: 'tool', engines: { node: '>=18' } });
    write('packages/tool/index.ts');
    const logs: string[] = [];
    const r = readRepoManifestsWithIgnored(root, warn, listFiles(root), { log: (l) => logs.push(l) });
    expect(r.packages.map((p) => p.name)).toEqual(['real', 'tool']);
    expect(r.ignored).toEqual([
      { path: 'packages/vscode', manifest: 'packages/vscode/package.json', manager: 'npm', name: 'hono-vscode', depsUnknown: false,
        deps: [{ name: 'real', manager: 'npm', constraint: '^1' }] },
    ]);
    expect(logs).toEqual(['skipped 1 VS Code extension manifest(s) (engines.vscode) as not org packages: packages/vscode/package.json']);
    expect(warnings).toEqual([]);
  });
});

describe('isLibrary (manifest shape: library vs runtime app)', () => {
  it('npm: exports/types/typings/module make a library; main/bin only is an app', () => {
    const shapes: Record<string, Record<string, unknown>> = {
      worker: { main: 'src/index.ts' },
      cli: { bin: { x: 'src/index.ts' } },
      exp: { exports: { '.': './src/index.ts' } },
      types: { main: 'src/index.ts', types: 'src/index.ts' },
      typings: { typings: 'src/index.ts' },
      mod: { module: 'src/index.ts' },
    };
    for (const [n, fields] of Object.entries(shapes)) {
      pkgJson(`p/${n}/package.json`, { name: n, ...fields });
      write(`p/${n}/src/index.ts`);
    }
    const lib = Object.fromEntries(readRepoManifests(root, warn).map((p) => [p.name, p.isLibrary]));
    expect(lib).toEqual({ worker: false, cli: false, exp: true, types: true, typings: true, mod: true });
  });

  it('pub: a library iff lib/ holds a .dart file directly', () => {
    write('a/pubspec.yaml', 'name: a\n');
    write('a/lib/a.dart');
    write('b/pubspec.yaml', 'name: b\n');
    write('b/bin/main.dart');
    write('b/lib/src/only_nested.dart');
    const lib = Object.fromEntries(readRepoManifests(root, warn).map((p) => [p.name, p.isLibrary]));
    expect(lib).toEqual({ a: true, b: false });
  });
});

describe('npm manifests', () => {
  it('resolves main/module/types to existing files, relative to the repo root', () => {
    pkgJson('packages/core/package.json', { name: '@acme/core', version: '2.0.0', main: './src/index.ts', types: 'src/index.ts', module: 'missing.js' });
    write('packages/core/src/index.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p).toMatchObject({ manager: 'npm', name: '@acme/core', version: '2.0.0', path: 'packages/core', manifest: 'packages/core/package.json' });
    expect(p!.entryPoints).toEqual(['packages/core/src/index.ts']);
  });

  it('collects every exports leaf across conditions, nesting, and arrays; ignores null and non-code', () => {
    pkgJson('package.json', {
      name: 'x',
      exports: {
        '.': { import: { types: './src/index.d.ts', default: './src/index.mjs' }, require: './src/index.cjs' },
        './a': ['./src/a.js', './src/a-fallback.js'],
        './internal': null,
        './package.json': './package.json',
      },
    });
    for (const f of ['src/index.d.ts', 'src/index.mjs', 'src/index.cjs', 'src/a.js', 'src/a-fallback.js']) write(f);
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/a-fallback.js', 'src/a.js', 'src/index.cjs', 'src/index.d.ts', 'src/index.mjs']);
  });

  it('accepts a string exports sugar', () => {
    pkgJson('package.json', { name: 'x', exports: './lib.js' });
    write('lib.js');
    expect(readRepoManifests(root, warn)[0]!.entryPoints).toEqual(['lib.js']);
  });

  it('resolves * patterns in exports against the filesystem (slashes included)', () => {
    pkgJson('package.json', { name: 'x', exports: { '.': './src/index.ts', './features/*': './src/features/*.ts' } });
    write('src/index.ts');
    write('src/features/a.ts');
    write('src/features/deep/b.ts');
    write('src/features/c.js');
    write('src/other.ts');
    expect(readRepoManifests(root, warn)[0]!.entryPoints).toEqual(['src/features/a.ts', 'src/features/deep/b.ts', 'src/index.ts']);
  });

  it('maps dist-style * patterns to src when dist does not exist', () => {
    pkgJson('package.json', { name: 'x', exports: { './*': { types: './dist/*.d.ts', import: './dist/*.js' } } });
    write('src/a.ts');
    write('src/b.tsx');
    expect(readRepoManifests(root, warn)[0]!.entryPoints).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('bin as an object and as a string (runtime entry points only, never surface), browser only if a string', () => {
    pkgJson('a/package.json', { name: 'a', bin: { one: './cli/one.js', two: 'cli/two' }, browser: { './x.js': false } });
    write('a/cli/one.js');
    write('a/cli/two');
    write('a/x.js');
    pkgJson('b/package.json', { name: 'b', bin: 'cli.mjs', browser: 'browser.js' });
    write('b/cli.mjs');
    write('b/browser.js');
    const [a, b] = readRepoManifests(root, warn);
    expect(a!.entryPoints).toEqual([]);
    expect(a!.runtimeEntryPoints).toEqual(['a/cli/one.js', 'a/cli/two']);
    expect(b!.entryPoints).toEqual(['b/browser.js']);
    expect(b!.runtimeEntryPoints).toEqual(['b/cli.mjs']);
    expect(warnings).toEqual([]); // a bin is an entry point: no "no entry points" warning, no index fallback
  });

  it('maps dist/lib/build/out paths to src .ts/.tsx when the built file is absent', () => {
    pkgJson('package.json', {
      name: 'x', main: 'dist/index.js', types: 'dist/index.d.ts', module: './lib/esm/mod.mjs', bin: { c: 'out/cli.cjs' },
      exports: { './ui': './build/ui.js' },
    });
    write('src/index.ts');
    write('src/esm/mod.ts');
    write('src/cli.ts');
    write('src/ui.tsx');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/esm/mod.ts', 'src/index.ts', 'src/ui.tsx']);
    expect(p!.runtimeEntryPoints).toEqual(['src/cli.ts']); // the bin
  });

  it('dist→src also tries index variants: dist/vue.mjs → src/vue/index.ts, dist/x/index.js → src/x.ts', () => {
    pkgJson('package.json', {
      name: 'x',
      exports: {
        '.': './dist/index.mjs',
        './vue': { types: './dist/vue.d.mts', import: './dist/vue.mjs' },
        './react': './dist/react/index.js',
        './plugins/*': './dist/plugins/*.mjs',
        // db0: the index group matches, so the parent group (src/integrations/*.ts, whose
        // `*` would also catch drizzle/_utils.ts) is not tried.
        './integrations/*': './dist/integrations/*/index.mjs',
      },
    });
    write('src/index.ts');
    write('src/vue/index.ts');
    write('src/react.tsx');
    write('src/plugins/a/index.ts');
    write('src/integrations/drizzle/index.ts');
    write('src/integrations/drizzle/_utils.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual([
      'src/index.ts', 'src/integrations/drizzle/index.ts', 'src/plugins/a/index.ts', 'src/react.tsx', 'src/vue/index.ts',
    ]);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('resolves built output to the TypeScript source beside it (recast: main.js / main.d.ts → main.ts)', () => {
    pkgJson('package.json', { name: 'recast', main: 'main.js', types: 'main.d.ts', module: 'lib/esm.mjs' });
    write('main.ts');
    write('lib/esm.mts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['lib/esm.mts', 'main.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('records code-looking main/module/types/exports leaves that resolve to nothing (not bin, not non-code)', () => {
    pkgJson('package.json', {
      name: 'x',
      main: './dist/index.cjs',
      types: './dist/gone.d.ts',
      bin: { x: './dist/cli.mjs' },
      exports: {
        '.': './dist/index.mjs',
        './vue': './dist/vue.mjs',
        './pkg': './package.json',
        './styles': './dist/styles.css',
        './gone/*': './dist/gone/*.js',
      },
    });
    write('src/index.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual(['./dist/gone.d.ts', './dist/gone/*.js', './dist/vue.mjs']);
  });

  it('an exports entry is unresolved only when none of its conditions resolves (hono require → dist/cjs)', () => {
    pkgJson('package.json', {
      name: 'hono',
      exports: {
        '.': { types: './dist/types/index.d.ts', import: './dist/index.js', require: './dist/cjs/index.js' },
        './jsx': { import: './dist/jsx/index.js', require: './dist/cjs/jsx/index.js' },
        './gone': { import: './dist/gone.js', require: './dist/cjs/gone.js' },
        './adapter/*': { import: './dist/adapter/*/index.js', require: './dist/cjs/adapter/*/index.js' },
      },
    });
    write('src/index.ts');
    write('src/jsx/index.ts');
    write('src/adapter/bun/index.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/adapter/bun/index.ts', 'src/index.ts', 'src/jsx/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual(['./dist/cjs/gone.js', './dist/gone.js']);
  });

  it('* patterns never match dotfiles, node_modules, build output or non-code files (scule "./*": "./*")', () => {
    pkgJson('package.json', { name: 'scule', exports: { '.': './src/index.ts', './*': './*', './d/*': './dist/*.js' } });
    for (const f of ['src/index.ts', 'src/extra.ts', 'LICENSE', '.eslintrc', '.github/x.js', 'README.md', 'dist/built.js', 'build/b.js']) write(f);
    // A git checkout (so the committed dist/ and build/ are listed): a build dir is matched
    // only by a pattern that starts there.
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root, stdio: 'ignore' });
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['dist/built.js', 'src/extra.ts', 'src/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('a conditions-object exports (no subpath keys) is one entry', () => {
    pkgJson('package.json', { name: 'x', exports: { import: './dist/index.mjs', require: './dist/cjs/index.cjs' } });
    write('src/index.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('maps dist/x.d.mts / .d.cts / .d.ts declaration leaves to src/x.ts or src/x.d.ts (vite-dev-server ./types)', () => {
    pkgJson('package.json', {
      name: 'x',
      exports: {
        '.': './dist/index.mjs',
        './types': { types: './dist/types.d.mts' },
        './env': { types: './dist/env.d.cts' },
        './glob': { types: './dist/glob.d.ts' },
      },
    });
    write('src/index.ts');
    write('src/types.d.ts');
    write('src/env.ts');
    write('src/glob.d.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/env.ts', 'src/glob.d.ts', 'src/index.ts', 'src/types.d.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('maps entries under each tsconfig outDir to its rootDir (supabase auth-js: dist/main + dist/module, rootDir src)', () => {
    pkgJson('packages/auth/package.json', {
      name: '@x/auth', main: 'dist/main/index.js', module: 'dist/module/index.js', types: 'dist/module/index.d.ts',
      exports: { './lib/*': './dist/module/lib/*.js' },
    });
    write('tsconfig.base.json', '{ "compilerOptions": { "strict": true } }');
    // JSONC: comments and trailing commas, as tsc accepts them.
    write('packages/auth/tsconfig.json', `{
      // CommonJS build
      "extends": "../../tsconfig.base.json",
      "include": ["src"],
      "compilerOptions": { "outDir": "dist/main", "rootDir": "src", /* sources */ "module": "CommonJS", },
    }`);
    // Inherits rootDir from ./tsconfig (extends without .json).
    write('packages/auth/tsconfig.module.json', '{ "extends": "./tsconfig", "compilerOptions": { "outDir": "dist/module" } }');
    write('packages/auth/tsconfig.test.json', '{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": ".", "outDir": "dist/test" } }');
    write('packages/auth/src/index.ts');
    write('packages/auth/src/lib/helpers.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['packages/auth/src/index.ts', 'packages/auth/src/lib/helpers.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('tsconfigOutDirs: extends chains, paths relative to the defining config, defaults and drops', () => {
    write('configs/base.json', '{ "compilerOptions": { "outDir": "../pkg/build/cjs", "rootDir": "../pkg/lib" } }');
    write('pkg/tsconfig.json', '{ "extends": "../configs/base.json" }'); // outDir/rootDir from the base's dir
    write('pkg/tsconfig.esm.json', '{ "extends": ["./tsconfig.json"], "compilerOptions": { "outDir": "build/esm" } }');
    write('pkg/tsconfig.inc.json', '{ "include": ["source"], "compilerOptions": { "outDir": "out" } }'); // rootDir = the include dir
    write('pkg/tsconfig.none.json', '{ "compilerOptions": { "outDir": "o2" } }'); // no src/: package dir
    write('pkg/tsconfig.escape.json', '{ "compilerOptions": { "outDir": "../elsewhere" } }'); // leaves the package
    write('pkg/tsconfig.same.json', '{ "compilerOptions": { "outDir": "lib", "rootDir": "lib" } }'); // outDir == rootDir
    write('pkg/tsconfig.pkgname.json', '{ "extends": "@tsconfig/node20/tsconfig.json" }'); // no outDir anywhere
    write('pkg/tsconfig.broken.json', '{ "compilerOptions": { "outDir": ');
    write('pkg/tsconfig.cycle.json', '{ "extends": "./tsconfig.cycle.json", "compilerOptions": { "outDir": "c" } }');
    write('pkg/nested/tsconfig.json', '{ "compilerOptions": { "outDir": "zzz" } }'); // not at the package root
    const files = listFiles(root).filter((f) => f.startsWith('pkg/')).map((f) => f.slice(4));
    expect(tsconfigOutDirs(root, 'pkg', files)).toEqual([
      { outDir: 'build/cjs', rootDir: 'lib', config: 'tsconfig.json' },
      { outDir: 'build/esm', rootDir: 'lib', config: 'tsconfig.esm.json' },
      { outDir: 'out', rootDir: 'source', config: 'tsconfig.inc.json' },
      { outDir: 'o2', rootDir: '', config: 'tsconfig.none.json' },
      { outDir: 'c', rootDir: '', config: 'tsconfig.cycle.json' },
    ]);
    expect(stripJsonc('{"a": "// not a comment", /* c */ "b": [1, 2,], } // end')).toBe('{"a": "// not a comment",   "b": [1, 2] } \n');
  });

  it('sourceForBuildOutput: a deep dist import path to its source (supabase dist/module/lib/types)', () => {
    pkgJson('pkgs/sb/package.json', { name: '@x/sb', main: 'dist/main/index.js' });
    write('pkgs/sb/tsconfig.json', '{ "compilerOptions": { "outDir": "dist/main", "rootDir": "src" } }');
    write('pkgs/sb/tsconfig.module.json', '{ "extends": "./tsconfig.json", "compilerOptions": { "outDir": "dist/module" } }');
    write('pkgs/sb/src/index.ts');
    write('pkgs/sb/src/lib/types.ts');
    write('pkgs/sb/src/lib/helpers/index.ts');
    // No tsconfig names dist/esm: the one-segment strip.
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/module/lib/types')).toBe('src/lib/types.ts');
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/main/lib/types.d.ts')).toBe('src/lib/types.ts');
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/esm/lib/types.js')).toBe('src/lib/types.ts');
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/module/lib/helpers')).toBe('src/lib/helpers/index.ts');
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/module/lib/gone')).toBeNull();
    // Several leading segments may go, but never down to a bare index (lib-dual's
    // `@acme/dual-legacy/dist/esm/internal/gone` stays without a source).
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/esm/internal/gone')).toBeNull();
    // ... nor through a dropped format dir (`dist/esm/gone/index.js` → `dist/gone/index.js`).
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/esm/gone')).toBeNull();
    expect(sourceForBuildOutput(root, 'pkgs/sb', 'dist/esm/extra/lib/types.js')).toBe('src/lib/types.ts');
    expect(sourceForBuildOutput(root, 'pkgs/sb', '../escape')).toBeNull();
  });

  it('a build dir named for one target: dist-electron/ → src/electron/, then electron/, then src/ (marlo)', () => {
    pkgJson('desktop/package.json', { name: '@workspace/desktop', private: true, main: 'dist-electron/main.js' });
    write('desktop/src/electron/main.ts');
    write('desktop/src/electron/preload.ts');
    write('desktop/src/pages/index.astro');
    write('desktop/renderer/app.js');
    write('desktop/src/worker.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.unresolvedEntryPoints).toEqual([]);
    expect(p!.entryPoints).toContain('desktop/src/electron/main.ts');
    expect(sourceForBuildOutput(root, 'desktop', 'dist-electron/preload.js')).toBe('src/electron/preload.ts');
    expect(sourceForBuildOutput(root, 'desktop', 'build-renderer/app.js')).toBe('renderer/app.js');
    expect(sourceForBuildOutput(root, 'desktop', 'renderer-dist/app.js')).toBe('renderer/app.js');
    expect(sourceForBuildOutput(root, 'desktop', 'out-worker/worker.js')).toBe('src/worker.ts');
    // Existence-checked: a leaf with no source anywhere stays unresolved; a dir that only
    // looks like one (`distribution/`, `dist-/`) is not a named build dir.
    expect(sourceForBuildOutput(root, 'desktop', 'dist-electron/gone.js')).toBeNull();
    expect(sourceForBuildOutput(root, 'desktop', 'distribution/main.js')).toBeNull();
    expect(sourceForBuildOutput(root, 'desktop', 'dist-/main.js')).toBeNull();
    pkgJson('other/package.json', { name: 'other', main: 'dist-electron/main.js' });
    write('other/src/main.js');
    const q = readRepoManifests(root, warn).find((x) => x.name === 'other');
    // `src/main.js` is JavaScript: another target's code, not the electron build's source.
    expect(q!.unresolvedEntryPoints).toEqual(['dist-electron/main.js']);
  });

  it('sourceForBuildOutput: a nested build dir maps to the src beside it (Expo plugin/build → plugin/src)', () => {
    pkgJson('ads/package.json', { name: '@x/ads', main: 'lib/commonjs/index.js', 'react-native': 'src/index.ts' });
    write('ads/src/index.ts');
    write('ads/plugin/src/index.ts');
    write('ads/tools/gen/src/run.ts');
    expect(sourceForBuildOutput(root, 'ads', 'plugin/build')).toBe('plugin/src/index.ts');
    expect(sourceForBuildOutput(root, 'ads', 'plugin/build/index.js')).toBe('plugin/src/index.ts');
    expect(sourceForBuildOutput(root, 'ads', 'tools/gen/dist/run.js')).toBe('tools/gen/src/run.ts');
    // Existence-checked; `lib/` nested is a source dir name as often as a build dir.
    expect(sourceForBuildOutput(root, 'ads', 'plugin/build/gone.js')).toBeNull();
    expect(sourceForBuildOutput(root, 'ads', 'other/build')).toBeNull();
    write('ads/tools/lib/src/x.ts');
    expect(sourceForBuildOutput(root, 'ads', 'tools/lib/x.js')).toBeNull();
  });

  it('an Expo config plugin: app.plugin.js and the source of the plugin/build it requires are runtime entries', () => {
    pkgJson('applovin/package.json', {
      name: '@x/applovin', main: 'lib/commonjs/index.js', 'react-native': 'src/index.ts',
      exports: { '.': { source: './src/index.ts', default: './lib/commonjs/index.js' }, './app.plugin.js': './app.plugin.js' },
      devDependencies: { '@expo/config-plugins': '^54.0.0' },
    });
    write('applovin/app.plugin.js', "module.exports = require('./plugin/out');\n");
    // The plugin's own tsconfig names another output dir: the rootDir index is found through it.
    write('applovin/plugin/tsconfig.json', '{ "extends": "expo-module-scripts/tsconfig.plugin", "compilerOptions": { "outDir": "out", "rootDir": "lib" } }');
    write('applovin/plugin/lib/index.ts');
    write('applovin/src/index.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.unresolvedEntryPoints).toEqual([]);
    expect(p!.entryPoints).toEqual(['applovin/app.plugin.js', 'applovin/plugin/lib/index.ts', 'applovin/src/index.ts']);
    // app.plugin.js is surface (an exports leaf) AND loaded by Expo, like a Firebase main.
    expect(p!.runtimeEntryPoints).toEqual(['applovin/app.plugin.js', 'applovin/plugin/lib/index.ts']);
  });

  it('no Expo config plugin: an expo dependency alone, or app.plugin.js requiring a missing build, adds nothing else', () => {
    pkgJson('a/package.json', { name: 'a', main: 'src/index.ts', dependencies: { expo: '^54.0.0' } });
    write('a/src/index.ts');
    write('a/plugin/src/index.ts');
    pkgJson('b/package.json', { name: 'b', main: 'src/index.ts' });
    write('b/src/index.ts');
    write('b/app.plugin.js', "module.exports = require('./plugin/build');\n");
    const [a, b] = readRepoManifests(root, warn);
    expect(a!.runtimeEntryPoints).toEqual([]);
    expect(b!.runtimeEntryPoints).toEqual(['b/app.plugin.js']);
    expect(b!.entryPoints).toEqual(['b/app.plugin.js', 'b/src/index.ts']);
  });

  it('a tsconfig rootDir other than src, allowJs sources, and .mjs → .mts', () => {
    pkgJson('package.json', { name: 'x', main: 'out/cjs/main.js', exports: { './m': './out/esm/m.mjs', './j': './out/esm/j.js' } });
    write('tsconfig.json', '{ "compilerOptions": { "outDir": "out/cjs", "rootDir": "lib", "allowJs": true } }');
    write('tsconfig.esm.json', '{ "extends": "./tsconfig.json", "compilerOptions": { "outDir": "out/esm" } }');
    write('lib/main.ts');
    write('lib/m.mts');
    write('lib/j.js');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['lib/j.js', 'lib/m.mts', 'lib/main.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('without a tsconfig mapping, strips one leading output segment: dist/<seg>/x.js → src/x.ts', () => {
    pkgJson('package.json', {
      name: 'x', main: 'dist/main/index.js', module: 'lib/esm/index.mjs', types: 'dist/types/api.d.ts',
      exports: { './react': './dist/react/index.js' },
    });
    write('src/index.ts');
    write('src/api.ts');
    // src/react/ exists (a subpath dir): dist/react/index.js must not become src/index.ts.
    write('src/react/other.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/api.ts', 'src/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual(['./dist/react/index.js']);
  });

  it('react-native-builder-bob: format dirs are dropped and `source` / `react-native` cover the top-level build fields', () => {
    // invertase react-native-google-mobile-ads packages/core.
    pkgJson('core/package.json', {
      name: 'rngma', main: 'lib/commonjs/index.js', module: 'lib/module/index.js', types: 'lib/typescript/commonjs/index.d.ts',
      'react-native': 'src/index.ts', source: 'src/index.ts',
      exports: { '.': {
        'react-native': { types: './lib/typescript/module/index.d.ts', default: './src/index.ts' },
        import: { types: './lib/typescript/module/index.d.ts', default: './lib/module/index.js' },
        require: { types: './lib/typescript/commonjs/index.d.ts', default: './lib/commonjs/index.js' },
      } },
    });
    write('core/src/index.ts');
    // react-native-coverage: `lib/typescript/src/index.d.ts` (tsc rootDir = the package).
    pkgJson('cov/package.json', { name: 'cov', main: './lib/module/index.js', types: './lib/typescript/src/index.d.ts', exports: { './node': { types: './lib/typescript/src/node.d.ts', default: './lib/module/node.js' } } });
    write('cov/src/index.tsx');
    write('cov/src/node.ts');
    // A top-level field whose source is really missing stays unresolved without a `source`.
    pkgJson('gone/package.json', { name: 'gone', main: 'lib/commonjs/index.js', types: 'lib/typescript/commonjs/gone.d.ts' });
    write('gone/src/index.ts');
    // ... but a resolving `source` covers it (it is a build of that source).
    pkgJson('src-only/package.json', { name: 'src-only', source: 'src/main.ts', types: 'lib/typescript/whatever.d.ts' });
    write('src-only/src/main.ts');
    const pkgs = readRepoManifests(root, warn);
    const by = (n: string) => pkgs.find((p) => p.name === n)!;
    expect(by('rngma').entryPoints).toEqual(['core/src/index.ts']);
    expect(by('rngma').unresolvedEntryPoints).toEqual([]);
    expect(by('cov').entryPoints).toEqual(['cov/src/index.tsx', 'cov/src/node.ts']);
    expect(by('cov').unresolvedEntryPoints).toEqual([]);
    expect(by('gone').unresolvedEntryPoints).toEqual(['lib/typescript/commonjs/gone.d.ts']);
    expect(by('src-only').entryPoints).toEqual(['src-only/src/main.ts']);
    expect(by('src-only').unresolvedEntryPoints).toEqual([]);
  });

  it('nested build outputs: format dirs anywhere, several leading segments, a src/ under the output dir', () => {
    // tanstack react-start `./dist/default-entry/esm/server.js`, react-start-rsc
    // `dist/esm/src/index.d.ts`, devtools-utils `./dist/react/esm/index.js`.
    pkgJson('package.json', {
      name: 'x', types: 'dist/esm/src/index.d.ts',
      exports: {
        '.': { import: './dist/esm/index.js' },
        './server-entry': { types: './dist/default-entry/esm/server.d.ts', default: './dist/default-entry/esm/server.js' },
        './react': './dist/react/esm/index.js',
        './deep': './dist/web/v2/deep.js',
      },
    });
    for (const f of ['src/index.ts', 'src/server.tsx', 'src/default-entry/server.ts', 'src/react/index.ts', 'src/deep.ts']) write(f);
    const [p] = readRepoManifests(root, warn);
    // default-entry/esm/server.js must reach src/default-entry/server.ts, not src/server.tsx.
    expect(p!.entryPoints).toEqual(['src/deep.ts', 'src/default-entry/server.ts', 'src/index.ts', 'src/react/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('bundler named inputs map dist/<name>.js to their source (vite rolldown.config.ts, tanstack vite.config.<x>.ts)', () => {
    pkgJson('vite/package.json', {
      name: 'vite',
      exports: { '.': './dist/node/index.js', './internal': './dist/node/internal.js', './module-runner': './dist/node/module-runner.js', './gone': './dist/node/gone.js' },
    });
    write('vite/rolldown.config.ts', [
      'const nodeConfig = defineConfig({',
      '  input: {',
      "    index: path.resolve(dirname, 'src/node/index.ts'),",
      "    internal: path.resolve(dirname, 'src/node/internalIndex.ts'),",
      '  },',
      '})',
      "const runner = defineConfig({ input: { 'module-runner': path.resolve(dirname, 'src/module-runner/index.ts') } })",
      "const missing = defineConfig({ input: { gone: './src/nowhere.ts' } })",
    ].join('\n'));
    for (const f of ['src/node/index.ts', 'src/node/internalIndex.ts', 'src/module-runner/index.ts']) write(`vite/${f}`);
    pkgJson('utils/package.json', { name: 'utils', exports: { './solid/class': './dist/solid-class/esm/class.js' } });
    write('utils/vite.config.solid-class.ts', "export default tanstackViteConfig({ entry: ['./src/solid/class.ts', './src/solid/mount.tsx'], outDir: './dist/solid-class' })");
    write('utils/src/solid/class.ts');
    write('utils/src/solid/mount.tsx');
    write('utils/src/solid/index.ts');
    const pkgs = readRepoManifests(root, warn);
    const vite = pkgs.find((p) => p.name === 'vite')!;
    expect(vite.entryPoints).toEqual(['vite/src/module-runner/index.ts', 'vite/src/node/index.ts', 'vite/src/node/internalIndex.ts']);
    expect(vite.unresolvedEntryPoints).toEqual(['./dist/node/gone.js']);
    const utils = pkgs.find((p) => p.name === 'utils')!;
    expect(utils.entryPoints).toEqual(['utils/src/solid/class.ts']);
    expect(utils.unresolvedEntryPoints).toEqual([]);
  });

  it('dist-layout manifest: leaves outside a build dir map to the source root; without exports, directory indices are surface (drizzle-orm)', () => {
    pkgJson('drz/package.json', { name: 'drz', main: './index.cjs', module: './index.js', types: './index.d.ts' });
    write('drz/tsconfig.json', '{ "compilerOptions": { "outDir": "dist" }, "include": ["src", "scripts"] }');
    for (const f of ['src/index.ts', 'src/pg-core/index.ts', 'src/pg-core/table.ts', 'src/pg-core/columns/index.ts', 'src/types/index.d.ts', 'scripts/build.ts']) write(`drz/${f}`);
    // With `exports`, the subpaths are declared: only the named leaves, no directory indices.
    pkgJson('exp/package.json', { name: 'exp', exports: { '.': { types: './index.d.ts', default: './index.js' }, './sub': './sub.mjs' } });
    for (const f of ['src/index.ts', 'src/sub.ts', 'src/other/index.ts']) write(`exp/${f}`);
    // A tsconfig rootDir other than src, JS sources, an extension-less main.
    pkgJson('js/package.json', { name: 'js', main: './index', types: './types.d.ts' });
    write('js/tsconfig.json', '{ "compilerOptions": { "outDir": "out", "rootDir": "lib", "allowJs": true } }');
    for (const f of ['lib/index.js', 'lib/types.ts', 'lib/util/index.jsx']) write(`js/${f}`);
    const pkgs = readRepoManifests(root, warn);
    const by = (n: string) => pkgs.find((p) => p.name === n)!;
    expect(by('drz').entryPoints).toEqual(['drz/src/index.ts', 'drz/src/pg-core/columns/index.ts', 'drz/src/pg-core/index.ts']);
    expect(by('drz').unresolvedEntryPoints).toEqual([]);
    expect(by('drz').runtimeEntryPoints).toEqual([]);
    expect(by('exp').entryPoints).toEqual(['exp/src/index.ts', 'exp/src/sub.ts']);
    expect(by('exp').unresolvedEntryPoints).toEqual([]);
    expect(by('js').entryPoints).toEqual(['js/lib/index.js', 'js/lib/types.ts', 'js/lib/util/index.jsx']);
    expect(by('js').unresolvedEntryPoints).toEqual([]);
    // The adapter's deep-import mapping follows the same rule (`drz/pg-core`).
    expect(sourceForBuildOutput(root, 'drz', 'pg-core')).toBe('src/pg-core/index.ts');
    expect(sourceForBuildOutput(root, 'drz', 'pg-core/table.js')).toBe('src/pg-core/table.ts');
    expect(sourceForBuildOutput(root, 'drz', 'pg-core/gone')).toBeNull();
  });

  it('dist-layout rule: a source that does not exist stays unresolved; a directly resolving main adds no directory indices', () => {
    // The file really is missing: unresolved, as before (fail closed: the package stays opaque).
    pkgJson('gone/package.json', { name: 'gone', main: './gone.cjs', types: './gone.d.ts' });
    write('gone/src/index.ts');
    write('gone/src/sub/index.ts');
    // main resolves to a root file: not a dist layout, src/ dirs are not subpaths.
    pkgJson('plain/package.json', { name: 'plain', main: './index.js' });
    write('plain/index.js');
    write('plain/src/sub/index.ts');
    // A leaf under a build dir keeps the build-dir rules (dist/x.js is not src/dist/x.ts).
    pkgJson('built/package.json', { name: 'built', main: './dist/x.js' });
    write('built/src/dist/x.ts');
    const pkgs = readRepoManifests(root, warn);
    const by = (n: string) => pkgs.find((p) => p.name === n)!;
    expect(by('gone').unresolvedEntryPoints).toEqual(['./gone.cjs', './gone.d.ts']);
    expect(by('gone').entryPoints).toEqual(['gone/src/index.ts']); // the index fallback only
    expect(by('plain').entryPoints).toEqual(['plain/index.js']);
    expect(by('built').unresolvedEntryPoints).toEqual(['./dist/x.js']);
  });

  it('dist-layout rule: a mapped main that a script runs stays a runtime entry, like the index fallback (drizzle-seed)', () => {
    pkgJson('package.json', { name: 'app', main: './index.js', scripts: { start: 'tsx src/index.ts' } });
    write('src/index.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['src/index.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
    expect(p!.runtimeEntryPoints).toEqual(['src/index.ts']);
  });

  it('sourceForBuildOutput: tsdown / tsup / rolldown entries and a build-script mv rename (@flue/cli)', () => {
    // @flue/cli: `tsdown && mv dist/flue.mjs dist/flue.js`, bin imports ../dist/flue.js.
    pkgJson('cli/package.json', { name: '@x/cli', bin: { x: 'bin/x.mjs' }, scripts: { build: 'tsdown && mv dist/flue.mjs dist/flue.js' } });
    write('cli/tsdown.config.ts', "export default defineConfig({ entry: { flue: 'src/main.ts', 'run-bootstrap': 'src/lib/run-bootstrap.ts' }, format: ['esm'] })");
    for (const f of ['bin/x.mjs', 'src/main.ts', 'src/lib/run-bootstrap.ts']) write(`cli/${f}`);
    // A rename to another name; a string entry (named by its stem).
    pkgJson('ren/package.json', { name: 'ren', scripts: { build: 'tsup && mv -f ./dist/index.cjs ./dist/cli.cjs; echo done' } });
    write('ren/tsup.config.ts', "export default { entry: 'src/index.ts', format: ['cjs'] }");
    write('ren/src/index.ts');
    // An array entry (rolldown).
    pkgJson('arr/package.json', { name: 'arr' });
    write('arr/rolldown.config.mjs', "export default { input: ['src/entries/a.ts', 'src/entries/b.ts'] }");
    for (const f of ['src/entries/a.ts', 'src/entries/b.ts']) write(`arr/${f}`);
    expect(sourceForBuildOutput(root, 'cli', 'dist/flue.js')).toBe('src/main.ts');
    expect(sourceForBuildOutput(root, 'cli', 'dist/flue.mjs')).toBe('src/main.ts');
    expect(sourceForBuildOutput(root, 'cli', 'dist/run-bootstrap.mjs')).toBe('src/lib/run-bootstrap.ts');
    expect(sourceForBuildOutput(root, 'cli', 'dist/gone.mjs')).toBeNull();
    expect(sourceForBuildOutput(root, 'ren', 'dist/cli.cjs')).toBe('src/index.ts');
    expect(sourceForBuildOutput(root, 'ren', 'dist/cli')).toBe('src/index.ts');
    expect(sourceForBuildOutput(root, 'ren', 'dist/index.cjs')).toBe('src/index.ts');
    expect(sourceForBuildOutput(root, 'ren', 'dist/other.cjs')).toBeNull();
    expect(sourceForBuildOutput(root, 'arr', 'dist/a.mjs')).toBe('src/entries/a.ts');
    expect(sourceForBuildOutput(root, 'arr', 'dist/b.cjs')).toBe('src/entries/b.ts');
  });

  it('a build-script mv only renames outputs of a named input, within one dir', () => {
    pkgJson('package.json', { name: 'x', exports: { './a': './dist/renamed.js', './b': './dist/sub/moved.js' }, scripts: { build: 'tsdown && mv dist/unknown.mjs dist/renamed.js && mv dist/main.mjs dist/sub/moved.js' } });
    write('tsdown.config.ts', "export default { entry: { main: 'src/entry.ts' } }");
    write('src/entry.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual([]);
    expect(p!.unresolvedEntryPoints).toEqual(['./dist/renamed.js', './dist/sub/moved.js']);
  });

  it('the segment strip needs the source to exist and never maps to the src dir itself', () => {
    pkgJson('package.json', { name: 'x', main: 'dist/cjs/gone.js', types: 'dist/cjs.d.ts' });
    write('src/other.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.unresolvedEntryPoints).toEqual(['dist/cjs.d.ts', 'dist/cjs/gone.js']);
  });

  it('adds Vite/HTML client entries: index.html scripts and vite.config input values that resolve to local code', () => {
    pkgJson('app/package.json', { name: 'app', private: true });
    write('app/index.html', '<html><head><script type="module" src="/src/main.tsx"></script>\n<script src="https://cdn.x/y.js"></script>\n<script src="./src/missing.ts"></script></head></html>');
    write('app/admin.html', "<script type='module' src='src/admin.ts'></script>");
    write('app/vite.config.ts', [
      "export default defineConfig({ build: { rollupOptions: {",
      "  input: { main: 'index.html', worker: resolve(__dirname, 'src/worker.ts'), page: 'pages/p.html', nope: 'src/nope.ts' },",
      "}}, ssr: { input: 'src/entry-server.ts' }, other: { input: ['src/a.ts', 'README.md'] } });",
    ].join('\n'));
    write('app/pages/p.html', '<script src="./p.ts"></script><script src="/src/root.ts"></script>');
    for (const f of ['src/main.tsx', 'src/admin.ts', 'src/worker.ts', 'src/entry-server.ts', 'src/a.ts', 'pages/p.ts', 'src/root.ts', 'src/unused.ts']) write(`app/${f}`);
    write('app/README.md');
    const logs: string[] = [];
    const [p] = readRepoManifests(root, warn, undefined, { log: (m) => logs.push(m) });
    expect(p!.entryPoints).toEqual([
      'app/pages/p.ts', 'app/src/a.ts', 'app/src/admin.ts', 'app/src/entry-server.ts', 'app/src/main.tsx', 'app/src/root.ts', 'app/src/worker.ts',
    ]);
    expect(logs.some((l) => l.startsWith('app/package.json: client entry points from HTML / vite / rollup / webpack config: app/pages/p.ts'))).toBe(true);
    expect(p!.runtimeEntryPoints).toEqual(p!.entryPoints);
  });

  it('webpack entries, inline <script> bodies and Electron loadFile HTML are runtime entries (flame-engine ignite)', () => {
    // ignite: webpack.config.js without `entry` (default ./src/index.js → dist/main.js),
    // index.html loads the build through an inline require, main.js opens it with loadFile.
    pkgJson('ignite/package.json', { name: 'ignite', main: 'main.js', devDependencies: { webpack: '^4' } });
    write('ignite/webpack.config.js', 'module.exports = { target: "electron-renderer", module: { rules: [{ test: /\\.js$/ }] } };');
    write('ignite/index.html', "<html><body><script>\n  require('./renderer.js')\n  require('./dist/main.js');\n</script></body></html>");
    write('ignite/main.js', 'mainWindow.loadFile("index.html")');
    for (const f of ['src/index.js', 'src/helper.js', 'renderer.js']) write(`ignite/${f}`);
    // Explicit entries: string, array, object with a descriptor; an expression is ignored.
    pkgJson('wp/package.json', { name: 'wp', private: true });
    write('wp/webpack.prod.config.js', [
      "module.exports = [{ entry: { app: './src/app.js', admin: ['./src/admin.ts', './src/polyfill.js'],",
      "  worker: { import: './src/worker.js', dependOn: 'app' }, dyn: getEntry() } },",
      "  { entry: './src/other.js' }];",
    ].join('\n'));
    write('wp/rollup.config.mjs', "export default { input: 'src/rolled.ts' };");
    write('wp/public/app.html', '<script type="module">import { boot } from "../src/inline.ts"; import("./lazy.js");</script>');
    write('wp/electron/main.ts', 'win.loadURL(`file://${__dirname}/../public/app.html`); win.loadURL(`file://${__dirname}/win.html`)');
    write('wp/electron/win.html', '<script src="./dist/app.js"></script><script src="https://x.y/z.js"></script>');
    for (const f of ['src/app.js', 'src/admin.ts', 'src/polyfill.js', 'src/worker.js', 'src/other.js', 'src/rolled.ts', 'src/index.js', 'src/inline.ts', 'public/lazy.js']) write(`wp/${f}`);
    const pkgs = readRepoManifests(root, warn);
    const ignite = pkgs.find((p) => p.name === 'ignite')!;
    expect(ignite.runtimeEntryPoints).toEqual(['ignite/renderer.js', 'ignite/src/index.js']);
    expect(ignite.entryPoints).toEqual(['ignite/main.js', 'ignite/renderer.js', 'ignite/src/index.js']);
    const wp = pkgs.find((p) => p.name === 'wp')!;
    // src/index.js is not added (the configs name their entries); public/app.html is
    // opened through `${__dirname}/../public/app.html`, so its inline import / import()
    // count; win.html's `./dist/app.js` maps to the webpack entry `app`.
    expect(wp.runtimeEntryPoints).toEqual([
      'wp/public/lazy.js', 'wp/src/admin.ts', 'wp/src/app.js', 'wp/src/inline.ts', 'wp/src/other.js', 'wp/src/polyfill.js', 'wp/src/rolled.ts',
      'wp/src/worker.js',
    ]);
  });

  it('inline script and Electron HTML scanners read only literal local paths', () => {
    expect(inlineScriptRefs("require('./a.js'); require('fs'); import x from '/b.ts'; import './c'; import('https://x/y.js'); import(`./d${n}.js`)"))
      .toEqual(['./a.js', '/b.ts', './c']);
    expect(electronHtmlRefs("w.loadFile('./ui/index.html'); w.loadURL('file://' + __dirname + '/b.html'); w.loadURL('https://x.y/c.html'); w.loadFile(page)"))
      .toEqual(['ui/index.html', 'b.html']);
    expect(electronHtmlRefs('no windows here')).toEqual([]);
    // bluefireteam SpritesheetMapper: url.format({ pathname: path.join(__dirname, 'index.html') }) over several lines.
    expect(electronHtmlRefs('win.loadURL(url.format({\n    pathname: path.join(__dirname, "index.html"),\n    protocol: "file:",\n    slashes: true\n  }));'))
      .toEqual(['index.html']);
    expect(electronHtmlRefs("w.loadURL('file://' + path.join(__dirname, 'ui', 'app.html'))")).toEqual(['ui/app.html']);
    expect(webpackEntries("entry: path.resolve(__dirname, 'src/main.ts'), output: { filename: 'x.js' }"))
      .toEqual([{ name: 'main', path: 'src/main.ts' }]);
    expect(webpackEntries('entry: getEntries()')).toEqual([]);
  });

  it('package.json imports: every condition target that resolves to local code is an entry point (ocache #crypto)', () => {
    pkgJson('package.json', {
      name: 'ocache',
      exports: './dist/index.mjs',
      imports: {
        '#crypto': { node: './lib/digest.node.mjs', default: './lib/digest.mjs' },
        '#internal/*': './src/internal/*.ts',
        '#dep': 'some-package',
        '#gone': './lib/gone.mjs',
      },
    });
    write('src/index.ts');
    write('lib/digest.node.mjs');
    write('lib/digest.mjs');
    write('src/internal/a.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.entryPoints).toEqual(['lib/digest.mjs', 'lib/digest.node.mjs', 'src/index.ts', 'src/internal/a.ts']);
    expect(p!.runtimeEntryPoints).toEqual(['lib/digest.mjs', 'lib/digest.node.mjs', 'src/internal/a.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('runtime entry conventions: wrangler main, Pages functions/, HonoX, Vercel api/, Next, SvelteKit, Nuxt, Netlify', () => {
    // hono.dev: wrangler.jsonc `main`, no package.json entry; the generated .d.ts is not an entry.
    pkgJson('site/package.json', { name: 'site', private: true, devDependencies: { wrangler: '^4' } });
    write('site/wrangler.jsonc', '{\n  // comment\n  "name": "hono",\n  "main": "./worker.ts",\n}\n');
    write('site/worker.ts');
    write('site/worker-configuration.d.ts');
    write('site/functions/api/[id].ts');
    write('site/functions/_middleware.js');
    write('site/functions/types.d.ts');
    write('site/functions/x.test.ts');
    // wrangler.toml: only a top-level `main` (a [[durable_objects]] table is not the entry).
    pkgJson('toml/package.json', { name: 'toml', main: 'lib.ts' });
    write('toml/lib.ts');
    write('toml/wrangler.toml', 'name = "w"\nmain = "src/index.ts"\n[env.dev]\nmain = "src/dev.ts"\n');
    write('toml/src/index.ts');
    write('toml/src/dev.ts');
    // HonoX by dependency.
    pkgJson('x/package.json', { name: 'x', dependencies: { honox: '^0.1' } });
    for (const f of ['app/server.ts', 'app/client.ts', 'app/routes/index.tsx', 'app/routes/_renderer.tsx', 'app/islands/counter.tsx', 'app/global.d.ts', 'app/lib/util.ts']) write(`x/${f}`);
    // No honox dependency: app/routes is just code.
    pkgJson('y/package.json', { name: 'y', main: 'index.ts' });
    write('y/index.ts');
    write('y/app/routes/index.tsx');
    // Vercel, Next, SvelteKit, Nuxt, Netlify.
    pkgJson('v/package.json', { name: 'v' });
    write('v/vercel.json', '{}');
    write('v/api/hello.ts');
    pkgJson('n/package.json', { name: 'n', dependencies: { next: '15' } });
    write('n/app/page.tsx');
    write('n/src/pages/about.tsx');
    pkgJson('k/package.json', { name: 'k', devDependencies: { '@sveltejs/kit': '2' } });
    write('k/src/routes/+page.ts');
    write('k/src/lib/x.ts');
    pkgJson('u/package.json', { name: 'u', dependencies: { nuxt: '3' } });
    write('u/pages/index.ts');
    write('u/server/api/hello.ts');
    pkgJson('l/package.json', { name: 'l' });
    write('l/netlify/functions/hello.mts');
    const logs: string[] = [];
    const byName = new Map(readRepoManifests(root, warn, undefined, { log: (m) => logs.push(m) }).map((p) => [p.name, p]));
    expect(byName.get('site')!.entryPoints).toEqual(['site/functions/_middleware.js', 'site/functions/api/[id].ts', 'site/worker.ts']);
    expect(byName.get('site')!.runtimeEntryPoints).toEqual(byName.get('site')!.entryPoints);
    expect(byName.get('toml')!.runtimeEntryPoints).toEqual(['toml/src/index.ts']);
    expect(byName.get('x')!.runtimeEntryPoints).toEqual([
      'x/app/client.ts', 'x/app/islands/counter.tsx', 'x/app/routes/_renderer.tsx', 'x/app/routes/index.tsx', 'x/app/server.ts',
    ]);
    expect(byName.get('y')!.entryPoints).toEqual(['y/index.ts']);
    expect(byName.get('y')!.runtimeEntryPoints).toEqual([]);
    expect(byName.get('v')!.runtimeEntryPoints).toEqual(['v/api/hello.ts']);
    expect(byName.get('n')!.runtimeEntryPoints).toEqual(['n/app/page.tsx', 'n/src/pages/about.tsx']);
    expect(byName.get('k')!.runtimeEntryPoints).toEqual(['k/src/routes/+page.ts']);
    expect(byName.get('u')!.runtimeEntryPoints).toEqual(['u/pages/index.ts', 'u/server/api/hello.ts']);
    expect(byName.get('l')!.runtimeEntryPoints).toEqual(['l/netlify/functions/hello.mts']);
    expect(logs.some((l) => l.startsWith('site/package.json: 3 runtime entry point(s) by convention'))).toBe(true);
    // No "no entry points resolved" warning when a convention supplies them.
    expect(warnings.filter((w) => w.includes('no entry points'))).toEqual([]);
  });

  it('urlReferencedFiles: new URL(rel, import.meta.url) and join(__dirname, …) name code files (fix round 4)', () => {
    expect(urlReferencedFiles('const e = fileURLToPath(new URL("./serve.main.ts", import.meta.url));')).toEqual(['./serve.main.ts']);
    expect(urlReferencedFiles("new Worker(new URL( '../workers/w.js' ,import.meta.url), { type: 'module' })")).toEqual(['../workers/w.js']);
    expect(urlReferencedFiles("spawn('node', [path.join(__dirname, 'bin', 'child.mjs')]); resolve(import.meta.dirname, './x.ts')"))
      .toEqual(['./bin/child.mjs', './x.ts']);
    // Not code, not relative, computed, or not relative to the file: nothing.
    expect(urlReferencedFiles([
      "new URL('./data.json', import.meta.url)", "new URL('https://x.dev/a.js', import.meta.url)",
      'new URL(`./${name}.ts`, import.meta.url)', "new URL('./a.ts', base)", "join(__dirname, name, 'x.js')", "join(root, 'x.js')",
    ].join('\n'))).toEqual([]);
  });

  it('a file named by new URL / __dirname in the package source is a runtime entry point if it exists', () => {
    pkgJson('cli/package.json', { name: 'cli', exports: './src/index.ts' });
    write('cli/src/index.ts', "export const x = 1;\n");
    write('cli/src/functions/bundler.ts', 'const entry = fileURLToPath(new URL("./serve.main.ts", import.meta.url));\n'
      + "const gone = new URL('./missing.ts', import.meta.url);\nconst w = join(__dirname, '../../dist/worker.js');\n");
    write('cli/src/functions/serve.main.ts', 'serve();\n');
    write('cli/src/worker.ts');
    // A test naming a file does not make it an entry (tests are not runtime sources).
    write('cli/src/functions/bundler.test.ts', "new URL('./only-test.ts', import.meta.url)\n");
    write('cli/src/functions/only-test.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.runtimeEntryPoints).toEqual(['cli/src/functions/serve.main.ts', 'cli/src/worker.ts']);
    expect(p!.entryPoints).toEqual(['cli/src/functions/serve.main.ts', 'cli/src/index.ts', 'cli/src/worker.ts']);
  });

  it('runnerTargets: the file after node / tsx / ts-node / bun / nodemon, flags and their values skipped', () => {
    expect(runnerTargets('node dist/server/server.js')).toEqual(['dist/server/server.js']);
    expect(runnerTargets('PG_META_EXPORT_DOCS=true node --loader ts-node/esm src/server/server.ts > openapi.json')).toEqual(['src/server/server.ts']);
    expect(runnerTargets('nodemon --exec node --loader ts-node/esm src/server/server.ts | pino-pretty --colorize')).toEqual(['src/server/server.ts']);
    expect(runnerTargets('nodemon -w src -e ts,json src/main.ts')).toEqual(['src/main.ts']);
    expect(runnerTargets('tsx watch --clear-screen=false src/index.ts')).toEqual(['src/index.ts']);
    expect(runnerTargets('bun run src/cli.ts && bun run build')).toEqual(['src/cli.ts']);
    expect(runnerTargets('cross-env NODE_ENV=production node -r dotenv/config ./build/index.mjs --port 3000')).toEqual(['./build/index.mjs']);
    expect(runnerTargets('./node_modules/.bin/ts-node "scripts/seed.ts"; deno run -A main.ts')).toEqual(['scripts/seed.ts', 'main.ts']);
    // Inline code, a script name, a non-runner, a URL: nothing.
    expect(runnerTargets('node -e "require(\'./x.js\')"')).toEqual([]);
    expect(runnerTargets('node --test')).toEqual([]);
    expect(runnerTargets('vite build && tsc -p tsconfig.json')).toEqual([]);
    expect(runnerTargets('deno run https://deno.land/x/y.ts')).toEqual([]);
  });

  it('runnerTargets: tsm, tsimp and the other TypeScript runners (houston-discord: tsm src/stats.ts)', () => {
    expect(runnerTargets('tsm src/stats.ts')).toEqual(['src/stats.ts']);
    expect(runnerTargets('tsimp scripts/x.ts')).toEqual(['scripts/x.ts']);
    expect(runnerTargets('bunx tsm --require dotenv/config src/a.ts')).toEqual(['src/a.ts']);
    expect(runnerTargets('node --import tsx src/b.ts')).toEqual(['src/b.ts']);
    expect(runnerTargets('ts-node-esm src/c.ts && jiti src/d.ts && esno src/e.ts && vite-node src/f.ts')).toEqual(['src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']);
    expect(runnerTargets('sucrase-node g.ts; swc-node h.ts')).toEqual(['g.ts', 'h.ts']);
    // bunx / npx run a package binary, not a file: its arguments are not entries.
    expect(runnerTargets('bunx vitest run src/x.test.ts')).toEqual([]);
    expect(runnerTargets('npx eslint src/y.ts')).toEqual([]);
  });

  it('dockerfileTargets: CMD / ENTRYPOINT in exec and shell form, WORKDIR-absolute paths, not HEALTHCHECK', () => {
    expect(dockerfileTargets([
      'FROM node:20 AS build', 'WORKDIR /usr/src/app', 'COPY . .', 'RUN npm run build',
      'FROM node:20', 'WORKDIR /usr/src/app/', 'CMD ["node", "dist/server/server.js"]',
      'HEALTHCHECK --interval=5s CMD node -e "fetch(\'http://localhost:8080/health\')"',
    ].join('\n'))).toEqual(['dist/server/server.js']);
    expect(dockerfileTargets('WORKDIR /app\nENTRYPOINT ["node"]\nCMD ["/app/dist/main.js"]\n')).toEqual(['dist/main.js']);
    expect(dockerfileTargets('ENTRYPOINT node \\\n  --enable-source-maps lib/run.js\n')).toEqual(['lib/run.js']);
    // Absolute outside WORKDIR, npm start (the script is scanned itself), invalid exec form.
    expect(dockerfileTargets('WORKDIR /app\nCMD ["node", "/opt/x.js"]\nCMD npm start\nCMD ["node", "a.js"\n')).toEqual([]);
  });

  it('script and Dockerfile entries map build output to sources (postgres-meta: node dist/server/server.js)', () => {
    pkgJson('api/package.json', {
      name: 'api', private: true, main: 'dist/lib/index.js',
      scripts: { start: 'node dist/server/server.js', seed: 'tsx scripts/seed.ts', gone: 'node dist/nope.js' },
    });
    write('api/tsconfig.json', '{ "include": ["src"], "compilerOptions": { "outDir": "dist", "rootDir": "src" } }');
    write('api/Dockerfile', 'FROM node:20\nWORKDIR /srv\nCMD ["node", "/srv/dist/worker.js"]\n');
    write('api/src/lib/index.ts');
    write('api/src/server/server.ts');
    write('api/src/worker.ts');
    write('api/scripts/seed.ts');
    const logs: string[] = [];
    const [p] = readRepoManifests(root, warn, undefined, { log: (m) => logs.push(m) });
    expect(p!.entryPoints).toEqual(['api/scripts/seed.ts', 'api/src/lib/index.ts', 'api/src/server/server.ts', 'api/src/worker.ts']);
    expect(p!.runtimeEntryPoints).toEqual(['api/scripts/seed.ts', 'api/src/server/server.ts', 'api/src/worker.ts']);
    expect(p!.unresolvedEntryPoints).toEqual([]);
  });

  it('Next.js files loaded by name: beside the router dir (src/ for src/app), next.config at the root', () => {
    // src/app project: src/middleware.ts is the middleware; a root middleware.ts is ignored by Next.
    pkgJson('web/package.json', { name: 'web', private: true, dependencies: { next: '16' } });
    for (const f of [
      'src/app/page.tsx', 'src/middleware.ts', 'src/instrumentation.ts', 'src/instrumentation-client.ts', 'src/mdx-components.tsx',
      'src/lib/util.ts', 'middleware.ts', 'next.config.mjs',
    ]) write(`web/${f}`);
    // Root app/ project (Next 16 `proxy.ts`).
    pkgJson('root/package.json', { name: 'root', private: true, dependencies: { next: '16' } });
    for (const f of ['app/layout.tsx', 'proxy.ts', 'instrumentation.js', 'next.config.ts', 'src/middleware.ts', 'lib/x.ts']) write(`root/${f}`);
    // No next dependency: none of this is an entry.
    pkgJson('plain/package.json', { name: 'plain', main: 'index.ts' });
    for (const f of ['index.ts', 'middleware.ts', 'next.config.js']) write(`plain/${f}`);
    const byName = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(byName.get('web')!.runtimeEntryPoints).toEqual([
      'web/next.config.mjs', 'web/src/app/page.tsx', 'web/src/instrumentation-client.ts', 'web/src/instrumentation.ts',
      'web/src/mdx-components.tsx', 'web/src/middleware.ts',
    ]);
    expect(byName.get('root')!.runtimeEntryPoints).toEqual([
      'root/app/layout.tsx', 'root/instrumentation.js', 'root/next.config.ts', 'root/proxy.ts',
    ]);
    expect(byName.get('plain')!.runtimeEntryPoints).toEqual([]);
  });

  it('Cloudflare Pages functions/ without a wrangler config: a wrangler dependency or a `wrangler pages` script', () => {
    // honojs examples/pages-stack: no wrangler config, wrangler in devDependencies.
    pkgJson('dep/package.json', { name: 'dep', private: true, devDependencies: { wrangler: '^4' } });
    write('dep/functions/api/[[route]].ts');
    pkgJson('scr/package.json', { name: 'scr', private: true, scripts: { deploy: 'vite build && wrangler pages deploy dist' } });
    write('scr/functions/hello.ts');
    // Neither: functions/ is just code.
    pkgJson('none/package.json', { name: 'none', main: 'index.ts', scripts: { dev: 'vite' } });
    write('none/index.ts');
    write('none/functions/x.ts');
    const byName = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(byName.get('dep')!.runtimeEntryPoints).toEqual(['dep/functions/api/[[route]].ts']);
    expect(byName.get('scr')!.runtimeEntryPoints).toEqual(['scr/functions/hello.ts']);
    expect(byName.get('none')!.runtimeEntryPoints).toEqual([]);
  });

  it('wrangler Durable Object classes (TOML bindings + migrations, JSON bindings) become runtimeEntrySymbols', () => {
    pkgJson('t/package.json', { name: 't', private: true });
    write('t/wrangler.toml', [
      'name = "do"', 'main = "src/index.ts"', '',
      '[[durable_objects.bindings]]', 'name = "COUNTER"', 'class_name = "Counter"', '',
      '[[env.prod.durable_objects.bindings]]', "name = 'ROOM'", "class_name = 'Room'", '',
      '[[migrations]]', 'tag = "v1"', 'new_classes = ["Counter", "Legacy"]', '',
      '[[migrations]]', 'tag = "v2"', 'new_sqlite_classes = [', '  "Chat",', ']', '',
    ].join('\n'));
    write('t/src/index.ts');
    pkgJson('j/package.json', { name: 'j', private: true });
    write('j/wrangler.jsonc', `{
  // comment
  "main": "src/index.ts",
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room", "Lobby"] }],
}`);
    write('j/src/index.ts');
    pkgJson('n/package.json', { name: 'n', private: true });
    write('n/wrangler.toml', 'name = "n"\nmain = "src/index.ts"\n');
    write('n/src/index.ts');
    const byName = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(byName.get('t')!.runtimeEntrySymbols).toEqual(['Chat', 'Counter', 'Legacy', 'Room']);
    expect(byName.get('j')!.runtimeEntrySymbols).toEqual(['Lobby', 'Room']);
    expect(byName.get('n')!.runtimeEntrySymbols).toBeUndefined();
  });

  it('wrangler main from a `wrangler dev|deploy <file>` script when no config names one', () => {
    // honojs examples/durable-objects: wrangler.toml without `main`, the entry on the command line.
    pkgJson('a/package.json', { name: 'a', private: true, scripts: { dev: 'wrangler dev src/index.ts', deploy: 'wrangler deploy --minify src/index.ts' } });
    write('a/wrangler.toml', 'name = "a"\n[[durable_objects.bindings]]\nname = "C"\nclass_name = "Counter"\n');
    write('a/src/index.ts');
    // A config `main` wins over the script.
    pkgJson('b/package.json', { name: 'b', private: true, scripts: { dev: 'wrangler dev other.ts' } });
    write('b/wrangler.toml', 'main = "src/main.ts"\n');
    write('b/src/main.ts');
    write('b/other.ts');
    // No config at all, still a script entry; `wrangler pages dev` is not a Worker entry.
    pkgJson('c/package.json', { name: 'c', private: true, scripts: { start: 'wrangler dev ./worker.js --port 8787', p: 'wrangler pages dev ./dist.js' } });
    write('c/worker.js');
    write('c/dist.js');
    const byName = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(byName.get('a')!.runtimeEntryPoints).toEqual(['a/src/index.ts']);
    expect(byName.get('a')!.entryPoints).toEqual(['a/src/index.ts']);
    expect(byName.get('a')!.runtimeEntrySymbols).toEqual(['Counter']);
    expect(byName.get('b')!.runtimeEntryPoints).toEqual(['b/src/main.ts']);
    expect(byName.get('c')!.runtimeEntryPoints).toEqual(['c/worker.js']);
  });

  it('framework apps get runtime entries: Docusaurus, VitePress, Astro, Nuxt (3 and 4) and the files their configs name', () => {
    // trpc www: docusaurus.config.ts requires files by path; theme, pages, plugins, sidebars.
    pkgJson('www/package.json', { name: 'www', private: true, dependencies: { '@docusaurus/core': '^3' } });
    write('www/docusaurus.config.ts', [
      "import { parseEnv } from './src/utils/env';",
      "export default { presets: [['classic', { docs: { sidebarPath: require.resolve('./sidebars.js'),",
      "  remarkPlugins: [require('./mdxToJsx')] } }]], plugins: ['./src/plugins/local', require.resolve('./docusaurus.preferredTheme.js')],",
      "  themeConfig: { image: './static/og.png' } };",
    ].join('\n'));
    for (const f of ['sidebars.js', 'mdxToJsx.js', 'docusaurus.preferredTheme.js', 'src/utils/env.ts', 'src/theme/Footer/index.tsx',
      'src/pages/index.tsx', 'src/plugins/local/index.js', 'src/components/Unused.tsx', 'static/og.png']) write(`www/${f}`);
    // vite docs: a VitePress site under docs/ of the package, data loaders anywhere.
    pkgJson('vp/package.json', { name: 'vp', private: true, devDependencies: { vitepress: '^1' } });
    for (const f of ['docs/.vitepress/config.ts', 'docs/.vitepress/theme/index.ts', 'docs/.vitepress/theme/Layout.ts',
      'docs/.vitepress/cache/deps/x.js', 'docs/_data/blog.data.ts', 'docs/unused.ts']) write(`vp/${f}`);
    // Without vitepress, a .vitepress dir is not a convention.
    pkgJson('novp/package.json', { name: 'novp', private: true, dependencies: { x: '1' } });
    write('novp/.vitepress/config.ts');
    write('novp/a.data.ts');
    // An Astro site.
    pkgJson('site/package.json', { name: 'site', private: true, dependencies: { astro: '^5' } });
    write('site/astro.config.mjs', "export default defineConfig({ integrations: [starlight({ routeMiddleware: './src/routeData.ts' })] });");
    for (const f of ['src/pages/rss.ts', 'src/pages/api/[id].ts', 'src/middleware.ts', 'src/actions/index.ts', 'src/content.config.ts',
      'src/routeData.ts', 'src/lib/orphan.ts']) write(`site/${f}`);
    // An Astro integration (depends on astro, no astro.config): no convention.
    pkgJson('integ/package.json', { name: 'integ', exports: './src/index.ts', peerDependencies: { astro: '^5' } });
    write('integ/src/index.ts');
    write('integ/src/middleware.ts');
    // Nuxt 3 (root dirs) and a Nuxt 4 layer (app/ srcDir; no nuxt dependency, only a config).
    pkgJson('n3/package.json', { name: 'n3', private: true, dependencies: { nuxt: '^3' } });
    write('n3/nuxt.config.ts', "export default defineNuxtConfig({ plugins: ['./extra/plugin.ts'] })");
    for (const f of ['composables/useX.ts', 'utils/fmt.ts', 'stores/cart.ts', 'layouts/default.ts', 'middleware/auth.ts', 'plugins/p.ts',
      'components/C.ts', 'server/api/x.ts', 'extra/plugin.ts', 'lib/other.ts']) write(`n3/${f}`);
    pkgJson('n4/package.json', { name: 'n4', private: true });
    write('n4/nuxt.config.ts');
    write('n4/app/composables/useY.ts');
    write('n4/app/pages/index.ts');
    write('n4/lib/other.ts');
    const by = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(by.get('www')!.runtimeEntryPoints).toEqual([
      'www/docusaurus.config.ts', 'www/docusaurus.preferredTheme.js', 'www/mdxToJsx.js', 'www/sidebars.js',
      'www/src/pages/index.tsx', 'www/src/plugins/local/index.js', 'www/src/theme/Footer/index.tsx', 'www/src/utils/env.ts',
    ]);
    expect(by.get('vp')!.runtimeEntryPoints).toEqual(['vp/docs/.vitepress/config.ts', 'vp/docs/.vitepress/theme/Layout.ts', 'vp/docs/.vitepress/theme/index.ts', 'vp/docs/_data/blog.data.ts']);
    expect(by.get('novp')!.runtimeEntryPoints).toEqual([]);
    expect(by.get('site')!.runtimeEntryPoints).toEqual([
      'site/astro.config.mjs', 'site/src/actions/index.ts', 'site/src/content.config.ts', 'site/src/middleware.ts',
      'site/src/pages/api/[id].ts', 'site/src/pages/rss.ts', 'site/src/routeData.ts',
    ]);
    expect(by.get('integ')!.runtimeEntryPoints).toEqual([]);
    expect(by.get('n3')!.runtimeEntryPoints).toEqual([
      'n3/components/C.ts', 'n3/composables/useX.ts', 'n3/extra/plugin.ts', 'n3/layouts/default.ts', 'n3/middleware/auth.ts', 'n3/nuxt.config.ts',
      'n3/plugins/p.ts', 'n3/server/api/x.ts', 'n3/stores/cart.ts', 'n3/utils/fmt.ts',
    ]);
    expect(by.get('n4')!.runtimeEntryPoints).toEqual(['n4/app/composables/useY.ts', 'n4/app/pages/index.ts', 'n4/nuxt.config.ts']);
    expect(warnings.filter((w) => /^(?:www|vp|site|n3|n4)\//.test(w))).toEqual([]);
  });

  it('jscodeshift codemods: transform dirs and transform modules are runtime entries, `parser` an entry symbol', () => {
    // tanstack query-codemods (CommonJS `module.exports = (file, api) =>`), trpc upgrade
    // (`export const parser`, surface through `exports`), tanstack ai codemods/.
    pkgJson('qc/package.json', { name: '@x/query-codemods', private: true, devDependencies: { jscodeshift: '17' } });
    write('qc/src/v5/is-loading/is-loading.cjs', 'const u = require("../../utils/index.cjs");\nmodule.exports = (file, api) => { return u(file); };');
    write('qc/src/utils/index.cjs', 'module.exports = ({ root, jscodeshift }) => {};');
    write('qc/src/v5/is-loading/__tests__/is-loading.test.cjs', 'module.exports = (file, api) => {};');
    pkgJson('up/package.json', { name: '@x/upgrade', exports: { './transforms/provider': { require: './dist/transforms/provider.cjs' } }, dependencies: { jscodeshift: '17' } });
    write('up/src/transforms/provider.ts', "export default function transform(file: FileInfo, api: API) {}\nexport const parser = 'tsx';");
    write('up/src/lib/helper.ts');
    pkgJson('ai/codemods/package.json', { name: '@x/ai-codemods', private: true });
    write('ai/codemods/ag-ui/transform.ts', 'export default function transform(\n  fileInfo: FileInfo,\n  api: API,\n) {}');
    write('ai/codemods/run.mjs');
    // Not a codemod package: the same text is no convention.
    pkgJson('plain/package.json', { name: 'plain', private: true, dependencies: { x: '1' } });
    write('plain/src/transforms/t.ts', "export const parser = 'tsx';");
    const by = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(by.get('@x/query-codemods')!.runtimeEntryPoints).toEqual(['qc/src/v5/is-loading/is-loading.cjs']);
    expect(by.get('@x/query-codemods')!.runtimeEntrySymbols).toEqual(['parser']);
    // A surface file stays surface; `parser` is then kept by name (ingest runtimeEntrySymbols).
    expect(by.get('@x/upgrade')!.entryPoints).toEqual(['up/src/transforms/provider.ts']);
    expect(by.get('@x/upgrade')!.runtimeEntrySymbols).toEqual(['parser']);
    expect(by.get('@x/ai-codemods')!.runtimeEntryPoints).toEqual(['ai/codemods/ag-ui/transform.ts']);
    expect(by.get('plain')!.runtimeEntryPoints).toEqual([]);
    expect(by.get('plain')!.runtimeEntrySymbols).toBeUndefined();
  });

  it('Firebase Functions and terraform entry_point: deployed exports are runtime entries / entry symbols', () => {
    // invertase tanstack-query-firebase: firebase.json functions.source → functions/, whose
    // main re-exports its triggers.
    write('firebase.json', JSON.stringify({ functions: { predeploy: 'npm run build', source: 'functions' }, firestore: {} }));
    pkgJson('functions/package.json', { name: 'fns', main: 'lib/index.js' });
    write('functions/src/index.ts', "export { onUser } from './triggers/user';\nexport * from './http.js';\nexport const direct = 1;");
    write('functions/src/triggers/user.ts');
    write('functions/src/http.ts');
    write('functions/src/unused.ts');
    // extensions-terraform: `entry_point = "translateText"` names an export of a package in the repo.
    write('ext/terraform/main.tf', 'resource "google_cloudfunctions2_function" "f" {\n  build_config {\n    entry_point = "translateText"\n  }\n}');
    pkgJson('ext/function/package.json', { name: 'translate', main: 'lib/index.js' });
    write('ext/function/src/index.ts');
    // An array of codebases, and a default `functions` source.
    write('multi/firebase.json', JSON.stringify({ functions: [{ source: 'api', codebase: 'a' }, { codebase: 'b' }] }));
    pkgJson('multi/api/package.json', { name: 'api', main: 'index.js' });
    write('multi/api/index.js');
    pkgJson('multi/functions/package.json', { name: 'mf', main: 'index.js' });
    write('multi/functions/index.js');
    pkgJson('other/package.json', { name: 'other', main: 'index.js' });
    write('other/index.js');
    const by = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    const fns = by.get('fns')!;
    expect(fns.entryPoints).toEqual(['functions/src/http.ts', 'functions/src/index.ts', 'functions/src/triggers/user.ts']);
    // The main stays surface AND is a runtime entry (ingest: its exports are entry symbols).
    expect(fns.runtimeEntryPoints).toEqual(['functions/src/http.ts', 'functions/src/index.ts', 'functions/src/triggers/user.ts']);
    expect(by.get('api')!.runtimeEntryPoints).toEqual(['multi/api/index.js']);
    expect(by.get('mf')!.runtimeEntryPoints).toEqual(['multi/functions/index.js']);
    expect(by.get('other')!.runtimeEntryPoints).toEqual([]);
    expect(by.get('translate')!.runtimeEntrySymbols).toEqual(['translateText']);
  });

  it('React Native platform modules: each variant of an imported base is a runtime entry', () => {
    // invertase react-native-apple-authentication: lib/index.js re-exports './AppleButton',
    // which exists only as AppleButton.ios.js / .android.js / .macos.js.
    pkgJson('package.json', { name: 'rn', main: 'lib/index.js', devDependencies: { 'react-native': '0.82' } });
    write('lib/index.js', "export { default as AppleButton } from './AppleButton';");
    for (const f of ['lib/AppleButton.ios.js', 'lib/AppleButton.android.js', 'lib/AppleButton.macos.js', 'lib/Orphan.ios.js']) write(f);
    // An Expo app (app.json `expo`): root index.<platform> entries.
    write('app/app.json', '{ "expo": { "name": "x" } }');
    pkgJson('app/package.json', { name: 'expo-app', private: true, main: 'index.js' });
    write('app/index.js');
    write('app/index.web.js');
    // Not React Native: `.web.js` is just a name.
    pkgJson('web/package.json', { name: 'web', main: 'index.js' });
    write('web/index.js', "import './x';");
    write('web/x.web.js');
    const by = new Map(readRepoManifests(root, warn).map((p) => [p.name, p]));
    expect(by.get('rn')!.runtimeEntryPoints).toEqual(['lib/AppleButton.android.js', 'lib/AppleButton.ios.js', 'lib/AppleButton.macos.js']);
    expect(by.get('expo-app')!.runtimeEntryPoints).toEqual(['app/index.web.js']);
    expect(by.get('web')!.runtimeEntryPoints).toEqual([]);
  });

  it('templates are never packages: Nx generator files/, __brick__, .template, a templated name', () => {
    // tanstack ai: tools/workspace-plugin/src/generators/react-app/files/package.json.
    pkgJson('tools/plugin/src/generators/react-app/files/package.json', { name: '<%= name %>', dependencies: { '@acme/core': '1' } });
    pkgJson('bricks/app/__brick__/package.json', { name: 'brick', dependencies: {} });
    pkgJson('.template/package.json', { name: 'tpl' });
    // A templated name anywhere else.
    pkgJson('starter/package.json', { name: '{{project_name}}', dependencies: { x: '1' } });
    write('starter/pubspec.yaml', 'name: "{{name.snakeCase()}}"\n');
    // Under examples/ AND a generator: a template, never a promotable consumer.
    pkgJson('examples/generators/g/files/package.json', { name: 'g-files' });
    pkgJson('pkgs/real/package.json', { name: 'real' });
    write('pkgs/real/index.js');
    const logs: string[] = [];
    const r = readRepoManifestsWithIgnored(root, warn, undefined, { log: (m) => logs.push(m) });
    expect(r.packages.map((p) => p.name)).toEqual(['real']);
    expect(r.ignored.map((m) => [m.manifest, m.byDir, m.consumerDir ?? false])).toEqual([
      ['.template/package.json', true, false],
      ['bricks/app/__brick__/package.json', true, false],
      ['examples/generators/g/files/package.json', true, false],
      ['starter/package.json', true, false],
      ['starter/pubspec.yaml', true, false],
      ['tools/plugin/src/generators/react-app/files/package.json', true, false],
    ]);
    expect(r.ignored.find((m) => m.manifest === 'starter/package.json')!.deps.map((d) => d.name)).toEqual(['x']);
    expect(logs.some((l) => l.startsWith('skipped 2 template manifest(s) (a templated name: <%= %> or {{ }}) as not org packages: starter/package.json'))).toBe(true);
  });

  it('a convention never reaches into a nested package', () => {
    pkgJson('package.json', { name: 'root', dependencies: { nuxt: '3' } });
    write('pages/a.ts');
    pkgJson('server/sub/package.json', { name: 'sub' });
    write('server/sub/x.ts');
    write('server/y.ts');
    const [p] = readRepoManifests(root, warn);
    expect(p!.runtimeEntryPoints).toEqual(['pages/a.ts', 'server/y.ts']);
  });

  it('package.json files bounds what an exports `*` pattern matches (unctx: files ["dist"], "./*": "./*")', () => {
    // (`dist` itself is skipped outside git, so `esm` plays its part here.)
    pkgJson('a/package.json', { name: 'a', files: ['esm'], exports: { '.': './esm/index.mjs', './*': './*' } });
    write('a/esm/index.mjs');
    write('a/eslint.config.mjs');
    write('a/test/x.test.ts');
    write('a/esm/extra.mjs');
    // A dist→src variant stands for the built file, which `files` covers.
    pkgJson('b/package.json', { name: 'b', files: ['dist', '!dist/*.map'], exports: { './plugins/*': './dist/plugins/*.mjs' } });
    write('b/src/plugins/p.ts');
    // Not covered by `files`: no match, even through dist→src.
    pkgJson('c/package.json', { name: 'c', files: ['lib/**/*.js'], exports: { '.': './lib/index.js', './x/*': './dist/x/*.mjs' } });
    write('c/lib/index.js');
    write('c/src/x/y.ts');
    const [a, b, c] = readRepoManifests(root, warn);
    expect(a!.entryPoints).toEqual(['a/esm/extra.mjs', 'a/esm/index.mjs']);
    expect(b!.entryPoints).toEqual(['b/src/plugins/p.ts']);
    expect(c!.entryPoints).toEqual(['c/lib/index.js']);
  });

  it('prefers the built file when it exists (no src mapping)', () => {
    pkgJson('package.json', { name: 'x', main: 'lib/index.js' });
    write('lib/index.js');
    write('src/index.ts');
    expect(readRepoManifests(root, warn)[0]!.entryPoints).toEqual(['lib/index.js']);
  });

  it('probes extensions and directory index like Node', () => {
    pkgJson('a/package.json', { name: 'a', main: './main' });
    write('a/main.ts');
    pkgJson('b/package.json', { name: 'b', main: 'lib' });
    write('b/lib/index.js');
    const [a, b] = readRepoManifests(root, warn);
    expect(a!.entryPoints).toEqual(['a/main.ts']);
    expect(b!.entryPoints).toEqual(['b/lib/index.js']);
  });

  it('falls back to index files when nothing declared resolves', () => {
    pkgJson('a/package.json', { name: 'a', main: 'dist/nope.js' });
    write('a/src/index.ts');
    write('a/src/index.tsx');
    pkgJson('b/package.json', { name: 'b' });
    write('b/index.mjs');
    write('b/src/index.ts');
    pkgJson('c/package.json', { name: 'c' });
    const [a, b, c] = readRepoManifests(root, warn);
    expect(a!.entryPoints).toEqual(['a/src/index.ts']);
    expect(b!.entryPoints).toEqual(['b/index.mjs']);
    expect(c!.entryPoints).toEqual([]);
    expect(warnings.some((w) => w.includes('c/package.json') && w.includes('no entry points'))).toBe(true);
  });

  it('ignores entry paths that escape the package', () => {
    pkgJson('a/package.json', { name: 'a', main: '../b/index.ts' });
    write('b/index.ts');
    write('a/index.ts');
    expect(readRepoManifests(root, warn)[0]!.entryPoints).toEqual(['a/index.ts']);
  });

  it('visibility rules', () => {
    expect(npmVisibility({ private: true, publishConfig: { registry: 'https://npm.acme.dev' } })).toBe('private');
    expect(npmVisibility({ publishConfig: { registry: 'https://npm.acme.dev/' } })).toBe('published-private');
    expect(npmVisibility({ publishConfig: { registry: 'https://registry.npmjs.org/' } })).toBe('published-public');
    expect(npmVisibility({ publishConfig: { access: 'public' } })).toBe('published-public');
    expect(npmVisibility({ private: 'true' })).toBe('published-public');
    expect(npmVisibility({})).toBe('published-public');
  });

  it('deps: all four fields, constraint verbatim, first non-dev field wins, dev only when only in devDependencies, sorted', () => {
    pkgJson('package.json', {
      name: 'x', private: true,
      devDependencies: { z: '^9', shared: '^1-dev', onlydev: '1' },
      dependencies: { b: 'workspace:*' },
      peerDependencies: { shared: '>=1' },
      optionalDependencies: { a: 'file:../a' },
    });
    const [p] = readRepoManifests(root, warn);
    expect(p!.visibility).toBe('private');
    expect(p!.deps).toEqual([
      { name: 'a', manager: 'npm', constraint: 'file:../a' },
      { name: 'b', manager: 'npm', constraint: 'workspace:*' },
      { name: 'onlydev', manager: 'npm', constraint: '1', dev: true },
      { name: 'shared', manager: 'npm', constraint: '>=1' },
      { name: 'z', manager: 'npm', constraint: '^9', dev: true },
    ]);
  });

  it('skips a package without a name and without dependencies (a bare marker), with a warning', () => {
    pkgJson('package.json', { private: true, workspaces: ['packages/*'] });
    pkgJson('packages/a/package.json', { name: 'a' });
    pkgJson('marker/package.json', { private: true, type: 'module' });
    pkgJson('empty/package.json', { dependencies: {}, devDependencies: {} });
    write('packages/a/index.ts');
    const pkgs = readRepoManifests(root, warn);
    expect(pkgs.map((p) => p.name)).toEqual(['a']);
    expect(warnings).toEqual([
      'empty/package.json: no "name" and no dependencies, skipped',
      'marker/package.json: no "name" and no dependencies, skipped',
      'package.json: no "name" and no dependencies, skipped',
    ]);
  });

  it('a package without a name but with dependencies is a private consumer-only package under a synthetic name', () => {
    // supabase multiplayer.dev, hack-the-base/dec-24, realtime/assets: nameless apps
    // importing @supabase/ssr / @supabase/realtime-js. Skipping them hid those uses.
    pkgJson('package.json', { private: false, main: 'src/index.ts', dependencies: { '@acme/ssr': '^1' }, devDependencies: { vite: '5' } });
    write('src/index.ts');
    pkgJson('assets/package.json', { devDependencies: { '@acme/realtime': 'file:../lib' } });
    write('assets/js/app.js');
    const logs: string[] = [];
    const pkgs = readRepoManifests(root, warn, listFiles(root), { log: (l) => logs.push(l) });
    expect(pkgs).toEqual([
      {
        manager: 'npm', name: '_unnamed/.', version: null, visibility: 'private', isLibrary: false, path: '.', manifest: 'package.json',
        entryPoints: [], unresolvedEntryPoints: [], runtimeEntryPoints: [],
        deps: [{ name: '@acme/ssr', manager: 'npm', constraint: '^1' }, { name: 'vite', manager: 'npm', constraint: '5', dev: true }],
      },
      {
        manager: 'npm', name: '_unnamed/assets', version: null, visibility: 'private', isLibrary: false, path: 'assets', manifest: 'assets/package.json',
        entryPoints: [], unresolvedEntryPoints: [], runtimeEntryPoints: [],
        deps: [{ name: '@acme/realtime', manager: 'npm', constraint: 'file:../lib', dev: true }],
      },
    ]);
    expect(warnings).toEqual([]);
    expect(logs).toEqual([
      'assets/package.json: no "name"; indexed as the consumer-only package _unnamed/assets (private, no export surface)',
      'package.json: no "name"; indexed as the consumer-only package _unnamed/. (private, no export surface)',
    ]);
  });

  it('ignores Rust crates\' test_cases/ fixture manifests (supabase/edge-runtime)', () => {
    pkgJson('crates/base/test_cases/commonjs-workspace/say/package.json', { name: 'say', main: 'index.js' });
    write('crates/base/test_cases/commonjs-workspace/say/index.js');
    pkgJson('packages/test_cases/package.json', { name: 'test_cases' }); // a packages/ member named like it: kept
    write('packages/test_cases/index.ts');
    expect(readRepoManifests(root, warn).map((p) => p.name)).toEqual(['test_cases']);
  });

  it('a malformed package.json is skipped with a warning and kept as an ignored manifest with unknown deps (fail closed, never an abort)', () => {
    write('package.json', '{ nope');
    pkgJson('pkg/package.json', { name: 'ok' });
    write('pkg/index.ts');
    const r = readRepoManifestsWithIgnored(root, warn);
    expect(r.packages.map((p) => p.name)).toEqual(['ok']);
    expect(r.ignored).toEqual([{
      path: '.', manifest: 'package.json', manager: 'npm', name: null, deps: [], depsUnknown: true, reason: expect.stringMatching(/^cannot parse: /),
    }]);
    expect(warnings).toEqual([expect.stringMatching(/^package\.json: cannot parse \(.*\); not an org package: its deps are unknown/)]);
    // readNpmPackage alone still throws (the promotion pass catches it).
    expect(() => readNpmPackage(root, '.', null)).toThrow(/cannot parse package\.json/);
  });

  it('a mason template manifest ({{…}} name) is no package, and names with {{ are never accepted', () => {
    pkgJson('tpl/package.json', { name: '{{project_name.paramCase()}}', dependencies: { '@acme/x': '^1' } });
    write('app/pubspec.yaml', 'name: {{project_name.snakeCase()}}_android\n');
    write('app/lib/a.dart');
    const r = readRepoManifestsWithIgnored(root, warn);
    expect(r.packages).toEqual([]);
    expect(r.ignored.map((m) => [m.manifest, m.name, m.deps.map((d) => d.name), m.reason])).toEqual([
      ['app/pubspec.yaml', '{{project_name.snakeCase()}}_android', [], 'template name {{project_name.snakeCase()}}_android'],
      ['tpl/package.json', '{{project_name.paramCase()}}', ['@acme/x'], 'template name {{project_name.paramCase()}}'],
    ]);
  });
});

describe('pub manifests', () => {
  it('parses name/version/deps incl. path deps; entry points are lib/*.dart + bin/**', () => {
    write('pkgs/app/pubspec.yaml', `# comment
name: app
version: 1.2.3 # trailing comment
description: >
  folded text: with a colon
  dependencies: not really
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  core:
    path: ../core
  http: ^1.0.0
  quoted: "^2.0.0"
  anyver:
  flutter:
    sdk: flutter
  gitdep:
    git:
      url: https://example.com/x.git
      ref: main
  hosted_dep:
    hosted: https://pub.acme.dev
    version: ^3.0.0
  flow: {path: ../flow}
dev_dependencies:
  http: ^0.1.0
  test: ^1.24.0
flutter:
  assets:
    - images/a.png
    - images/b.png
`);
    write('pkgs/app/lib/app.dart');
    write('pkgs/app/lib/other.dart');
    write('pkgs/app/lib/src/impl.dart');
    write('pkgs/app/lib/readme.md');
    write('pkgs/app/bin/main.dart');
    write('pkgs/app/bin/tools/gen.dart');
    write('pkgs/app/test/app_test.dart');
    const [p] = readRepoManifests(root, warn);
    expect(p).toMatchObject({ manager: 'pub', name: 'app', version: '1.2.3', visibility: 'private', path: 'pkgs/app' });
    expect(p!.entryPoints).toEqual(['pkgs/app/bin/main.dart', 'pkgs/app/bin/tools/gen.dart', 'pkgs/app/lib/app.dart', 'pkgs/app/lib/other.dart']);
    expect(p!.deps).toEqual([
      { name: 'anyver', manager: 'pub', constraint: 'any' },
      { name: 'core', manager: 'pub', constraint: 'path:../core' },
      { name: 'flow', manager: 'pub', constraint: 'path:../flow' },
      { name: 'flutter', manager: 'pub', constraint: 'sdk:flutter' },
      { name: 'gitdep', manager: 'pub', constraint: 'git:https://example.com/x.git' },
      { name: 'hosted_dep', manager: 'pub', constraint: '^3.0.0' },
      { name: 'http', manager: 'pub', constraint: '^1.0.0' },
      { name: 'quoted', manager: 'pub', constraint: '^2.0.0' },
      { name: 'test', manager: 'pub', constraint: '^1.24.0', dev: true },
    ]);
  });

  it('visibility rules', () => {
    expect(pubVisibility(undefined)).toBe('published-public');
    expect(pubVisibility('none')).toBe('private');
    expect(pubVisibility('https://pub.acme.dev')).toBe('published-private');
    expect(pubVisibility('https://pub.dev')).toBe('published-public');
    expect(parsePubspecYaml("name: x\npublish_to: 'none'\n")['publish_to']).toBe('none');
  });

  it('YAML subset: sequences at key indent, block scalars, CRLF', () => {
    const doc = parsePubspecYaml('name: x\r\nplatforms:\r\n- linux\r\n- web\r\nnotes: |\r\n  a: b\r\ndependencies:\r\n  y: 1.0.0\r\n');
    expect(doc).toEqual({ name: 'x', platforms: null, notes: null, dependencies: { y: '1.0.0' } });
  });

  it('an application without publish_to is private: lib/main.dart with main, a Flutter app section, mason hooks', () => {
    const read = (files: Record<string, string>) => (rel: string): string | null => files[rel] ?? null;
    const doc = (y: string) => parsePubspecYaml(y);
    expect(pubApplicationReason(doc('name: a\n'), ['lib/main.dart'], read({ 'lib/main.dart': 'void main() => runApp(const App());\n' })))
      .toBe('lib/main.dart declares main');
    expect(pubApplicationReason(doc('name: a\n'), ['lib/main.dart'], read({ 'lib/main.dart': 'Future<void> main() async {}\n' })))
      .toBe('lib/main.dart declares main');
    // An analyzer plugin's lib/main.dart declares `plugin`, not main: a library.
    expect(pubApplicationReason(doc('name: a\n'), ['lib/main.dart'], read({ 'lib/main.dart': 'final plugin = P();\nvoid mainly() {}\n' }))).toBeNull();
    expect(pubApplicationReason(doc('name: a\nflutter:\n  uses-material-design: true\n'), ['lib/main.dart'], read({})))
      .toBe('flutter: uses-material-design and no library besides lib/main.dart');
    expect(pubApplicationReason(doc('name: a\nflutter:\n  assets:\n    - images/\n'), ['lib/src/app.dart'], read({})))
      .toBe('flutter: assets and no library besides lib/main.dart');
    // A Flutter package with public libraries and assets is a library.
    expect(pubApplicationReason(doc('name: a\nflutter:\n  assets:\n    - images/\n'), ['lib/a.dart'], read({}))).toBeNull();
    expect(pubApplicationReason(doc('name: h\ndependencies:\n  mason: ^0.1.0\n'), ['pre_gen.dart'], read({})))
      .toBe('mason hooks: pre_gen.dart / post_gen.dart');
    expect(pubApplicationReason(doc('name: h\n'), ['pre_gen.dart'], read({}))).toBeNull();

    write('app/pubspec.yaml', 'name: app\n');
    write('app/lib/main.dart', 'void main() {}\n');
    write('app/lib/src/x.dart');
    write('pubapp/pubspec.yaml', 'name: pubapp\npublish_to: https://pub.acme.dev\n'); // explicit publish_to wins
    write('pubapp/lib/main.dart', 'void main() {}\n');
    write('lib1/pubspec.yaml', 'name: lib1\n');
    write('lib1/lib/lib1.dart');
    const logs: string[] = [];
    expect(readRepoManifests(root, warn, listFiles(root), { log: (l) => logs.push(l) }).map((p) => [p.name, p.visibility])).toEqual([
      ['app', 'private'], ['lib1', 'published-public'], ['pubapp', 'published-private'],
    ]);
    expect(logs).toEqual(['app/pubspec.yaml: an application (lib/main.dart declares main) without publish_to: treated as private']);
  });

  it('skips a pubspec without a name, with a warning', () => {
    write('pubspec.yaml', 'dependencies:\n  a: any\n');
    expect(readRepoManifests(root, warn)).toEqual([]);
    expect(warnings).toEqual(['pubspec.yaml: no "name", skipped']);
  });
});
