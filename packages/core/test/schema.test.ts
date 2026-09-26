import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../src/db.ts';

const REJECTED = /sentei:|constraint/i;

let db: DatabaseSync;

function run(sql: string, ...params: Array<string | number | null>): void {
  db.prepare(sql).run(...params);
}

function count(sql: string, ...params: Array<string | number | null>): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function addRepo(repo = 'acme/lib'): void {
  run('INSERT INTO repos (repo, default_branch, head_sha, indexed_at, index_status) VALUES (?, ?, ?, ?, ?)',
    repo, 'main', 'abc123', 1_700_000_000, 'ok');
}

function addPackage(
  name: string,
  opts: { repo?: string; visibility?: string; manager?: string; id?: string; path?: string } = {},
): string {
  const manager = opts.manager ?? 'npm';
  const repo = opts.repo ?? 'acme/lib';
  const id = opts.id ?? `${manager}:${repo}:${name}`;
  run('INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, repo, opts.path ?? `packages/${name.replace(/[@/]/g, '_')}`, manager, name, '1.0.0', opts.visibility ?? 'private', '["src/index.ts"]');
  return id;
}

function addSymbol(packageId: string, name: string, str = `scip-typescript npm ${packageId} 1.0.0 src/\`index.ts\`/${name}().`): number {
  const r = db.prepare('INSERT INTO symbols (symbol_str, package_id, file, line, col, kind, name, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(str, packageId, 'src/index.ts', 1, 0, 'function', name, 1);
  return Number(r.lastInsertRowid);
}

function addOccurrence(symbolId: number, filePackage: string, defPackage: string, enclosing: number | null = null): void {
  run('INSERT INTO occurrences (symbol_id, package_id, def_package_id, file, line, col, role, enclosing_symbol_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    symbolId, filePackage, defPackage, 'src/use.ts', 3, 4, 8, enclosing);
}

function addEdge(from: number, to: number, fromPkg: string, toPkg: string, source = 'scip'): void {
  run('INSERT INTO edges (from_symbol_id, to_symbol_id, from_package_id, to_package_id, source) VALUES (?, ?, ?, ?, ?)',
    from, to, fromPkg, toPkg, source);
}

function addFinding(symbolId: number, verdict: string): void {
  run('INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, ?)',
    symbolId, verdict, '[]', '[]');
}

function setPolicy(key: string, value: unknown): void {
  run('INSERT INTO policy (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
});

describe('openDb', () => {
  it('enables foreign keys and is idempotent', () => {
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
    // Re-open a file DB twice to prove re-applying the schema is a no-op.
    const path = join(process.env['TMPDIR'] ?? '.', `sentei-schema-test-${process.pid}.db`);
    db = openDb(path);
    addRepo();
    db.close();
    db = openDb(path);
    expect(count('SELECT count(*) AS n FROM repos')).toBe(1);
    expect(count("SELECT count(*) AS n FROM policy WHERE key = 'minAgeDays'")).toBe(1);
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    db = openDb(':memory:');
  });

  it('stamps SCHEMA_VERSION and refuses a DB stamped with another version', () => {
    expect(SCHEMA_VERSION).toBe(11);
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(v.user_version).toBe(SCHEMA_VERSION);
    db.close();
    const path = join(process.env['TMPDIR'] ?? '.', `sentei-schema-version-${process.pid}.db`);
    // Sandboxed runs reuse pids: a file left by an aborted run must not decide this test.
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    db = openDb(path);
    db.exec('PRAGMA user_version = 1');
    db.close();
    expect(() => openDb(path)).toThrow(/schema version 1, expected 11/);
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    db = openDb(':memory:');
  });
});

describe('smoke', () => {
  it('accepts a repo -> package -> symbol -> occurrence -> edge chain', () => {
    addRepo();
    addRepo('acme/app');
    const lib = addPackage('@acme/lib');
    const app = addPackage('@acme/app', { repo: 'acme/app' });
    run('INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id) VALUES (?, ?, ?, ?, ?)',
      app, '@acme/lib', 'npm', '^1.0.0', lib);
    const a = addSymbol(lib, 'a');
    const b = addSymbol(lib, 'b');
    const main = addSymbol(app, 'main');
    addOccurrence(a, app, lib, main);
    addEdge(main, a, app, lib);
    addEdge(a, b, lib, lib, 'overlay');
    expect(count('SELECT count(*) AS n FROM occurrences')).toBe(1);
    expect(count('SELECT count(*) AS n FROM edges')).toBe(2);
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkErrors).toEqual([]);
  });

  it('computes is_external from package_id vs def_package_id', () => {
    addRepo();
    const lib = addPackage('@acme/lib');
    const app = addPackage('@acme/app');
    const a = addSymbol(lib, 'a');
    addOccurrence(a, lib, lib);
    addOccurrence(a, app, lib);
    const rows = db.prepare('SELECT package_id, is_external FROM occurrences ORDER BY package_id').all();
    expect(rows).toEqual([
      { package_id: app, is_external: 1 },
      { package_id: lib, is_external: 0 },
    ]);
  });

  it('cascades DELETE FROM repos to every derived row', () => {
    addRepo();
    const lib = addPackage('@acme/lib');
    const a = addSymbol(lib, 'a');
    const b = addSymbol(lib, 'b');
    addOccurrence(a, lib, lib, b);
    addEdge(b, a, lib, lib);
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'dynamic_access', 'x')", lib);
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'a')", lib);
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', b, 1);
    run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/index.ts', 'default')", a);
    addFinding(a, 'private_dead');
    addRepo('acme/app');
    const app = addPackage('@acme/app', { repo: 'acme/app' });
    run('INSERT INTO documents (package_id, file, module_symbol_id, is_entry) VALUES (?, ?, ?, 1)', lib, 'src/index.ts', b);
    run('INSERT INTO unresolved_refs (consumer_package_id, target_package_id, symbol_str, file, line, col) VALUES (?, ?, ?, ?, ?, ?)',
      app, lib, 'gone', 'src/main.ts', 1, 2);
    run("INSERT INTO witness_files (consumer_package_id, target_package_id, file) VALUES (?, ?, 'bench/x.ts')", app, lib);
    run('DELETE FROM repos');
    for (const t of ['packages', 'package_deps', 'symbols', 'occurrences', 'edges', 'package_flags', 'keep_rules', 'witness_ok', 'findings', 'documents', 'unresolved_refs', 'symbol_exports', 'witness_files']) {
      expect(count(`SELECT count(*) AS n FROM ${t}`), t).toBe(0);
    }
  });
});

