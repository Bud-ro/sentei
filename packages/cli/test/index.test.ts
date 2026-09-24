import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageContext } from '../src/context.ts';
import { readScipIndex } from '@sentei/core/scip';
import { isCached } from '../src/indexers/cache.ts';
import { install, scipTypescript, type ExecResult, type Runner } from '../src/indexers/scip-typescript.ts';
import type { DiscoverFile, DiscoveredRepo, ExportsSidecar } from '../src/indexers/types.ts';
import { index, type RepoIndex } from '../src/stages/index.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/org-small');
/** Copy options that never carry a node_modules left in the fixture by a manual run. */
const NO_NODE_MODULES = { recursive: true, filter: (src: string) => path.basename(src) !== 'node_modules' };

let tmp: string;
let work: string;
let lines: string[];

function ctx(): StageContext {
  // The index stage does not touch the database.
  return { work, dbPath: path.join(work, 'sentei.db'), db: undefined as unknown as DatabaseSync, log: (l) => lines.push(l) };
}

function readJson<T>(...p: string[]): T {
  return JSON.parse(readFileSync(path.join(...p), 'utf8')) as T;
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-index-')));
  for (const r of ['app', 'lib-core']) {
    cpSync(path.join(FIXTURE, 'repos', r), path.join(tmp, 'repos', r), NO_NODE_MODULES);
  }
  work = path.join(tmp, 'work');
  mkdirSync(work);
  // A stale link in the way must be replaced.
  mkdirSync(path.join(tmp, 'repos/app/node_modules/@acme'), { recursive: true });
  symlinkSync('../../../nowhere', path.join(tmp, 'repos/app/node_modules/@acme/core'));

  const discover: DiscoverFile = {
    org: 'acme',
    repos: [
      {
        repo: 'acme/lib-core',
        localPath: path.join(tmp, 'repos/lib-core'),
        defaultBranch: 'main',
        headSha: 'sha-lib',
        packages: [
          {
            packageId: 'npm:@acme/core',
            path: '.',
            manager: 'npm',
            name: '@acme/core',
            version: '1.0.0',
            visibility: 'private',
            entryPoints: ['src/index.ts'],
            deps: [],
          },
        ],
      },
      {
        repo: 'acme/app',
        localPath: path.join(tmp, 'repos/app'),
        defaultBranch: 'main',
        headSha: 'sha-app',
        packages: [
          {
            packageId: 'npm:@acme/app',
            path: '.',
            manager: 'npm',
            name: '@acme/app',
            version: '1.0.0',
            visibility: 'private',
            entryPoints: ['src/main.ts'],
            deps: [{ name: '@acme/core', manager: 'npm', constraint: '^1.0.0', resolvedPackageId: 'npm:@acme/core' }],
          },
          {
            // No indexer owns pub packages in M1.
            packageId: 'pub:app_tool',
            path: 'tool',
            manager: 'pub',
            name: 'app_tool',
            entryPoints: [],
            deps: [],
          },
        ],
      },
    ],
  };
  writeFileSync(path.join(work, 'discover.json'), JSON.stringify(discover, null, 2));
  lines = [];
  await index(ctx());
}, 30_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('index stage on fixtures/org-small', () => {
  it('writes non-empty .scip files for both packages', () => {
    for (const f of ['acme__lib-core/acme__core.scip', 'acme__app/acme__app.scip']) {
      const p = path.join(work, 'index', f);
      expect(existsSync(p), f).toBe(true);
      expect(statSync(p).size, f).toBeGreaterThan(0);
    }
  });

  it('records ok statuses in index.json, and failed/no indexer for an unowned package', () => {
    const lib = readJson<RepoIndex>(work, 'index/acme__lib-core/index.json');
    expect(lib).toMatchObject({ repo: 'acme/lib-core', headSha: 'sha-lib', status: 'ok' });
    expect(lib.packages).toEqual([
      expect.objectContaining({
        packageId: 'npm:@acme/core',
        indexer: 'scip-typescript',
        indexerVersion: '0.4.0',
        status: 'ok',
        scip: 'acme__core.scip',
        exports: 'acme__core.exports.json',
      }),
    ]);
    const app = readJson<RepoIndex>(work, 'index/acme__app/index.json');
    expect(app.status).toBe('failed');
    expect(app.packages.map((p) => [p.packageId, p.status])).toEqual([
      ['npm:@acme/app', 'ok'],
      ['pub:app_tool', 'failed'],
    ]);
    expect(app.packages[1]!.diagnostics).toEqual(['error: no indexer']);
    expect(lines.some((l) => l.includes('npm:@acme/core: ok'))).toBe(true);
  });

  it('lists exactly the lib export surface with export sites in the entry file', () => {
    const sidecar = readJson<ExportsSidecar>(work, 'index/acme__lib-core/acme__core.exports.json');
    expect(sidecar.packageId).toBe('npm:@acme/core');
    expect(sidecar.entryPoints).toEqual(['src/index.ts']);
    expect(sidecar.unresolved).toEqual([]);
    expect(sidecar.exports.map((e) => e.name).sort()).toEqual(['internalOnlyFn', 'unusedFn', 'usedFn']);
    for (const e of sidecar.exports) {
      expect(e).toMatchObject({ entry: 'src/index.ts', exportedAs: e.name, file: 'src/fns.ts' });
      expect(e.sites).toHaveLength(1);
      expect(e.sites[0]!.file).toBe('src/index.ts');
      expect(e.sites[0]!.line).toBe(1);
    }
    const used = sidecar.exports.find((e) => e.name === 'usedFn')!;
    expect([used.line, used.col]).toEqual([3, 16]); // `export function usedFn` on line 4
    expect(used.sites[0]!.col).toBe('export { '.length);
  });

  it('source-links the org dependency into the consumer, replacing a stale link', () => {
    const link = path.join(tmp, 'repos/app/node_modules/@acme/core');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(path.join('..', '..', '..', 'lib-core'));
    expect(realpathSync(link)).toBe(path.join(tmp, 'repos/lib-core'));
    const app = readJson<RepoIndex>(work, 'index/acme__app/index.json');
    expect(app.packages[0]!.diagnostics).toContain('info: replaced stale symlink node_modules/@acme/core');
  });

  it('skips a repo whose index.json matches headSha and indexer versions', async () => {
    lines = [];
    await index(ctx());
    expect(lines).toEqual([
      '[index] acme/lib-core: cached at sha-lib (use --force to re-index)',
      '[index] acme/app: cached at sha-app (use --force to re-index)',
    ]);
  });
});

