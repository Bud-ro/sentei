// Phase 3 fix round 9b (rerun at 840cd97): lazy component loaders (docs.page's
// `next/dynamic(() => import('./search-dialog'))`), Next.js app-router files under dot
// directories (`app/.well-known/jwks.json/route.ts`), solution-style tsconfigs whose
// entries are in no program (astro), and an `extends` that cannot be resolved
// (very_good_workflows' docs site).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importedNames } from '../src/indexers/consumer-checks.ts';
import { computeExportSurface } from '../src/indexers/export-surface.ts';

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
