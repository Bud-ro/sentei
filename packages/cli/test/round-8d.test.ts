// Phase 3 fix round 8d (evaluation batches A/B/D): dist-layout manifests (drizzle-orm),
// bins and scripts loading the package's own unbuilt build output (create-astro,
// @nuxt/scripts-cli), string entry points naming the package's own modules (Astro
// integrations' serverEntrypoint, jscodeshift transforms).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanOwnModuleLoads } from '../src/indexers/consumer-checks.ts';
import { computeExportSurface } from '../src/indexers/export-surface.ts';
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

describe('own-module loads: bins loading unbuilt dist/, string entry points (withastro, nuxt, trpc)', () => {
  const TSCONFIG = {
    compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, allowJs: true, types: [] },
    include: ['src', 'bin'],
  };
  function surface(repo: string, name: string, extra: Partial<Parameters<typeof computeExportSurface>[0]> = {}) {
    const pkgDir = path.join(root, 'repos', repo);
    return computeExportSurface({
      packageId: `npm:acme/${repo}:${name}`, repoRoot: pkgDir, pkgDir, nestedPackageDirs: [], entryPoints: [], runtimeEntryPoints: [],
      tsconfig: path.join(pkgDir, 'tsconfig.json'), orgPackageNames: new Set([name]), orgPackageDirs: [], packageName: name, ...extra,
    });
  }
  const runtime = (r: ReturnType<typeof surface>): string[] =>
    r.sidecar.entrySymbols.filter((e) => e.kind === 'runtime').map((e) => `${e.file}#${e.name}`);

  it('a bin importing ../dist/cli.mjs references and seeds the mapped source exports (named, destructured, whole module)', () => {
    write('cli', {
      'package.json': { name: '@acme/cli', version: '1.0.0', type: 'module', exports: { '.': './dist/cli.mjs' }, bin: { cli: './bin/cli.mjs' } },
      'tsconfig.json': TSCONFIG,
      'bin/cli.mjs': [
        `import { runCli } from '../dist/cli.mjs';`,
        `process.exitCode = runCli(process.argv.slice(2));`,
        `void import('../dist/run.js').then(({ main }) => main());`,
        `const all = await import('../dist/all.js');`,
        `export { all };`,
        '',
      ].join('\n'),
      'bin/plain': `#!/usr/bin/env node\nrequire('../dist/plain.js');\n`,
      'src/cli.ts': `export function runCli(args: string[]): number { return args.length; }\nexport function cliUnused(): void {}\n`,
      'src/run.ts': `function runHelper(): number { return 1; }\nexport function main(): number { return runHelper(); }\nexport function runOther(): void {}\n`,
      'src/all.ts': `export const a = 1;\nexport const b = 2;\n`,
      'src/plain.ts': `const plainTop = 1;\nconsole.log(plainTop);\n`,
      // A test's load: nothing seeded (and no reference: the file is in no program).
      'test/cli.test.mjs': `import { cliUnused } from '../dist/cli.mjs';\ncliUnused();\n`,
    });
    const r = surface('cli', '@acme/cli', { entryPoints: ['src/cli.ts'], runtimeEntryPoints: ['bin/cli.mjs', 'bin/plain'] });
    expect(r.partial).toBe(false);
    // runCli (named by the bin), main (destructured in `.then`), every export of a whole-module
    // import; a module with no exports: its top-level declarations (the extension-less bin).
    expect(runtime(r)).toEqual(['src/all.ts#a', 'src/all.ts#b', 'src/cli.ts#runCli', 'src/plain.ts#plainTop', 'src/run.ts#main']);
    expect(r.sidecar.shorthandRefs.map((x) => `${x.file}:${x.line}:${x.col} ${x.member} -> ${x.targetPackage}/${x.targetFile}:${x.targetLine}`)).toEqual([
      'bin/cli.mjs:0:9 runCli -> @acme/cli/src/cli.ts:0',
      'bin/cli.mjs:2:38 main -> @acme/cli/src/run.ts:1',
      'bin/cli.mjs:3:25 a -> @acme/cli/src/all.ts:0',
      'bin/cli.mjs:3:25 b -> @acme/cli/src/all.ts:1',
    ]);
    expect(r.diagnostics).toContain("info: bin/cli.mjs:1:24 loads own module src/cli.ts ('../dist/cli.mjs')");
  });

  it('unbuilt output that no source maps to makes the package partial with a cause (never ok); from a test file it does not', () => {
    write('gap', {
      'package.json': { name: '@acme/gap', version: '1.0.0', bin: './bin/gap.mjs' },
      'tsconfig.json': TSCONFIG,
      'bin/gap.mjs': `import('../dist/gone.js');\n`,
      'src/index.ts': `export const x = 1;\n`,
      'test/a.test.mjs': `import '../dist/nothing.js';\n`,
    });
    const r = surface('gap', '@acme/gap', { runtimeEntryPoints: ['bin/gap.mjs'] });
    expect(r.partial).toBe(true);
    expect(r.diagnostics.at(-1)).toBe("cause: error: bin/gap.mjs:1:8 loads '../dist/gone.js', the package's own unbuilt build output, which no source maps to (what it uses is unknown)");
    expect(r.diagnostics).toContain("warn: test/a.test.mjs:1:8 loads '../dist/nothing.js', the package's own build output with no source (test file, not a counted consumer; status unaffected)");
    // Negative: a missing relative import outside a build dir, or a native addon, is no gap.
    write('nogap', {
      'package.json': { name: '@acme/nogap', version: '1.0.0' },
      'tsconfig.json': TSCONFIG,
      'src/index.ts': `export const x = 1;\n`,
      'bin/run.mjs': `import('./missing.js');\nrequire('../build/Release/addon.node');\n`,
      // A hand-written declaration file loads no code (withastro cli-kit's utils.d.ts).
      'utils.d.ts': `export * from './dist/utils/index.d.js';\n`,
    });
    expect(surface('nogap', '@acme/nogap').partial).toBe(false);
  });

  it('string entries naming the package\'s own subpath or an own file are runtime entries (Astro serverEntrypoint, jscodeshift)', () => {
    write('integration', {
      'package.json': {
        name: '@acme/integration', version: '1.0.0', type: 'module',
        exports: { '.': './dist/index.js', './server.js': './dist/server.js', './transforms/*': './dist/transforms/*.js' },
      },
      'tsconfig.json': TSCONFIG,
      'src/index.ts': [
        `export default function integration() {`,
        `  return {`,
        `    serverEntrypoint: '@acme/integration/server.js',`,
        `    transform: require.resolve('@acme/integration/transforms/provider'),`,
        `    worker: new URL('./worker.ts', import.meta.url),`,
        `    label: './notes.md',`,
        `  };`,
        `}`,
        `declare const require: { resolve(s: string): string };`,
        '',
      ].join('\n'),
      'src/server.ts': `export default { check() { return true; } };\nexport function renderToStaticMarkup(): string { return ''; }\n`,
      'src/transforms/provider.ts': `export const parser = 'tsx';\nexport default function transformer(): void {}\n`,
      'src/worker.ts': `export function onMessage(): void {}\n`,
      'src/notes.md': '# not code\n',
      'src/unrelated.ts': `export function notLoaded(): void {}\n`,
      // A tool config (no entry point) naming an own file: also an own-file load record.
      'tool.config.mjs': `export default { entry: './src/extra.ts' };\n`,
      'src/extra.ts': `export function extra(): void {}\n`,
    });
    const r = surface('integration', '@acme/integration', { entryPoints: ['src/index.ts', 'src/server.ts'] });
    expect(r.partial).toBe(false);
    // The anonymous `export default {…}` has no SCIP definition to name (not recorded).
    expect(runtime(r)).toEqual([
      'src/extra.ts#extra', 'src/server.ts#renderToStaticMarkup', 'src/transforms/provider.ts#parser', 'src/transforms/provider.ts#transformer', 'src/worker.ts#onMessage',
    ]);
    // Loads from the entry file need no record (the package's entry set is credible
    // anyway); the config's load is recorded, so its entry symbols never make it so.
    expect(r.sidecar.unindexedImports).toEqual([
      { file: 'tool.config.mjs', module: 'src/extra.ts', targetPackage: '@acme/integration', relative: true },
    ]);
    expect(r.sidecar.shorthandRefs).toEqual([]); // a string is not a reference
  });

  it('scanOwnModuleLoads: existing relative imports are ordinary imports; names from each import form', () => {
    write('forms', {
      'package.json': { name: '@acme/forms', version: '1.0.0' },
      'src/a.ts': `export const a = 1;\n`,
      'bin/x.cjs': [
        `const { one, two: renamed } = require('../dist/a.js');`,
        `const ns = require('../dist/a.js');`,
        `import def, { three } from '../lib/a.js';`,
        `import * as star from '../dist/a.js';`,
        `export { four } from '../dist/a.js';`,
        `import { a } from '../src/a.js';`,
        `const five = require('../dist/a.js').five;`,
        '',
      ].join('\n'),
    });
    const pkgDir = path.join(root, 'repos/forms');
    const { loads, gaps } = scanOwnModuleLoads({ repoRoot: pkgDir, pkgDir, nestedPackageDirs: [], files: [path.join(pkgDir, 'bin/x.cjs')], selfName: '@acme/forms' });
    expect(gaps).toEqual([]);
    expect(loads.map((l) => `${l.line}:${l.spec} ${l.names === undefined ? '*' : l.names.map((n) => n.name).join(',')}`)).toEqual([
      '0:../dist/a.js one,two',
      '1:../dist/a.js *',
      '2:../lib/a.js default,three',
      '3:../dist/a.js *',
      '4:../dist/a.js four',
      '6:../dist/a.js five',
    ]);
    expect(new Set(loads.flatMap((l) => l.targets.map((t) => path.relative(pkgDir, t))))).toEqual(new Set(['src/a.ts']));
  });
});
