// Phase 3 fix round 9b (rerun at 840cd97): lazy component loaders (docs.page's
// `next/dynamic(() => import('./search-dialog'))`), Next.js app-router files under dot
// directories (`app/.well-known/jwks.json/route.ts`), solution-style tsconfigs whose
// entries are in no program (astro), and an `extends` that cannot be resolved
// (very_good_workflows' docs site).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importedNames } from '../src/indexers/consumer-checks.ts';
import { computeExportSurface, nextDotDirEntries } from '../src/indexers/export-surface.ts';
import { readScipIndex } from '@sentei/core/scip';
import { BASE_TSCONFIG, RUNTIME_TSCONFIG, scipTypescript } from '../src/indexers/scip-typescript.ts';
import type { DiscoveredPackage, DiscoveredRepo, ExportsSidecar, IndexerInput } from '../src/indexers/types.ts';

let root: string;

function write(repo: string, files: Record<string, string | object>): void {
  for (const [f, body] of Object.entries(files)) {
    const abs = path.join(root, 'repos', repo, ...f.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-9b-')));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TSCONFIG = {
  compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', noEmit: true, skipLibCheck: true, allowJs: true, types: [] },
  include: ['src'],
};

function surface(repo: string, name: string | null, extra: Partial<Parameters<typeof computeExportSurface>[0]> = {}) {
  const pkgDir = path.join(root, 'repos', repo);
  return computeExportSurface({
    packageId: `npm:acme/${repo}:${name ?? '_unnamed/.'}`, repoRoot: pkgDir, pkgDir, nestedPackageDirs: [], entryPoints: [], runtimeEntryPoints: [],
    tsconfig: path.join(pkgDir, 'tsconfig.json'), orgPackageNames: new Set(name === null ? [] : [name]), orgPackageDirs: [], packageName: name, ...extra,
  });
}
const refs = (r: ReturnType<typeof surface>): string[] =>
  r.sidecar.shorthandRefs.map((x) => `${x.file}:${x.line}:${x.col} ${x.member} -> ${x.targetFile}:${x.targetLine}`).sort();

describe('dynamic imports: lazy component loaders take the default export, named uses their names', () => {
  it('importedNames reads the use of an import() result', () => {
    const names = (code: string): string => {
      const sf = ts.createSourceFile('a.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let out = 'none';
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(n.arguments[0]!)) {
          const r = importedNames(n.arguments[0], () => ({ file: 'a.tsx', line: 0, col: 0 }));
          out = r === undefined ? '*' : r === null ? 'null' : r.map((x) => x.name).join(',');
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return out;
    };
    expect(names(`const D = dynamic(() => import('./d'), { ssr: false });`)).toBe('default');
    expect(names(`const D = React.lazy(() => import('./d'));`)).toBe('default');
    expect(names(`const D = lazy(async () => { return await import('./d'); });`)).toBe('default');
    expect(names(`const D = defineAsyncComponent({ loader: () => import('./d') });`)).toBe('default');
    expect(names(`const D = dynamic(() => import('./d').then((m) => m.Named));`)).toBe('Named');
    expect(names(`const D = lazy(() => import('./d').then((m) => ({ default: m.Named })));`)).toBe('Named');
    expect(names(`async function f() { const m = await import('./d'); return m.a() + m.b; }`)).toBe('a,b');
    expect(names(`async function f() { return (await import('./d')).run(); }`)).toBe('run');
    // Unknown uses: every export (negative).
    expect(names(`async function f() { const m = await import('./d'); register(m); }`)).toBe('*');
    expect(names(`const p = import('./d');`)).toBe('*');
    expect(names(`const D = memo(() => import('./d'));`)).toBe('*');
    expect(names(`import('./d').then((m) => use(m));`)).toBe('*');
  });

  it('a lazy loader references the default export; a named use its names; an unknown use nothing (docs.page)', () => {
    write('next-app', {
      'package.json': { name: 'app', version: '1.0.0', private: true, dependencies: { next: '15.0.0' } },
      'tsconfig.json': TSCONFIG,
      'src/components/search.tsx': [
        `declare function dynamic(loader: () => Promise<unknown>, o?: object): unknown;`,
        `export const SearchDialog = dynamic(() => import("./search-dialog"), { ssr: false });`,
        `export async function load() { const m = await import("./helpers"); return m.used(); }`,
        `export async function whole() { const m = await import("./whole"); return Object.keys(m); }`,
        '',
      ].join('\n'),
      'src/components/search-dialog.tsx': `export default function SearchDialog() { return null; }\nexport function notRendered() {}\n`,
      'src/components/helpers.ts': `export function used() { return 1; }\nexport function unused() { return 2; }\n`,
      'src/components/whole.ts': `export const w = 1;\n`,
    });
    const r = surface('next-app', 'app');
    expect(r.partial).toBe(false);
    expect(refs(r)).toEqual([
      'src/components/search.tsx:1:49 default -> src/components/search-dialog.tsx:0',
      'src/components/search.tsx:2:77 used -> src/components/helpers.ts:0',
    ]);
    // Never an entry symbol: only a reference from the loading code.
    expect(r.sidecar.entrySymbols).toEqual([]);
    // A nameless package cannot be targeted by a sidecar reference: nothing (module-level only).
    expect(refs(surface('next-app', null))).toEqual([]);
  });
});

describe('Next.js app-router files under a dot directory (docs.page app/.well-known/jwks.json/route.ts)', () => {
  it('are listed for a Next package only, router file names only; their exports are runtime entry symbols', () => {
    write('next-dot', {
      'package.json': { name: 'web', version: '1.0.0', private: true, dependencies: { next: '15.0.0' } },
      'tsconfig.json': { ...TSCONFIG, include: ['**/*'] },
      'src/app/page.tsx': `export default function Page() { return null; }\n`,
      'src/app/.well-known/jwks.json/route.ts': `import { keys } from '../../../lib/keys';\nexport function GET() { return keys(); }\n`,
      'src/app/.well-known/helper.ts': `export const notARoute = 1;\n`,
      'app/(group)/.hidden/page.tsx': `export default function Hidden() { return null; }\n`,
      'src/lib/keys.ts': `export function keys() { return []; }\n`,
      // The runtime tsconfig the adapter writes for them (writeRuntimeTsconfig).
      'tsconfig.sentei-runtime.json': { extends: './tsconfig.json', compilerOptions: { allowJs: true }, include: [], files: ['./src/app/.well-known/jwks.json/route.ts'] },
    });
    const pkgDir = path.join(root, 'repos/next-dot');
    expect(nextDotDirEntries(pkgDir).map((f) => path.relative(pkgDir, f))).toEqual(['app/(group)/.hidden/page.tsx', 'src/app/.well-known/jwks.json/route.ts']);
    const r = surface('next-dot', 'web', { runtimeTsconfig: path.join(pkgDir, 'tsconfig.sentei-runtime.json') });
    expect(r.partial).toBe(false);
    expect(r.sidecar.entrySymbols.filter((e) => e.kind === 'runtime').map((e) => `${e.file}#${e.name}`)).toEqual(['src/app/.well-known/jwks.json/route.ts#GET']);
    // Without the runtime tsconfig the file is in no program: nothing is seeded (a diagnostic).
    const bare = surface('next-dot', 'web');
    expect(bare.sidecar.entrySymbols).toEqual([]);
    expect(bare.diagnostics.some((d) => d.includes('load src/app/.well-known/jwks.json/route.ts, which is in no TypeScript program'))).toBe(true);
    // Negative: not a Next package.
    write('not-next', { 'package.json': { name: 'x', version: '1.0.0' }, 'app/.well-known/route.ts': `export function GET() {}\n` });
    expect(nextDotDirEntries(path.join(root, 'repos/not-next'))).toEqual([]);
  });
});

/** The adapter on a one-package repo (installs off): writes `files`, returns its input. */
function adapterInput(repo: string, files: Record<string, string | object>, pkg: Partial<DiscoveredPackage> = {}): IndexerInput {
  write(repo, files);
  const p: DiscoveredPackage = { packageId: `npm:acme/${repo}:${repo}`, path: '.', manager: 'npm', name: repo, version: '1.0.0', entryPoints: [], deps: [], ...pkg };
  const r: DiscoveredRepo = { repo: `acme/${repo}`, localPath: path.join(root, 'repos', repo), headSha: null, packages: [p] };
  return { repo: r, pkg: p, lookup: () => undefined, orgPackages: [{ repo: r, pkg: p }], options: { install: false, maxOldSpaceMb: 2048 } };
}
async function runAdapter(inp: IndexerInput) {
  const out = path.join(root, `out-${inp.pkg.name}`);
  mkdirSync(out, { recursive: true });
  const r = await scipTypescript.run(inp, out);
  return {
    ...r,
    sidecar: existsSync(r.exportsFile) ? JSON.parse(readFileSync(r.exportsFile, 'utf8')) as ExportsSidecar : undefined,
    docs: existsSync(r.scipFile) ? readScipIndex(r.scipFile).documents.map((d) => d.relativePath).sort() : [],
  };
}

describe('solution-style tsconfigs: entries in no referenced project (astro packages/astro)', () => {
  const opts = { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', noEmit: true, skipLibCheck: true, types: [] };
  const sources = {
    'package.json': { name: 'solution', version: '1.0.0' },
    'tsconfig.build.json': { compilerOptions: opts, include: ['src'] },
    'src/index.ts': `export const main = 1;\n`,
    'components/index.ts': `export function component() { return 1; }\n`,
    'types.d.ts': `export type Tag = 'a';\n`,
  };
  const entries = { entryPoints: ['src/index.ts', 'components/index.ts', 'types.d.ts'] };

  it('are indexed through the runtime tsconfig with the package options: surface known, status ok', async () => {
    const r = await runAdapter(adapterInput('solution', {
      ...sources, 'tsconfig.json': { compilerOptions: opts, files: [], references: [{ path: './tsconfig.build.json' }] },
    }, entries));
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    expect(r.diagnostics).toContain(`info: 2 entry point(s) in no project of the solution-style tsconfig (project references) indexed through ${RUNTIME_TSCONFIG}: components/index.ts, types.d.ts`);
    expect(r.docs).toEqual(['components/index.ts', 'src/index.ts', 'types.d.ts']);
    expect(r.sidecar!.exports.map((e) => `${e.entry}#${e.exportedAs}`)).toEqual(['components/index.ts#component', 'src/index.ts#main', 'types.d.ts#Tag']);
    expect(r.sidecar!.missingEntryPoints).toEqual([]);
    expect(existsSync(path.join(root, 'repos/solution', RUNTIME_TSCONFIG))).toBe(false); // removed after the run
  }, 120_000);

  it('negative: without project references an entry outside the program still leaves the surface unknown (partial)', async () => {
    const r = await runAdapter(adapterInput('plain', {
      ...sources, 'package.json': { name: 'plain', version: '1.0.0' }, 'tsconfig.json': { compilerOptions: opts, include: ['src'] },
    }, entries));
    expect(r.status).toBe('partial');
    expect(r.diagnostics.at(-1)).toBe('cause: warn: entry point(s) not in the TypeScript program, export surface unknown: components/index.ts, types.d.ts');
  }, 120_000);
});

describe('an extends that cannot be resolved (very_good_workflows site: @tsconfig/docusaurus not installed)', () => {
  const site = {
    'package.json': { name: 'site', version: '1.0.0', private: true },
    'src/pages/index.js': `import { helper } from '../lib/helper';\nexport default function Home() { return helper(); }\n`,
    'src/lib/helper.js': `export function helper() { return 1; }\n`,
  };

  it('a package name that is not installed: indexed without it, the rest of the config kept, status ok', async () => {
    const r = await runAdapter(adapterInput('site', {
      ...site,
      'tsconfig.json': '{\n  // editor only\n  "extends": "@tsconfig/docusaurus/tsconfig.json",\n  "compilerOptions": { "baseUrl": ".", "jsx": "react-jsx" },\n}\n',
    }, { entryPoints: ['src/pages/index.js'] }));
    expect(r.status, r.diagnostics.join('\n')).toBe('ok');
    expect(r.diagnostics).toContain(`warn: tsconfig.json extends '@tsconfig/docusaurus/tsconfig.json', which is not installed; indexed through ${BASE_TSCONFIG} `
      + 'without it (its own compilerOptions, include and files kept; assumed allowJs, module esnext, moduleResolution bundler)');
    expect(r.docs).toEqual(['src/lib/helper.js', 'src/pages/index.js']);
    expect(r.sidecar!.exports.map((e) => e.exportedAs)).toEqual(['default']);
    expect(existsSync(path.join(root, 'repos/site', BASE_TSCONFIG))).toBe(false); // removed after the run
    expect(readFileSync(path.join(root, 'repos/site/tsconfig.json'), 'utf8')).toContain('@tsconfig/docusaurus'); // never rewritten
  }, 120_000);

  it('negative: a missing relative extends (a generated .nuxt/tsconfig.json) still fails the index', async () => {
    const r = await runAdapter(adapterInput('gen', {
      ...site, 'package.json': { name: 'gen', version: '1.0.0', private: true }, 'tsconfig.json': { extends: './.nuxt/tsconfig.json' },
    }, { entryPoints: ['src/pages/index.js'] }));
    expect(r.status).toBe('failed');
    expect(r.diagnostics.some((d) => d.startsWith('warn: tsconfig.json extends'))).toBe(false);
  }, 120_000);
});
