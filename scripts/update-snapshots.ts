// Indexer snapshots (PLAN.md §6.6): upgrading an indexer requires re-running the
// fixture orgs and diffing the produced SCIP. This script copies each fixture org
// to $TMPDIR, runs discover + index (installs off), renders every `.scip` with
// snapshotScip and writes
//   fixtures/snapshots/<indexer>@<version>/<org>/<repo slug>/<pkg slug>.snapshot.txt
//   fixtures/snapshots/<indexer>@<version>/<org>/<repo slug>/<pkg slug>.exports.json
// (the export sidecar, keys and arrays sorted), then deletes stale files for the
// orgs it regenerated. A changed snapshot is reviewed like a code change.
// packages/cli/test/snapshots.test.ts checks the files are current.
//
//   npm run snapshots:update
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@sentei/core/db';
import { readScipIndex } from '@sentei/core/scip';
import { snapshotScip } from '@sentei/core/scip/snapshot';
import { discover } from '../packages/cli/src/stages/discover.ts';
import { index, type RepoIndex } from '../packages/cli/src/stages/index.ts';

export const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
export const SNAPSHOTS = path.join(FIXTURES, 'snapshots');
export const UPDATE_COMMAND = 'npm run snapshots:update';

export interface FixtureOrg {
  /** Directory name under fixtures/. */
  name: string;
  /** Needs the Dart SDK on PATH. */
  dart: boolean;
}

export const ORGS: readonly FixtureOrg[] = [
  { name: 'org-small', dart: false },
  { name: 'org-dart', dart: true },
];

export function hasDart(): boolean {
  return spawnSync('dart', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
}

export function hasFlutter(): boolean {
  return spawnSync('flutter', ['--version', '--machine'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
}

/** Fixture repos that need the Flutter SDK (repo name -> pub package name), per org. */
export const FLUTTER_REPOS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'org-dart': { 'flutter-app': 'acme_flutter_app', 'flutter-widgets': 'acme_widgets' },
};

/**
 * Without `flutter` on PATH: removes the org's Flutter repos from a fixture
 * copy (org.json and repos/), so the rest of the org indexes as before.
 */
export function dropFlutterRepos(orgName: string, orgDir: string): void {
  const drop = Object.keys(FLUTTER_REPOS[orgName] ?? {});
  if (drop.length === 0) return;
  const orgJson = path.join(orgDir, 'org.json');
  const cfg = JSON.parse(readFileSync(orgJson, 'utf8')) as { repos: Array<{ name: string }> };
  cfg.repos = cfg.repos.filter((r) => !drop.includes(r.name));
  writeFileSync(orgJson, JSON.stringify(cfg, null, 2));
  for (const r of drop) rmSync(path.join(orgDir, 'repos', r), { recursive: true, force: true });
}

/** A snapshot key (`<indexer>/<org>/<owner>__<repo>/...`) of one of the org's Flutter repos. */
export function isFlutterSnapshot(orgName: string, rel: string): boolean {
  const repoSlug = rel.split('/')[2] ?? '';
  return Object.keys(FLUTTER_REPOS[orgName] ?? {}).some((r) => repoSlug.endsWith(`__${r}`));
}

/** Skip installed deps and pub state a manual run may have left in the fixture. */
const SKIP = new Set(['node_modules', '.dart_tool', 'pubspec.lock', 'pubspec_overrides.yaml']);

/** Recursively sort object keys, and arrays by their canonical JSON (sidecar arrays are sets). */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v
      .map(canonical)
      .map((x) => [JSON.stringify(x), x] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, x]) => x);
  }
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/**
 * Index one fixture org in a temp copy and return its snapshot files, keyed by
 * POSIX path relative to fixtures/snapshots.
 */
