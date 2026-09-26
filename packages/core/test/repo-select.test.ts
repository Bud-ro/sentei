import { describe, expect, it } from 'vitest';
import { readRepoSelectConfig } from '../src/config.ts';
import {
  decideRepo, defaultSelectSettings, diffSettings, excludedReposWarning, mergeSelectSettings, minPushedCutoff, shortenExcludedWarning,
  type RepoFacts, type RepoSelectSettings,
} from '../src/repo-select.ts';

const NOW = Date.parse('2026-09-26T00:00:00Z');
const facts = (name: string, extra: Partial<RepoFacts> = {}): RepoFacts => ({
  name, fork: false, template: false, archived: false, disabled: false,
  language: 'TypeScript', sizeKb: 1000, pushedAt: '2026-09-01T00:00:00Z', manifests: [], headTreeKb: 500, probe: 'tree', ...extra,
});
const settings = (extra: Partial<RepoSelectSettings> = {}): RepoSelectSettings => ({ ...defaultSelectSettings(), ...extra });
const decide = (f: RepoFacts, s: Partial<RepoSelectSettings> = {}) => decideRepo(f, settings(s), NOW);

describe('decideRepo', () => {
  it('includes a plain TypeScript repo, recording why', () => {
    expect(decide(facts('lib'))).toEqual({ include: true, reasons: ['language TypeScript'] });
    expect(decide(facts('app', { language: 'dart' }))).toEqual({ include: true, reasons: ['language dart'] });
  });

  it('archived, forks, templates, disabled and empty repos are skipped', () => {
    expect(decide(facts('a', { archived: true }))).toEqual({ include: false, reasons: ['archived (--include-archived to keep)'] });
    expect(decide(facts('a', { archived: true }), { includeArchived: true }).include).toBe(true);
    expect(decide(facts('f', { fork: true }))).toEqual({ include: false, reasons: ['fork (--include-forks to keep)'] });
    expect(decide(facts('f', { fork: true }), { includeForks: true }).include).toBe(true);
    expect(decide(facts('t', { template: true }))).toEqual({ include: false, reasons: ['template repository'] });
    expect(decide(facts('d', { disabled: true }))).toEqual({ include: false, reasons: ['disabled by GitHub'] });
    expect(decide(facts('e', { empty: true })).reasons).toEqual(['empty repository (no commit on the default branch)']);
  });

  it('size over maxSizeMb: the HEAD tree size when known; null disables', () => {
    const big = facts('big', { headTreeKb: 600 * 1024 });
    expect(decide(big)).toEqual({ include: false, reasons: ['HEAD size 600 MB over repos.maxSizeMb 500'] });
    expect(decide(big, { maxSizeMb: 1000 }).include).toBe(true);
    expect(decide(big, { maxSizeMb: null }).include).toBe(true);
    // supabase/cli: a huge history (API size) but a small HEAD is kept.
    expect(decide(facts('cli', { sizeKb: 301 * 1024, headTreeKb: 26 * 1024 }), { maxSizeMb: 300 }))
      .toEqual({ include: true, reasons: ['language TypeScript'] });
  });

  it('size falls back to the API size (full history) only when the HEAD size is unknown', () => {
    const truncated = facts('mono', { sizeKb: 900 * 1024, headTreeKb: null, probe: 'truncated', manifests: ['package.json'] });
    expect(decide(truncated)).toEqual({ include: false, reasons: ['size 900 MB (API size, full history; git tree truncated) over repos.maxSizeMb 500'] });
    expect(decide({ ...truncated, probe: 'root' }).reasons).toEqual(['size 900 MB (API size, full history; git tree unavailable) over repos.maxSizeMb 500']);
    const unprobed = facts('big', { sizeKb: 900 * 1024, manifests: undefined, headTreeKb: undefined, probe: undefined });
    expect(decide(unprobed, { probe: false }).reasons).toEqual(['size 900 MB (API size, full history; probe off) over repos.maxSizeMb 500']);
    expect(decide(facts('unknown', { sizeKb: null, headTreeKb: null, probe: 'root' })).include).toBe(true);
  });

  it('pushed_at older than minPushed (ISO date or <n>d)', () => {
    const old = facts('old', { pushedAt: '2024-05-01T00:00:00Z' });
    expect(decide(old, { minPushed: '2025-01-01' })).toEqual({ include: false, reasons: ['last push 2024-05-01 before repos.minPushed 2025-01-01'] });
    expect(decide(old, { minPushed: '1000d' }).include).toBe(true);
    expect(decide(old, { minPushed: '365d' }).include).toBe(false);
    expect(decide(facts('never', { pushedAt: null }), { minPushed: '365d' }).reasons).toEqual(['never pushed (repos.minPushed 365d)']);
    expect(() => decide(old, { minPushed: 'last year' })).toThrow(/minPushed/);
    expect(minPushedCutoff('10d', NOW)).toBe(NOW - 10 * 86_400_000);
    expect(minPushedCutoff('2025-13-45', NOW)).toBeNull();
  });

  it('language: a listed language matches; otherwise a manifest anywhere in the HEAD tree decides', () => {
    const py = facts('hw', { language: 'Python' });
    const unprobed = { ...py, manifests: undefined, headTreeKb: undefined, probe: undefined };
    expect(decide(unprobed)).toEqual({ include: false, reasons: ['git tree probe pending'], needsProbe: true });
    // A TypeScript repo is probed too (HEAD size, manifests for the record).
    expect(decide({ ...unprobed, language: 'TypeScript' }).needsProbe).toBe(true);
    expect(decide({ ...py, manifests: ['assets/package.json'] })).toEqual({ include: true, reasons: ['language Python, but assets/package.json'] });
    expect(decide({ ...py, manifests: ['a/package.json', 'b/package.json', 'c/pubspec.yaml', 'd/package.json'] }).reasons)
      .toEqual(['language Python, but 4 manifests (a/package.json, b/package.json, c/pubspec.yaml, …)']);
    expect(decide(py)).toEqual({ include: false, reasons: ['language Python not in repos.languages; no package.json or pubspec.yaml in the HEAD tree'] });
    expect(decide({ ...py, probe: 'truncated', headTreeKb: null }).reasons)
      .toEqual(['language Python not in repos.languages; no package.json or pubspec.yaml at the root or in the truncated git tree']);
    expect(decide({ ...py, probe: 'root', headTreeKb: null }).reasons)
      .toEqual(['language Python not in repos.languages; no package.json or pubspec.yaml at the root (git tree unavailable)']);
    expect(decide(facts('docs', { language: null }), { probe: false }))
      .toEqual({ include: false, reasons: ['no language detected (probe off)'] });
    expect(decide(py, { languages: [] })).toEqual({ include: true, reasons: ['language rule disabled (repos.languages: [])'] });
    expect(decide(py, { languages: ['python'] }).include).toBe(true);
  });

  it('the probe is pending for candidates and explicitly matched repos, never for skipped kinds', () => {
    const unprobed = (extra: Partial<RepoFacts>): RepoFacts =>
      facts('hw', { language: 'C', manifests: undefined, headTreeKb: undefined, probe: undefined, ...extra });
    expect(decide(unprobed({ archived: true })).needsProbe).toBeUndefined();
    expect(decide(unprobed({ fork: true })).needsProbe).toBeUndefined();
    expect(decide(unprobed({ empty: true }), { exclude: ['hw'] }).needsProbe).toBeUndefined();
    expect(decide(unprobed({}), { probe: false }).needsProbe).toBeUndefined();
    // Explicitly matched: the decision stands, the probe is for the record (the report warning).
    expect(decide(unprobed({}), { exclude: ['hw'] })).toEqual({ include: false, reasons: ['excluded by repos.exclude "hw"'], needsProbe: true });
    expect(decide(unprobed({ archived: true }), { cliInclude: ['hw'] })).toEqual({ include: true, reasons: ['included by --include "hw"'], needsProbe: true });
    expect(decide(facts('hw'), { exclude: ['hw'] }).needsProbe).toBeUndefined(); // already probed
    expect(decideRepo(unprobed({}), settings({ exclude: ['hw'] }), NOW, true).needsProbe).toBeUndefined(); // legacy lockfile
  });

  it('names excluded repos with manifests in one warning, cut to ten for stdout', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ repo: `acme/r${String(i).padStart(2, '0')}`, reason: 'archived (--include-archived to keep)', manifests: ['package.json'] }));
    items[0] = { repo: 'acme/r00', reason: 'excluded by repos.exclude "r0*"', manifests: ['a/package.json', 'b/pubspec.yaml'] };
    items[1] = { repo: 'acme/r01', reason: 'HEAD size 600 MB over repos.maxSizeMb 500', manifests: ['package.json'] };
    items[2] = { repo: 'acme/r02', reason: 'clone failed: git clone: boom', manifests: ['package.json'] };
    const w = excludedReposWarning(items);
    expect(w.startsWith('12 excluded repo(s) have package manifests and may consume org packages (their references are invisible): '
      + 'acme/r00 (repos.exclude, 2 manifests), acme/r01 (size, 1 manifest), acme/r02 (clone failed, 1 manifest), acme/r03 (archived, 1 manifest), ')).toBe(true);
    expect(w.endsWith('acme/r11 (archived, 1 manifest)')).toBe(true);
    const short = shortenExcludedWarning(w);
    expect(short).toMatch(/acme\/r09 \(archived, 1 manifest\) … and 2 more \(all in report\.json warnings\)$/);
    expect(short).not.toContain('acme/r10');
    expect(shortenExcludedWarning(excludedReposWarning(items.slice(0, 10)))).toBe(excludedReposWarning(items.slice(0, 10)));
    expect(shortenExcludedWarning('minAgeDays is 0: age policy disabled')).toBe('minAgeDays is 0: age policy disabled');
  });

  it('include/exclude: --include > --exclude > repos.include > repos.exclude; include forces past every rule', () => {
    const hw = facts('hw-board', { language: 'C', archived: true, fork: true, template: true, sizeKb: 9e6 });
    expect(decide(hw, { include: ['hw-*'] })).toEqual({ include: true, reasons: ['included by repos.include "hw-*"'] });
    expect(decide(facts('lib'), { exclude: ['l*'] })).toEqual({ include: false, reasons: ['excluded by repos.exclude "l*"'] });
    expect(decide(facts('lib'), { include: ['lib'], exclude: ['l*'] }).include).toBe(true);
    expect(decide(facts('lib'), { cliExclude: ['lib'], include: ['lib'] }).reasons).toEqual(['excluded by --exclude "lib"']);
    expect(decide(facts('lib'), { cliInclude: ['lib'], cliExclude: ['*'] }).reasons).toEqual(['included by --include "lib"']);
    expect(decide(facts('other'), { cliInclude: ['lib'], cliExclude: ['*'] }).include).toBe(false);
    // Forced, but still impossible to clone.
    expect(decide(facts('x', { empty: true }), { cliInclude: ['x'] }))
      .toEqual({ include: false, reasons: ['included by --include "x"', 'empty repository (no commit on the default branch)'] });
  });

  it('legacy facts (old lockfile) skip the size, push and language rules', () => {
    expect(decideRepo(facts('x', { language: null, sizeKb: null }), settings(), NOW, true))
      .toEqual({ include: true, reasons: ['listed (lockfile without selection metadata)'] });
    expect(decideRepo(facts('x', { fork: true }), settings(), NOW, true).include).toBe(false);
  });
});

