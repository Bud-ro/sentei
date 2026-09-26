// Namespace values other than `import * as` bindings (consumer-checks.ts): members
// destructured from a dynamic import / a `typeof import()` value are recorded as
// namespaceMemberRefs; uses that hide which members are read are namespace_dynamic.
// scip-typescript 0.4.0 gives such destructured bindings `local` symbols only
// (supabase pg-delta: `const { analyzeAndSort } = await loadPgTopo()`).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeExportSurface, type ExportSurfaceResult } from '../src/indexers/export-surface.ts';

const TSCONFIG = {
  compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [] },
  include: ['src'],
};

/** One consumer file per case; `// flag` cases must raise namespace_dynamic at @acme/lib2. */
const CASES: Record<string, string> = {
  // const {a} = await import('lib')
  'direct.ts': `export async function f() {\n  const { a } = await import('@acme/lib');\n  return a();\n}\n`,
  // const {a} = await loadLib() (through a variable and a function)
  'loader.ts': [
    `const load = () => import('@acme/lib');`,
    `async function loadLib() { return await load(); }`,
    `export async function f() {`,
    `  const { b } = await loadLib();`,
    `  return b();`,
    `}`,
    '',
  ].join('\n'),
  // const m = await import('lib'); const {a} = m; m.d()
  'variable.ts': [
    `export async function f() {`,
    `  const m = await import('@acme/lib');`,
    `  const { c: renamed } = m;`,
    `  return renamed() + m.d();`,
    `}`,
    '',
  ].join('\n'),
  // import * as ns; const {a} = ns
  'star.ts': `import * as ns from '@acme/lib';\nconst { e } = ns;\nexport const v = e();\n`,
  // function f({a}: typeof import('lib'))
  'param.ts': `export function f({ f: g }: typeof import('@acme/lib')): number {\n  return g();\n}\n`,
  // pg-delta's shape: a guarded loader behind an injectable indirection.
  'pgdelta.ts': [
    `type M = typeof import('@acme/lib');`,
    `let imp: () => Promise<M> = () =>`,
    `  import('@acme/lib');`,
    `export function setImporter(i: (() => Promise<M>) | null): void {`,
    `  imp = i ?? (() => import('@acme/lib'));`,
    `}`,
    `async function loadM(): Promise<M> {`,
    `  try {`,
    `    return await imp();`,
    `  } catch (cause) {`,
    `    throw new Error(String(cause));`,
    `  }`,
    `}`,
    `export async function can(): Promise<boolean> {`,
    `  await loadM();`,
    `  return true;`,
    `}`,
    `export async function run(): Promise<number> {`,
    `  const { g } = await loadM();`,
    `  return g();`,
    `}`,
    '',
  ].join('\n'),
  // .then(({ a }) => ...)
  'then.ts': `export const p = import('@acme/lib').then(({ a }) => a());\n`,
  // an import * binding kept in a variable still typed as the namespace: tracked, not a flag
  'alias.ts': `import * as ns from '@acme/lib';\nconst m = ns;\nexport const v = m.b();\n`,
  // flag: an import * binding passed to a function (unchanged behaviour)
  'starpass.ts': `import * as ns2 from '@acme/lib2';\ndeclare function take(o: object): void;\ntake(ns2);\n`,
  // flag: a namespace exported as a value
  'exported.ts': `export const lib2 = await import('@acme/lib2');\n`,
  // flag: rest element
  'rest.ts': `export async function f() {\n  const { x, ...rest } = await import('@acme/lib2');\n  return [x, rest];\n}\n`,
  // flag: the namespace handed to a function taking `object`
  'pass.ts': `declare function take(o: object): void;\nexport async function f() {\n  take(await import('@acme/lib2'));\n}\n`,
  // flag: computed key
  'computed.ts': `declare const k: 'x' | 'y';\nexport async function f() {\n  const { [k]: z } = await import('@acme/lib2');\n  return z;\n}\n`,
  // flag: widened to any by the loader's return type
  'widened.ts': `async function load(): Promise<any> {\n  return import('@acme/lib2');\n}\nexport async function f() {\n  const { y } = await load();\n  return y;\n}\n`,
};

let root: string;
let result: ExportSurfaceResult;