describe('consumer checks and import sites', () => {
  let root: string;
  let cwork: string;
  const TSCONFIG = JSON.stringify({
    compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [] },
    include: ['src'],
  });
  const CONSUMERS: Record<string, string> = {
    // Subpath of an org package that does not exist: references silently dropped.
    'bad-module': `import { usedFn } from '@acme/core/nope';\nusedFn(1);\n`,
    // Version skew: removedFn is not exported by @acme/core.
    skew: `import { usedFn, removedFn as gone } from '@acme/core';\nusedFn(gone(1));\n`,
    // A plain type error unrelated to symbol linking.
    typeerr: `import { usedFn } from '@acme/core';\nconst n: number = 'x';\nusedFn(n);\n`,
    dyn: [
      `import * as core from '@acme/core';`,
      `declare const require: (s: string) => unknown;`,
      `declare const x: string;`,
      `const k = 'usedFn' as keyof typeof core;`,
      `core[k](1);`, // flag: computed key
      `core['usedFn'](1);`,
      `core.usedFn(1);`,
      `type T = typeof core;`,
      `export const keys: T | string[] = Object.keys(core);`, // flag: value use
      `require('@acme/' + x);`, // flag: may reach an org package
      `require('./' + x);`,
      'import(`../${x}`);',
      `require('lodash');`,
      '',
    ].join('\n'),
  };

  function writePkg(dir: string, name: string, files: Record<string, string>, deps: Record<string, string> = {}): void {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', private: true, type: 'module', types: 'src/index.ts', dependencies: deps }));
    writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG);
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, 'src', f), body);
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-consumer-')));
    cpSync(path.join(FIXTURE, 'repos', 'lib-core'), path.join(root, 'repos', 'lib-core'), NO_NODE_MODULES);
    writePkg(path.join(root, 'repos', 'lib-reexp'), '@acme/reexp', {
      'a.ts': `export function a(): number { return 1; }\nexport default function d(): number { return 2; }\n`,
      'index.ts': `import { a as aa } from './a';\nimport d from './a';\nexport { aa, d };\n`,
    });
    const libPkg = (repo: string, packageId: string, name: string, entry: string) => ({
      repo: `acme/${repo}`,
      localPath: path.join(root, 'repos', repo),
      headSha: null,
      packages: [{ packageId, path: '.', manager: 'npm', name, entryPoints: [entry], deps: [] as DiscoverFile['repos'][number]['packages'][number]['deps'] }],
    });
    const repos: DiscoverFile['repos'] = [
      libPkg('lib-core', 'npm:@acme/core', '@acme/core', 'src/index.ts'),
      libPkg('lib-reexp', 'npm:@acme/reexp', '@acme/reexp', 'src/index.ts'),
    ];
    for (const [name, body] of Object.entries(CONSUMERS)) {
      writePkg(path.join(root, 'repos', name), `@acme/${name}`, { 'main.ts': body }, { '@acme/core': '^1.0.0' });
      const r = libPkg(name, `npm:@acme/${name}`, `@acme/${name}`, 'src/main.ts');
      r.packages[0]!.deps = [{ name: '@acme/core', manager: 'npm', resolvedPackageId: 'npm:@acme/core' }];
      repos.push(r);
    }
    // Transitive resolution: `chain` (listed first) imports @acme/mid, which re-exports
    // from @acme/core through mid's own node_modules link.
    writePkg(path.join(root, 'repos', 'mid'), '@acme/mid', { 'index.ts': `export { usedFn as midFn } from '@acme/core';\n` }, { '@acme/core': '^1.0.0' });
    writePkg(path.join(root, 'repos', 'chain'), '@acme/chain', { 'main.ts': `import { midFn } from '@acme/mid';\nmidFn(1);\n` }, { '@acme/mid': '^1.0.0' });
    const mid = libPkg('mid', 'npm:@acme/mid', '@acme/mid', 'src/index.ts');
    mid.packages[0]!.deps = [{ name: '@acme/core', manager: 'npm', resolvedPackageId: 'npm:@acme/core' }];
    const chain = libPkg('chain', 'npm:@acme/chain', '@acme/chain', 'src/main.ts');
    chain.packages[0]!.deps = [{ name: '@acme/mid', manager: 'npm', resolvedPackageId: 'npm:@acme/mid' }];
    repos.unshift(chain);
    repos.push(mid);
    // Namespace member access to an alias re-export (scip-typescript 0.4.0 gap).
    writePkg(path.join(root, 'repos', 'nslib'), '@acme/nslib', {
      'a.ts': `export function a(): number { return 1; }\n`,
      'b.ts': `export function b(): number { return 2; }\n`,
      'index.ts': `export { a } from './a';\nexport * from './b';\n`,
    });
    writePkg(path.join(root, 'repos', 'nsuser'), '@acme/nsuser', { 'main.ts': `import * as ns from '@acme/nslib';\nns.a();\nns.b();\nns['a']();\n` }, { '@acme/nslib': '^1.0.0' });
    repos.push(libPkg('nslib', 'npm:@acme/nslib', '@acme/nslib', 'src/index.ts'));
    const nsuser = libPkg('nsuser', 'npm:@acme/nsuser', '@acme/nsuser', 'src/main.ts');
    nsuser.packages[0]!.deps = [{ name: '@acme/nslib', manager: 'npm', resolvedPackageId: 'npm:@acme/nslib' }];
    repos.push(nsuser);
    cwork = path.join(root, 'work');
    mkdirSync(cwork);
    writeFileSync(path.join(cwork, 'discover.json'), JSON.stringify({ org: 'acme', repos }));
    const c = { work: cwork, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} };
    await index(c, { install: false });
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const result = (repo: string, pkg = repo) => ({
    index: readJson<RepoIndex>(cwork, 'index', `acme__${repo}`, 'index.json'),
    sidecar: readJson<ExportsSidecar>(cwork, 'index', `acme__${repo}`, `acme__${pkg}.exports.json`),
  });

  it('an unresolved org module makes the package partial', () => {
    const { index: ix } = result('bad-module');
    expect(ix.status).toBe('partial');
    expect(ix.packages[0]!.diagnostics).toContain("error: unresolved org module '@acme/core/nope' at src/main.ts:1:24");
  });

  it('a missing named import is recorded in unresolvedImports without changing status', () => {
    const { index: ix, sidecar } = result('skew');
    expect(ix.status).toBe('ok');
    expect(sidecar.unresolvedImports).toEqual([
      { module: '@acme/core', name: 'removedFn', file: 'src/main.ts', line: 0, col: 17 },
    ]);
    expect(ix.packages[0]!.diagnostics.some((d) => d.startsWith("warn: 'removedFn' is not exported"))).toBe(true);
  });

  it('a plain type error is a warning only', () => {
    const { index: ix, sidecar } = result('typeerr');
    expect(ix.status).toBe('ok');
    expect(sidecar.unresolvedImports).toEqual([]);
    expect(ix.packages[0]!.diagnostics.some((d) => /^warn: src\/main\.ts:2:7 TS2322/.test(d))).toBe(true);
  });

  it('flags dynamic namespace use and computed require/import, and nothing else', () => {
    const { index: ix, sidecar } = result('dyn');
    expect(ix.status).toBe('ok');
    expect(sidecar.flags.map((f) => [f.flag, f.line, f.col])).toEqual([
      ['namespace_dynamic', 4, 0], // core[k]
      ['namespace_dynamic', 8, 46], // Object.keys(core)
      ['dynamic_access', 9, 0], // require('@acme/' + x)
    ]);
    expect(sidecar.flags[0]!.reason).toContain('computed key');
    expect(sidecar.flags[2]!.reason).toContain("require() with a non-literal specifier: '@acme/' + x");
  });

  it('links every org package before indexing any (transitive re-exports resolve regardless of order)', () => {
    const { index: ix, sidecar } = result('chain');
    expect(ix.status).toBe('ok');
    expect(sidecar.unresolvedImports).toEqual([]);
  });

  it('records namespace member accesses resolved to org declarations', () => {
    const { index: ix, sidecar } = result('nsuser');
    expect(ix.status).toBe('ok');
    const target = (targetFile: string) => ({ targetPackage: '@acme/nslib', targetFile, targetLine: 0, targetCol: 16 });
    expect(sidecar.namespaceMemberRefs).toEqual([
      { file: 'src/main.ts', line: 1, col: 3, member: 'a', ...target('src/a.ts') },
      { file: 'src/main.ts', line: 2, col: 3, member: 'b', ...target('src/b.ts') },
      { file: 'src/main.ts', line: 3, col: 3, member: 'a', ...target('src/a.ts') }, // ns['a']: the string literal
    ]);
    expect(sidecar.flags).toEqual([]);
    // A non-namespace package records none.
    expect(result('skew').sidecar.namespaceMemberRefs).toEqual([]);
  });

  it('records import bindings in re-exporting entry files as sites', () => {
    const { index: ix, sidecar } = result('lib-reexp', 'reexp');
    expect(ix.status).toBe('ok');
    const byName = Object.fromEntries(sidecar.exports.map((e) => [e.exportedAs, e]));
    expect(byName.aa).toMatchObject({ name: 'a', file: 'src/a.ts', line: 0, col: 16 });
    expect(byName.aa!.sites.map((s) => [s.file, s.line, s.col])).toEqual([
      ['src/index.ts', 0, 9], // import { a
      ['src/index.ts', 0, 14], // as aa }
      ['src/index.ts', 2, 9], // export { aa
    ]);
    expect(byName.d).toMatchObject({ name: 'd', file: 'src/a.ts', line: 1, col: 24 });
    expect(byName.d!.sites.map((s) => [s.line, s.col])).toEqual([
      [1, 7], // import d
      [2, 13], // export { ..., d }
    ]);
  });
});

