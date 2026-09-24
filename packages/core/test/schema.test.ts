import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';

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
  opts: { repo?: string; visibility?: string; manager?: string; id?: string } = {},
): string {
  const manager = opts.manager ?? 'npm';
  const id = opts.id ?? `${manager}:${name}`;
  run('INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, opts.repo ?? 'acme/lib', 'packages/x', manager, name, '1.0.0', opts.visibility ?? 'private', '["src/index.ts"]');
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
    addFinding(a, 'private_dead');
    run('DELETE FROM repos');
    for (const t of ['packages', 'package_deps', 'symbols', 'occurrences', 'edges', 'package_flags', 'keep_rules', 'witness_ok', 'findings']) {
      expect(count(`SELECT count(*) AS n FROM ${t}`), t).toBe(0);
    }
  });
});

describe('packages invariants', () => {
  beforeEach(() => addRepo());

  it('rejects duplicate (manager, name)', () => {
    addPackage('@acme/lib');
    // package_id is forced to manager:name, so the PK and UNIQUE (manager, name) coincide;
    // assert the rejection and that the explicit UNIQUE constraint exists.
    addRepo('acme/other');
    expect(() => addPackage('@acme/lib', { repo: 'acme/other' })).toThrow(REJECTED);
    const idx = db.prepare("SELECT count(*) AS n FROM pragma_index_list('packages') WHERE \"unique\" = 1 AND origin = 'u'").get() as { n: number };
    expect(idx.n).toBe(1);
  });

  it('rejects an unknown visibility', () => {
    expect(() => addPackage('@acme/lib', { visibility: 'public' })).toThrow(REJECTED);
  });

  it('rejects an unknown manager', () => {
    expect(() => addPackage('lib', { manager: 'cargo' })).toThrow(REJECTED);
  });

  it('rejects a package_id not shaped <manager>:<name>', () => {
    expect(() => addPackage('@acme/lib', { id: '@acme/lib' })).toThrow(REJECTED);
    expect(() => addPackage('@acme/lib', { id: 'pub:@acme/lib' })).toThrow(REJECTED);
  });

  it('rejects entry_points that are not a JSON array', () => {
    expect(() => run("INSERT INTO packages (package_id, repo, path, manager, name, visibility, entry_points) VALUES ('npm:x', 'acme/lib', '.', 'npm', 'x', 'private', '{}')"))
      .toThrow(REJECTED);
  });

  it('rejects a package whose repo does not exist', () => {
    expect(() => addPackage('@acme/lib', { repo: 'acme/missing' })).toThrow(REJECTED);
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
    expect(() => addSymbol('npm:@acme/missing', 'a')).toThrow(REJECTED);
  });

  it('rejects moving a symbol to another package', () => {
    const other = addPackage('@acme/other');
    const a = addSymbol(lib, 'a');
    expect(() => run('UPDATE symbols SET package_id = ? WHERE symbol_id = ?', other, a)).toThrow(REJECTED);
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
    expect(() => addOccurrence(a, 'npm:@acme/missing', lib)).toThrow(REJECTED);
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
    expect(() => addEdge(a, b, 'npm:@acme/missing', lib)).toThrow(REJECTED);
    expect(() => addEdge(a, b, lib, 'npm:@acme/missing')).toThrow(REJECTED);
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

describe('policy invariants', () => {
  it('rejects unknown keys and non-JSON values', () => {
    expect(() => setPolicy('minAgeDayz', 1)).toThrow(REJECTED);
    expect(() => run("UPDATE policy SET value = 'yes' WHERE key = 'assumeClosedWorld'")).toThrow(REJECTED);
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
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion_candidate blocked by opaque consumer/);
    // Weaker verdicts are not blocked by the structural guard.
    addFinding(a, 'needs_review');
  });

  it('rejects deletion/unexport candidates outside the closed world, unless assumeClosedWorld', () => {
    const pub = addPackage('@acme/pub', { visibility: 'published-public' });
    const s = addSymbol(pub, 's');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s, 1);
    expect(() => addFinding(s, 'deletion_candidate')).toThrow(/sentei: deletion\/unexport candidate requires closed-world/);
    expect(() => addFinding(s, 'unexport_candidate')).toThrow(/sentei: deletion\/unexport candidate requires closed-world/);
    addFinding(s, 'deprecation_candidate');

    setPolicy('assumeClosedWorld', true);
    addFinding(s, 'deletion_candidate');
    addFinding(s, 'unexport_candidate');
    expect(count('SELECT count(*) AS n FROM findings WHERE symbol_id = ?', s)).toBe(3);
  });

  it('treats published-private as closed-world only when trustPrivateRegistry is true', () => {
    const pp = addPackage('@acme/pp', { visibility: 'published-private' });
    const s = addSymbol(pp, 's');
    run('INSERT INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)', s, 1);
    setPolicy('trustPrivateRegistry', false);
    expect(() => addFinding(s, 'unexport_candidate')).toThrow(/sentei: deletion\/unexport candidate requires closed-world/);
    setPolicy('trustPrivateRegistry', true);
    addFinding(s, 'unexport_candidate');
  });

  it('treats a missing policy key as false (fail closed)', () => {
    const pp = addPackage('@acme/pp', { visibility: 'published-private' });
    const s = addSymbol(pp, 's');
    run("DELETE FROM policy WHERE key = 'trustPrivateRegistry'");
    expect(() => addFinding(s, 'unexport_candidate')).toThrow(/sentei:/);
  });

  it('rejects deletion_candidate matching a keep rule by name', () => {
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'a')", lib);
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion_candidate matches keep rule/);
  });

  it("rejects deletion_candidate matching a '*' keep rule", () => {
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, '*')", lib);
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion_candidate matches keep rule/);
  });

  it('does not apply keep rules for other symbols', () => {
    run("INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, 'b')", lib);
    addFinding(a, 'deletion_candidate');
  });

  it('rejects deletion_candidate without witness_ok', () => {
    run('DELETE FROM witness_ok');
    expect(() => addFinding(a, 'deletion_candidate')).toThrow(/sentei: deletion_candidate requires witness_ok/);
  });
});
