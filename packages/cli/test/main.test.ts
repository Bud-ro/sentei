// CLI argument parsing and exit codes: main() driven directly with captured output.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@sentei/core/db';
import { afterAll, describe, expect, it } from 'vitest';
import { formatError, main, parsePolicyOverrides, redactSecrets } from '../src/main.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures');
const tmpRoot = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-main-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const freshWork = (): string => path.join(tmpRoot, `work${n++}`);

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t) });
  return { code, out, err };
}

describe('usage', () => {
  it('--help and help print usage and exit 0', async () => {
    for (const argv of [['--help'], ['-h'], ['help'], ['discover', '--help']]) {
      const r = await run(...argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Usage: sentei <command>');
      expect(r.err).toBe('');
    }
  });

  it('no command exits 2 with usage on stderr', async () => {
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.err).toContain('Usage: sentei');
    expect(r.out).toBe('');
  });

  it('unknown command exits 2', async () => {
    const r = await run('frobnicate', '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^unknown command: frobnicate/);
  });

  it('extra positionals exit 2', async () => {
    const r = await run('analyze', 'extra');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^unexpected arguments: extra/);
  });

  it('unknown option exits 2', async () => {
    const r = await run('analyze', '--no-such-flag');
    expect(r.code).toBe(2);
    expect(r.err).toContain('--no-such-flag');
  });

  it.each(['0', '-5', '1.5', 'lots'])('--max-old-space-mb %s exits 2', async (v) => {
    const r = await run('index', `--max-old-space-mb=${v}`, '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^--max-old-space-mb must be a positive integer/);
  });

  it('usage errors do not create the work dir', async () => {
    const work = freshWork();
    await run('frobnicate', '--work', work);
    await run('discover', '--policy', 'bogus=1', '--work', work);
    expect(() => readFileSync(path.join(work, 'sentei.db'))).toThrow();
  });
});

describe('--policy', () => {
  it('unknown key exits 2', async () => {
    const r = await run('discover', '--policy', 'bogus=1', '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^--policy: unknown key "bogus" \(known: minAgeDays, /);
  });

  it.each([
    ['minAgeDays=-1', /"minAgeDays" must be a non-negative integer/],
    ['minAgeDays="7"', /"minAgeDays" must be a non-negative integer/],
    ['assumeClosedWorld=yes', /is not JSON/],
    ['assumeClosedWorld=1', /"assumeClosedWorld" must be a boolean/],
    ['assumeClosedWorld', /expected <key>=<json value>/],
    ['=true', /expected <key>=<json value>/],
  ])('%s exits 2', async (spec, msg) => {
    const r = await run('run', '--policy', spec, '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(msg);
  });

  it('is rejected for stages other than discover/run', async () => {
    const r = await run('analyze', '--policy', 'minAgeDays=0', '--work', freshWork());
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/only applies to discover/);
  });

  it('parses JSON values, last one wins', () => {
    expect(parsePolicyOverrides(['assumeClosedWorld=false', 'minAgeDays=0', 'minAgeDays=30']))
      .toEqual({ assumeClosedWorld: false, minAgeDays: 30 });
    expect(parsePolicyOverrides([])).toEqual({});
  });

  it('discover applies overrides on top of the org sentei.json', async () => {
    const orgDir = path.join(tmpRoot, 'org-policy');
    mkdirSync(path.join(orgDir, 'repos', 'lib'), { recursive: true });
    writeFileSync(path.join(orgDir, 'org.json'), JSON.stringify({ org: 'acme', repos: [{ name: 'lib' }] }));
    writeFileSync(path.join(orgDir, 'sentei.json'), JSON.stringify({ assumeClosedWorld: true, minAgeDays: 90 }));
    writeFileSync(path.join(orgDir, 'repos', 'lib', 'package.json'), JSON.stringify({ name: '@acme/lib', version: '1.0.0' }));
    const work = freshWork();
    const r = await run('discover', '--org-dir', orgDir, '--work', work, '--policy', 'minAgeDays=0');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('[discover] policy override minAgeDays=0 (was 90)');
    const model = JSON.parse(readFileSync(path.join(work, 'discover.json'), 'utf8'));
    expect(model.policy).toMatchObject({ assumeClosedWorld: true, minAgeDays: 0 });
    const db = openDb(path.join(work, 'sentei.db'));
    try {
      const rows = db.prepare("SELECT key, value FROM policy WHERE key IN ('assumeClosedWorld', 'minAgeDays') ORDER BY key").all();
      expect(rows).toEqual([{ key: 'assumeClosedWorld', value: 'true' }, { key: 'minAgeDays', value: '0' }]);
    } finally {
      db.close();
    }
  });
});

describe('stage errors', () => {
  it('a stage that throws exits 1 with "sentei <stage>: <message>" on stderr', async () => {
    const r = await run('discover', '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toBe('sentei discover: exactly one of --org <name> (GitHub) or --org-dir <dir> (local) is required\n');
    expect(r.out).not.toContain('done in');
  });

  it('--verbose adds the stack', async () => {
    const r = await run('discover', '--work', freshWork(), '--verbose');
    expect(r.code).toBe(1);
    expect(r.err.split('\n')[0]).toBe('sentei discover: exactly one of --org <name> (GitHub) or --org-dir <dir> (local) is required');
    expect(r.err).toMatch(/\n\s+at /);
  });

  it('run names the failing stage', async () => {
    const r = await run('run', '--org-dir', path.join(tmpRoot, 'missing-org'), '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei discover: cannot read .*org\.json/);
    expect(r.err.trimEnd().split('\n')).toHaveLength(1);
  });

  it('an error before the DB opens exits 1 too', async () => {
    const file = path.join(tmpRoot, 'not-a-dir');
    writeFileSync(file, '');
    const r = await run('analyze', '--work', path.join(file, 'work'));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei analyze: /);
  });

  it('formatError keeps the first line and strips a duplicate prefix', () => {
    expect(formatError('ingest', new Error('sentei: bad thing\nmore detail'), false, {})).toBe('sentei ingest: bad thing\n');
    expect(formatError('index', 'plain string', false, {})).toBe('sentei index: plain string\n');
  });

  it('never prints a token', () => {
    const env = { GITHUB_TOKEN: 'sekrit-token-value' };
    const err = new Error('clone failed: sekrit-token-value / ghp_abcdefghijklmnopqrstuvwxyz0123 / https://x-access-token:abc123@github.com');
    const text = formatError('discover', err, true, env);
    expect(text).not.toContain('sekrit-token-value');
    expect(text).not.toContain('ghp_abcdef');
    expect(text).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer xyz.789', {})).toBe('Authorization: Bearer ***');
  });
});

describe('timings and --quiet', () => {
  it('prints "[stage] done in Ns" after each stage', async () => {
    const r = await run('discover', '--org-dir', path.join(FIXTURES, 'org-small'), '--work', freshWork());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\[discover\] done in \d+\.\ds$/m);
  });

  it('a later stage on a DB its predecessor never filled fails with what to run first', async () => {
    const r = await run('analyze', '--work', freshWork());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^sentei analyze: .*run ingest first/);
  });

  it('run prints per-stage timings and a total line; --quiet keeps the summary only', async () => {
    const work = freshWork();
    // Copy the fixture: index writes node_modules source links into the org checkouts.
    const orgDir = path.join(tmpRoot, 'org-small');
    cpSync(path.join(FIXTURES, 'org-small'), orgDir, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes('node_modules'),
    });
    const loud = await run('run', '--org-dir', orgDir, '--work', work, '--no-install');
    expect(loud.err).toBe('');
    expect(loud.code).toBe(0);
    for (const s of ['discover', 'index', 'ingest', 'blame', 'analyze', 'witness', 'report']) {
      expect(loud.out).toMatch(new RegExp(`^\\[${s}\\] done in \\d+\\.\\ds$`, 'm'));
    }
    expect(loud.out).toMatch(/^\[run\] done in \d+\.\ds \(discover \d+\.\ds, index .*, report \d+\.\ds\)$/m);

    const quiet = await run('run', '--org-dir', orgDir, '--work', work, '--no-install', '--quiet');
    expect(quiet.code).toBe(0);
    expect(quiet.out).not.toContain('done in');
    expect(quiet.out).not.toMatch(/^\[discover\]/m);
    expect(quiet.out).toContain('Top blockers');
    expect(quiet.out).toMatch(/^sentei .* report, generated/m);
  }, 300_000);
});
