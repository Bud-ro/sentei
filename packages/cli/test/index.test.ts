import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageContext } from '../src/context.ts';
import { readScipIndex } from '@sentei/core/scip';
import { isCached } from '../src/indexers/cache.ts';
import { isGeneratedFile, scanUnindexedImports, unindexedScope } from '../src/indexers/consumer-checks.ts';
import { hermeticEnv, install, NUXT_PREPARE_TIMEOUT_MS, nuxtPrepare, runNode, runSurfaceWorker, scipTypescript, stderrTail, type ExecResult, type Runner } from '../src/indexers/scip-typescript.ts';
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
    for (const f of ['acme__lib-core/npm__acme__core.scip', 'acme__app/npm__acme__app.scip']) {
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
        indexerVersion: scipTypescript.version,
        status: 'ok',
        scip: 'npm__acme__core.scip',
        exports: 'npm__acme__core.exports.json',
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
    const sidecar = readJson<ExportsSidecar>(work, 'index/acme__lib-core/npm__acme__core.exports.json');
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

  it('reuses every package whose index.json entry matches headSha and indexer versions', async () => {
    const before = readFileSync(path.join(work, 'index/acme__app/index.json'), 'utf8');
    lines = [];
    await index(ctx());
    expect(lines).toEqual([
      '[index] acme/lib-core npm:@acme/core: cached (ok at sha-lib; use --force to re-index)',
      '[index] acme/app npm:@acme/app: cached (ok at sha-app; use --force to re-index)',
      '[index] acme/app pub:app_tool: cached (failed at sha-app; use --force to re-index)',
    ]);
    expect(readFileSync(path.join(work, 'index/acme__app/index.json'), 'utf8')).toBe(before);
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
    // Shorthand properties: scip-typescript links only the contextual property.
    short: [
      `import { usedFn } from '@acme/core';`,
      `interface Task { grade(): number; run(x: number): number }`,
      `function grade(): number { return 1; }`,
      `export const t: Task = { grade, run: usedFn };`,
      `export const u = { usedFn };`,
      `export function f(): object { const local = 1; return { local }; }`,
      '',
    ].join('\n'),
    // A deep dist import: a private build-output path, not a blocker.
    deepdist: `import { usedFn } from '@acme/core/dist/fns';\nusedFn(1);\n`,
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
    sidecar: readJson<ExportsSidecar>(cwork, 'index', `acme__${repo}`, `npm__acme__${pkg}.exports.json`),
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
    // namespace_dynamic is targeted at the namespace's package; dynamic_access is not.
    expect(sidecar.flags.map((f) => f.targetPackage)).toEqual(['@acme/core', '@acme/core', undefined]);
    expect(ix.packages[0]!.diagnostics.some((d) => d.startsWith('warn: namespace_dynamic at src/main.ts:5:1') && d.endsWith('(targets @acme/core)'))).toBe(true);
    expect(sidecar.flags[2]!.reason).toContain("require() with a non-literal specifier: '@acme/' + x");
    // The same value uses are also recorded as namespace spread refs to the module file.
    const spread = { targetPackage: '@acme/core', targetFile: 'src/index.ts' };
    expect(sidecar.namespaceSpreadRefs).toEqual([
      { file: 'src/main.ts', line: 4, col: 0, ...spread },
      { file: 'src/main.ts', line: 8, col: 46, ...spread },
    ]);
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

  it('records shorthand property references to own and imported org declarations, not to locals', () => {
    const { index: ix, sidecar } = result('short');
    expect(ix.status).toBe('ok');
    expect(sidecar.shorthandRefs).toEqual([
      { file: 'src/main.ts', line: 3, col: 25, member: 'grade', targetPackage: '@acme/short', targetFile: 'src/main.ts', targetLine: 2, targetCol: 9 },
      { file: 'src/main.ts', line: 4, col: 19, member: 'usedFn', targetPackage: '@acme/core', targetFile: 'src/fns.ts', targetLine: 3, targetCol: 16 },
    ]);
    expect(result('skew').sidecar.shorthandRefs).toEqual([]);
  });

  it('a deep dist import of an org package is recorded as an unresolved import, not partial', () => {
    const { index: ix, sidecar } = result('deepdist');
    expect(ix.status).toBe('ok');
    expect(sidecar.unresolvedImports).toEqual([{ module: '@acme/core/dist/fns', name: '*', file: 'src/main.ts', line: 0, col: 23 }]);
    const diags = ix.packages[0]!.diagnostics;
    expect(diags.some((d) => d.startsWith("warn: unresolved deep dist import '@acme/core/dist/fns' at src/main.ts:1:24"))).toBe(true);
    expect(diags.some((d) => d.startsWith('error:'))).toBe(false);
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
    sidecar: readJson<ExportsSidecar>(hwork, 'index', `acme__${repo}`, `npm__${pkg}.exports.json`),
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
      // SFC consumers: never indexed; org imports and relative imports of own code.
      'pages/playground.vue': [
        '<template><TabSelect /></template>',
        '<script setup lang="ts">',
        `import { ref } from "vue";`,
        `import TabSelect from "../components/TabSelect.vue";`,
        `import {`,
        `  Foo,`,
        `  type Bar,`,
        `} from "@acme/unbuilt";`,
        `import { vueComponents } from "../samples/components.ts";`,
        `import { helper } from "../samples/helper.js";`,
        `import { gone } from "../samples/missing";`,
        `import { self } from "@acme/consumer";`,
        '</script>',
        '',
      ].join('\n'),
      'components/TabSelect.vue': '<template><div /></template>\n',
      'samples/components.ts': `export const vueComponents = {};\n`,
      'samples/helper.ts': `export function helper(): void {}\n`,
      'docs/Demo.svelte': `<script>\n  import { built } from '@acme/built';\n</script>\n`,
      'docs/guide.mdx': `import { Foo } from '@acme/unbuilt'\n\n# Guide\n`,
      // Generated files: header comments (capnp-es, @generated in a block comment),
      // and a generator holding the header only as a string literal (not generated).
      'src/gen/schema.ts': `// This file has been automatically generated by capnp-es.\nexport const _capnpFileId = 0xe37ded525a68a7c9n;\n`,
      'src/gen/api.ts': `/* eslint-disable */\n/**\n * @generated by openapi-gen. Do not edit.\n */\nexport type Api = {};\n`,
      'src/gen/constants.ts': 'export const SOURCE_COMMENT = `// This file has been automatically generated by capnp-es.\\n`;\n',
      'src/late.ts': `${'// filler\n'.repeat(20)}// auto-generated below this line\nexport const late = 1;\n`,
      // An ignored manifest (discover: witness-only) inside the package.
      'examples/demo/package.json': { name: 'demo', private: true },
      'examples/demo/index.mjs': `import '@acme/built';\n`,
    });
    addRepo('consumer', { name: '@acme/consumer', entryPoints: ['src/main.ts'] }, ['@acme/unbuilt', '@acme/built']);
    repos[repos.length - 1]!.ignoredManifests = [{ path: 'examples/demo' }];
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
    const libIndex = readScipIndex(path.join(hwork, 'index/acme__unbuilt/npm__acme__unbuilt.scip'));
    const defs = libIndex.documents.flatMap((d) => d.occurrences.filter((o) => (o.symbolRoles & 1) === 1).map((o) => o.symbol));
    const fooDef = defs.find((s) => s.endsWith('/Foo#'));
    expect(fooDef).toBe('scip-typescript npm @acme/unbuilt 2.0.0 src/`index.ts`/Foo#');
    const consumerIndex = readScipIndex(path.join(hwork, 'index/acme__consumer/npm__acme__consumer.scip'));
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

  it('(4) records org imports from code and SFC files outside every tsconfig with their scope, skipping build output', () => {
    const { index: ix, sidecar } = result('consumer', 'acme__consumer');
    expect(sidecar.unindexedImports).toEqual([
      { file: 'docs/Demo.svelte', module: '@acme/built', targetPackage: '@acme/built', scope: 'docs' },
      { file: 'docs/example.mjs', module: '@acme/built', targetPackage: '@acme/built', scope: 'docs' },
      { file: 'docs/guide.mdx', module: '@acme/unbuilt', targetPackage: '@acme/unbuilt', scope: 'docs' },
      // A tool config is a real consumer: unscoped (a flag), although SCRIPT_GLOBS lists `*.config.*`.
      { file: 'eslint.config.mjs', module: '@acme/built', targetPackage: '@acme/built' },
      // Self imports by name are recorded with the package itself as target (core: self-witness).
      { file: 'eslint.config.mjs', module: '@acme/consumer/x', targetPackage: '@acme/consumer' },
      { file: 'pages/playground.vue', module: '@acme/consumer', targetPackage: '@acme/consumer' },
      { file: 'pages/playground.vue', module: '@acme/unbuilt', targetPackage: '@acme/unbuilt' },
      // Relative imports of own code files from an SFC: resolved, targeting the package itself
      // (`.js` → `.ts`; other SFCs and unresolvable paths are not recorded).
      { file: 'pages/playground.vue', module: 'samples/components.ts', targetPackage: '@acme/consumer', relative: true },
      { file: 'pages/playground.vue', module: 'samples/helper.ts', targetPackage: '@acme/consumer', relative: true },
      { file: 'scripts/gen.cjs', module: '@acme/unbuilt/sub', targetPackage: '@acme/unbuilt', scope: 'script' },
      { file: 'test/setup.test.mjs', module: '@acme/built', targetPackage: '@acme/built', scope: 'test' },
    ]);
    expect(ix.status).toBe('ok');
    expect(ix.packages[0]!.diagnostics).toContain(
      "warn: eslint.config.mjs is in no tsconfig and imports org module '@acme/built' (unindexed consumer of @acme/built)",
    );
  });

  it('skips ignored-manifest subtrees in the out-of-program scan', () => {
    // The previous test asserts the sidecar has no examples/demo entry; without
    // the ignored dir the scan would report it.
    const pkgDir = path.join(root, 'repos/consumer');
    const scan = (ignoredDirs: string[]) =>
      scanUnindexedImports({
        repoRoot: pkgDir,
        pkgDir,
        nestedPackageDirs: [],
        ignoredDirs,
        indexedFiles: new Set(),
        orgPackageNames: new Set(['@acme/built']),
        selfName: '@acme/consumer',
      }).map((u) => u.file);
    expect(scan([])).toContain('examples/demo/index.mjs');
    expect(scan([path.join(pkgDir, 'examples/demo')])).not.toContain('examples/demo/index.mjs');
    expect(result('consumer', 'acme__consumer').sidecar.unindexedImports.map((u) => u.file)).not.toContain('examples/demo/index.mjs');
  });

  it('lists generated own files by header comment, never by a string literal or a late comment', () => {
    const { index: ix, sidecar } = result('consumer', 'acme__consumer');
    expect(sidecar.generatedFiles).toEqual(['src/gen/api.ts', 'src/gen/schema.ts']);
    expect(ix.packages[0]!.diagnostics).toContain('info: 2 generated file(s) (header or path): src/gen/api.ts, src/gen/schema.ts');
    expect(result('solution', 'acme__solution').sidecar.generatedFiles).toEqual([]);
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
  /** npm exec runs with engine-strict off and an empty prefix (no devEngines check). */
  const execFlags = (): string[] => ['exec', '--yes', '--no-engine-strict', `--prefix=${path.join(root, '.pm/npm-exec-prefix')}`];
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
    expect(await install(dir, dir, diagnostics, [], fakeRunner(['pnpm'], calls), root)).toBe(true);
    const store = ['--store-dir', path.join(root, '.pm/pnpm-store')];
    expect(calls).toEqual([
      ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', ...store]],
      ['npm', [...execFlags(), '--package=pnpm@9.1.0', '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', ...store]],
    ]);
    expect(diagnostics).toContain(
      'info: pnpm is not installed (spawn pnpm ENOENT); falling back to npm exec --yes --package=pnpm@9.1.0 (version 9.1.0 from packageManager in package.json)',
    );
  });

  it('(3) uses latest without a packageManager field, and yarn berry through @yarnpkg/cli-dist', async () => {
    const plain = repo('yarn-classic', { 'package.json': '{}', 'yarn.lock': '' });
    const calls: Array<[string, string[]]> = [];
    const diagnostics: string[] = [];
    await install(plain, plain, diagnostics, [], fakeRunner(['yarn'], calls), root);
    expect(calls[1]).toEqual(['npm', [...execFlags(), '--package=yarn@latest', '--', 'yarn', 'install', '--frozen-lockfile', '--ignore-scripts']]);
    expect(diagnostics[0]).toContain('(version latest (no matching packageManager or devEngines.packageManager field))');

    const berry = repo('yarn-berry', { 'package.json': JSON.stringify({ packageManager: 'yarn@4.10.3' }), 'yarn.lock': '' });
    const calls2: Array<[string, string[]]> = [];
    await install(berry, berry, [], [], fakeRunner(['yarn'], calls2), root);
    expect(calls2[1]).toEqual(['npm', [...execFlags(), '--package=@yarnpkg/cli-dist@4.10.3', '--', 'yarn', 'install', '--immutable', '--mode=skip-build']]);
  });

  it('(3) skips a bun install with a warning when bun is missing, and names ENOENT when the fallback cannot start', async () => {
    const bun = repo('bun-repo', { 'package.json': '{}', 'bun.lock': '' });
    const diagnostics: string[] = [];
    expect(await install(bun, bun, diagnostics, [], fakeRunner(['bun'], []), root)).toBe(true);
    expect(diagnostics).toEqual(['warn: bun is not installed (spawn bun ENOENT); install skipped in .']);

    const npmRepo = repo('npm-repo', { 'package.json': '{}', 'package-lock.json': '{}' });
    const d2: string[] = [];
    expect(await install(npmRepo, npmRepo, d2, [], fakeRunner(['npm'], []), root)).toBe(false);
    expect(d2).toEqual(['error: npm ci --ignore-scripts in . could not start (ENOENT: spawn npm ENOENT)']);
  });

  it('(hermetic) every install subprocess keeps global/state/cache writes in the work dir', async () => {
    const dir = repo('hermetic', { 'package.json': JSON.stringify({ packageManager: 'yarn@4.10.3' }), 'yarn.lock': '' });
    const work = path.join(root, 'work');
    const envs: NodeJS.ProcessEnv[] = [];
    const runner: Runner = async (cmd, _args, _cwd, env) => {
      envs.push(env);
      return cmd === 'yarn'
        ? { code: -1, signal: null, stdout: '', stderr: '', errno: 'ENOENT', errorMessage: 'spawn yarn ENOENT' }
        : { code: 0, signal: null, stdout: '', stderr: '' };
    };
    const log: string[] = [];
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, npm_config_cache: process.env.npm_config_cache };
    process.env.HTTPS_PROXY = 'http://proxy.test:3128';
    process.env.npm_config_cache = '/inherited/npm-cache';
    try {
      expect(await install(dir, dir, [], log, runner, work)).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(envs).toHaveLength(2); // yarn, then the npm exec fallback
    const pm = path.join(work, '.pm');
    for (const env of envs) {
      expect(env).toMatchObject({
        XDG_DATA_HOME: path.join(pm, 'xdg-data'),
        XDG_STATE_HOME: path.join(pm, 'xdg-state'),
        XDG_CONFIG_HOME: path.join(pm, 'xdg-config'),
        XDG_CACHE_HOME: path.join(pm, 'xdg-cache'),
        PNPM_HOME: path.join(pm, 'pnpm-home'),
        YARN_GLOBAL_FOLDER: path.join(pm, 'yarn-global'),
        YARN_ENABLE_GLOBAL_CACHE: 'false',
        YARN_HTTPS_PROXY: 'http://proxy.test:3128',
        COREPACK_HOME: path.join(pm, 'corepack'),
        COREPACK_ENABLE_STRICT: '0',
        npm_config_cache: '/inherited/npm-cache',
      });
    }
    expect(existsSync(path.join(pm, 'xdg-state'))).toBe(true);
    // Keys are logged, values never.
    const envLine = log.find((l) => l.startsWith('# install env'))!;
    expect(envLine).toContain('XDG_DATA_HOME, XDG_STATE_HOME');
    expect(envLine).toContain('YARN_HTTPS_PROXY');
    expect(envLine).not.toContain('proxy.test');
    expect(log.filter((l) => l.startsWith('# install env'))).toHaveLength(1);
  });

  it('(hermetic) passes HTTP_PROXY to yarn only when set, and never overrides YARN_* proxies', () => {
    expect(hermeticEnv('/w', {}).env.YARN_HTTP_PROXY).toBeUndefined();
    expect(hermeticEnv('/w', { HTTP_PROXY: 'http://a' }).env.YARN_HTTP_PROXY).toBe('http://a');
    expect(hermeticEnv('/w', { https_proxy: 'http://b', YARN_HTTPS_PROXY: 'http://c' }).env.YARN_HTTPS_PROXY).toBe('http://c');
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

  const decide = (f: string, r: DiscoveredRepo, install: boolean) =>
    Object.fromEntries([...isCached(f, r, owners, { install })].map(([id, d]) => [id, d.reuse ? 'reuse' : (d.reason ?? 'none')]));

  it('(5a) reuses ok packages, refuses partial/failed ones and says why', () => {
    expect(decide(indexJson('ok', false), repo, false)).toEqual({ 'npm:a': 'reuse', 'pub:b': 'reuse' });
    expect(decide(indexJson('partial', false), repo, false)).toEqual({
      'npm:a': 'previous status partial; partial/failed results are always retried',
      'pub:b': 'reuse',
    });
    expect(decide(indexJson('failed', true), repo, true)['npm:a']).toBe('previous status failed; partial/failed results are always retried');
  });

  it('(5a) refuses a result made without install when this run installs', () => {
    const noInstall = 'previous run did not install dependencies';
    expect(decide(indexJson('ok', undefined), repo, true)['npm:a']).toBe(noInstall);
    expect(decide(indexJson('ok', false), repo, true)['npm:a']).toBe(noInstall);
    expect(decide(indexJson('ok', true), repo, true)['npm:a']).toBe('reuse');
    expect(decide(indexJson('ok', true), repo, false)['npm:a']).toBe('reuse');
    // A new commit: nothing reusable, no reason (nothing was cached for it).
    expect(decide(indexJson('ok', true), { ...repo, headSha: 'sha2' }, true)).toEqual({ 'npm:a': 'none', 'pub:b': 'none' });
    expect(decide(path.join(root, 'missing.json'), repo, true)).toEqual({ 'npm:a': 'none', 'pub:b': 'none' });
  });

  it('refuses a result written under an older output file name (slugs carry the manager)', () => {
    const f = path.join(root, 'names.json');
    for (const n of ['a.scip', 'a.exports.json', 'npm__a.scip', 'npm__a.exports.json']) writeFileSync(path.join(root, n), 'x');
    const entry = (slug: string) => ({
      packageId: 'npm:a', indexer: 'scip-typescript', indexerVersion: scipTypescript.version, status: 'ok', install: true,
      scip: `${slug}.scip`, exports: `${slug}.exports.json`,
    });
    const write = (slug: string) => writeFileSync(f, JSON.stringify({ repo: 'acme/r', headSha: 'sha1', status: 'ok', install: true, packages: [entry(slug)] }));
    write('a');
    expect(decide(f, repo, true)['npm:a']).toBe('output file name changed (a.scip)');
    write('npm__a');
    expect(decide(f, repo, true)['npm:a']).toBe('reuse');
  });
});

describe('per-package index cache (stage)', () => {
  let root: string;
  let pwork: string;
  let log: string[];
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler', noEmit: true, types: [] }, include: ['src'] });
  const run = async (opts: { force?: boolean } = {}) => {
    log = [];
    await index({ work: pwork, dbPath: '', db: undefined as unknown as DatabaseSync, log: (l) => log.push(l) }, { install: false, ...opts });
    return readJson<RepoIndex>(pwork, 'index/acme__mono/index.json');
  };

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-pkgcache-')));
    const files: Record<string, string> = {
      'a/package.json': JSON.stringify({ name: '@acme/a', version: '1.0.0', type: 'module', types: 'src/index.ts' }),
      'a/tsconfig.json': TSCONFIG,
      'a/src/index.ts': `export function fa(): number { return 1; }\n`,
      'b/package.json': JSON.stringify({ name: '@acme/b', version: '1.0.0', type: 'module', dependencies: { '@acme/a': '*' } }),
      'b/tsconfig.json': TSCONFIG,
      // Unresolved org module: b is partial.
      'b/src/index.ts': `import { fa } from '@acme/a/nope';\nexport const x = fa();\n`,
    };
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, 'mono', f)), { recursive: true });
      writeFileSync(path.join(root, 'mono', f), body);
    }
    pwork = path.join(root, 'work');
    mkdirSync(pwork);
    const pkg = (name: string, p: string, deps: string[]) => ({
      packageId: `npm:${name}`, path: p, manager: 'npm', name, entryPoints: [`${p}/src/index.ts`],
      deps: deps.map((d) => ({ name: d, manager: 'npm', resolvedPackageId: `npm:${d}` })),
    });
    const discover: DiscoverFile = {
      org: 'acme',
      repos: [{ repo: 'acme/mono', localPath: path.join(root, 'mono'), headSha: 'sha1', packages: [pkg('@acme/a', 'a', []), pkg('@acme/b', 'b', ['@acme/a'])] }],
    };
    writeFileSync(path.join(pwork, 'discover.json'), JSON.stringify(discover));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('re-runs only the package that cannot be reused and keeps the reused entry verbatim', async () => {
    const first = await run();
    expect(first.packages.map((p) => [p.packageId, p.status])).toEqual([['npm:@acme/a', 'ok'], ['npm:@acme/b', 'partial']]);
    const aLog = path.join(pwork, 'index/acme__mono/npm__acme__a.log');
    const aLogMtime = statSync(aLog).mtimeMs;

    const second = await run();
    expect(log[0]).toBe('[index] acme/mono npm:@acme/a: cached (ok at sha1; use --force to re-index)');
    expect(log[1]).toMatch(/^\[index\] acme\/mono npm:@acme\/b: re-indexed \(previous status partial; partial\/failed results are always retried\): partial/);
    expect(log).toHaveLength(2);
    expect(second.packages[0]).toEqual(first.packages[0]);
    expect(second.status).toBe('partial');
    expect(statSync(aLog).mtimeMs).toBe(aLogMtime); // a was not re-run

    await run({ force: true });
    expect(log.map((l) => l.replace(/: re-indexed \(--force\): .*/, ''))).toEqual([
      '[index] acme/mono npm:@acme/a',
      '[index] acme/mono npm:@acme/b',
    ]);
  }, 60_000);
});