describe('real-org fixes (honojs dogfood)', () => {
  let root: string;
  let hwork: string;
  const TSCONFIG = {
    compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [] },
    include: ['src'],
  };
  type Pkg = DiscoverFile['repos'][number]['packages'][number];
  const repos: DiscoverFile['repos'] = [];

  /** Writes `repos/<repo>/<file>` for each entry. */
  function write(repo: string, files: Record<string, string | object>): void {
    for (const [f, body] of Object.entries(files)) {
      const abs = path.join(root, 'repos', repo, ...f.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
  }
  function addRepo(repo: string, pkg: Partial<Pkg> & { name: string; entryPoints: string[] }, deps: string[] = []): void {
    repos.push({
      repo: `acme/${repo}`,
      localPath: path.join(root, 'repos', repo),
      headSha: null,
      packages: [
        {
          packageId: `npm:${pkg.name}`,
          path: '.',
          manager: 'npm',
          version: '1.0.0',
          deps: deps.map((d) => ({ name: d, manager: 'npm', resolvedPackageId: `npm:${d}` })),
          ...pkg,
        },
      ],
    });
  }
  const result = (repo: string, pkg: string) => ({
    index: readJson<RepoIndex>(hwork, 'index', `acme__${repo}`, 'index.json'),
    sidecar: readJson<ExportsSidecar>(hwork, 'index', `acme__${repo}`, `${pkg}.exports.json`),
  });

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-hono-')));

    // (1) Solution-style tsconfig: no files of its own, two referenced projects.
    write('solution', {
      'package.json': { name: '@acme/solution', version: '1.0.0', type: 'module' },
      'tsconfig.json': { files: [], references: [{ path: './tsconfig.a.json' }, { path: './packages-b' }] },
      'tsconfig.a.json': { ...TSCONFIG, include: ['src/a'] },
      'packages-b/tsconfig.json': { ...TSCONFIG, include: ['../src/b'] },
      'src/a/index.ts': `export function fromA(): number { return 1; }\n`,
      'src/b/index.ts': `export function fromB(): number { return 2; }\n`,
    });
    addRepo('solution', { name: '@acme/solution', entryPoints: ['src/a/index.ts', 'src/b/index.ts'] });

    // (2) A lib whose package.json points at unbuilt dist/ output, and its consumer.
    write('unbuilt', {
      'package.json': {
        name: '@acme/unbuilt',
        version: '2.0.0',
        type: 'module',
        main: 'dist/cjs/index.js',
        types: 'dist/types/index.d.ts',
        exports: {
          '.': { types: './dist/types/index.d.ts', import: './dist/index.js', require: './dist/cjs/index.js' },
          './sub': { types: './dist/types/sub.d.ts', import: './dist/sub.js' },
          './utils/*': { import: './dist/utils/*.js' },
          './package.json': './package.json',
        },
      },
      'tsconfig.json': TSCONFIG,
      'README.md': '# unbuilt\n',
      'src/index.ts': `export class Foo { run(): number { return 1; } }\n`,
      'src/sub.ts': `export function bar(): number { return 2; }\n`,
      'src/utils/text.ts': `export function upper(s: string): string { return s.toUpperCase(); }\n`,
    });
    addRepo('unbuilt', { name: '@acme/unbuilt', entryPoints: ['src/index.ts', 'src/sub.ts', 'src/utils/text.ts'] });
    // A lib whose declared targets all exist keeps a plain symlink.
    write('built', {
      'package.json': { name: '@acme/built', version: '1.0.0', type: 'module', types: 'src/index.ts', exports: { '.': './src/index.ts' } },
      'tsconfig.json': TSCONFIG,
      'src/index.ts': `export const built = 1;\n`,
    });
    addRepo('built', { name: '@acme/built', entryPoints: ['src/index.ts'] });

    write('consumer', {
      'package.json': { name: '@acme/consumer', version: '1.0.0', type: 'module' },
      'tsconfig.json': TSCONFIG,
      'src/main.ts': [
        `import { Foo } from '@acme/unbuilt';`,
        `import { bar } from '@acme/unbuilt/sub';`,
        `import { upper } from '@acme/unbuilt/utils/text';`,
        `import { built } from '@acme/built';`,
        `declare const x: string;`,
        // (5c) a data: URL module is not an org package.
        'const url = `data:text/javascript,export default ${x}`;',
        `export const r = [new Foo().run(), bar(), upper('a'), built, import(url)];`,
        '',
      ].join('\n'),
      // (5b) test files do not count as consumers: no flag, no partial.
      'src/main.test.ts': `declare const require: (s: string) => unknown;\ndeclare const y: string;\nrequire('@acme/' + y);\nimport { nope } from '@acme/unbuilt/missing';\nnope();\n`,
      // (4) config files outside every tsconfig.
      'eslint.config.mjs': `import config from '@acme/built';\nimport self from '@acme/consumer/x';\nexport default [...config, self];\n`,
      'scripts/gen.cjs': `const { Foo } = require("@acme/unbuilt/sub");\nrequire('lodash');\n`,
      'test/setup.test.mjs': `import '@acme/built';\n`,
      'docs/example.mjs': `export * from '@acme/built';\n`,
      'dist/bundle.js': `import '@acme/built';\n`,
    });
    addRepo('consumer', { name: '@acme/consumer', entryPoints: ['src/main.ts'] }, ['@acme/unbuilt', '@acme/built']);
    // A stale shadow left by a previous run is ours and gets replaced.
    write('consumer', { 'node_modules/@acme/unbuilt/.sentei-shadow': '', 'node_modules/@acme/unbuilt/stale.txt': 'x' });

    hwork = path.join(root, 'work');
    mkdirSync(hwork);
    writeFileSync(path.join(hwork, 'discover.json'), JSON.stringify({ org: 'acme', repos }));
    await index({ work: hwork, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} }, { install: false });
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('(1) reads the export surface of a solution-style tsconfig from its referenced projects', () => {
    const { index: ix, sidecar } = result('solution', 'acme__solution');
    expect(ix.status).toBe('ok');
    expect(sidecar.entryPoints).toEqual(['src/a/index.ts', 'src/b/index.ts']);
    expect(sidecar.missingEntryPoints).toEqual([]);
    expect(sidecar.exports.map((e) => [e.entry, e.name, e.file])).toEqual([
      ['src/a/index.ts', 'fromA', 'src/a/index.ts'],
      ['src/b/index.ts', 'fromB', 'src/b/index.ts'],
    ]);
    expect(sidecar.unindexedImports).toEqual([]);
  });

  it('(2) shadows an unbuilt org lib: rewritten package.json, symlinked contents, checkout symbols', () => {
    const shadow = path.join(root, 'repos/consumer/node_modules/@acme/unbuilt');
    expect(lstatSync(shadow).isDirectory()).toBe(true);
    expect(existsSync(path.join(shadow, '.sentei-shadow'))).toBe(true);
    expect(existsSync(path.join(shadow, 'stale.txt'))).toBe(false);
    expect(existsSync(path.join(shadow, 'node_modules'))).toBe(false);
    expect(lstatSync(path.join(shadow, 'package.json')).isSymbolicLink()).toBe(false);
    for (const e of ['src', 'README.md', 'tsconfig.json']) {
      expect(lstatSync(path.join(shadow, e)).isSymbolicLink(), e).toBe(true);
    }
    expect(realpathSync(path.join(shadow, 'src'))).toBe(path.join(root, 'repos/unbuilt/src'));
    const pj = readJson<Record<string, unknown>>(shadow, 'package.json');
    expect(pj).toMatchObject({
      name: '@acme/unbuilt',
      version: '2.0.0',
      type: 'module',
      main: 'src/index.ts',
      types: 'src/index.ts',
      exports: {
        '.': { types: './src/index.ts', import: './src/index.ts', require: './src/index.ts' },
        './sub': { types: './src/sub.ts', import: './src/sub.ts' },
        './utils/*': { import: './src/utils/*.ts' },
        './package.json': './package.json',
      },
    });

    // A lib with every declared target present keeps a plain symlink.
    const plain = path.join(root, 'repos/consumer/node_modules/@acme/built');
    expect(lstatSync(plain).isSymbolicLink()).toBe(true);
    expect(realpathSync(plain)).toBe(path.join(root, 'repos/built'));

    const { index: ix, sidecar } = result('consumer', 'acme__consumer');
    expect(ix.status).toBe('ok');
    expect(ix.packages[0]!.diagnostics.some((d) => d.startsWith('info: node_modules/@acme/unbuilt is a shadow of'))).toBe(true);
    expect(sidecar.flags).toEqual([]);

    // The consumer's reference is the lib's own definition symbol string.
    const libIndex = readScipIndex(path.join(hwork, 'index/acme__unbuilt/acme__unbuilt.scip'));
    const defs = libIndex.documents.flatMap((d) => d.occurrences.filter((o) => (o.symbolRoles & 1) === 1).map((o) => o.symbol));
    const fooDef = defs.find((s) => s.endsWith('/Foo#'));
    expect(fooDef).toBe('scip-typescript npm @acme/unbuilt 2.0.0 src/`index.ts`/Foo#');
    const consumerIndex = readScipIndex(path.join(hwork, 'index/acme__consumer/acme__consumer.scip'));
    const main = consumerIndex.documents.find((d) => d.relativePath === 'src/main.ts')!;
    const refs = new Set(main.occurrences.map((o) => o.symbol));
    expect(refs.has(fooDef!)).toBe(true);
    expect(refs.has(defs.find((s) => s.endsWith('/bar().'))!)).toBe(true);
    expect(refs.has(defs.find((s) => s.endsWith('/upper().'))!)).toBe(true);
  });

  it('(2) replaces its own shadow on a re-run and never displaces it', async () => {
    const r = repos.find((x) => x.repo === 'acme/consumer')!;
    const byId = new Map(repos.flatMap((x) => x.packages.map((p) => [p.packageId, { repo: x, pkg: p }] as const)));
    const prep = await scipTypescript.prepare!({
      repo: r,
      pkg: r.packages[0]!,
      lookup: (id) => byId.get(id),
      orgPackages: [...byId.values()],
      options: { install: false, maxOldSpaceMb: 1024 },
    });
    expect(prep.status).toBe('ok');
    expect(existsSync(path.join(root, 'repos/consumer/node_modules/.sentei-displaced'))).toBe(false);
    expect(existsSync(path.join(root, 'repos/consumer/node_modules/@acme/unbuilt/.sentei-shadow'))).toBe(true);
    expect(prep.diagnostics.filter((d) => d.includes('@acme/unbuilt'))).toHaveLength(1);
    expect(prep.diagnostics.some((d) => d.includes('displaced') || d.includes('@acme/built'))).toBe(false); // symlink already right
  });

  it('(4) records org imports from code files outside every tsconfig, skipping tests, docs, build output and self-imports', () => {
    const { index: ix, sidecar } = result('consumer', 'acme__consumer');
    expect(sidecar.unindexedImports).toEqual([
      { file: 'eslint.config.mjs', module: '@acme/built', targetPackage: '@acme/built' },
      { file: 'scripts/gen.cjs', module: '@acme/unbuilt/sub', targetPackage: '@acme/unbuilt' },
    ]);
    expect(ix.status).toBe('ok');
    expect(ix.packages[0]!.diagnostics).toContain(
      "warn: eslint.config.mjs is in no tsconfig and imports org module '@acme/built' (unindexed consumer of @acme/built)",
    );
  });

  it('(5b/c) drops flags and unresolved org modules from test files; exempts data: URL imports', () => {
    const { index: ix, sidecar } = result('consumer', 'acme__consumer');
    expect(sidecar.flags).toEqual([]);
    const diags = ix.packages[0]!.diagnostics;
    expect(diags.some((d) => d.startsWith('warn: dynamic_access at src/main.test.ts:3:1') && d.endsWith('dropped)'))).toBe(true);
    expect(diags.some((d) => d.startsWith("warn: unresolved org module '@acme/unbuilt/missing' at src/main.test.ts"))).toBe(true);
    expect(diags.some((d) => d.startsWith('error:'))).toBe(false);
    expect(diags.some((d) => d.includes('import() with a non-literal specifier: url'))).toBe(false);
  });
});

