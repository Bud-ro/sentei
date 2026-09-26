import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_IGNORE_MANIFEST_DIRS, listFiles, npmVisibility, parsePubspecYaml, pubVisibility, readRepoManifests, readRepoManifestsWithIgnored,
  dockerfileTargets, runnerTargets, sourceForBuildOutput, stripJsonc, tsconfigOutDirs,
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
    expect(sourceForBuildOutput(root, 'pkgs/sb', '../escape')).toBeNull();
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
    expect(logs.some((l) => l.startsWith('app/package.json: client entry points from index.html / vite.config: app/pages/p.ts'))).toBe(true);
    expect(p!.runtimeEntryPoints).toEqual(p!.entryPoints);
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
