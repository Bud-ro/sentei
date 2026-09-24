import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeSql } from '../src/analyze.ts';
import { openDb } from '../src/db.ts';
import { matchGlob } from '../src/glob.ts';
import { DOCS_GLOBS, GENERATED_GLOBS, TEST_GLOBS } from '../src/globs.ts';

// analyze.sql spells the test/docs globs as SQLite GLOB conditions (it is loaded
// verbatim). Parse them back and compare with the TypeScript lists the witness uses.

const SQL = readFileSync(new URL('../sql/analyze.sql', import.meta.url), 'utf8');
const BASENAME = "substr(file, length(rtrim(file, replace(file, '/', ''))) + 1)";

function viewGlobs(view: string): string[] {
  const start = SQL.indexOf(`CREATE VIEW ${view} `);
  expect(start, view).toBeGreaterThanOrEqual(0);
  const body = SQL.slice(start, SQL.indexOf(';', start));
  const out: string[] = [];
  const total = body.split(" GLOB '").length - 1;
  for (const line of body.split('\n')) {
    const cond = line.replace(/^\s*(?:WHERE|OR)\s+/, '');
    let m: RegExpExecArray | null;
    if ((m = /^(.*) GLOB '([^']*)'$/.exec(cond))) {
      if (m[1] === BASENAME && !m[2]!.includes('/')) out.push(`**/${m[2]}`);
      else if (m[1] === "('/' || file)" && /^\*\/[^*/]+\/\*$/.test(m[2]!)) out.push(`**/${m[2]!.slice(2, -2)}/**`);
      else throw new Error(`${view}: unrecognised GLOB condition: ${cond}`);
    }
  }
  expect(out.length, `${view}: every GLOB condition parsed`).toBe(total);
  return out;
}

describe('test/docs/generated globs: analyze.sql and globs.ts agree', () => {
  it('test_files spells exactly TEST_GLOBS', () => {
    expect(viewGlobs('test_files')).toEqual([...TEST_GLOBS]);
  });

  it('doc_files spells exactly DOCS_GLOBS', () => {
    expect(viewGlobs('doc_files')).toEqual([...DOCS_GLOBS]);
  });

  it('generated_files spells exactly GENERATED_GLOBS', () => {
    expect(viewGlobs('generated_files')).toEqual([...GENERATED_GLOBS]);
  });

  it('the views and matchGlob classify sample paths identically', () => {
    const paths = [
      'src/a.test.ts', 'b.spec.js', 'lib/f_test.dart', 'pkg/x_test.go', 'src/Button.stories.tsx', 'test/c.ts', 'src/test/d.ts',
      'src/__tests__/e.ts', 'src/mocks/h.ts', '__mocks__/m.ts', 'fixtures/f.ts', 'a/__fixtures__/f.ts', 'e2e/run.ts',
      'test-integration/i.ts', 'src/__schemas__/s.ts', 'docs/g.ts', 'examples/x/y.ts', 'src/example/z.ts', 'demo/d.ts',
      'src/testing/i.ts', 'src/latest/j.ts', 'x.test/k.ts', 'src/mocksy/a.ts', 'src/spec.ts', 'src/demos/a.ts', 'src/index.ts',
      'lib/a.g.dart', 'lib/src/b.pb.dart', 'c.pbenum.dart', 'lib/d.pbjson.dart', 'lib/e.pbserver.dart', 'lib/f.freezed.dart',
      'test/g.mocks.dart', 'lib/h.over_react.g.dart', 'src/i.generated.ts', 'generated/j.ts', 'src/__generated__/k.ts',
      'lib/g.dart', 'lib/pb.dart', 'src/generator/l.ts', 'src/generated.ts', 'lib/x.g.dart.bak',
    ];
    const db = openDb(':memory:');
    try {
      db.exec("INSERT INTO repos (repo) VALUES ('acme/a')");
      db.exec("INSERT INTO packages (package_id, repo, path, manager, name, visibility) VALUES ('npm:a', 'acme/a', '.', 'npm', 'a', 'private')");
      const ins = db.prepare("INSERT INTO documents (package_id, file) VALUES ('npm:a', ?)");
      for (const p of paths) ins.run(p);
      db.exec(analyzeSql());
      const inView = (v: string): string[] =>
        (db.prepare(`SELECT file FROM ${v} ORDER BY file`).all() as Array<{ file: string }>).map((r) => r.file);
      const byGlob = (gs: readonly string[]): string[] => paths.filter((p) => gs.some((g) => matchGlob(g, p))).sort();
      expect(inView('test_files')).toEqual(byGlob(TEST_GLOBS));
      expect(inView('doc_files')).toEqual(byGlob(DOCS_GLOBS));
      expect(inView('generated_files')).toEqual(byGlob(GENERATED_GLOBS));
      expect(inView('generated_files')).toEqual([
        'c.pbenum.dart', 'generated/j.ts', 'lib/a.g.dart', 'lib/d.pbjson.dart', 'lib/e.pbserver.dart', 'lib/f.freezed.dart',
        'lib/h.over_react.g.dart', 'lib/src/b.pb.dart', 'src/__generated__/k.ts', 'src/i.generated.ts', 'test/g.mocks.dart',
      ]);
      expect(inView('doc_files')).toEqual(['demo/d.ts', 'docs/g.ts', 'examples/x/y.ts', 'src/example/z.ts']);
    } finally {
      db.close();
    }
  });
});