describe('unjs fixes', () => {
  let root: string;
  let uwork: string;
  const TSCONFIG = {
    compilerOptions: {
      strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [],
      resolveJsonModule: true, allowJs: true, checkJs: false,
    },
    include: ['src'],
  };
  function write(repo: string, files: Record<string, string | object>): void {
    for (const [f, body] of Object.entries(files)) {
      const abs = path.join(root, 'repos', repo, ...f.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
  }
  const pkg = (repo: string, name: string, entryPoints: string[]): DiscoverFile['repos'][number] => ({
    repo: `acme/${repo}`,
    localPath: path.join(root, 'repos', repo),
    headSha: null,
    packages: [{ packageId: `npm:${name}`, path: '.', manager: 'npm', name, version: '1.0.0', entryPoints, deps: [] }],
  });
  const result = (repo: string) => ({
    index: readJson<RepoIndex>(uwork, 'index', `acme__${repo}`, 'index.json'),
    sidecar: readJson<ExportsSidecar>(uwork, 'index', `acme__${repo}`, `npm__acme__${repo}.exports.json`),
  });

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-unjs-')));
    // (1) A namespace import of an own relative module used as a value.
    write('spread', {
      'package.json': { name: '@acme/spread', version: '1.0.0', type: 'module' },
      'tsconfig.json': TSCONFIG,
      'src/utils/pkg.ts': `export const a = 1;\nexport function b(): number { return 2; }\n`,
      'src/main.ts': [
        `import * as _pkg from './utils/pkg';`,
        `export const utils = Object.freeze({ ..._pkg });`,
        `export const n = _pkg.a;`, // member access: no record
        `export type T = typeof _pkg;`, // type position: no record
        `export const keys = Object.keys(_pkg);`,
        '',
      ].join('\n'),
    });
    // (6) Exports scip-typescript has no global definition for.
    write('surface', {
      'package.json': { name: '@acme/surface', version: '3.1.0', type: 'module' },
      'tsconfig.json': TSCONFIG,
      'src/index.ts': [
        `const obj = { x: 1, y: 2 };`,
        `export const { x, y } = obj;`, // destructuring: SCIP locals
        `export function f(): number { return 1; }`,
        `f.extra = 1;`, // expando: adds a declaration to f
        `export { version } from '../package.json';`, // JSON module
        `export * from './typedefs.js';`,
        `export type { Hidden } from '../lib/extra';`, // declared outside every tsconfig's files
        // A type import merged with a destructured value (vendored ast-types): the type is the definition.
        `import type { Pair } from './types';`,
        `const { Pair } = { Pair: 1 };`,
        `export { Pair };`,
        '',
      ].join('\n'),
      'src/types.ts': `export interface Pair { p: number }\n`,
      'src/typedefs.js': `/** @typedef {{ a: number }} Shape */\nexport const real = 1;\n`,
      'lib/extra.d.ts': `export interface Hidden { h: number }\n`,
    });
    // Ambient augmentations and script declarations: entry symbols.
    write('ambient', {
      'package.json': { name: '@acme/ambient', version: '1.0.0', type: 'module' },
      'tsconfig.json': TSCONFIG,
      'src/index.ts': [
        `export const v = 1;`,
        `declare module 'hono' {`,
        `  interface ContextVariableMap { user: string }`,
        `}`,
        `declare global {`,
        `  interface Window { x: number }`,
        `}`,
        `export namespace N { export const a = 1; }`, // ordinary namespace: not recorded
        `export type { Surf } from './surf.js';`,
        `declare global { namespace G { namespace H { class Deep {} } } }`,
        '',
      ].join('\n'),
      'src/globals.d.ts': `declare const process: { argv: string[] };\n`,
      'src/types.d.ts': `export interface Exported { e: number }\ninterface Local { l: number }\n`,
      // Wrangler-style script namespaces: members at any nesting are recorded too.
      'src/wasm.d.ts': [
        `declare namespace WebAssembly {`,
        `  class CompileError extends Error {}`,
        `  namespace Inner { interface Deep { d: number } }`,
        `}`,
        '',
      ].join('\n'),
      // A namespace on the export surface is an ordinary export, members included.
      'src/surf.d.ts': `declare namespace Surf { interface Member { m: number } }\nexport { Surf };\n`,
    });
    const repos = [
      pkg('spread', '@acme/spread', ['src/main.ts']),
      pkg('surface', '@acme/surface', ['src/index.ts']),
      pkg('ambient', '@acme/ambient', ['src/index.ts']),
    ];
    uwork = path.join(root, 'work');
    mkdirSync(uwork);
    writeFileSync(path.join(uwork, 'discover.json'), JSON.stringify({ org: 'acme', repos }));
    await index({ work: uwork, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} }, { install: false });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('(1) records value uses of a relative namespace import as namespaceSpreadRefs, without a flag', () => {
    const { index: ix, sidecar } = result('spread');
    expect(ix.status).toBe('ok');
    const target = { targetPackage: '@acme/spread', targetFile: 'src/utils/pkg.ts' };
    expect(sidecar.namespaceSpreadRefs).toEqual([
      { file: 'src/main.ts', line: 1, col: 40, ...target },
      { file: 'src/main.ts', line: 4, col: 32, ...target },
    ]);
    expect(sidecar.flags).toEqual([]);
    // Member refs stay limited to namespaces of org packages imported by name.
    expect(sidecar.namespaceMemberRefs).toEqual([]);
  });

  it('(6) records no export SCIP cannot define, and flags exports declared outside every tsconfig', () => {
    const { index: ix, sidecar } = result('surface');
    expect(sidecar.exports.map((e) => [e.exportedAs, e.file, e.line, e.col])).toEqual([
      ['Pair', 'src/types.ts', 0, 17],
      ['f', 'src/index.ts', 2, 16],
      ['real', 'src/typedefs.js', 1, 13],
    ]);
    // Every record matches a SCIP definition (ingest's position join).
    const defs = new Set(
      readScipIndex(path.join(uwork, 'index/acme__surface/npm__acme__surface.scip')).documents.flatMap((doc) =>
        doc.occurrences.filter((o) => (o.symbolRoles & 1) !== 0 && !o.symbol.startsWith('local ')).map((o) => `${doc.relativePath}:${o.range[0]}:${o.range[1]}`),
      ),
    );
    expect(sidecar.exports.filter((e) => !defs.has(`${e.file}:${e.line}:${e.col}`))).toEqual([]);
    expect(sidecar.unresolved).toEqual([
      "src/index.ts#Hidden (declared in lib/extra.d.ts, which is in no tsconfig's files, so scip-typescript did not index it)",
    ]);
    expect(ix.status).toBe('partial');
    const diags = ix.packages[0]!.diagnostics;
    expect(diags).toContain('info: 3 export(s) declared by destructuring (`export const { a } = ...`) not recorded: scip-typescript defines them as locals');
    expect(diags).toContain('info: 1 JSDoc @typedef/@callback export(s) not recorded: scip-typescript does not index JSDoc');
    expect(diags).toContain('info: 1 expando assignment declaration(s) (`fn.prop = ...`) not recorded');
    expect(diags).toContain('info: exports declared in JSON modules not recorded: package.json');
    // The sidecar field exists (empty) for every package.
    expect(sidecar.namespaceSpreadRefs).toEqual([]);
  });

  it('records declarations in ambient module/global augmentations and .d.ts script declarations as entry symbols', () => {
    const { sidecar } = result('ambient');
    const kind = 'ambient';
    expect(sidecar.entrySymbols).toEqual([
      { file: 'src/globals.d.ts', line: 0, col: 14, name: 'process', kind },
      { file: 'src/index.ts', line: 1, col: 15, name: 'hono', kind },
      { file: 'src/index.ts', line: 2, col: 12, name: 'ContextVariableMap', kind },
      { file: 'src/index.ts', line: 4, col: 8, name: 'global', kind },
      { file: 'src/index.ts', line: 5, col: 12, name: 'Window', kind },
      { file: 'src/index.ts', line: 9, col: 8, name: 'global', kind },
      { file: 'src/index.ts', line: 9, col: 27, name: 'G', kind },
      { file: 'src/index.ts', line: 9, col: 41, name: 'H', kind },
      { file: 'src/index.ts', line: 9, col: 51, name: 'Deep', kind },
      { file: 'src/types.d.ts', line: 1, col: 10, name: 'Local', kind },
      { file: 'src/wasm.d.ts', line: 0, col: 18, name: 'WebAssembly', kind },
      { file: 'src/wasm.d.ts', line: 1, col: 8, name: 'CompileError', kind },
      { file: 'src/wasm.d.ts', line: 2, col: 12, name: 'Inner', kind },
      { file: 'src/wasm.d.ts', line: 2, col: 30, name: 'Deep', kind },
    ]);
    const defs = new Set(
      readScipIndex(path.join(uwork, 'index/acme__ambient/npm__acme__ambient.scip')).documents.flatMap((doc) =>
        doc.occurrences.filter((o) => (o.symbolRoles & 1) !== 0 && !o.symbol.startsWith('local ')).map((o) => `${doc.relativePath}:${o.range[0]}:${o.range[1]}`),
      ),
    );
    expect(sidecar.entrySymbols.filter((e) => !defs.has(`${e.file}:${e.line}:${e.col}`))).toEqual([]);
  });

  it('(2) a failing export-surface worker fails the package with its stderr tail', async () => {
    const diagnostics: string[] = [];
    const log: string[] = [];
    const job = { sidecarFile: path.join(root, 'no/such/dir/x.exports.json'), input: {
      packageId: 'npm:@acme/spread', repoRoot: path.join(root, 'repos/spread'), pkgDir: path.join(root, 'repos/spread'),
      nestedPackageDirs: [], entryPoints: ['src/main.ts'], tsconfig: path.join(root, 'repos/spread/tsconfig.json'),
      orgPackageNames: [], orgPackageDirs: [],
    } };
    expect(await runSurfaceWorker(job, root, 1024, log, diagnostics)).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^error: export surface failed: worker exited with code 1: .*ENOENT/);
    expect(log[0]).toMatch(/^\$ node --max-old-space-size=1024 .*surface-worker\.ts/);
  }, 60_000);

  it('(3) retries a node child once with double heap when it runs out of memory', async () => {
    const calls: string[][] = [];
    const oom: Runner = async (_cmd, args) => {
      calls.push(args);
      return calls.length === 1
        ? { code: 134, signal: null, stdout: '', stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n' }
        : { code: 0, signal: null, stdout: 'done', stderr: '' };
    };
    const diagnostics: string[] = [];
    let cleaned = 0;
    const proc = await runNode({ what: 'scip-typescript', args: ['x.js'], cwd: root, maxOldSpaceMb: 4096, log: [], diagnostics, run: oom, beforeRetry: () => cleaned++ });
    expect(proc.code).toBe(0);
    expect(calls).toEqual([['--max-old-space-size=4096', 'x.js'], ['--max-old-space-size=8192', 'x.js']]);
    expect(cleaned).toBe(1);
    expect(diagnostics).toEqual(['warn: scip-typescript ran out of heap at --max-old-space-size=4096 (exited with code 134); retrying once with 8192']);

    // SIGABRT counts too; a second OOM is not retried again; other failures are not retried at all.
    const sig: Runner = async (_c, args) => (calls.push(args), { code: null, signal: 'SIGABRT', stdout: '', stderr: '' });
    calls.length = 0;
    expect((await runNode({ what: 'w', args: [], cwd: root, maxOldSpaceMb: 100, log: [], diagnostics: [], run: sig })).signal).toBe('SIGABRT');
    expect(calls).toHaveLength(2);
    const plain: Runner = async (_c, args) => (calls.push(args), { code: 1, signal: null, stdout: '', stderr: 'boom' });
    calls.length = 0;
    await runNode({ what: 'w', args: [], cwd: root, maxOldSpaceMb: 100, log: [], diagnostics: [], run: plain });
    expect(calls).toHaveLength(1);
  });

  it('(4) reads the package manager version from devEngines.packageManager (object or array form)', async () => {
    const calls: Array<[string, string[]]> = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, args]);
      return cmd === 'npm' ? { code: 0, signal: null, stdout: '', stderr: '' } : { code: -1, signal: null, stdout: '', stderr: '', errno: 'ENOENT', errorMessage: `spawn ${cmd} ENOENT` };
    };
    const obj = path.join(root, 'pm-obj');
    write('../pm-obj', {
      'package.json': { devEngines: { runtime: { name: 'node', version: '^24.0.0' }, packageManager: { name: 'pnpm', version: '11.24.0', onFail: 'download' } } },
      'pnpm-lock.yaml': '',
    });
    const d1: string[] = [];
    expect(await install(obj, obj, d1, [], runner, root)).toBe(true);
    expect(calls[1]![1]).toContain('--package=pnpm@11.24.0');
    expect(d1[0]).toContain('(version 11.24.0 from devEngines.packageManager in package.json)');

    const arr = path.join(root, 'pm-arr');
    write('../pm-arr', {
      'package.json': { devEngines: { packageManager: [{ name: 'npm', version: '^11' }, { name: 'yarn', version: '^4.1.0' }] } },
      'yarn.lock': '',
    });
    calls.length = 0;
    await install(arr, arr, [], [], runner, root);
    // A berry range still selects @yarnpkg/cli-dist.
    expect(calls[1]![1]).toContain('--package=@yarnpkg/cli-dist@^4.1.0');
    // packageManager wins over devEngines.
    const both = path.join(root, 'pm-both');
    write('../pm-both', { 'package.json': { packageManager: 'pnpm@9.0.0', devEngines: { packageManager: { name: 'pnpm', version: '10.0.0' } } }, 'pnpm-lock.yaml': '' });
    calls.length = 0;
    await install(both, both, [], [], runner, root);
    expect(calls[1]![1]).toContain('--package=pnpm@9.0.0');
  });

  it('(4) runs installs with engine-strict off and puts the stderr tail into the error', async () => {
    const dir = path.join(root, 'pm-fail');
    write('../pm-fail', { 'package.json': '{}', 'package-lock.json': '{}' });
    const envs: NodeJS.ProcessEnv[] = [];
    const failing: Runner = async (_cmd, _args, _cwd, env) => {
      envs.push(env);
      return { code: 1, signal: null, stdout: '', stderr: 'npm warn one\n\nline 2\nline 3\nline 4\nline 5\nnpm error code EBADENGINE\n' };
    };
    const diagnostics: string[] = [];
    expect(await install(dir, dir, diagnostics, [], failing, root)).toBe(false);
    expect(diagnostics).toEqual(['error: npm ci --ignore-scripts in . exited with code 1: npm warn one | line 2 | line 3 | line 4 | line 5 | npm error code EBADENGINE']);
    expect(envs[0]).toMatchObject({ npm_config_engine_strict: 'false', NPM_CONFIG_ENGINE_STRICT: 'false', pnpm_config_engine_strict: 'false' });

    // pnpm prints its errors on stdout: with an empty stderr, the stdout tail is used.
    const quiet: Runner = async () => ({ code: 1, signal: null, stdout: 'Scope: all\n[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install\n', stderr: '' });
    const d2: string[] = [];
    expect(await install(dir, dir, d2, [], quiet, root)).toBe(false);
    expect(d2[0]).toMatch(/exited with code 1: Scope: all \| \[ERR_PNPM_OUTDATED_LOCKFILE\] Cannot install$/);
  });
});

