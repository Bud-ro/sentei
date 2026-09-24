import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StageContext } from '../src/context.ts';
import type { DiscoverFile, ExportsSidecar } from '../src/indexers/types.ts';
import { index, type RepoIndex } from '../src/stages/index.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/org-small');

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
    cpSync(path.join(FIXTURE, 'repos', r), path.join(tmp, 'repos', r), { recursive: true });
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
