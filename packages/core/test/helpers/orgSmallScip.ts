// Builds ingest inputs for fixtures/org-small without the discover/index stages:
// runs scip-typescript on a temp copy of the fixture (consumer's node_modules/@acme/core
// symlinked to the lib checkout, as the index stage does), hand-writes the export
// sidecars, index.json files and the discover model, and seeds repos/packages rows.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ExportsSidecar, IngestDiscoverInput, RepoIndexFile } from '../../src/ingest.ts';
import { repoSlug } from '../../src/ingest.ts';

const FIXTURE = resolve(import.meta.dirname, '../../../../fixtures/org-small');

/** Path to scip-typescript's CLI script, or undefined if it is not installed. */
export function findScipTypescript(): string | undefined {
  const fromEnv = process.env['SENTEI_SCIP_TYPESCRIPT'];
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
  const require = createRequire(join(import.meta.dirname, '../../../cli/package.json'));
  try {
    const pkgJson = require.resolve('@sourcegraph/scip-typescript/package.json');
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['scip-typescript'];
    return bin ? join(dirname(pkgJson), bin) : undefined;
  } catch {
    return undefined;
  }
}

export interface OrgSmallInputs {
  root: string;
  workDir: string;
  discover: IngestDiscoverInput;
  /** Insert the repos/packages/package_deps rows discover would write. */
  seedDb(db: DatabaseSync): void;
  cleanup(): void;
}

interface Pos { file: string; line: number; col: number }

/** 0-based position of the `nth` match of `re`'s capture group 1 in a repo file. */
function locate(repoDir: string, file: string, re: RegExp, nth = 0): Pos {
  const lines = readFileSync(join(repoDir, file), 'utf8').split(/\r?\n/);
  let seen = 0;
  for (let line = 0; line < lines.length; line += 1) {
    const g = new RegExp(re.source, 'g');
    for (let m = g.exec(lines[line]!); m; m = g.exec(lines[line]!)) {
      if (seen === nth) return { file, line, col: m.index + m[0].indexOf(m[1]!) };
      seen += 1;
    }
  }
  throw new Error(`locate: ${re} not found in ${file}`);
}

export function buildOrgSmallInputs(scipTs: string): OrgSmallInputs {
  const root = mkdtempSync(join(tmpdir(), 'sentei-ingest-'));
  const repos = join(root, 'repos');
  const workDir = join(root, 'work');
  // node_modules is skipped: the index stage may have left links in the fixture checkout.
  cpSync(join(FIXTURE, 'repos'), repos, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes('node_modules') });
  mkdirSync(join(repos, 'app/node_modules/@acme'), { recursive: true });
  symlinkSync('../../../lib-core', join(repos, 'app/node_modules/@acme/core'));

  const lib = { repo: 'acme/lib-core', dir: join(repos, 'lib-core'), packageId: 'npm:@acme/core', name: '@acme/core', entry: 'src/index.ts' };
  const app = { repo: 'acme/app', dir: join(repos, 'app'), packageId: 'npm:@acme/app', name: '@acme/app', entry: 'src/main.ts' };

  // Sidecar for @acme/core: `export { usedFn, unusedFn, internalOnlyFn } from './fns'`.
  const exported = ['usedFn', 'unusedFn', 'internalOnlyFn'];
  const libSidecar: ExportsSidecar = {
    packageId: lib.packageId,
    entryPoints: [lib.entry],
    exports: exported.map((name) => ({
      entry: lib.entry,
      exportedAs: name,
      name,
      ...locate(lib.dir, 'src/fns.ts', new RegExp(`function (${name})\\b`)),
      sites: [locate(lib.dir, lib.entry, new RegExp(`\\b(${name})\\b`))],
    })),
    unresolved: [],
  };
  const appSidecar: ExportsSidecar = { packageId: app.packageId, entryPoints: [app.entry], exports: [], unresolved: [] };

  for (const [r, sidecar] of [[lib, libSidecar], [app, appSidecar]] as const) {
    const dir = join(workDir, 'index', repoSlug(r.repo));
    mkdirSync(dir, { recursive: true });
    const slug = r.packageId.replace(/[:/@]+/g, '_');
    const res = spawnSync(process.execPath, [scipTs, 'index', '--output', join(dir, `${slug}.scip`)], { cwd: r.dir, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`scip-typescript failed in ${r.dir}: ${res.stderr}${res.stdout}`);
    writeFileSync(join(dir, `${slug}.exports.json`), JSON.stringify(sidecar, null, 2));
    const index: RepoIndexFile = {
      repo: r.repo,
      headSha: null,
      status: 'ok',
      packages: [{
        packageId: r.packageId, indexer: 'scip-typescript', indexerVersion: '0.4.0', status: 'ok',
        scip: `${slug}.scip`, exports: `${slug}.exports.json`, diagnostics: [],
      }],
    };
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2));
  }

  const discover: IngestDiscoverInput = {
    repos: [app, lib].map((r) => ({
      repo: r.repo,
      config: { extraEdges: [] },
      packages: [{ packageId: r.packageId, path: '.', entryPoints: [r.entry] }],
    })),
  };

  return {
    root,
    workDir,
    discover,
    seedDb(db) {
      for (const r of [app, lib]) {
        db.prepare("INSERT INTO repos (repo, default_branch) VALUES (?, 'main')").run(r.repo);
        db.prepare("INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, entry_points) VALUES (?, ?, '.', 'npm', ?, '1.0.0', 'private', ?)")
          .run(r.packageId, r.repo, r.name, JSON.stringify([r.entry]));
      }
      db.prepare("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id) VALUES (?, ?, 'npm', '^1.0.0', ?)")
        .run(app.packageId, lib.name, lib.packageId);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
