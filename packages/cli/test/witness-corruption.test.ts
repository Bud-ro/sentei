// PLAN.md §8 witness check acceptance: hand-corrupt a `.scip` index so it loses the
// consumer's reference to a symbol, and prove the independent text witness catches it
// (the would-be deletion is downgraded to needs_review with witness_mismatch reasons).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toBinary } from '@bufbuild/protobuf';
import type { Report } from '@sentei/core';
import { openDb } from '@sentei/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { readScipIndex } from '@sentei/core/scip';
// IndexSchema is not re-exported by @sentei/core/scip (read.ts keeps SCIP types internal).
import { IndexSchema } from '../../core/src/scip/scip_pb.ts';
import { analyze } from '../src/stages/analyze.ts';
import { discover } from '../src/stages/discover.ts';
import { index } from '../src/stages/index.ts';
import { ingest } from '../src/stages/ingest.ts';
import { report } from '../src/stages/report.ts';
import { witness } from '../src/stages/witness.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures');

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

describe('witness check (PLAN.md §8): a reference dropped from the SCIP index is caught', () => {
  it('downgrades usedFn to needs_review with witness_mismatch reasons', async () => {
    const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-witness-')));
    tmps.push(tmp);
    const orgDir = path.join(tmp, 'org-small');
    cpSync(path.join(FIXTURES, 'org-small'), orgDir, {
      recursive: true,
      filter: (src: string) => path.basename(src) !== 'node_modules',
    });
    const work = path.join(tmp, 'work');
    mkdirSync(work, { recursive: true });
    const dbPath = path.join(work, 'sentei.db');
    const db = openDb(dbPath);
    const lines: string[] = [];
    const ctx = { work, dbPath, db, orgDir, log: (l: string) => lines.push(l) };
    try {
      await discover(ctx);
      await index(ctx, { install: false });

      // Corrupt: drop every usedFn occurrence from app's src/main.ts, keep the rest.
      const scipPath = path.join(work, 'index', 'acme__app', 'npm__acme__app.scip');
      const idx = readScipIndex(scipPath);
      const doc = idx.documents.find((d) => d.relativePath === 'src/main.ts');
      expect(doc).toBeDefined();
      const before = doc!.occurrences.length;
      doc!.occurrences = doc!.occurrences.filter((o) => !o.symbol.endsWith('usedFn().'));
      expect(before - doc!.occurrences.length).toBeGreaterThan(0);
      // The module reference ('@acme/core') survives, so the index is otherwise intact.
      expect(doc!.occurrences.some((o) => o.symbol.includes('@acme/core'))).toBe(true);
      writeFileSync(scipPath, toBinary(IndexSchema, idx));

      await ingest(ctx);
      await analyze(ctx);
      await witness(ctx);
      await report(ctx);

      const r = JSON.parse(readFileSync(path.join(work, 'report.json'), 'utf8')) as Report;
      const core = r.findings.filter((f) => f.package_id === 'npm:@acme/core');
      const used = core.filter((f) => f.symbol === 'usedFn');
      expect(used.map((f) => ({ verdict: f.verdict, reasons: f.reasons }))).toEqual([
        {
          verdict: 'needs_review',
          reasons: [
            'no_refs',
            'witness_mismatch:npm:@acme/app:src/main.ts:2',
            'witness_mismatch:npm:@acme/app:src/main.ts:6',
          ],
        },
      ]);
      expect(used.some((f) => f.verdict === 'deletion_candidate')).toBe(false);

      const usedRows = db
        .prepare(
          `SELECT f.verdict FROM findings f JOIN symbols s ON s.symbol_id = f.symbol_id
           WHERE s.package_id = 'npm:@acme/core' AND s.name = 'usedFn'`,
        )
        .all() as Array<{ verdict: string }>;
      expect(usedRows.map((x) => x.verdict)).toEqual(['needs_review']);
      const okRows = db
        .prepare(
          `SELECT w.symbol_id FROM witness_ok w JOIN symbols s ON s.symbol_id = w.symbol_id
           WHERE s.package_id = 'npm:@acme/core' AND s.name = 'usedFn'`,
        )
        .all();
      expect(okRows).toEqual([]);

      // Control: a genuinely unused export still passes the witness.
      const unused = core.filter((f) => f.symbol === 'unusedFn');
      expect(unused.map((f) => ({ verdict: f.verdict, reasons: f.reasons }))).toEqual([
        { verdict: 'deletion_candidate', reasons: ['no_refs'] },
      ]);
      expect(lines.some((l) => l.includes('[witness] mismatch npm:@acme/core#usedFn'))).toBe(true);
    } finally {
      db.close();
    }
  }, 60_000);
});