describe('packages invariants', () => {
  beforeEach(() => addRepo());

  it('accepts the same (manager, name) in two repos: identity is (repo, path, manager)', () => {
    const a = addPackage('@acme/lib');
    addRepo('acme/other');
    const b = addPackage('@acme/lib', { repo: 'acme/other' });
    expect([a, b]).toEqual(['npm:acme/lib:@acme/lib', 'npm:acme/other:@acme/lib']);
    // An npm and a pub package may share a dir; two npm packages may not.
    addPackage('lib_x', { manager: 'pub', path: 'packages/x' });
    addPackage('lib-x', { path: 'packages/x' });
    expect(() => addPackage('lib-y', { path: 'packages/x' })).toThrow(REJECTED);
    const idx = db.prepare("SELECT count(*) AS n FROM pragma_index_list('packages') WHERE \"unique\" = 1 AND origin = 'u'").get() as { n: number };
    expect(idx.n).toBe(1);
  });

  it('rejects an unknown visibility', () => {
    expect(() => addPackage('@acme/lib', { visibility: 'public' })).toThrow(REJECTED);
  });

  it('rejects an unknown manager', () => {
    expect(() => addPackage('lib', { manager: 'cargo' })).toThrow(REJECTED);
  });

  it('defaults is_library to 0 and rejects values outside 0/1', () => {
    const id = addPackage('@acme/lib');
    expect(count('SELECT is_library AS n FROM packages WHERE package_id = ?', id)).toBe(0);
    run('UPDATE packages SET is_library = 1 WHERE package_id = ?', id);
    expect(() => run('UPDATE packages SET is_library = 2 WHERE package_id = ?', id)).toThrow(REJECTED);
    expect(() => run('UPDATE packages SET is_library = NULL WHERE package_id = ?', id)).toThrow(REJECTED);
  });

  it('rejects a package_id not shaped <manager>:<repo>:<name>', () => {
    expect(() => addPackage('@acme/lib', { id: '@acme/lib' })).toThrow(REJECTED);
    expect(() => addPackage('@acme/lib', { id: 'npm:@acme/lib' })).toThrow(REJECTED);
    expect(() => addPackage('@acme/lib', { id: 'pub:acme/lib:@acme/lib' })).toThrow(REJECTED);
    expect(() => addPackage('@acme/lib', { id: 'npm:acme/other:@acme/lib' })).toThrow(REJECTED);
  });

  it('rejects entry_points that are not a JSON array', () => {
    expect(() => run("INSERT INTO packages (package_id, repo, path, manager, name, visibility, entry_points) VALUES ('npm:acme/lib:x', 'acme/lib', '.', 'npm', 'x', 'private', '{}')"))
      .toThrow(REJECTED);
  });

  it('rejects a package whose repo does not exist', () => {
    expect(() => addPackage('@acme/lib', { repo: 'acme/missing' })).toThrow(REJECTED);
  });
});

