import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFiles, npmVisibility, parsePubspecYaml, pubVisibility, readRepoManifests } from '../src/manifests.ts';

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
  it('skips dependency, build and VCS dirs', () => {
    for (const d of ['node_modules', '.dart_tool', 'build', 'dist', '.git', 'vendor', 'third_party']) write(`${d}/x/package.json`, '{}');
    write('pkgs/a/node_modules/b/package.json', '{}');
    write('pkgs/a/src/x.ts');
    expect(listFiles(root)).toEqual(['pkgs/a/src/x.ts']);
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

  it('deps: all four fields, constraint verbatim, first non-dev field wins, sorted', () => {
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
      { name: 'onlydev', manager: 'npm', constraint: '1' },
      { name: 'shared', manager: 'npm', constraint: '>=1' },
      { name: 'z', manager: 'npm', constraint: '^9' },
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
      { name: 'test', manager: 'pub', constraint: '^1.24.0' },
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