describe('settings', () => {
  it('merges config and CLI; CLI booleans override, CLI globs are kept apart', () => {
    const s = mergeSelectSettings(
      { include: ['a'], exclude: ['b'], languages: ['Go'], maxSizeMb: null, minPushed: '30d', includeForks: true, probe: false },
      { include: ['c'], includeForks: false, includeArchived: true },
    );
    expect(s).toEqual({
      include: ['a'], exclude: ['b'], cliInclude: ['c'], cliExclude: [], languages: ['Go'], maxSizeMb: null,
      minPushed: '30d', includeForks: false, includeArchived: true, probe: false,
    });
    expect(mergeSelectSettings({}, {})).toEqual(defaultSelectSettings());
    expect(diffSettings(defaultSelectSettings(), s)).toContain('maxSizeMb 500 → null');
    expect(diffSettings(s, s)).toEqual([]);
  });

  it('validates the sentei.json repos section', () => {
    expect(readRepoSelectConfig('f', { languages: [], maxSizeMb: 100, minPushed: '2025-01-01', cloneConcurrency: 4, probe: false }))
      .toEqual({ languages: [], maxSizeMb: 100, minPushed: '2025-01-01', cloneConcurrency: 4, probe: false });
    expect(() => readRepoSelectConfig('f', { exclud: [] })).toThrow(/unknown key "repos.exclud"/);
    expect(() => readRepoSelectConfig('f', { maxSizeMb: '1' })).toThrow(/repos.maxSizeMb/);
    expect(() => readRepoSelectConfig('f', { minPushed: 'yesterday' })).toThrow(/repos.minPushed/);
    expect(() => readRepoSelectConfig('f', { cloneConcurrency: 100 })).toThrow(/1 to 32/);
    expect(() => readRepoSelectConfig('f', { include: 'x' })).toThrow(/array of strings/);
    expect(() => readRepoSelectConfig('f', [])).toThrow(/must be an object/);
  });
});
