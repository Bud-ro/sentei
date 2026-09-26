import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { discoverLocal, discoverRepos, writeDiscoverToDb } from '../src/discover.ts';

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
    expect(logs).toEqual([
      'acme/app-worker: package.json: 2 runtime entry point(s) by convention (wrangler main, functions/, routes/…): functions/api/hello.ts, src/worker.ts',
      'acme/lib-cascade: package.json: client entry points from index.html / vite.config: src/client.ts',
      'acme/tool-py: npm:acme/tool-py:@acme/tool-py flagged unindexed_consumer (1 .py file(s), e.g. scripts/build.py)',
    ]);
    expect(model.org).toBe('acme');
    expect(model.source).toEqual({ kind: 'local', dir: FIXTURE });
    expect(model.generatedAt).toBe(1_700_000_000);
    const REPOS = ['app', 'app-consumer', 'app-dynamic', 'app-skew', 'app-worker', 'lib-cascade', 'lib-core', 'lib-dyn', 'lib-testkit', 'lib-widgets', 'lib-y', 'repo-broken', 'tool-py'];
    expect(model.repos.map((r) => r.repo)).toEqual(REPOS.map((n) => `acme/${n}`));
    expect(model.repos[0]!.localPath).toBe(join(FIXTURE, 'repos', 'app'));

    writeDiscoverToDb(db, model);
    expect(all('SELECT repo, default_branch, head_sha, index_status FROM repos ORDER BY repo')).toEqual(
      REPOS.map((n) => ({ repo: `acme/${n}`, default_branch: 'main', head_sha: null, index_status: null })),
    );
    expect(all('SELECT package_id, repo, path, manager, name, version, visibility, is_library, entry_points FROM packages ORDER BY package_id')).toEqual([
      { package_id: 'npm:acme/app-consumer:@acme/consumer', repo: 'acme/app-consumer', path: '.', manager: 'npm', name: '@acme/consumer', version: '1.0.0', visibility: 'private', is_library: 0, entry_points: '["src/main.ts"]' },
      { package_id: 'npm:acme/app-dynamic:@acme/app-dynamic', repo: 'acme/app-dynamic', path: '.', manager: 'npm', name: '@acme/app-dynamic', version: '1.0.0', visibility: 'private', is_library: 1, entry_points: '["src/load.cts","src/main.ts"]' },
      { package_id: 'npm:acme/app-skew:@acme/app-skew', repo: 'acme/app-skew', path: '.', manager: 'npm', name: '@acme/app-skew', version: '1.0.0', visibility: 'private', is_library: 0, entry_points: '["src/main.ts"]' },
      // wrangler.jsonc `main` + Pages functions/ (by convention); the `bin` is runtime-only, not an entry point
      { package_id: 'npm:acme/app-worker:@acme/worker', repo: 'acme/app-worker', path: '.', manager: 'npm', name: '@acme/worker', version: '1.0.0', visibility: 'private', is_library: 0, entry_points: '["functions/api/hello.ts","src/worker.ts"]' },
      { package_id: 'npm:acme/app:@acme/app', repo: 'acme/app', path: '.', manager: 'npm', name: '@acme/app', version: '1.0.0', visibility: 'private', is_library: 0, entry_points: '["src/main.ts"]' },
      // exports "." with an unbuilt `require` arm (fine: `import` resolves), `imports` map arms, index.html client entry
      { package_id: 'npm:acme/lib-cascade:@acme/cascade', repo: 'acme/lib-cascade', path: '.', manager: 'npm', name: '@acme/cascade', version: '1.0.0', visibility: 'private', is_library: 1, entry_points: '["src/client.ts","src/impl.node.ts","src/impl.ts","src/index.ts"]' },
      { package_id: 'npm:acme/lib-core:@acme/core', repo: 'acme/lib-core', path: '.', manager: 'npm', name: '@acme/core', version: '1.0.0', visibility: 'private', is_library: 1, entry_points: '["src/index.ts"]' },
      { package_id: 'npm:acme/lib-dyn:@acme/dyn', repo: 'acme/lib-dyn', path: '.', manager: 'npm', name: '@acme/dyn', version: '1.0.0', visibility: 'private', is_library: 1, entry_points: '["src/index.ts"]' },
      { package_id: 'npm:acme/lib-testkit:@acme/testkit', repo: 'acme/lib-testkit', path: '.', manager: 'npm', name: '@acme/testkit', version: '1.0.0', visibility: 'private', is_library: 1, entry_points: '["src/index.ts"]' },
      // published-public (no "private"), exports map incl. a "./deep/*" pattern resolved against the filesystem
      { package_id: 'npm:acme/lib-widgets:@acme/widgets', repo: 'acme/lib-widgets', path: '.', manager: 'npm', name: '@acme/widgets', version: '1.0.0', visibility: 'published-public', is_library: 1, entry_points: '["src/anon.ts","src/deep/thing.ts","src/index.ts","src/lazy.ts","src/unused-anon.ts"]' },
      { package_id: 'npm:acme/lib-y:@acme/y', repo: 'acme/lib-y', path: '.', manager: 'npm', name: '@acme/y', version: '1.0.0', visibility: 'private', is_library: 1, entry_points: '["src/index.ts"]' },
      { package_id: 'npm:acme/repo-broken:@acme/broken', repo: 'acme/repo-broken', path: '.', manager: 'npm', name: '@acme/broken', version: '1.0.0', visibility: 'private', is_library: 0, entry_points: '["src/main.ts"]' },
      { package_id: 'npm:acme/tool-py:@acme/tool-py', repo: 'acme/tool-py', path: '.', manager: 'npm', name: '@acme/tool-py', version: '1.0.0', visibility: 'private', is_library: 0, entry_points: '["src/main.ts"]' },
    ]);
    expect(all('SELECT * FROM package_deps ORDER BY consumer_package_id, dep_name')).toEqual([
      { consumer_package_id: 'npm:acme/app-consumer:@acme/consumer', dep_name: '@acme/testkit', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-testkit:@acme/testkit', dev: 1, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/app-consumer:@acme/consumer', dep_name: '@acme/widgets', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-widgets:@acme/widgets', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/app-consumer:@acme/consumer', dep_name: '@acme/y', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-y:@acme/y', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/app-dynamic:@acme/app-dynamic', dep_name: '@acme/dyn', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-dyn:@acme/dyn', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/app-skew:@acme/app-skew', dep_name: '@acme/widgets', dep_manager: 'npm', dep_constraint: '1.0.0', resolved_package_id: 'npm:acme/lib-widgets:@acme/widgets', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/app-worker:@acme/worker', dep_name: '@acme/widgets', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-widgets:@acme/widgets', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/app:@acme/app', dep_name: '@acme/core', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-core:@acme/core', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/lib-widgets:@acme/widgets', dep_name: '@acme/y', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-y:@acme/y', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/repo-broken:@acme/broken', dep_name: '@acme/y', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-y:@acme/y', dev: 0, resolution: 'name', ambiguous: 0 },
      { consumer_package_id: 'npm:acme/tool-py:@acme/tool-py', dep_name: '@acme/y', dep_manager: 'npm', dep_constraint: '^1.0.0', resolved_package_id: 'npm:acme/lib-y:@acme/y', dev: 0, resolution: 'name', ambiguous: 0 },
    ]);
    expect(all('SELECT key, value FROM policy ORDER BY key')).toEqual([
      { key: 'assumeClosedWorld', value: 'true' },
      { key: 'countDocsAsConsumers', value: 'false' },
      { key: 'countTestsAsConsumers', value: 'false' },
      { key: 'minAgeDays', value: '0' },
      { key: 'trustPrivateRegistry', value: 'true' },
    ]);
    expect(all('SELECT * FROM keep_rules')).toEqual([{ package_id: 'npm:acme/lib-widgets:@acme/widgets', symbol_name: 'keptFn' }]);
    expect(all('SELECT * FROM package_flags')).toEqual([
      { package_id: 'npm:acme/tool-py:@acme/tool-py', flag: 'unindexed_consumer', reason: '1 .py file(s), e.g. scripts/build.py', file: 'scripts/build.py', target_package_id: null },
    ]);
    expect(all('SELECT * FROM blocked_packages ORDER BY package_id')).toEqual([
      { package_id: 'npm:acme/lib-y:@acme/y', blocker_package_id: 'npm:acme/tool-py:@acme/tool-py', flag: 'unindexed_consumer' },
    ]);
  });

  it('is a whole-org rebuild: rerunning replaces rows (and cascades derived data)', () => {
    const model = discoverLocal({ orgDir: FIXTURE });
    writeDiscoverToDb(db, model);
    db.prepare("INSERT INTO repos (repo) VALUES ('acme/gone')").run();
    db.prepare("INSERT INTO symbols (symbol_str, package_id, file, name) VALUES ('s', 'npm:acme/lib-core:@acme/core', 'src/index.ts', 'x')").run();
    writeDiscoverToDb(db, model);
    expect(all('SELECT count(*) AS n FROM repos')).toEqual([{ n: 13 }]);
    expect(all("SELECT count(*) AS n FROM repos WHERE repo = 'acme/gone'")).toEqual([{ n: 0 }]);
    expect(all('SELECT count(*) AS n FROM symbols')).toEqual([{ n: 0 }]);
  });
});