describe('excluded_repos', () => {
  it('takes a JSON array of manifests or NULL, nothing else', () => {
    run("INSERT INTO excluded_repos (repo, reason, manifests) VALUES ('acme/a', 'archived', NULL), ('acme/b', 'size', '[\"package.json\"]')");
    expect(count('SELECT count(*) AS n FROM excluded_repos')).toBe(2);
    expect(() => run("INSERT INTO excluded_repos (repo, reason, manifests) VALUES ('acme/c', 'x', '{}')")).toThrow(REJECTED);
    expect(() => run("INSERT INTO excluded_repos (repo, reason, manifests) VALUES ('acme/d', 'x', 'nope')")).toThrow(REJECTED);
    expect(() => run("INSERT INTO excluded_repos (repo, reason, manifests) VALUES ('acme/e', NULL, NULL)")).toThrow(REJECTED);
  });
});

describe('symbols invariants', () => {
  let lib: string;
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
  });

  it('rejects duplicate symbol_str', () => {
    addSymbol(lib, 'a', 'same');
    expect(() => addSymbol(lib, 'b', 'same')).toThrow(REJECTED);
  });

  it('rejects a symbol whose package does not exist', () => {
    expect(() => addSymbol('npm:acme/lib:@acme/missing', 'a')).toThrow(REJECTED);
  });

  it('rejects moving a symbol to another package', () => {
    const other = addPackage('@acme/other');
    const a = addSymbol(lib, 'a');
    expect(() => run('UPDATE symbols SET package_id = ? WHERE symbol_id = ?', other, a)).toThrow(REJECTED);
  });
});

describe('symbols.parent_symbol_id invariants', () => {
  let lib: string;
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
  });

  it('accepts a same-package parent and cascades its deletion to members', () => {
    const owner = addSymbol(lib, 'Foo', 'Foo#');
    const member = addSymbol(lib, 'bar', 'Foo#bar().');
    run('UPDATE symbols SET parent_symbol_id = ? WHERE symbol_id = ?', owner, member);
    run('DELETE FROM symbols WHERE symbol_id = ?', owner);
    expect(count('SELECT count(*) AS n FROM symbols')).toBe(0);
  });

  it('rejects an unknown parent', () => {
    const member = addSymbol(lib, 'bar');
    expect(() => run('UPDATE symbols SET parent_symbol_id = 9999 WHERE symbol_id = ?', member)).toThrow(REJECTED);
    expect(() => run("INSERT INTO symbols (symbol_str, package_id, file, name, parent_symbol_id) VALUES ('x', ?, 'f', 'x', 9999)", lib))
      .toThrow(REJECTED);
  });

  it('rejects a parent in another package (insert and update)', () => {
    const other = addPackage('@acme/other');
    const owner = addSymbol(other, 'Foo', 'Foo#');
    const member = addSymbol(lib, 'bar');
    expect(() => run('UPDATE symbols SET parent_symbol_id = ? WHERE symbol_id = ?', owner, member))
      .toThrow(/sentei: symbols.parent_symbol_id/);
    expect(() => run("INSERT INTO symbols (symbol_str, package_id, file, name, parent_symbol_id) VALUES ('x', ?, 'f', 'x', ?)", lib, owner))
      .toThrow(/sentei: symbols.parent_symbol_id/);
  });

  it('rejects a symbol being its own parent', () => {
    const a = addSymbol(lib, 'a');
    expect(() => run('UPDATE symbols SET parent_symbol_id = symbol_id WHERE symbol_id = ?', a)).toThrow(REJECTED);
  });
});

