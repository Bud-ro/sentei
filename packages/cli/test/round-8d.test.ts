// Phase 3 fix round 8d (evaluation batches A/B/D): dist-layout manifests (drizzle-orm),
// bins and scripts loading the package's own unbuilt build output (create-astro,
// @nuxt/scripts-cli), string entry points naming the package's own modules (Astro
// integrations' serverEntrypoint, jscodeshift transforms).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { distLayoutSource, scipTypescript, sourceRoots } from '../src/indexers/scip-typescript.ts';
import type { DiscoverFile } from '../src/indexers/types.ts';

let root: string;

function write(repo: string, files: Record<string, string | object>): void {
  for (const [f, body] of Object.entries(files)) {
    const abs = path.join(root, 'repos', repo, ...f.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-8d-')));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('dist-layout manifests (drizzle-orm: main ./index.cjs, subpaths by file layout)', () => {
  let prep: Awaited<ReturnType<NonNullable<typeof scipTypescript.prepare>>>;
  const consumerDir = (): string => path.join(root, 'repos/flat/packages/zod');

  beforeAll(async () => {
    write('flat', {
      // The repo publishes `dist/` with this package.json copied in: every path is
      // relative to the build output.
      'packages/orm/package.json': { name: '@acme/orm', version: '1.0.0', type: 'module', main: './index.cjs', module: './index.js', types: './index.d.ts' },
      'packages/orm/tsconfig.json': '{\n  // JSONC\n  "compilerOptions": { "outDir": "dist", },\n  "include": ["src"],\n}\n',
      'packages/orm/src/index.ts': `export * from './column.ts';\n`,
      'packages/orm/src/column.ts': `export class Column {}\n`,
      'packages/orm/src/pg-core/index.ts': `export * from './table.ts';\n`,
      'packages/orm/src/pg-core/table.ts': `export class PgTable {}\n`,
      'packages/orm/src/sqlite-core.ts': `export const sqlite = 1;\n`,
      // rootDir other than src, with an exports map and typesVersions in the dist layout.
      'packages/lib/package.json': {
        name: '@acme/lib', version: '1.0.0', types: './index.d.ts',
        exports: { '.': { types: './index.d.ts', import: './index.js' }, './extra': './extra.js' },
        typesVersions: { '*': { extra: ['./extra.d.ts'] } },
      },
      'packages/lib/tsconfig.json': { compilerOptions: { rootDir: 'source', outDir: 'dist' } },
      'packages/lib/source/index.ts': `export const lib = 1;\n`,
      'packages/lib/source/extra.ts': `export const extra = 1;\n`,
      'packages/zod/package.json': { name: '@acme/zod', version: '1.0.0' },
      'packages/zod/src/main.ts': [
        `import { Column } from '@acme/orm';`,
        `import { PgTable } from '@acme/orm/pg-core';`,
        `import { sqlite } from '@acme/orm/sqlite-core';`,
        `import { lib } from '@acme/lib';`,
        `import { extra } from '@acme/lib/extra';`,
        `export const all = [Column, PgTable, sqlite, lib, extra];`,
        '',
      ].join('\n'),
    });
    const pkg = (p: string, name: string) => ({ packageId: `npm:acme/flat:${name}`, path: p, manager: 'npm' as const, name, entryPoints: [], deps: [] as DiscoverFile['repos'][number]['packages'][number]['deps'] });
    const repo: DiscoverFile['repos'][number] = {
      repo: 'acme/flat', localPath: path.join(root, 'repos/flat'), headSha: null,
      packages: [pkg('packages/orm', '@acme/orm'), pkg('packages/lib', '@acme/lib'), pkg('packages/zod', '@acme/zod')],
    };
    repo.packages[2]!.deps = ['@acme/orm', '@acme/lib'].map((d) => ({ name: d, manager: 'npm', resolvedPackageId: `npm:acme/flat:${d}` }));
    const byId = new Map(repo.packages.map((p) => [p.packageId, { repo, pkg: p }] as const));
    prep = await scipTypescript.prepare!({
      repo, pkg: repo.packages[2]!, lookup: (id) => byId.get(id), orgPackages: [...byId.values()], options: { install: false, maxOldSpaceMb: 1024 },
    });
  });

  function resolve(spec: string, moduleResolution: ts.ModuleResolutionKind): string | undefined {
    const bundler = moduleResolution === ts.ModuleResolutionKind.Bundler;
    const options: ts.CompilerOptions = { moduleResolution, module: bundler ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS, allowImportingTsExtensions: true, noEmit: true };
    const r = ts.resolveModuleName(spec, path.join(consumerDir(), 'src/main.ts'), options, ts.sys);
    return r.resolvedModule === undefined ? undefined : realpathSync(r.resolvedModule.resolvedFileName);
  }

  it('distLayoutSource / sourceRoots map a root-relative build path to the same path under the source root', () => {
    const orm = path.join(root, 'repos/flat/packages/orm');
    expect(sourceRoots(orm)).toEqual(['src']);
    expect(sourceRoots(path.join(root, 'repos/flat/packages/lib'))).toEqual(['source']);
    expect(distLayoutSource(orm, './index.cjs')).toBe('src/index.ts');
    expect(distLayoutSource(orm, 'index.d.ts')).toBe('src/index.ts');
    expect(distLayoutSource(orm, 'pg-core')).toBe('src/pg-core/index.ts');
    expect(distLayoutSource(orm, 'pg-core/index.js')).toBe('src/pg-core/index.ts');
    expect(distLayoutSource(orm, 'sqlite-core')).toBe('src/sqlite-core.ts');
    // Negative: nothing there, or a path already under the root.
    expect(distLayoutSource(orm, 'mysql-core')).toBeNull();
    expect(distLayoutSource(orm, 'src/gone.js')).toBeNull();
  });

  it.each([
    ['bundler', ts.ModuleResolutionKind.Bundler],
    ['node10', ts.ModuleResolutionKind.Node10],
  ] as const)('TypeScript (%s) resolves the package and its layout subpaths to the checkout sources', (_, mode) => {
    const orm = path.join(root, 'repos/flat/packages/orm/src');
    expect(resolve('@acme/orm', mode)).toBe(path.join(orm, 'index.ts'));
    expect(resolve('@acme/orm/pg-core', mode)).toBe(path.join(orm, 'pg-core/index.ts'));
    expect(resolve('@acme/orm/sqlite-core', mode)).toBe(path.join(orm, 'sqlite-core.ts'));
    const lib = path.join(root, 'repos/flat/packages/lib/source');
    expect(resolve('@acme/lib', mode)).toBe(path.join(lib, 'index.ts'));
    expect(resolve('@acme/lib/extra', mode)).toBe(path.join(lib, 'extra.ts'));
  });

  it('writes the rewritten manifest into the shadow only', () => {
    const nm = path.join(consumerDir(), 'node_modules/@acme');
    expect(JSON.parse(readFileSync(path.join(nm, 'orm/package.json'), 'utf8'))).toMatchObject({
      main: './src/index.ts', module: './src/index.ts', types: './src/index.ts',
    });
    expect(JSON.parse(readFileSync(path.join(nm, 'lib/package.json'), 'utf8'))).toMatchObject({
      types: './source/index.ts',
      exports: { '.': { types: './source/index.ts', import: './source/index.ts' }, './extra': './source/extra.ts' },
      typesVersions: { '*': { extra: ['./source/extra.ts'] } },
    });
    expect(JSON.parse(readFileSync(path.join(root, 'repos/flat/packages/orm/package.json'), 'utf8'))['main']).toBe('./index.cjs');
    expect(prep.diagnostics.some((d) => d.startsWith('info: node_modules/@acme/orm is a shadow of') && d.includes('main: ./index.cjs → ./src/index.ts')
      && d.includes('deep imports linked to sources: pg-core → src/pg-core/index.ts, sqlite-core → src/sqlite-core.ts'))).toBe(true);
  });
});