describe('discoverLocal on a synthetic org', () => {
  function org(repos: string[], cfg?: object): void {
    write('org/org.json', { org: 'acme', repos: repos.map((name) => ({ name, default_branch: 'main' })) });
    if (cfg) write('org/sentei.json', cfg);
  }

  it('the same (manager, name) in two repos is two packages (package id <manager>:<repo>:<name>)', () => {
    org(['a', 'b']);
    write('org/repos/a/package.json', { name: '@acme/dup' });
    write('org/repos/b/packages/x/package.json', { name: '@acme/dup' });
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    expect(m.repos.flatMap((r) => r.packages.map((p) => [p.packageId, p.path]))).toEqual([
      ['npm:acme/a:@acme/dup', '.'], ['npm:acme/b:@acme/dup', 'packages/x'],
    ]);
    expect(logs).toContain('note: 2 org packages are named npm:@acme/dup: npm:acme/a:@acme/dup, npm:acme/b:@acme/dup');
    writeDiscoverToDb(db, m);
    expect(all('SELECT package_id, repo, name FROM packages ORDER BY package_id')).toEqual([
      { package_id: 'npm:acme/a:@acme/dup', repo: 'acme/a', name: '@acme/dup' },
      { package_id: 'npm:acme/b:@acme/dup', repo: 'acme/b', name: '@acme/dup' },
    ]);
  });

  it('resolves a shared name: same repo first, else the only published one, else ambiguous (every candidate flagged)', () => {
    org(['one', 'two', 'three', 'four', 'mono']);
    // @acme/dup: published in one, private in two -> a consumer elsewhere means one.
    write('org/repos/one/package.json', { name: '@acme/dup' });
    write('org/repos/two/package.json', { name: '@acme/dup', private: true });
    // @acme/both: published in three and four -> ambiguous outside those repos.
    write('org/repos/three/package.json', { name: '@acme/both' });
    write('org/repos/four/package.json', { name: '@acme/both' });
    write('org/repos/four/app/package.json', { name: 'four-app', private: true, dependencies: { '@acme/both': '^1', '@acme/dup': '^1' } });
    // mono has its own @acme/dup (private): same repo wins even over the published one.
    write('org/repos/mono/package.json', { name: '@acme/dup', private: true });
    write('org/repos/mono/app/package.json', {
      name: 'mono-app', private: true, dependencies: { '@acme/dup': 'workspace:*', '@acme/both': '^1', alias: 'npm:@acme/dup@^1' },
    });
    write('org/repos/mono/examples/demo/package.json', { name: 'demo', dependencies: { '@acme/both': '^1' } });
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    const pkg = (id: string) => m.repos.flatMap((r) => r.packages).find((p) => p.packageId === id)!;
    expect(pkg('npm:acme/four:four-app').deps).toEqual([
      { name: '@acme/both', manager: 'npm', constraint: '^1', resolvedPackageId: 'npm:acme/four:@acme/both', resolution: 'same-repo',
        candidates: ['npm:acme/four:@acme/both', 'npm:acme/three:@acme/both'] },
      { name: '@acme/dup', manager: 'npm', constraint: '^1', resolvedPackageId: 'npm:acme/one:@acme/dup', resolution: 'published',
        candidates: ['npm:acme/mono:@acme/dup', 'npm:acme/one:@acme/dup', 'npm:acme/two:@acme/dup'] },
    ]);
    const monoApp = pkg('npm:acme/mono:mono-app');
    expect(monoApp.deps.map((d) => [d.name, d.resolvedPackageId, d.resolution ?? null, d.ambiguous ?? false])).toEqual([
      ['@acme/both', null, null, true],
      ['@acme/dup', 'npm:acme/mono:@acme/dup', 'same-repo', false],
      ['alias', 'npm:acme/mono:@acme/dup', 'same-repo', false],
    ]);
    const reason = 'dep @acme/both matches 2 org packages: npm:acme/four:@acme/both, npm:acme/three:@acme/both';
    expect(monoApp.flags).toEqual([
      { flag: 'ambiguous_dep', reason, file: 'app/package.json', targetPackageId: 'npm:acme/four:@acme/both' },
      { flag: 'ambiguous_dep', reason, file: 'app/package.json', targetPackageId: 'npm:acme/three:@acme/both' },
    ]);
    // Ignored manifests resolve the same way; an ambiguous dep keeps its candidates (the witness scans for each).
    expect(m.repos.find((r) => r.repo === 'acme/mono')!.ignoredManifests[0]!.deps).toEqual([
      { name: '@acme/both', manager: 'npm', constraint: '^1', resolvedPackageId: null, ambiguous: true,
        candidates: ['npm:acme/four:@acme/both', 'npm:acme/three:@acme/both'] },
    ]);
    expect(logs).toContain('warning: acme/mono: npm:acme/mono:mono-app dep @acme/both matches 2 org packages (npm:acme/four:@acme/both, '
      + 'npm:acme/three:@acme/both); unresolved, their verdicts are blocked (ambiguous_dep). Keep the one it means and exclude the '
      + 'others in the org sentei.json, e.g. "ignoreManifests": ["four/package.json", "three/package.json"] minus the real one');
    expect(logs).toContain('acme/four: npm:acme/four:four-app dep @acme/dup matches 3 org packages; resolved to npm:acme/one:@acme/dup (published)');

    writeDiscoverToDb(db, m);
    expect(all(`SELECT dep_name, resolved_package_id, resolution, ambiguous FROM package_deps
      WHERE consumer_package_id = 'npm:acme/mono:mono-app' ORDER BY dep_name`)).toEqual([
      { dep_name: '@acme/both', resolved_package_id: null, resolution: null, ambiguous: 1 },
      { dep_name: '@acme/dup', resolved_package_id: 'npm:acme/mono:@acme/dup', resolution: 'same-repo', ambiguous: 0 },
      { dep_name: 'alias', resolved_package_id: 'npm:acme/mono:@acme/dup', resolution: 'same-repo', ambiguous: 0 },
    ]);
    // Fail closed: each candidate is blocked for the consumer; the consumer itself stays transparent.
    expect(all("SELECT package_id, blocker_package_id, flag FROM blocked_packages WHERE flag = 'ambiguous_dep' ORDER BY package_id")).toEqual([
      { package_id: 'npm:acme/four:@acme/both', blocker_package_id: 'npm:acme/mono:mono-app', flag: 'ambiguous_dep' },
      { package_id: 'npm:acme/three:@acme/both', blocker_package_id: 'npm:acme/mono:mono-app', flag: 'ambiguous_dep' },
    ]);
    expect(all('SELECT package_id FROM opaque_packages')).toEqual([]);
  });

  it('private duplicates within one repo are auto-ignored (kept as ignored manifests); across repos they are packages', () => {
    org(['lib', 'docs', 'site']);
    write('org/repos/lib/package.json', { name: '@acme/lib' });
    write('org/repos/lib/apps/demo/package.json', { name: '@acme/lib', private: true, dependencies: { '@acme/lib': 'workspace:*' } });
    // Private in two repos: two real packages (ids differ by repo).
    write('org/repos/docs/package.json', { name: 'docs', private: true });
    write('org/repos/site/package.json', { name: 'docs', private: true, dependencies: { '@acme/lib': '^1' } });
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    expect(m.repos.flatMap((r) => r.packages.map((p) => `${r.repo}:${p.path}:${p.packageId}`))).toEqual([
      'acme/docs:.:npm:acme/docs:docs', 'acme/lib:.:npm:acme/lib:@acme/lib', 'acme/site:.:npm:acme/site:docs',
    ]);
    expect(m.repos.map((r) => r.ignoredManifests.map((i) => [i.manifest, i.name, i.deps.map((d) => d.resolvedPackageId)]))).toEqual([
      [],
      [['apps/demo/package.json', '@acme/lib', ['npm:acme/lib:@acme/lib']]],
      [],
    ]);
    expect(logs.filter((l) => l.includes('ignored private duplicate'))).toEqual([
      'acme/lib: ignored private duplicate manifest acme/lib/apps/demo/package.json (same name as acme/lib/package.json)',
    ]);
  });

  it('pub: publish_to: none duplicates are private too; two non-private ones in one repo still clash', () => {
    org(['a', 'b', 'c']);
    write('org/repos/a/pubspec.yaml', 'name: shared\n');
    write('org/repos/b/pubspec.yaml', 'name: shared\npublish_to: none\n');
    write('org/repos/c/package.json', { name: 'x' });
    write('org/repos/c/sub/package.json', { name: 'x', private: true });
    write('org/repos/c/other/package.json', { name: 'x' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(
      /npm:acme\/c:x: acme\/c:package\.json, acme\/c:other\/package\.json\n/);
    write('org/repos/c/other/package.json', { name: 'y' });
    const m = discoverLocal({ orgDir: join(tmp, 'org') });
    expect(m.repos.flatMap((r) => r.packages.map((p) => p.packageId))).toEqual([
      'pub:acme/a:shared', 'pub:acme/b:shared', 'npm:acme/c:x', 'npm:acme/c:y',
    ]);
  });

  it('flags a package whose code-looking entry point resolves to nothing opaque_consumer; ingest keeps the flag', () => {
    org(['lib']);
    write('org/repos/lib/package.json', { name: '@acme/lib', exports: { '.': './dist/index.mjs', './vue': './dist/vue.mjs' } });
    write('org/repos/lib/src/index.ts', '');
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    const p = m.repos[0]!.packages[0]!;
    expect(p.unresolvedEntryPoints).toEqual(['./dist/vue.mjs']);
    expect(p.flags).toEqual([{ flag: 'opaque_consumer', reason: 'discover: unresolved entry point ./dist/vue.mjs', file: 'package.json' }]);
    expect(logs).toContain('warning: acme/lib: npm:acme/lib:@acme/lib flagged opaque_consumer (unresolved entry point ./dist/vue.mjs)');
    writeDiscoverToDb(db, m);
    expect(all('SELECT package_id, flag, reason, file, target_package_id FROM package_flags')).toEqual([
      { package_id: 'npm:acme/lib:@acme/lib', flag: 'opaque_consumer', reason: 'discover: unresolved entry point ./dist/vue.mjs', file: 'package.json', target_package_id: null },
    ]);
    expect(all('SELECT package_id FROM opaque_packages')).toEqual([{ package_id: 'npm:acme/lib:@acme/lib' }]);
  });

  it('the same-repo clash message lists every location and copy-pasteable ignoreManifests suggestions', () => {
    org(['hono', 'starter', 'vscode']);
    write('org/repos/hono/package.json', { name: 'hono' });
    write('org/repos/starter/package.json', { name: 'basic' });
    write('org/repos/starter/apps/vercel/package.json', { name: 'hono' });
    write('org/repos/starter/apps/node/package.json', { name: 'hono' });
    write('org/repos/starter/basic/package.json', { name: 'basic' });
    write('org/repos/vscode/package.json', { name: 'hono' }); // another repo: no clash
    let msg = '';
    try {
      discoverLocal({ orgDir: join(tmp, 'org') });
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('  npm:acme/starter:basic: acme/starter:package.json, acme/starter:basic/package.json\n');
    expect(msg).toContain('  npm:acme/starter:hono: acme/starter:apps/node/package.json, acme/starter:apps/vercel/package.json\n');
    expect(msg).not.toContain('vscode');
    const suggestion = /^ {2}("ignoreManifests": \[.*\])$/m.exec(msg)?.[1];
    expect(JSON.parse(`{${suggestion}}`)).toEqual({
      ignoreManifests: ['starter/package.json', 'starter/basic/package.json', 'starter/apps/node/package.json', 'starter/apps/vercel/package.json'],
    });
  });

  it('ignoreManifests globs (org sentei.json) remove manifests; unused globs warn', () => {
    org(['hono', 'starter', 'vscode'], { ignoreManifests: ['vscode/package.json', 'starter/apps/*/package.json', 'nope/**'] });
    write('org/repos/hono/package.json', { name: 'hono' });
    write('org/repos/starter/apps/vercel/package.json', { name: 'hono' });
    write('org/repos/starter/apps/vercel/index.ts', '');
    write('org/repos/vscode/package.json', { name: 'hono' });
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    expect(m.repos.map((r) => [r.repo, r.packages.map((p) => p.packageId)])).toEqual([
      ['acme/hono', ['npm:acme/hono:hono']], ['acme/starter', []], ['acme/vscode', []],
    ]);
    expect(logs).toContain('acme/vscode: skipped 1 manifest(s) as not org packages (ignoreManifestDirs/ignoreManifests): package.json');
    expect(logs).toContain('warning: org sentei.json ignoreManifests "nope/**" matched no manifest');
  });

  it('manifests under default ignore dirs are not org packages; ignoreManifestDirs replaces the default', () => {
    org(['hono', 'starter']);
    write('org/repos/hono/package.json', { name: 'hono' });
    write('org/repos/starter/templates/vercel/package.json', { name: 'hono' });
    write('org/repos/starter/templates/vercel/index.ts', '');
    write('org/repos/hono/index.ts', '');
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    expect(m.repos.flatMap((r) => r.packages.map((p) => p.packageId))).toEqual(['npm:acme/hono:hono']);
    expect(logs).toEqual([
      'acme/starter: skipped 1 manifest(s) as not org packages (ignoreManifestDirs/ignoreManifests): templates/vercel/package.json',
    ]);
    // An explicit list replaces the default: templates/ is now a real package (another repo: no clash).
    org(['hono', 'starter'], { ignoreManifestDirs: ['fixtures'] });
    expect(discoverLocal({ orgDir: join(tmp, 'org') }).repos.flatMap((r) => r.packages.map((p) => p.packageId)))
      .toEqual(['npm:acme/hono:hono', 'npm:acme/starter:hono']);
  });

  it('records ignored manifests per repo with deps resolved against org packages (discover.json only, not the DB)', () => {
    org(['lib', 'app']);
    write('org/repos/lib/package.json', { name: '@acme/lib', main: 'src/index.ts' });
    write('org/repos/lib/src/index.ts', '');
    write('org/repos/lib/examples/demo/package.json', {
      name: 'demo', dependencies: { '@acme/lib': 'workspace:*', react: '^18' }, devDependencies: { aliased: 'npm:@acme/lib@^1' },
    });
    write('org/repos/lib/examples/demo/src/x.ts', '');
    write('org/repos/app/package.json', { name: '@acme/app' });
    write('org/repos/app/fixtures/broken/package.json', '{ nope');
    write('org/repos/app/templates/dart/pubspec.yaml', 'dependencies:\n  lib_pub: ^1.0.0\n');
    const logs: string[] = [];
    const m = discoverLocal({ orgDir: join(tmp, 'org'), log: (l) => logs.push(l) });
    const [app, lib] = m.repos;
    expect(lib!.ignoredManifests).toEqual([{
      path: 'examples/demo',
      manifest: 'examples/demo/package.json',
      manager: 'npm',
      name: 'demo',
      deps: [
        { name: '@acme/lib', manager: 'npm', constraint: 'workspace:*', resolvedPackageId: 'npm:acme/lib:@acme/lib', resolution: 'name' },
        { name: 'aliased', manager: 'npm', constraint: 'npm:@acme/lib@^1', resolvedPackageId: 'npm:acme/lib:@acme/lib', resolution: 'name', dev: true },
        { name: 'react', manager: 'npm', constraint: '^18', resolvedPackageId: null },
      ],
      depsUnknown: false,
    }]);
    expect(app!.ignoredManifests).toEqual([
      { path: 'fixtures/broken', manifest: 'fixtures/broken/package.json', manager: 'npm', name: null, deps: [], depsUnknown: true },
      {
        path: 'templates/dart', manifest: 'templates/dart/pubspec.yaml', manager: 'pub', name: null,
        deps: [{ name: 'lib_pub', manager: 'pub', constraint: '^1.0.0', resolvedPackageId: null }], depsUnknown: false,
      },
    ]);
    expect(logs.some((l) => /^warning: acme\/app: fixtures\/broken\/package\.json \(ignored manifest\): cannot parse/.test(l))).toBe(true);
    // Nothing of it reaches the DB.
    writeDiscoverToDb(db, m);
    expect(all('SELECT package_id FROM packages ORDER BY package_id')).toEqual([{ package_id: 'npm:acme/app:@acme/app' }, { package_id: 'npm:acme/lib:@acme/lib' }]);
    expect(all('SELECT count(*) AS n FROM package_deps')).toEqual([{ n: 0 }]);
  });

  describe('unindexed_consumer', () => {
    function flags(m: ReturnType<typeof discoverLocal>): unknown[] {
      writeDiscoverToDb(db, m);
      return all('SELECT * FROM package_flags ORDER BY package_id');
    }

    it('flags an org-package consumer with code in a language we cannot index, and only that package', () => {
      org(['lib', 'mono']);
      write('org/repos/lib/package.json', { name: '@acme/lib' });
      write('org/repos/lib/tools/gen.go', ''); // not a consumer of any org package: no flag
      write('org/repos/mono/package.json', { name: 'root', private: true, dependencies: { '@acme/lib': '^1' } });
      write('org/repos/mono/src/index.ts', '');
      write('org/repos/mono/scripts/b.py', '');
      write('org/repos/mono/scripts/a.py', '');
      write('org/repos/mono/scripts/Tool.RB', '');
      // Not the root package's: a nested package, SKIP_DIRS, ignored manifest dirs.
      write('org/repos/mono/packages/n/package.json', { name: '@acme/n', dependencies: { '@acme/lib': '^1' } });
      write('org/repos/mono/packages/n/index.ts', '');
      write('org/repos/mono/node_modules/x/y.py', '');
      write('org/repos/mono/tests/t.py', '');
      write('org/repos/mono/examples/e/main.go', '');
      const m = discoverLocal({ orgDir: join(tmp, 'org') });
      const root = m.repos[1]!.packages.find((p) => p.packageId === 'npm:acme/mono:root')!;
      expect(root.flags).toEqual([{ flag: 'unindexed_consumer', reason: '2 .py, 1 .rb file(s), e.g. scripts/Tool.RB', file: 'scripts/Tool.RB' }]);
      expect(flags(m)).toEqual([
        { package_id: 'npm:acme/mono:root', flag: 'unindexed_consumer', reason: '2 .py, 1 .rb file(s), e.g. scripts/Tool.RB', file: 'scripts/Tool.RB', target_package_id: null },
      ]);
      expect(all('SELECT package_id, blocker_package_id, flag FROM blocked_packages')).toEqual([
        { package_id: 'npm:acme/lib:@acme/lib', blocker_package_id: 'npm:acme/mono:root', flag: 'unindexed_consumer' },
      ]);
    });

    it('is not set for shell/YAML/JSON/Markdown/Dockerfile-only consumers or for packages without org deps', () => {
      org(['lib', 'app', 'third']);
      write('org/repos/lib/package.json', { name: '@acme/lib' });
      write('org/repos/app/package.json', { name: 'app', dependencies: { '@acme/lib': '^1' } });
      for (const f of ['build.sh', 'ci.yaml', 'ci.yml', 'data.json', 'README.md', 'Dockerfile', 'Makefile', 'src/i.ts', 'src/x.dart']) {
        write(`org/repos/app/${f}`, '');
      }
      write('org/repos/third/package.json', { name: 'third', dependencies: { lodash: '^4' } });
      write('org/repos/third/main.py', '');
      const m = discoverLocal({ orgDir: join(tmp, 'org') });
      expect(m.repos.flatMap((r) => r.packages.map((p) => p.flags))).toEqual([[], [], []]);
      expect(flags(m)).toEqual([]);
    });
  });

  it('same name under different managers is allowed', () => {
    org(['a']);
    write('org/repos/a/package.json', { name: 'same' });
    write('org/repos/a/dart/pubspec.yaml', 'name: same\n');
    const m = discoverLocal({ orgDir: join(tmp, 'org') });
    expect(m.repos[0]!.packages.map((p) => p.packageId)).toEqual(['npm:acme/a:same', 'pub:acme/a:same']);
  });

  it('resolves workspace/file/alias npm deps and pub path deps; overlays, keep rules, default policy', () => {
    org(['mono', 'dart'], { keep: ['npm:@acme/a#legacy', 'npm:@acme/nope#x', 'pub:acme/dart:e#eKept', 'pub:acme/mono:e#x'] });
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
    expect(dart!.packages.map((p) => [p.packageId, p.path, p.visibility, p.isLibrary, p.entryPoints])).toEqual([
      ['pub:acme/dart:d', '.', 'published-public', true, ['lib/d.dart']],
      ['pub:acme/dart:e', 'e', 'private', true, ['e/lib/e.dart']],
    ]);
    expect(dart!.packages[0]!.deps).toEqual([
      { name: 'e', manager: 'pub', constraint: 'path:e', resolvedPackageId: 'pub:acme/dart:e', resolution: 'name' },
      { name: 'http', manager: 'pub', constraint: '^1.0.0', resolvedPackageId: null },
    ]);
    expect(mono!.packages.map((p) => [p.packageId, p.path, p.entryPoints])).toEqual([
      ['npm:acme/mono:root', '.', []],
      ['npm:acme/mono:@acme/a', 'packages/a', ['packages/a/src/index.ts', 'packages/a/stories/deep/A.stories.tsx']],
      ['npm:acme/mono:@acme/b', 'packages/b', ['packages/b/index.ts']],
    ]);
    expect(mono!.packages[2]!.deps).toEqual([
      { name: '@acme/a', manager: 'npm', constraint: 'workspace:^', resolvedPackageId: 'npm:acme/mono:@acme/a', resolution: 'name' },
      { name: 'aliased', manager: 'npm', constraint: 'npm:@acme/a@^1.0.0', resolvedPackageId: 'npm:acme/mono:@acme/a', resolution: 'name' },
      { name: 'lodash', manager: 'npm', constraint: '^4', resolvedPackageId: null },
      { name: 'root', manager: 'npm', constraint: 'file:../..', resolvedPackageId: 'npm:acme/mono:root', resolution: 'name', dev: true },
    ]);
    expect(mono!.config.extraEdges).toEqual([{ from: 'file:packages/b/index.ts', to: 'npm:@acme/a#*' }]);
    expect(logs.some((l) => l.includes('"nothing/**" matched no files'))).toBe(true);

    const warnings: string[] = [];
    writeDiscoverToDb(db, m, (w) => warnings.push(w));
    // Name-only keep entries apply to every package of that name; <repo>:<name> ones to that package.
    expect(all('SELECT package_id, symbol_name FROM keep_rules ORDER BY package_id, symbol_name')).toEqual([
      { package_id: 'npm:acme/mono:@acme/a', symbol_name: 'legacy' },
      { package_id: 'npm:acme/mono:@acme/b', symbol_name: '*' },
      { package_id: 'pub:acme/dart:e', symbol_name: 'eKept' },
    ]);
    expect(warnings).toEqual([
      'org sentei.json: keep entry "npm:@acme/nope#x" names unknown package npm:@acme/nope, ignored',
      'org sentei.json: keep entry "pub:acme/mono:e#x" names unknown package pub:acme/mono:e, ignored',
    ]);
    expect(all("SELECT value FROM policy WHERE key = 'minAgeDays'")).toEqual([{ value: '180' }]);
    expect(all('SELECT count(*) AS n FROM package_deps WHERE resolved_package_id IS NOT NULL')).toEqual([{ n: 4 }]);
  });

  it('rejects malformed sentei.json (unknown keys, bad keep entries, wrong types)', () => {
    org(['a'], { minAgeDays: 30, keep: ['npm:x'] });
    write('org/repos/a/package.json', { name: 'a' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/keep entry "npm:x"/);
    for (const bad of ['npm:acme:x#s', 'npm:a/b/c:x#s', 'cargo:x#s', 'npm:x#', 'npm:x#a#b']) {
      org(['a'], { keep: [bad] });
      expect(() => discoverLocal({ orgDir: join(tmp, 'org') }), bad).toThrow(/must look like "npm:<name>#<symbol>", "npm:<org>\/<repo>:<name>#<symbol>"/);
    }
    org(['a'], { minAgeDay: 30 });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/unknown key "minAgeDay"/);
    org(['a'], { assumeClosedWorld: 'yes' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/"assumeClosedWorld" must be a boolean/);
    org(['a'], { ignoreManifestDir: ['x'] });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/unknown key "ignoreManifestDir"/);
    org(['a'], { ignoreManifestDirs: 'fixtures' });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/"ignoreManifestDirs" must be an array of strings/);
    org(['a'], { ignoreManifestDirs: ['a/b'] });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/must be a single directory name/);
    org(['a'], { ignoreManifests: ['package.json'] });
    expect(() => discoverLocal({ orgDir: join(tmp, 'org') })).toThrow(/must be "<repo name>\/<manifest path>"/);
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
    expect(all('SELECT count(*) AS n FROM packages')).toEqual([{ n: 13 }]);
  });
});

describe('discoverRepos', () => {
  it('builds the model from explicit checkouts: github source, head shas, default policy without a config dir', () => {
    write('clones/b/package.json', { name: 'b', dependencies: { a: '^1' } });
    write('clones/a/package.json', { name: 'a' });
    const source = { kind: 'github' as const, org: 'acme', apiUrl: 'https://api.github.com', lockfile: null, clonesDir: join(tmp, 'clones') };
    const m = discoverRepos({
      org: 'acme',
      source,
      repos: ['b', 'a'].map((name, i) => ({ name, defaultBranch: 'main', localPath: join(tmp, 'clones', name), headSha: String(i).repeat(40) })),
      orgConfigDir: null,
      now: 1,
    });
    expect(m.source).toEqual(source);
    expect(m.policy.minAgeDays).toBe(180);
    expect(m.repos.map((r) => [r.repo, r.headSha])).toEqual([['acme/a', '1'.repeat(40)], ['acme/b', '0'.repeat(40)]]);
    expect(m.repos[1]!.packages[0]!.deps[0]!.resolvedPackageId).toBe('npm:acme/a:a');
    writeDiscoverToDb(db, m);
    expect(all('SELECT repo, head_sha FROM repos ORDER BY repo')).toEqual([
      { repo: 'acme/a', head_sha: '1'.repeat(40) },
      { repo: 'acme/b', head_sha: '0'.repeat(40) },
    ]);
  });
});

describe('setPolicyValue / isPolicyKey (shared by org sentei.json and --policy)', () => {
  it('validates and stores policy values', async () => {
    const { DEFAULT_POLICY, isPolicyKey, setPolicyValue } = await import('../src/config.ts');
    const p = { ...DEFAULT_POLICY };
    setPolicyValue(p, 'minAgeDays', 0, 'x');
    setPolicyValue(p, 'assumeClosedWorld', true, 'x');
    expect(p).toMatchObject({ minAgeDays: 0, assumeClosedWorld: true });
    expect(() => setPolicyValue(p, 'minAgeDays', 1.5, 'where')).toThrow('sentei: where: "minAgeDays" must be a non-negative integer');
    expect(() => setPolicyValue(p, 'countTestsAsConsumers', 'true', 'where')).toThrow('"countTestsAsConsumers" must be a boolean');
    expect(isPolicyKey('trustPrivateRegistry')).toBe(true);
    expect(isPolicyKey('keep')).toBe(false);
    expect(isPolicyKey('toString')).toBe(false);
  });
});

describe('package ids and package refs (config.ts)', () => {
  it('builds and splits <manager>:<repo>:<name>; parses name-only and repo-qualified refs', async () => {
    const { packageIdOf, splitPackageId, parsePackageRef, packageRefMatches, parseKeepEntry } = await import('../src/config.ts');
    expect(packageIdOf('npm', 'acme/lib-core', '@acme/core')).toBe('npm:acme/lib-core:@acme/core');
    expect(splitPackageId('pub:Workiva/w_flux:w_flux')).toEqual({ manager: 'pub', repo: 'Workiva/w_flux', name: 'w_flux' });
    for (const bad of ['npm:@acme/core', 'npm:acme:x', 'npm:a/b/c:x', 'npm:acme/x:', 'npm:acme/x:y:z']) expect(splitPackageId(bad), bad).toBeNull();
    expect(parsePackageRef('npm:@acme/core')).toEqual({ manager: 'npm', repo: null, name: '@acme/core' });
    expect(parsePackageRef('npm:acme/lib-core:@acme/core')).toEqual({ manager: 'npm', repo: 'acme/lib-core', name: '@acme/core' });
    expect(parsePackageRef('pub:w_flux')).toEqual({ manager: 'pub', repo: null, name: 'w_flux' });
    expect(parsePackageRef('npm:acme:x')).toBeNull();
    const pkg = { manager: 'npm', repo: 'acme/one', name: '@acme/dup' };
    expect(packageRefMatches(parsePackageRef('npm:@acme/dup')!, pkg)).toBe(true);
    expect(packageRefMatches(parsePackageRef('npm:acme/one:@acme/dup')!, pkg)).toBe(true);
    expect(packageRefMatches(parsePackageRef('npm:acme/two:@acme/dup')!, pkg)).toBe(false);
    expect(packageRefMatches(parsePackageRef('pub:@acme/dup')!, pkg)).toBe(false);
    expect(parseKeepEntry('npm:acme/one:@acme/dup#*')).toEqual({ ref: { manager: 'npm', repo: 'acme/one', name: '@acme/dup' }, symbolName: '*' });
  });
});