describe('symbol_exports invariants', () => {
  let lib: string;
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
  });

  it('accepts several aliases per symbol and entry, rejecting duplicates', () => {
    const a = addSymbol(lib, 'a');
    run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/index.ts', 'a')", a);
    run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/index.ts', 'b')", a);
    run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/other.ts', 'a')", a);
    expect(count('SELECT count(*) AS n FROM symbol_exports')).toBe(3);
    expect(() => run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/index.ts', 'b')", a))
      .toThrow(REJECTED);
  });

  it('rejects an unknown symbol and missing columns', () => {
    const a = addSymbol(lib, 'a');
    expect(() => run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (9999, 'src/index.ts', 'a')"))
      .toThrow(REJECTED);
    expect(() => run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (NULL, 'src/index.ts', 'a')"))
      .toThrow(REJECTED);
    expect(() => run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, NULL, 'a')", a)).toThrow(REJECTED);
    expect(() => run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/index.ts', NULL)", a))
      .toThrow(REJECTED);
  });

  it('cascades when the symbol goes', () => {
    const a = addSymbol(lib, 'a');
    const b = addSymbol(lib, 'b');
    run("INSERT INTO symbol_exports (symbol_id, entry_file, exported_as) VALUES (?, 'src/index.ts', 'a'), (?, 'src/index.ts', 'b')", a, b);
    run('DELETE FROM symbols WHERE symbol_id = ?', a);
    expect(db.prepare('SELECT symbol_id, exported_as FROM symbol_exports').all()).toEqual([{ symbol_id: b, exported_as: 'b' }]);
  });
});

describe('documents invariants', () => {
  let lib: string;
  let mod: number;
  function addDoc(pkg: string, file: string, moduleSymbol: number | null, isEntry: number = 0): void {
    run('INSERT INTO documents (package_id, file, module_symbol_id, is_entry) VALUES (?, ?, ?, ?)', pkg, file, moduleSymbol, isEntry);
  }
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
    mod = addSymbol(lib, 'index.ts', 'src/`index.ts`/');
  });

  it('accepts a document and cascades when its module symbol goes', () => {
    addDoc(lib, 'src/index.ts', mod, 1);
    run('DELETE FROM symbols');
    expect(count('SELECT count(*) AS n FROM documents')).toBe(0);
  });

  it('rejects a duplicate (package_id, file)', () => {
    addDoc(lib, 'src/index.ts', mod);
    expect(() => addDoc(lib, 'src/index.ts', null)).toThrow(REJECTED);
  });

  it('rejects an unknown package or module symbol', () => {
    expect(() => addDoc('npm:acme/lib:@acme/missing', 'src/index.ts', null)).toThrow(REJECTED);
    expect(() => addDoc(lib, 'src/index.ts', 9999)).toThrow(REJECTED);
  });

  it('rejects a module symbol from another package (insert and update)', () => {
    const other = addPackage('@acme/other');
    expect(() => addDoc(other, 'src/index.ts', mod)).toThrow(/sentei: documents.module_symbol_id/);
    addDoc(lib, 'src/index.ts', mod);
    expect(() => run('UPDATE documents SET package_id = ?', other)).toThrow(/sentei: documents.module_symbol_id/);
  });

  it('rejects is_entry outside 0/1', () => {
    expect(() => addDoc(lib, 'src/index.ts', mod, 2)).toThrow(REJECTED);
  });
});

