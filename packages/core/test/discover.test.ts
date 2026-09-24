import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { discoverLocal, writeDiscoverToDb } from '../src/discover.ts';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/org-small', import.meta.url));

let tmp: string;
let db: DatabaseSync;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sentei-discover-'));
  db = openDb(join(tmp, 'sentei.db'));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function all(sql: string): unknown[] {
  return db.prepare(sql).all().map((r) => ({ ...r }));
}

function write(rel: string, content: string | object): void {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
}

describe('discoverLocal on fixtures/org-small', () => {
  it('builds the model and writes it to the DB', () => {
    const logs: string[] = [];
    const model = discoverLocal({ orgDir: FIXTURE, log: (l) => logs.push(l), now: 1_700_000_000 });
    expect(logs).toEqual([]);
    expect(model.org).toBe('acme');
    expect(model.source).toEqual({ kind: 'local', dir: FIXTURE });
    expect(model.generatedAt).toBe(1_700_000_000);
    expect(model.repos.map((r) => r.repo)).toEqual(['acme/app', 'acme/lib-core']);
    expect(model.repos[0]!.localPath).toBe(join(FIXTURE, 'repos', 'app'));

    writeDiscoverToDb(db, model);
    expect(all('SELECT repo, default_branch, head_sha, index_status FROM repos ORDER BY repo')).toEqual([
      { repo: 'acme/app', default_branch: 'main', head_sha: null, index_status: null },
      { repo: 'acme/lib-core', default_branch: 'main', head_sha: null, index_status: null },
    ]);
    expect(all('SELECT package_id, repo, path, manager, name, version, visibility, entry_points FROM packages ORDER BY package_id')).toEqual([
      { package_id: 'npm:@acme/app', repo: 'acme/app', path: '.', manager: 'npm', name: '@acme/app', version: '1.0.0', visibility: 'private', entry_points: '["src/main.ts"]' },
      { package_id: 'npm:@acme/core', repo: 'acme/lib-core', path: '.', manager: 'npm', name: '@acme/core', version: '1.0.0', visibility: 'private', entry_points: '["src/index.ts"]' },
    ]);
    expect(all('SELECT * FROM package_deps')).toEqual([
      { consumer_package_id: 'npm:@acme/app', dep_name: '@acme/core', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:@acme/core' },
    ]);
    expect(all('SELECT key, value FROM policy ORDER BY key')).toEqual([
      { key: 'assumeClosedWorld', value: 'true' },
      { key: 'countDocsAsConsumers', value: 'false' },
      { key: 'countTestsAsConsumers', value: 'false' },
      { key: 'minAgeDays', value: '0' },
      { key: 'trustPrivateRegistry', value: 'true' },
    ]);
    expect(all('SELECT * FROM keep_rules')).toEqual([]);
  });

  it('is a whole-org rebuild: rerunning replaces rows (and cascades derived data)', () => {
    const model = discoverLocal({ orgDir: FIXTURE });
    writeDiscoverToDb(db, model);
    db.prepare("INSERT INTO repos (repo) VALUES ('acme/gone')").run();
    db.prepare("INSERT INTO symbols (symbol_str, package_id, file, name) VALUES ('s', 'npm:@acme/core', 'src/index.ts', 'x')").run();
    writeDiscoverToDb(db, model);
    expect(all('SELECT repo FROM repos ORDER BY repo')).toEqual([{ repo: 'acme/app' }, { repo: 'acme/lib-core' }]);
    expect(all('SELECT count(*) AS n FROM symbols')).toEqual([{ n: 0 }]);
  });
});

describe('discoverLocal on a synthetic org', () => {
  function org(repos: string[], cfg?: object): void {
    write('org/org.json', { org: 'acme', repos: repos.map((name) => ({ name, default_branch: 'main' })) });
    if (cfg) write('org/sentei.json', cfg);
  }

  it('duplicate (manager, name) across repos is a hard error naming both locations', () => {
    org(['a', 'b']);
    write('org/repos/a/package.json', { name: '@acme/dup' });
    write('org/repos/b/packages/x/package.json', { name: '@acme/dup' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(
      /npm:@acme\/dup: acme\/a:package\.json, acme\/b:packages\/x\/package\.json/);
  });

  it('same name under different managers is allowed', () => {
    org(['a']);
    write('org/repos/a/package.json', { name: 'same' });
    write('org/repos/a/dart/pubspec.yaml', 'name: same\n');
    const m = discoverLocal({ orgDir: join(tmp, 'org') });
    expect(m.repos[0]!.packages.map((p) => p.packageId)).toEqual(['npm:same', 'pub:same']);
  });

  it('resolves workspace/file/alias npm deps and pub path deps; overlays, keep rules, default policy', () => {
    org(['mono', 'dart'], { keep: ['npm:@acme/a#legacy', 'npm:@acme/nope#x'] });
    write('org/repos/mono/package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    write('org/repos/mono/packages/a/package.json', { name: '@acme/a', main: 'src/index.ts' });
    write('org/repos/mono/packages/a/src/index.ts', '');
    write('org/repos/mono/packages/a/stories/deep/A.stories.tsx', '');
    write('org/repos/mono/packages/b/package.json', {
      name: '@acme/b',
      dependencies: { '@acme/a': 'workspace:^', aliased: 'npm:@acme/a@^1.0.0', lodash: '^4' },
      devDependencies: { root: 'file:../..' },
    });
    write('org/repos/mono/packages/b/index.ts', '');
    write('org/repos/mono/sentei.json', {
      extraEntryPoints: ['packages/*/stories/**/*.tsx', 'nothing/**'],
      extraEdges: [{ from: 'file:packages/b/index.ts', to: 'npm:@acme/a#*' }],
      keep: ['npm:@acme/b#*', 'npm:@acme/a#legacy'],
    });
    write('org/repos/dart/pubspec.yaml', 'name: d\ndependencies:\n  e:\n    path: e\n  http: ^1.0.0\n');
    write('org/repos/dart/lib/d.dart', '');
    write('org/repos/dart/e/pubspec.yaml', 'name: e\npublish_to: none\n');
    write('org/repos/dart/e/lib/e.dart', '');

    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    expect(m.policy).toEqual({ minAgeDays: 180, trustPrivateRegistry: true, assumeClosedWorld: false, countTestsAsConsumers: false, countDocsAsConsumers: false });
    expect(m.repos.map((r) => r.repo)).toEqual(['acme/dart', 'acme/mono']);
    const [dart, mono] = m.repos;
    expect(dart!.packages.map((p) => [p.packageId, p.path, p.visibility, p.entryPoints])).toEqual([
      ['pub:d', '.', 'published-public', ['lib/d.dart']],
      ['pub:e', 'e', 'private', ['e/lib/e.dart']],
    ]);
    expect(dart!.packages[0]!.deps).toEqual([
      { name: 'e', manager: 'pub', constraint: 'path:e', resolvedPackageId: 'pub:e' },
      { name: 'http', manager: 'pub', constraint: '^1.0.0', resolvedPackageId: null },
    ]);
    expect(mono!.packages.map((p) => [p.packageId, p.path, p.entryPoints])).toEqual([
      ['npm:root', '.', []],
      ['npm:@acme/a', 'packages/a', ['packages/a/src/index.ts', 'packages/a/stories/deep/A.stories.tsx']],
      ['npm:@acme/b', 'packages/b', ['packages/b/index.ts']],
    ]);
    expect(mono!.packages[2]!.deps).toEqual([
      { name: '@acme/a', manager: 'npm', constraint: 'workspace:^', resolvedPackageId: 'npm:@acme/a' },
      { name: 'aliased', manager: 'npm', constraint: 'npm:@acme/a@^1.0.0', resolvedPackageId: 'npm:@acme/a' },
      { name: 'lodash', manager: 'npm', constraint: '^4', resolvedPackageId: null },
      { name: 'root', manager: 'npm', constraint: 'file:../..', resolvedPackageId: 'npm:root' },
    ]);
    expect(mono!.config.extraEdges).toEqual([{ from: 'file:packages/b/index.ts', to: 'npm:@acme/a#*' }]);
    expect(logs.some((l) => l.includes('"nothing/**" matched no files'))).toBe(true);

    const warnings: string[] = [];
    writeDiscoverToDb(db, m, (w) => warnings.push(w));
    expect(all('SELECT package_id, symbol_name FROM keep_rules ORDER BY package_id, symbol_name')).toEqual([
      { package_id: 'npm:@acme/a', symbol_name: 'legacy' },
      { package_id: 'npm:@acme/b', symbol_name: '*' },
    ]);
    expect(warnings).toEqual(['org sentei.json: keep entry "npm:@acme/nope#x" names unknown package npm:@acme/nope, ignored']);
    expect(all("SELECT value FROM policy WHERE key = 'minAgeDays'")).toEqual([{ value: '180' }]);
    expect(all('SELECT count(*) AS n FROM package_deps WHERE resolved_package_id IS NOT NULL')).toEqual([{ n: 4 }]);
  });

  it('rejects malformed sentei.json (unknown keys, bad keep entries, wrong types)', () => {
    org(['a'], { minAgeDays: 30, keep: ['npm:x'] });
    write('org/repos/a/package.json', { name: 'a' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/keep entry "npm:x"/);
    org(['a'], { minAgeDay: 30 });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/unknown key "minAgeDay"/);
    org(['a'], { assumeClosedWorld: 'yes' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/"assumeClosedWorld" must be a boolean/);
    org(['a'], {});
    write('org/repos/a/sentei.json', { extraEntryPoint: ['x'] });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/unknown key "extraEntryPoint"/);
    write('org/repos/a/sentei.json', { extraEdges: [{ from: 'x' }] });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/extraEdges\[0\]/);
  });

  it('a repo listed in org.json without a checkout is an error', () => {
    org(['missing']);
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/acme\/missing: expected a checkout/);
  });

  it('a failed write rolls back and leaves the previous org intact', () => {
    writeDiscoverToDb(db, discoverLocal({ orgDir: FIXTURE }));
    const bad = discoverLocal({ orgDir: FIXTURE });
    bad.repos[0]!.packages[0]!.visibility = 'bogus' as never;
    expect(() => writeDiscoverToDb(db, bad)).toThrow();
    expect(all('SELECT count(*) AS n FROM packages')).toEqual([{ n: 2 }]);
  });
});
