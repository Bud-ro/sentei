import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageContext } from '../src/context.ts';
import type { DiscoverFile, ExportsSidecar } from '../src/indexers/types.ts';
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