describe('occurrences.is_export_site invariants', () => {
  it('defaults to 0 and rejects values outside 0/1', () => {
    addRepo();
    const lib = addPackage('@acme/lib');
    const a = addSymbol(lib, 'a');
    addOccurrence(a, lib, lib);
    expect(count('SELECT is_export_site AS n FROM occurrences')).toBe(0);
    expect(() => run('INSERT INTO occurrences (symbol_id, package_id, def_package_id, file, role, is_export_site) VALUES (?, ?, ?, ?, 0, 2)', a, lib, lib, 'f'))
      .toThrow(REJECTED);
    expect(() => run('INSERT INTO occurrences (symbol_id, package_id, def_package_id, file, role, is_export_site) VALUES (?, ?, ?, ?, 0, NULL)', a, lib, lib, 'f'))
      .toThrow(REJECTED);
  });
});

describe('unresolved_refs invariants', () => {
  let lib: string;
  let app: string;
  function addUnresolved(consumer: string, target: string, sym: string | null = 'npm @acme/lib . gone().', file: string | null = 'src/main.ts'): void {
    run('INSERT INTO unresolved_refs (consumer_package_id, target_package_id, symbol_str, file, line, col) VALUES (?, ?, ?, ?, 1, 2)',
      consumer, target, sym, file);
  }
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
    app = addPackage('@acme/app');
  });

  it('accepts a cross-package unresolved reference', () => {
    addUnresolved(app, lib);
    expect(count('SELECT count(*) AS n FROM unresolved_refs')).toBe(1);
  });

  it('rejects unknown consumer or target packages', () => {
    expect(() => addUnresolved('npm:acme/lib:@acme/missing', lib)).toThrow(REJECTED);
    expect(() => addUnresolved(app, 'npm:acme/lib:@acme/missing')).toThrow(REJECTED);
  });

  it('rejects a same-package unresolved reference', () => {
    expect(() => addUnresolved(lib, lib)).toThrow(REJECTED);
  });

  it('rejects missing symbol_str or file', () => {
    expect(() => addUnresolved(app, lib, null)).toThrow(REJECTED);
    expect(() => addUnresolved(app, lib, 'x', null)).toThrow(REJECTED);
  });
});

describe('occurrences invariants', () => {
  let lib: string;
  let app: string;
  let a: number;
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
    app = addPackage('@acme/app');
    a = addSymbol(lib, 'a');
  });

  it('rejects an unknown symbol_id', () => {
    expect(() => addOccurrence(9999, app, lib)).toThrow(REJECTED);
  });

  it('rejects an unknown package_id', () => {
    expect(() => addOccurrence(a, 'npm:acme/lib:@acme/missing', lib)).toThrow(REJECTED);
  });

  it('rejects an unknown enclosing_symbol_id', () => {
    expect(() => addOccurrence(a, app, lib, 9999)).toThrow(REJECTED);
  });

  it('rejects def_package_id drifting from symbols.package_id (insert and update)', () => {
    expect(() => addOccurrence(a, app, app)).toThrow(/sentei: occurrences.def_package_id/);
    addOccurrence(a, app, lib);
    expect(() => run('UPDATE occurrences SET def_package_id = ?', app)).toThrow(/sentei: occurrences.def_package_id/);
  });
});

describe('edges invariants', () => {
  let lib: string;
  let a: number;
  let b: number;
  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
    a = addSymbol(lib, 'a');
    b = addSymbol(lib, 'b');
  });

  it('rejects unknown endpoint symbols', () => {
    expect(() => addEdge(a, 9999, lib, lib)).toThrow(REJECTED);
    expect(() => addEdge(9999, a, lib, lib)).toThrow(REJECTED);
  });

  it('rejects unknown endpoint packages', () => {
    // The edges_packages_match trigger fires before the FK check; either rejection is fine.
    expect(() => addEdge(a, b, 'npm:acme/lib:@acme/missing', lib)).toThrow(REJECTED);
    expect(() => addEdge(a, b, lib, 'npm:acme/lib:@acme/missing')).toThrow(REJECTED);
  });

  it('rejects package ids that do not match the endpoint symbols', () => {
    const other = addPackage('@acme/other');
    expect(() => addEdge(a, b, other, lib)).toThrow(/sentei: edges package ids/);
    expect(() => addEdge(a, b, lib, other)).toThrow(/sentei: edges package ids/);
  });

  it('rejects an unknown source', () => {
    expect(() => addEdge(a, b, lib, lib, 'guess')).toThrow(REJECTED);
  });
});

