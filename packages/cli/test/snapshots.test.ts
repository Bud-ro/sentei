// PLAN.md §6.6: the checked-in indexer snapshots (fixtures/snapshots/) must match
// what the pinned indexers produce on the fixture orgs today. On a deliberate
// indexer upgrade, run `npm run snapshots:update` and review the diff.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkedInFiles, FLUTTER_REPOS, generateOrgSnapshots, hasDart, hasFlutter, isFlutterSnapshot, ORGS, SNAPSHOTS, UPDATE_COMMAND } from '../../../scripts/update-snapshots.ts';

const HAS_DART = hasDart();
const HAS_FLUTTER = hasFlutter();
const tmp = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-snapshots-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A unified diff of one file (via `diff -u` when available). */
function diffHint(rel: string, want: string | undefined, got: string | undefined): string {
  const a = path.join(tmp, 'checked-in', rel);
  const b = path.join(tmp, 'regenerated', rel);
  for (const [p, text] of [[a, want], [b, got]] as const) {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text ?? '');
  }
  const d = spawnSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, a, b], { encoding: 'utf8' });
  const body = d.error ? `(no \`diff\` binary; compare ${a} with ${b})` : d.stdout || '(contents identical; empty file)';
  const lines = body.split('\n');
  return lines.length > 80 ? `${lines.slice(0, 80).join('\n')}\n... (${lines.length - 80} more lines; full files: ${a} ${b})` : body;
}

for (const org of ORGS) {
  if (org.dart && !HAS_DART) console.warn(`[snapshots.test] SKIPPING ${org.name}: \`dart\` is not on PATH`);
  if (HAS_DART && !HAS_FLUTTER && FLUTTER_REPOS[org.name] !== undefined) {
    console.warn(`[snapshots.test] SKIPPING the Flutter repos of ${org.name}: \`flutter\` is not on PATH`);
  }
  describe.skipIf(org.dart && !HAS_DART)(`indexer snapshots of fixtures/${org.name}`, () => {
    it('match fixtures/snapshots byte for byte', async () => {
      const got = await generateOrgSnapshots(org, undefined, HAS_FLUTTER);
      const want = checkedInFiles(org.name);
      if (!HAS_FLUTTER) for (const rel of [...want.keys()]) if (isFlutterSnapshot(org.name, rel)) want.delete(rel);
      expect(got.size, 'no snapshot produced').toBeGreaterThan(0);
      const problems: string[] = [];
      for (const rel of [...new Set([...want.keys(), ...got.keys()])].sort()) {
        const w = want.get(rel);
        const g = got.get(rel);
        if (w === g) continue;
        const what = w === undefined ? 'new (not checked in)' : g === undefined ? 'stale (no longer produced)' : 'changed';
        problems.push(`${rel}: ${what}\n${diffHint(rel, w, g)}`);
      }
      if (problems.length > 0) {
        throw new Error(
          `indexer snapshots under ${SNAPSHOTS} are out of date for ${org.name}:\n\n${problems.join('\n')}\n` +
            `If the change is intended (e.g. an indexer upgrade), run \`${UPDATE_COMMAND}\` and review \`git diff fixtures/snapshots\` like a code change.`,
        );
      }
    }, 600_000);
  });
}
