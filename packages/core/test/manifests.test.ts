import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IGNORE_MANIFEST_DIRS, listFiles, npmVisibility, parsePubspecYaml, pubVisibility, readRepoManifests, readRepoManifestsWithIgnored,
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
    expect(listFiles(root)).toEqual([
      '.gitignore', 'a/c.ts', 'a-b.ts', 'packages/build/package.json', 'packages/build/src/index.ts', 'untracked.ts', 'vendor/lib/x.ts',
    ]);
  });
});

describe('ignored manifest dirs', () => {
  it('the default list covers test-data dirs (test_fixtures, testdata, goldens, …)', () => {
    for (const d of ['test_fixtures', 'test_fixture', 'testdata', 'test_data', 'golden', 'goldens', 'fixtures', 'test']) {
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
      { path: 'examples/demo', manifest: 'examples/demo/package.json', manager: 'npm', name: 'demo', depsUnknown: false, deps: [
        { name: 'real', manager: 'npm', constraint: '^1' },
        { name: 'vitest', manager: 'npm', constraint: '^1', dev: true },
      ] },
      { path: 'fixtures/bad', manifest: 'fixtures/bad/package.json', manager: 'npm', name: null, deps: [], depsUnknown: true },
      { path: 'gen/x', manifest: 'gen/x/package.json', manager: 'npm', name: null, depsUnknown: false, deps: [
        { name: 'real', manager: 'npm', constraint: '*' },
      ] },
      { path: 'templates/app', manifest: 'templates/app/pubspec.yaml', manager: 'pub', name: 'app', depsUnknown: false, deps: [
        { name: 'real_pub', manager: 'pub', constraint: 'path:../..' },
        { name: 'test', manager: 'pub', constraint: 'any', dev: true },
      ] },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^fixtures\/bad\/package\.json \(ignored manifest\): cannot parse: .*; its deps are unknown$/);
    expect(readRepoManifests(root, () => {}, listFiles(root))).toEqual(r.packages);
  });

  it('manifests under default ignore dirs (any depth) are skipped with one log line; their files are still listed', () => {
    pkgJson('package.json', { name: 'real', main: 'src/index.ts' });
    write('src/index.ts');
    for (const d of DEFAULT_IGNORE_MANIFEST_DIRS) pkgJson(`pkgs/${d}/x/package.json`, { name: `dup-${d}` });
    write('templates/vercel/pubspec.yaml', 'name: real\n');
    write('templates/vercel/lib/a.dart');
    write('examples/basic/src/main.ts');
    pkgJson('packages/testing/package.json', { name: 'testing' }); // "testing" is not "test"
    write('packages/testing/index.ts');
    const logs: string[] = [];
    const pkgs = readRepoManifests(root, warn, listFiles(root), { log: (l) => logs.push(l) });
    expect(pkgs.map((p) => p.name)).toEqual(['real', 'testing']);
    expect(logs).toEqual([
      `skipped ${DEFAULT_IGNORE_MANIFEST_DIRS.length + 1} manifest(s) as not org packages (ignoreManifestDirs/ignoreManifests): `
        + 'pkgs/__fixtures__/x/package.json, pkgs/__mocks__/x/package.json, pkgs/__tests__/x/package.json, ...',
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

  it('bin as an object and as a string, browser only if a string', () => {
    pkgJson('a/package.json', { name: 'a', bin: { one: './cli/one.js', two: 'cli/two' }, browser: { './x.js': false } });
    write('a/cli/one.js');
    write('a/cli/two');
    write('a/x.js');
    pkgJson('b/package.json', { name: 'b', bin: 'cli.mjs', browser: 'browser.js' });
    write('b/cli.mjs');
    write('b/browser.js');
    const [a, b] = readRepoManifests(root, warn);
    expect(a!.entryPoints).toEqual(['a/cli/one.js', 'a/cli/two']);
    expect(b!.entryPoints).toEqual(['b/browser.js', 'b/cli.mjs']);
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
    expect(readRepoManifests(root, warn)[0]!.entryPoints).toEqual(['src/cli.ts', 'src/esm/mod.ts', 'src/index.ts', 'src/ui.tsx']);
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

  it('skips a package without a name, with a warning', () => {
    pkgJson('package.json', { private: true, workspaces: ['packages/*'] });
    pkgJson('packages/a/package.json', { name: 'a' });
    write('packages/a/index.ts');
    const pkgs = readRepoManifests(root, warn);
    expect(pkgs.map((p) => p.name)).toEqual(['a']);
    expect(warnings).toEqual(['package.json: no "name", skipped']);
  });

  it('a malformed package.json is an error (fail closed)', () => {
    write('package.json', '{ nope');
    expect(() => readRepoManifests(root, warn)).toThrow(/cannot parse package\.json/);
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

  it('skips a pubspec without a name, with a warning', () => {
    write('pubspec.yaml', 'dependencies:\n  a: any\n');
    expect(readRepoManifests(root, warn)).toEqual([]);
    expect(warnings).toEqual(['pubspec.yaml: no "name", skipped']);
  });
});