describe('package_flags invariants', () => {
  it('rejects an unknown flag', () => {
    addRepo();
    const lib = addPackage('@acme/lib');
    expect(() => run("INSERT INTO package_flags (package_id, flag) VALUES (?, 'looks_fine')", lib)).toThrow(REJECTED);
  });
});

describe('targeted package_flags (target_package_id)', () => {
  let lib: string;
  let other: string;
  let app: string;
  const blocked = (): unknown[] =>
    db.prepare('SELECT package_id, blocker_package_id, flag FROM blocked_packages ORDER BY package_id, blocker_package_id').all();
  const opaque = (): unknown[] => db.prepare('SELECT package_id FROM opaque_packages ORDER BY package_id').all();

  beforeEach(() => {
    addRepo();
    lib = addPackage('@acme/lib');
    other = addPackage('@acme/other');
    app = addPackage('@acme/app');
    for (const dep of [lib, other]) {
      run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id) VALUES (?, ?, 'npm', ?)",
        app, dep.slice('npm:acme/lib:'.length), dep);
    }
  });

  it('an untargeted flag blocks every dependency and makes the consumer opaque', () => {
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'unindexed_consumer', 'build.py')", app);
    expect(blocked()).toEqual([
      { package_id: lib, blocker_package_id: app, flag: 'unindexed_consumer' },
      { package_id: other, blocker_package_id: app, flag: 'unindexed_consumer' },
    ]);
    expect(opaque()).toEqual([{ package_id: app }]);
  });

  it('a targeted flag blocks only its target and does not make the consumer opaque', () => {
    run("INSERT INTO package_flags (package_id, flag, reason, file, target_package_id) VALUES (?, 'unindexed_consumer', 'x', 'eslint.config.mjs', ?)",
      app, lib);
    expect(blocked()).toEqual([{ package_id: lib, blocker_package_id: app, flag: 'unindexed_consumer' }]);
    expect(opaque()).toEqual([]);
    const s = addSymbol(lib, 'a');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s, 1);
    expect(() => addFinding(s, 'deletion_candidate')).toThrow(/sentei: deletion\/deprecation candidate blocked by opaque consumer/);
    const t = addSymbol(other, 't');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', t, 1);
    addFinding(t, 'deletion_candidate');
  });

  it('a targeted flag blocks its target even without a manifest dependency', () => {
    const tool = addPackage('@acme/tool');
    run("INSERT INTO package_flags (package_id, flag, reason, target_package_id) VALUES (?, 'unindexed_consumer', 'x', ?)", tool, lib);
    expect(blocked()).toEqual([{ package_id: lib, blocker_package_id: tool, flag: 'unindexed_consumer' }]);
  });

  it('ambiguous_dep is always targeted and blocks only its target', () => {
    expect(() => run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'ambiguous_dep', 'dep x matches 2 org packages')", app))
      .toThrow(REJECTED);
    run("INSERT INTO package_flags (package_id, flag, reason, target_package_id) VALUES (?, 'ambiguous_dep', 'dep x', ?)", app, lib);
    expect(blocked()).toEqual([{ package_id: lib, blocker_package_id: app, flag: 'ambiguous_dep' }]);
    expect(opaque()).toEqual([]);
  });

  it('package_deps: an ambiguous dep has no resolved package; resolution is one of the known rules', () => {
    run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, ambiguous) VALUES (?, 'x', 'npm', 1)", app);
    expect(() => run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id, ambiguous) VALUES (?, 'y', 'npm', ?, 1)", app, lib))
      .toThrow(REJECTED);
    run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id, resolution) VALUES (?, 'z', 'npm', ?, 'published')", app, lib);
    expect(() => run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id, resolution) VALUES (?, 'w', 'npm', ?, 'guess')", app, lib))
      .toThrow(REJECTED);
  });

  it('rejects an unknown or self target, and cascades when the target goes', () => {
    expect(() => run("INSERT INTO package_flags (package_id, flag, target_package_id) VALUES (?, 'unindexed_consumer', 'npm:nope')", app))
      .toThrow(REJECTED);
    expect(() => run("INSERT INTO package_flags (package_id, flag, target_package_id) VALUES (?, 'unindexed_consumer', ?)", app, app))
      .toThrow(REJECTED);
    run("INSERT INTO package_flags (package_id, flag, target_package_id) VALUES (?, 'unindexed_consumer', ?)", app, other);
    run('DELETE FROM packages WHERE package_id = ?', other);
    expect(count('SELECT count(*) AS n FROM package_flags')).toBe(0);
  });
});