describe('package-manager fallbacks (no network: the runner is faked)', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-pm-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function fakeRunner(missing: string[], calls: Array<[string, string[]]>): Runner {
    return async (cmd, args): Promise<ExecResult> => {
      calls.push([cmd, args]);
      if (missing.includes(cmd)) {
        return { code: -1, signal: null, stdout: '', stderr: `spawn ${cmd} ENOENT\n`, errno: 'ENOENT', errorMessage: `spawn ${cmd} ENOENT` };
      }
      return { code: 0, signal: null, stdout: '', stderr: '' };
    };
  }
  function repo(name: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(path.join(dir, f), body);
    return dir;
  }

  it('(3) runs a missing pnpm through npm exec at the packageManager version', async () => {
    const dir = repo('pnpm-repo', {
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@9.1.0+sha512.abc' }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    });
    const calls: Array<[string, string[]]> = [];
    const diagnostics: string[] = [];
    expect(await install(dir, dir, diagnostics, [], fakeRunner(['pnpm'], calls))).toBe(true);
    expect(calls).toEqual([
      ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
      ['npm', ['exec', '--yes', '--package=pnpm@9.1.0', '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']],
    ]);
    expect(diagnostics).toContain(
      'info: pnpm is not installed (spawn pnpm ENOENT); falling back to npm exec --yes --package=pnpm@9.1.0 (version 9.1.0 from packageManager in package.json)',
    );
  });

  it('(3) uses latest without a packageManager field, and yarn berry through @yarnpkg/cli-dist', async () => {
    const plain = repo('yarn-classic', { 'package.json': '{}', 'yarn.lock': '' });
    const calls: Array<[string, string[]]> = [];
    const diagnostics: string[] = [];
    await install(plain, plain, diagnostics, [], fakeRunner(['yarn'], calls));
    expect(calls[1]).toEqual(['npm', ['exec', '--yes', '--package=yarn@latest', '--', 'yarn', 'install', '--frozen-lockfile', '--ignore-scripts']]);
    expect(diagnostics[0]).toContain('(version latest (no matching packageManager field))');

    const berry = repo('yarn-berry', { 'package.json': JSON.stringify({ packageManager: 'yarn@4.10.3' }), 'yarn.lock': '' });
    const calls2: Array<[string, string[]]> = [];
    await install(berry, berry, [], [], fakeRunner(['yarn'], calls2));
    expect(calls2[1]).toEqual(['npm', ['exec', '--yes', '--package=@yarnpkg/cli-dist@4.10.3', '--', 'yarn', 'install', '--immutable', '--mode=skip-build']]);
  });

  it('(3) skips a bun install with a warning when bun is missing, and names ENOENT when the fallback cannot start', async () => {
    const bun = repo('bun-repo', { 'package.json': '{}', 'bun.lock': '' });
    const diagnostics: string[] = [];
    expect(await install(bun, bun, diagnostics, [], fakeRunner(['bun'], []))).toBe(true);
    expect(diagnostics).toEqual(['warn: bun is not installed (spawn bun ENOENT); install skipped in .']);

    const npmRepo = repo('npm-repo', { 'package.json': '{}', 'package-lock.json': '{}' });
    const d2: string[] = [];
    expect(await install(npmRepo, npmRepo, d2, [], fakeRunner(['npm'], []))).toBe(false);
    expect(d2).toEqual(['error: npm ci --ignore-scripts in . could not start (ENOENT: spawn npm ENOENT)']);
  });
});

describe('index cache', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-cache-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const repo: DiscoveredRepo = {
    repo: 'acme/r',
    localPath: '/nowhere',
    headSha: 'sha1',
    packages: [
      { packageId: 'npm:a', path: '.', manager: 'npm', name: 'a', entryPoints: [], deps: [] },
      { packageId: 'pub:b', path: 'b', manager: 'pub', name: 'b', entryPoints: [], deps: [] },
    ],
  };
  const owners = [
    [repo.packages[0]!, scipTypescript],
    [repo.packages[1]!, undefined],
  ] as const;
  function indexJson(status: 'ok' | 'partial' | 'failed', install: boolean | undefined): string {
    const f = path.join(root, `${status}-${String(install)}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        repo: 'acme/r',
        headSha: 'sha1',
        status: 'failed',
        ...(install === undefined ? {} : { install }),
        packages: [
          { packageId: 'npm:a', indexer: 'scip-typescript', indexerVersion: scipTypescript.version, status },
          // A package no indexer owns is always failed; it does not block reuse.
          { packageId: 'pub:b', indexer: null, indexerVersion: null, status: 'failed' },
        ],
      }),
    );
    return f;
  }

  it('(5a) reuses an ok index, refuses a partial/failed one and says why', () => {
    const log: string[] = [];
    expect(isCached(indexJson('ok', false), repo, owners, { install: false, log: (l) => log.push(l) })).toBe(true);
    expect(isCached(indexJson('partial', false), repo, owners, { install: false, log: (l) => log.push(l) })).toBe(false);
    expect(isCached(indexJson('failed', true), repo, owners, { install: true, log: (l) => log.push(l) })).toBe(false);
    expect(log).toEqual([
      '[index] acme/r: not reusing cached index (previous status npm:a=partial; partial/failed results are always retried)',
      '[index] acme/r: not reusing cached index (previous status npm:a=failed; partial/failed results are always retried)',
    ]);
  });

  it('(5a) refuses an index made without install when this run installs', () => {
    expect(isCached(indexJson('ok', undefined), repo, owners, { install: true })).toBe(false);
    expect(isCached(indexJson('ok', false), repo, owners, { install: true })).toBe(false);
    expect(isCached(indexJson('ok', true), repo, owners, { install: true })).toBe(true);
    expect(isCached(indexJson('ok', true), repo, owners, { install: false })).toBe(true);
    expect(isCached(indexJson('ok', true), { ...repo, headSha: 'sha2' }, owners, { install: true })).toBe(false);
  });
});