describe('unjs final verification (external re-exports, self imports, JS entries, diagnostic tails)', () => {
  let root: string;
  let vwork: string;
  const TSCONFIG = {
    compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [] },
    include: ['src'],
  };
  function write(repo: string, files: Record<string, string | object>): void {
    for (const [f, body] of Object.entries(files)) {
      const abs = path.join(root, 'repos', repo, ...f.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
  }
  const pkg = (repo: string, name: string, entryPoints: string[]): DiscoverFile['repos'][number] => ({
    repo: `acme/${repo}`,
    localPath: path.join(root, 'repos', repo),
    headSha: null,
    packages: [{ packageId: `npm:${name}`, path: '.', manager: 'npm', name, version: '1.0.0', entryPoints, deps: [] }],
  });
  const result = (repo: string) => ({
    index: readJson<RepoIndex>(vwork, 'index', `acme__${repo}`, 'index.json'),
    sidecar: readJson<ExportsSidecar>(vwork, 'index', `acme__${repo}`, `npm__acme__${repo}.exports.json`),
  });

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-unjs-verify-')));
    write('selfy', {
      'package.json': { name: '@acme/selfy', version: '1.0.0', type: 'module' },
      'tsconfig.json': TSCONFIG,
      'src/index.ts': `export const a = 1;\n`,
      // (1) unenv's polyfill: the default export is the lib's globalThis.
      'src/polyfill.ts': `export default globalThis;\n`,
      // (2) a self import by name that does not resolve (no exports map, no self link).
      'src/loader.ts': `export const load = (): Promise<unknown> => import('@acme/selfy/runners/node');\n`,
      // (2) a root config outside the program importing the package by name.
      'build.config.ts': `import { a } from '@acme/selfy';\nexport default { a };\n`,
    });
    write('jsentry', {
      'package.json': { name: '@acme/jsentry', version: '1.0.0', type: 'module' },
      'tsconfig.json': TSCONFIG,
      // (1) an alias that resolves to nothing stays unresolved.
      'src/index.ts': `export const b = 1;\nexport { nope } from './other.ts';\n`,
      'src/other.ts': `export const other = 1;\n`,
      // (4) JavaScript entries the program excludes, and a declaration entry.
      'lib/mock.cjs': `Object.defineProperty(exports, "__esModule", { value: true });\nexports.named = 1;\nmodule.exports = createMock("mock");\n`,
      'lib/run.mjs': `#!/usr/bin/env node\nexport async function run() {}\nconst x = 1;\nexport { x as y };\nexport default run;\n`,
      'lib/mock.d.cts': `export = unknown;\n`,
    });
    const repos = [
      pkg('selfy', '@acme/selfy', ['src/index.ts', 'src/polyfill.ts']),
      pkg('jsentry', '@acme/jsentry', ['src/index.ts', 'lib/mock.cjs', 'lib/run.mjs', 'lib/mock.d.cts']),
    ];
    vwork = path.join(root, 'work');
    mkdirSync(vwork);
    writeFileSync(path.join(vwork, 'discover.json'), JSON.stringify({ org: 'acme', repos }));
    await index({ work: vwork, dbPath: '', db: undefined as unknown as DatabaseSync, log: () => {} }, { install: false });
  }, 120_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('(1) an export resolving to a declaration outside the package is neither a record nor unresolved', () => {
    const { index: ix, sidecar } = result('selfy');
    expect(sidecar.exports.map((e) => [e.entry, e.exportedAs])).toEqual([['src/index.ts', 'a']]);
    expect(sidecar.unresolved).toEqual([]);
    expect(ix.packages[0]!.diagnostics).toContain(
      'info: 1 export(s) resolve to declarations outside the package (lib, node_modules or another org package), not recorded: src/polyfill.ts#default',
    );
    // An alias to nothing (`unknown` symbol) is still unresolved.
    expect(result('jsentry').sidecar.unresolved).toContain('src/index.ts#nope');
  });

  it('(2) self imports by name are unindexed imports of the package itself, never unresolved org modules', () => {
    const { index: ix, sidecar } = result('selfy');
    expect(sidecar.unindexedImports).toEqual([
      { file: 'build.config.ts', module: '@acme/selfy', targetPackage: '@acme/selfy' },
      { file: 'src/loader.ts', module: '@acme/selfy/runners/node', targetPackage: '@acme/selfy' },
    ]);
    expect(ix.status).toBe('ok');
    const diags = ix.packages[0]!.diagnostics;
    expect(diags.some((d) => d.startsWith('error:'))).toBe(false);
    expect(diags).toContain("info: build.config.ts is in no tsconfig and imports this package by name ('@acme/selfy'; self-witness)");
    expect(diags.some((d) => d.startsWith("warn: unresolved self import '@acme/selfy/runners/node' at src/loader.ts:1:"))).toBe(true);
  });

  it('(4) text-scans JavaScript entries outside the program into unresolved surface; declaration entries stay unknown', () => {
    const { index: ix, sidecar } = result('jsentry');
    expect(ix.status).toBe('partial');
    expect(sidecar.missingEntryPoints).toEqual(['lib/mock.cjs', 'lib/run.mjs', 'lib/mock.d.cts']);
    const why = '(JavaScript entry outside the tsconfig program)';
    expect(sidecar.unresolved).toEqual([
      `lib/mock.cjs#default ${why}`,
      `lib/mock.cjs#named ${why}`,
      `lib/run.mjs#default ${why}`,
      `lib/run.mjs#run ${why}`,
      `lib/run.mjs#y ${why}`,
      'src/index.ts#nope',
    ]);
    const diags = ix.packages[0]!.diagnostics;
    expect(diags).toContain('warn: entry lib/mock.cjs is JavaScript outside the tsconfig program; add it to include (exports: default, named)');
    expect(diags).toContain('warn: entry point(s) not in the TypeScript program, export surface unknown: lib/mock.d.cts');
  });

  it('(3) subprocess diagnostics keep the first 3 and last 5 non-empty lines', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    lines[0] = 'ERROR  Cannot find module /x/fontaine/dist/index.cjs';
    expect(stderrTail({ stderr: `${lines.join('\n\n')}\n` })).toBe(
      ': ERROR  Cannot find module /x/fontaine/dist/index.cjs | l2 | l3 | … | l8 | l9 | l10 | l11 | l12',
    );
    // Up to 8 lines: all of them.
    expect(stderrTail({ stderr: 'a\nb\nc\nd\ne\nf\ng\nh\n' })).toBe(': a | b | c | d | e | f | g | h');
    // stdout when stderr is empty; '' when both are.
    expect(stderrTail({ stderr: '', stdout: 'Scope: all\n' })).toBe(': Scope: all');
    expect(stderrTail({ stderr: '\n', stdout: '' })).toBe('');
    // Each part is capped: the head keeps its start, the tail its end.
    const long = stderrTail({ stderr: [`H${'x'.repeat(900)}`, 'b', 'c', 'd', 'e', 'f', 'g', 'h', `${'y'.repeat(900)}T`].join('\n') });
    expect(long.startsWith(': Hxxx')).toBe(true);
    expect(long.endsWith('yyyT')).toBe(true);
    expect(long.length).toBeLessThan(1020);
  });

  it('(3) nuxt prepare keeps the error head of a long stack', async () => {
    const dir = path.join(root, 'nuxt-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'site', devDependencies: { nuxt: '^4' } }));
    const stack = ['ERROR  Cannot find module /x/fontaine/dist/index.cjs', ...Array.from({ length: 20 }, (_, i) => `    at frame${i}`)];
    const run: Runner = async () => ({ code: 1, signal: null, stdout: '', stderr: stack.join('\n') });
    const diagnostics: string[] = [];
    expect(await nuxtPrepare(dir, diagnostics, [], run, root)).toBe(false);
    expect(diagnostics[0]).toMatch(/exited with code 1: ERROR {2}Cannot find module \/x\/fontaine\/dist\/index\.cjs \| at frame0 \| at frame1 \| … \| at frame15/);
  });
});