export async function generateOrgSnapshots(
  org: FixtureOrg,
  log: (l: string) => void = () => {},
  flutter: boolean = hasFlutter(),
): Promise<Map<string, string>> {
  const tmp = realpathSync(mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-snapshots-')));
  try {
    const orgDir = path.join(tmp, org.name);
    cpSync(path.join(FIXTURES, org.name), orgDir, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    if (!flutter) dropFlutterRepos(org.name, orgDir);
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    const dbPath = path.join(work, 'sentei.db');
    const db = openDb(dbPath);
    try {
      const ctx = { work, dbPath, db, orgDir, log };
      await discover(ctx);
      await index(ctx, { install: false, force: true });
    } finally {
      db.close();
    }

    const files = new Map<string, string>();
    const indexRoot = path.join(work, 'index');
    // Belt and braces: nothing machine-specific may leak into a checked-in file.
    const scrub = (s: string): string => s.replaceAll(tmp, '<tmp>');
    for (const repoSlug of readdirSync(indexRoot).sort()) {
      const repoDir = path.join(indexRoot, repoSlug);
      const idxFile = path.join(repoDir, 'index.json');
      if (!existsSync(idxFile)) continue;
      const repoIndex = JSON.parse(readFileSync(idxFile, 'utf8')) as RepoIndex;
      for (const p of repoIndex.packages) {
        if (p.indexer === null || p.scip === null) continue;
        const scip = path.join(repoDir, p.scip);
        if (!existsSync(scip)) continue;
        const base = `${p.indexer}@${p.indexerVersion}/${org.name}/${repoSlug}/${path.basename(p.scip, '.scip')}`;
        files.set(`${base}.snapshot.txt`, scrub(snapshotScip(readScipIndex(scip))));
        if (p.exports !== null && existsSync(path.join(repoDir, p.exports))) {
          const sidecar = canonical(JSON.parse(readFileSync(path.join(repoDir, p.exports), 'utf8')));
          files.set(`${base}.exports.json`, scrub(`${JSON.stringify(sidecar, null, 2)}\n`));
        }
      }
    }
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every checked-in snapshot file of `org`, keyed like generateOrgSnapshots. */
export function checkedInFiles(org: string, root = SNAPSHOTS): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(root, p).split(path.sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  for (const tool of readdirSync(root, { withFileTypes: true })) {
    if (tool.isDirectory() && existsSync(path.join(root, tool.name, org))) walk(path.join(root, tool.name, org));
  }
  return out;
}

/** Write `files` under `root` and delete this org's files that were not produced. */
function writeOrg(org: string, files: Map<string, string>, root: string, keep: (rel: string) => boolean = () => false): { written: number; deleted: string[] } {
  const deleted: string[] = [];
  for (const rel of checkedInFiles(org, root).keys()) {
    if (!files.has(rel) && !keep(rel)) {
      rmSync(path.join(root, rel));
      deleted.push(rel);
    }
  }
  for (const [rel, text] of files) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  // Drop directories emptied by the deletions (e.g. an old <indexer>@<version>).
  const prune = (dir: string): boolean => {
    let empty = true;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !prune(path.join(dir, e.name))) empty = false;
    }
    if (empty && dir !== root) rmSync(dir, { recursive: true });
    return empty;
  };
  if (existsSync(root)) prune(root);
  return { written: files.size, deleted };
}

async function main(): Promise<void> {
  const dart = hasDart();
  const flutter = hasFlutter();
  for (const org of ORGS) {
    if (org.dart && !dart) {
      console.warn(`[snapshots] SKIPPING ${org.name}: \`dart\` is not on PATH (its snapshots are left untouched)`);
      continue;
    }
    if (!flutter && FLUTTER_REPOS[org.name] !== undefined) {
      console.warn(`[snapshots] ${org.name}: \`flutter\` is not on PATH; its Flutter repos' snapshots are left untouched`);
    }
    const files = await generateOrgSnapshots(org, (l) => {
      if (l.startsWith('[index]')) console.log(l);
    }, flutter);
    const { written, deleted } = writeOrg(org.name, files, SNAPSHOTS, (rel) => !flutter && isFlutterSnapshot(org.name, rel));
    console.log(`[snapshots] ${org.name}: wrote ${written} file(s)${deleted.length ? `, deleted ${deleted.join(', ')}` : ''}`);
  }
  console.log('[snapshots] review with `git diff fixtures/snapshots`');
}

if (import.meta.main) await main();