function write(file: string, body: string | object): void {
  const abs = path.join(root, ...file.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-nsdestr-')));
  for (const [name, dir] of [['@acme/lib', 'lib'], ['@acme/lib2', 'lib2']] as const) {
    write(`${dir}/package.json`, { name, version: '1.0.0', type: 'module', types: 'src/index.ts' });
    write(`${dir}/tsconfig.json`, TSCONFIG);
  }
  // `a` is an alias re-export (the case scip-typescript also misses for `ns.a`).
  write('lib/src/a.ts', `export function a(): number { return 1; }\n`);
  write('lib/src/index.ts', [
    `export { a } from './a';`,
    ...['b', 'c', 'd', 'e', 'f', 'g'].map((n) => `export function ${n}(): number { return 1; }`),
    `export function unused(): number { return 0; }`,
    '',
  ].join('\n'));
  write('lib2/src/index.ts', `export const x = 1;\nexport const y = 2;\n`);
  write('app/package.json', { name: '@acme/app', version: '1.0.0', type: 'module', main: 'src/direct.ts' });
  write('app/tsconfig.json', TSCONFIG);
  for (const [f, body] of Object.entries(CASES)) write(`app/src/${f}`, body);
  mkdirSync(path.join(root, 'app/node_modules/@acme'), { recursive: true });
  symlinkSync(path.join(root, 'lib'), path.join(root, 'app/node_modules/@acme/lib'));
  symlinkSync(path.join(root, 'lib2'), path.join(root, 'app/node_modules/@acme/lib2'));

  result = computeExportSurface({
    packageId: 'npm:acme/app:@acme/app',
    repoRoot: path.join(root, 'app'),
    pkgDir: path.join(root, 'app'),
    nestedPackageDirs: [],
    entryPoints: ['src/direct.ts'],
    tsconfig: path.join(root, 'app/tsconfig.json'),
    orgPackageNames: new Set(['@acme/lib', '@acme/lib2', '@acme/app']),
    orgPackageDirs: [
      { name: '@acme/lib', dir: path.join(root, 'lib') },
      { name: '@acme/lib2', dir: path.join(root, 'lib2') },
      { name: '@acme/app', dir: path.join(root, 'app') },
    ],
    packageName: '@acme/app',
  });
}, 60_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('namespace destructuring and dynamic-import namespaces', () => {
  it('resolves every destructured / accessed member to the declaration', () => {
    const refs = result.sidecar.namespaceMemberRefs.map((r) => `${r.file}:${r.line}:${r.col} ${r.member} -> ${r.targetPackage}/${r.targetFile}:${r.targetLine}`);
    expect(refs.sort()).toEqual([
      'src/alias.ts:2:19 b -> @acme/lib/src/index.ts:1',
      'src/direct.ts:1:10 a -> @acme/lib/src/a.ts:0',
      'src/loader.ts:3:10 b -> @acme/lib/src/index.ts:1',
      'src/param.ts:0:20 f -> @acme/lib/src/index.ts:5',
      'src/pgdelta.ts:18:10 g -> @acme/lib/src/index.ts:6',
      'src/star.ts:1:8 e -> @acme/lib/src/index.ts:4',
      'src/then.ts:0:45 a -> @acme/lib/src/a.ts:0',
      'src/variable.ts:2:10 c -> @acme/lib/src/index.ts:2',
      'src/variable.ts:3:23 d -> @acme/lib/src/index.ts:3',
      // lib2 members named next to a flagged use are recorded too (x of `{ x, ...rest }`).
      'src/rest.ts:1:10 x -> @acme/lib2/src/index.ts:0',
    ].sort());
  });

  it('never flags a fully resolved use (no namespace_dynamic at @acme/lib)', () => {
    expect(result.sidecar.flags.filter((f) => f.targetPackage === '@acme/lib')).toEqual([]);
    expect(result.sidecar.namespaceSpreadRefs.filter((r) => r.targetPackage === '@acme/lib')).toEqual([]);
    expect(result.sidecar.unresolvedImports).toEqual([]);
  });

  it('flags a rest element, a computed key, a namespace passed or exported as a value, and a widened loader (negative cases)', () => {
    const flags = result.sidecar.flags.map((f) => `${f.flag} ${f.file}:${f.line}:${f.col} -> ${f.targetPackage}`);
    expect(flags.sort()).toEqual([
      'namespace_dynamic src/computed.ts:2:10 -> @acme/lib2',
      'namespace_dynamic src/exported.ts:0:26 -> @acme/lib2',
      'namespace_dynamic src/pass.ts:2:13 -> @acme/lib2', // the import() call, climbed through await
      'namespace_dynamic src/rest.ts:1:13 -> @acme/lib2',
      'namespace_dynamic src/starpass.ts:2:5 -> @acme/lib2',
      'namespace_dynamic src/widened.ts:1:9 -> @acme/lib2',
    ]);
    // Each flagged use also keeps the whole target module reachable (spread ref).
    expect(result.sidecar.namespaceSpreadRefs.map((r) => `${r.file}:${r.line} ${r.targetPackage}/${r.targetFile}`).sort()).toEqual([
      'src/computed.ts:2 @acme/lib2/src/index.ts',
      'src/exported.ts:0 @acme/lib2/src/index.ts',
      'src/pass.ts:2 @acme/lib2/src/index.ts',
      'src/rest.ts:1 @acme/lib2/src/index.ts',
      'src/starpass.ts:2 @acme/lib2/src/index.ts',
      'src/widened.ts:1 @acme/lib2/src/index.ts',
    ]);
  });
});