describe('unjs final round (scope, SFC, generated files, heap retry, nuxt)', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-unjs-final-')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('scopes unindexed files: test before docs before script dirs; tool configs and plain files stay unscoped', () => {
    expect(unindexedScope('test/setup.mjs')).toBe('test');
    expect(unindexedScope('docs/fixtures/a.mjs')).toBe('test');
    expect(unindexedScope('examples/playground/a.mjs')).toBe('docs');
    expect(unindexedScope('bench/run.mjs')).toBe('script');
    expect(unindexedScope('packages/x/scripts/release.ts')).toBe('script');
    expect(unindexedScope('eslint.config.mjs')).toBeUndefined();
    expect(unindexedScope('vitest.workspace.ts')).toBeUndefined();
    expect(unindexedScope('pages/playground.vue')).toBeUndefined();
  });

  it('detects generated files from header comments of any comment syntax, and tool-output dirs', () => {
    const f = (name: string, body: string): string => {
      const abs = path.join(root, 'gen', name);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      return abs;
    };
    const gen = (name: string, body: string): boolean => isGeneratedFile(f(name, body), `gen/${name}`);
    expect(gen('capnp.ts', '// This file has been automatically generated by capnp-es.\nimport * as $ from "capnp-es";\n')).toBe(true);
    expect(gen('shebang.mjs', '#!/usr/bin/env node\n# not a comment in JS, but harmless\n// Code generated by x. DO NOT EDIT.\n')).toBe(true);
    expect(gen('block.ts', '/* eslint-disable */\n/**\n * This file is auto-generated by orval.\n */\n')).toBe(true);
    expect(gen('comp.vue', '<!-- @generated -->\n<template />\n')).toBe(true);
    expect(gen('page.mdx', '{/* Automatically generated from api.json */}\n# API\n')).toBe(true);
    expect(gen('literal.ts', 'export const HEADER = "// @generated";\nconst x = 1; // do not edit (a trailing comment is not a header)\n')).toBe(false);
    expect(gen('late.ts', `${'const a = 1;\n'.repeat(20)}// @generated\n`)).toBe(false);
    expect(gen('plain.ts', '/** Utilities. */\nexport const a = 1;\n')).toBe(false);
    expect(isGeneratedFile(f('nuxt.d.ts', 'export {}\n'), 'app/.nuxt/nuxt.d.ts')).toBe(true);
    // Wrangler's header, Go-style and "this file was generated" headers.
    expect(gen('env.d.ts', '/* eslint-disable */\n// Generated by Wrangler by running `wrangler types` (hash: 1a2b)\n// Runtime types generated with workerd@1.2\ndeclare namespace Cloudflare {}\n')).toBe(true);
    expect(gen('go.ts', '// Code generated by protoc-gen-es; edit the .proto instead.\n')).toBe(true);
    expect(gen('was.ts', '/*\n * This file was generated from schema.graphql.\n */\n')).toBe(true);
    // Names that are generated whatever the header says.
    expect(isGeneratedFile(f('worker-configuration.d.ts', 'interface Env {}\n'), 'apps/api/worker-configuration.d.ts')).toBe(true);
    expect(isGeneratedFile(f('api.generated.d.ts', 'interface A {}\n'), 'src/api.generated.d.ts')).toBe(true);
    expect(isGeneratedFile(f('worker-configuration.ts', 'export {}\n'), 'src/worker-configuration.ts')).toBe(false);
  });

  it('retries scip-typescript with the no-hover-signature preload after a heap exhaustion', async () => {
    const calls: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      calls.push(args);
      return calls.length === 1
        ? { code: null, signal: 'SIGABRT', stdout: '', stderr: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n' }
        : { code: 0, signal: null, stdout: '', stderr: '' };
    };
    const diagnostics: string[] = [];
    const preload = path.resolve(import.meta.dirname, '../src/indexers/scip-typescript-nodocs.cjs');
    const proc = await runNode({
      what: 'scip-typescript', args: ['main.js', 'index'], cwd: root, maxOldSpaceMb: 4096, log: [], diagnostics, run,
      retry: { nodeArgs: ['--require', preload], note: 'and without hover signatures' },
    });
    expect(proc.code).toBe(0);
    expect(calls).toEqual([
      ['--max-old-space-size=4096', 'main.js', 'index'],
      ['--max-old-space-size=8192', '--require', preload, 'main.js', 'index'],
    ]);
    expect(diagnostics).toEqual([
      'warn: scip-typescript ran out of heap at --max-old-space-size=4096 (was killed by SIGABRT); retrying once with 8192 and without hover signatures',
    ]);
    expect(existsSync(preload)).toBe(true);
  });

  it('the preload replaces only the hover signature of the pinned scip-typescript', async () => {
    const { spawnSync } = await import('node:child_process');
    const preload = path.resolve(import.meta.dirname, '../src/indexers/scip-typescript-nodocs.cjs');
    const r = spawnSync(process.execPath, ['--require', preload, '-e', [
      `const p = require.resolve('@sourcegraph/scip-typescript/package.json');`,
      `const { FileIndexer } = require(require('node:path').join(require('node:path').dirname(p), 'dist/src/FileIndexer.js'));`,
      `process.stdout.write(FileIndexer.prototype.signatureForDocumentation());`,
    ].join('\n')], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^\(signature omitted by sentei/);
  });

  describe('nuxt prepare (fake runner)', () => {
    const app = (name: string, pkg: object, nuxtTsconfig = false): string => {
      const dir = path.join(root, 'nuxt', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      if (nuxtTsconfig) {
        mkdirSync(path.join(dir, '.nuxt'), { recursive: true });
        writeFileSync(path.join(dir, '.nuxt/tsconfig.json'), '{}');
      }
      return dir;
    };
    const runner = (calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeout?: number }>, result: ExecResult): Runner =>
      async (cmd, args, cwd, env, _shell, _input, timeout) => {
        calls.push({ cmd, args, cwd, env, ...(timeout !== undefined ? { timeout } : {}) });
        return result;
      };
    const ok: ExecResult = { code: 0, signal: null, stdout: '', stderr: '' };

    it('runs npm exec --yes -- nuxt prepare once for a nuxt app without .nuxt/tsconfig.json, hermetic, with a 10 min timeout', async () => {
      const dir = app('devtools-app', { name: 'devtools-app', devDependencies: { nuxt: 'catalog:' } });
      const calls: Parameters<typeof runner>[0] = [];
      const diagnostics: string[] = [];
      expect(await nuxtPrepare(dir, diagnostics, [], runner(calls, ok), path.join(root, 'work'))).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cmd: 'npm', args: ['exec', '--yes', '--', 'nuxt', 'prepare'], cwd: dir, timeout: NUXT_PREPARE_TIMEOUT_MS });
      expect(NUXT_PREPARE_TIMEOUT_MS).toBe(600_000);
      expect(calls[0]!.env['XDG_CACHE_HOME']).toBe(path.join(root, 'work/.pm/xdg-cache'));
      expect(diagnostics).toEqual(['info: nuxt app without .nuxt/tsconfig.json; ran npm exec --yes -- nuxt prepare']);
    });

    it('does nothing without nuxt in dependencies/devDependencies or when .nuxt/tsconfig.json exists', async () => {
      const calls: Parameters<typeof runner>[0] = [];
      const diagnostics: string[] = [];
      const plain = app('lib', { name: 'lib', dependencies: { '@nuxt/kit': '^3' } });
      const prepared = app('site', { name: 'site', dependencies: { nuxt: '^4' } }, true);
      expect(await nuxtPrepare(plain, diagnostics, [], runner(calls, ok), root)).toBe(false);
      expect(await nuxtPrepare(prepared, diagnostics, [], runner(calls, ok), root)).toBe(false);
      expect(calls).toEqual([]);
      expect(diagnostics).toEqual([]);
    });

    it('a failing or timed-out nuxt prepare leaves a warning with the reason and nothing else', async () => {
      const dir = app('website', { name: 'website', devDependencies: { nuxt: '^3.10.3' } });
      const diagnostics: string[] = [];
      const fail: ExecResult = { code: 1, signal: null, stdout: '', stderr: 'ERROR  Cannot find module @nuxt/content\n' };
      expect(await nuxtPrepare(dir, diagnostics, [], runner([], fail), root)).toBe(false);
      const killed: ExecResult = { code: null, signal: 'SIGTERM', stdout: '', stderr: '' };
      expect(await nuxtPrepare(dir, diagnostics, [], runner([], killed), root)).toBe(false);
      expect(diagnostics).toEqual([
        'warn: nuxt app without .nuxt/tsconfig.json; npm exec --yes -- nuxt prepare exited with code 1: ERROR  Cannot find module @nuxt/content',
        'warn: nuxt app without .nuxt/tsconfig.json; npm exec --yes -- nuxt prepare was killed by SIGTERM (timeout 10 min)',
      ]);
    });
  });
});