describe('policy invariants', () => {
  it('rejects unknown keys and non-JSON values', () => {
    expect(() => setPolicy('minAgeDayz', 1)).toThrow(REJECTED);
    expect(() => run("UPDATE policy SET value = 'yes' WHERE key = 'minAgeDays'")).toThrow(REJECTED);
    expect(() => run("UPDATE policy SET key = 'assumeClosedWorld' WHERE key = 'minAgeDays'")).toThrow(REJECTED);
  });

  it('silently drops the removed assumeClosedWorld key on insert (no longer a policy)', () => {
    setPolicy('assumeClosedWorld', true);
    run("INSERT INTO policy (key, value) VALUES ('assumeClosedWorld', 'false')");
    expect(count("SELECT count(*) AS n FROM policy WHERE key = 'assumeClosedWorld'")).toBe(0);
    expect(count('SELECT count(*) AS n FROM policy')).toBe(4);
  });
});

describe('findings invariants', () => {
  let lib: string;
  let app: string;
  let a: number;

  /** A symbol that satisfies every deletion guard, so each test breaks exactly one. */
  beforeEach(() => {
    addRepo();
    addRepo('acme/app');
    lib = addPackage('@acme/lib', { visibility: 'private' });
    app = addPackage('@acme/app', { repo: 'acme/app' });
    run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id) VALUES (?, '@acme/lib', 'npm', ?)", app, lib);
    a = addSymbol(lib, 'a');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', a, 1_700_000_000);
  });

  it('accepts a deletion_candidate when every guard is satisfied', () => {
    addFinding(a, 'deletion_candidate');
    expect(count('SELECT count(*) AS n FROM findings')).toBe(1);
  });

  it('accepts a blocked verdict (analyze reports blockers instead of a verdict)', () => {
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'index_failed', 'tsc crashed')", app);
    run(`INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, 'blocked', '["no_refs"]', ?)`,
      a, JSON.stringify([`${app}:index_failed`]));
    expect(count("SELECT count(*) AS n FROM findings WHERE verdict = 'blocked'")).toBe(1);
  });

  it('rejects an unknown verdict', () => {
    expect(() => addFinding(a, 'dead')).toThrow(REJECTED);
  });

  it('rejects non-array reasons / blocked_by', () => {
    expect(() => run("INSERT INTO findings (symbol_id, verdict, reasons) VALUES (?, 'private_dead', '\"x\"')", a)).toThrow(REJECTED);
    expect(() => run("INSERT INTO findings (symbol_id, verdict, blocked_by) VALUES (?, 'private_dead', 'nope')", a)).toThrow(REJECTED);
  });

  it('rejects an unknown symbol', () => {
    expect(() => addFinding(9999, 'private_dead')).toThrow(REJECTED);
  });

  it('rejects updates (insert-only)', () => {
    addFinding(a, 'private_dead');
    expect(() => run("UPDATE findings SET verdict = 'deletion_candidate'")).toThrow(/sentei: findings are insert-only/);
  });

  it('rejects deletion_candidate when a consumer is opaque', () => {
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'index_failed', 'tsc crashed')", app);
    expect(db.prepare('SELECT package_id, blocker_package_id, flag FROM blocked_packages').all())
      .toEqual([{ package_id: lib, blocker_package_id: app, flag: 'index_failed' }]);
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion\/deprecation candidate blocked by opaque consumer/);
    // Weaker verdicts are not blocked by the structural guard.
    addFinding(a, 'needs_review');
  });

  it('allows deletion/unexport only in private packages, deprecation only in published ones', () => {
    const pub = addPackage('@acme/pub', { visibility: 'published-public' });
    const s = addSymbol(pub, 's');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s, 1);
    expect(() => addFinding(s, 'deletion_candidate')).toThrow(/sentei: deletion\/unexport candidate requires a private package/);
    expect(() => addFinding(s, 'unexport_candidate')).toThrow(/sentei: deletion\/unexport candidate requires a private package/);
    addFinding(s, 'deprecation_candidate');
    expect(() => addFinding(a, 'deprecation_candidate')).toThrow(/sentei: deprecation_candidate requires a published package/);
    expect(db.prepare('SELECT package_id FROM private_packages ORDER BY package_id').all())
      .toEqual([{ package_id: app }, { package_id: lib }]);
  });

  it('treats published-private as private only when trustPrivateRegistry is true', () => {
    const pp = addPackage('@acme/pp', { visibility: 'published-private' });
    const s = addSymbol(pp, 's');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s, 1);
    setPolicy('trustPrivateRegistry', false);
    expect(() => addFinding(s, 'unexport_candidate')).toThrow(/sentei: deletion\/unexport candidate requires a private package/);
    addFinding(s, 'deprecation_candidate');
    run('DELETE FROM findings');
    setPolicy('trustPrivateRegistry', true);
    addFinding(s, 'unexport_candidate');
    expect(() => addFinding(s, 'deprecation_candidate')).toThrow(/sentei: deprecation_candidate requires a published package/);
  });

  it('guards a would-be-deletion deprecation like a deletion; an internal-only one needs no witness', () => {
    const pub = addPackage('@acme/pub', { visibility: 'published-public' });
    run("INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, resolved_package_id) VALUES (?, '@acme/pub', 'npm', ?)", app, pub);
    const dep = (sym: number, reasons: string[]): void =>
      run("INSERT INTO findings (symbol_id, verdict, reasons) VALUES (?, 'deprecation_candidate', ?)", sym, JSON.stringify(reasons));
    const s1 = addSymbol(pub, 's1');
    expect(() => dep(s1, ['no_refs'])).toThrow(/sentei: deletion\/deprecation candidate requires witness_ok/);
    expect(() => dep(s1, ['only_test_refs'])).toThrow(/requires witness_ok/);
    expect(() => dep(s1, ['internal_refs_only', 'dead_island'])).toThrow(/requires witness_ok/);
    dep(s1, ['internal_refs_only', 'only_test_refs']); // the published form of an unexport
    const s2 = addSymbol(pub, 's2');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s2, 1);
    dep(s2, ['no_refs']);
    const s3 = addSymbol(pub, 'kept');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s3, 1);
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'kept')", pub);
    expect(() => dep(s3, ['no_refs'])).toThrow(/sentei: deletion\/deprecation candidate matches keep rule/);
    run('DELETE FROM keep_rules');
    run("INSERT INTO package_flags (package_id, flag, reason) VALUES (?, 'index_failed', 'tsc crashed')", app);
    expect(() => dep(s3, ['no_refs'])).toThrow(/sentei: deletion\/deprecation candidate blocked by opaque consumer/);
  });

  it('treats a missing policy key as false (fail closed)', () => {
    const pp = addPackage('@acme/pp', { visibility: 'published-private' });
    const s = addSymbol(pp, 's');
    run("DELETE FROM policy WHERE key = 'trustPrivateRegistry'");
    expect(() => addFinding(s, 'unexport_candidate')).toThrow(/sentei:/);
  });

  it('rejects deletion_candidate matching a keep rule by name', () => {
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'a')", lib);
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion\/deprecation candidate matches keep rule/);
  });

  it("rejects deletion_candidate matching a '*' keep rule", () => {
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, '*')", lib);
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion\/deprecation candidate matches keep rule/);
  });

  it('does not apply keep rules for other symbols', () => {
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'b')", lib);
    addFinding(a, 'deletion_candidate');
  });

  it('rejects deletion_candidate without witness_ok', () => {
    run('DELETE FROM witness_ok');
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion\/deprecation candidate requires witness_ok/);
  });
});
