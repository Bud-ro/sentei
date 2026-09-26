import { describe, expect, it } from 'vitest';
import { readRepoSelectConfig } from '../src/config.ts';
import {
  decideRepo, defaultSelectSettings, diffSettings, mergeSelectSettings, minPushedCutoff, type RepoFacts, type RepoSelectSettings,
} from '../src/repo-select.ts';

const NOW = Date.parse('2026-09-26T00:00:00Z');
const facts = (name: string, extra: Partial<RepoFacts> = {}): RepoFacts => ({
  name, fork: false, template: false, archived: false, disabled: false,
  language: 'TypeScript', sizeKb: 1000, pushedAt: '2026-09-01T00:00:00Z', ...extra,
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

  it('size over maxSizeMb (API size in KB); null disables', () => {
    const big = facts('big', { sizeKb: 600 * 1024 });
    expect(decide(big)).toEqual({ include: false, reasons: ['size 600 MB over repos.maxSizeMb 500'] });
    expect(decide(big, { maxSizeMb: 1000 }).include).toBe(true);
    expect(decide(big, { maxSizeMb: null }).include).toBe(true);
    expect(decide(facts('unknown', { sizeKb: null })).include).toBe(true);
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

  it('language: a listed language matches; otherwise the manifest probe decides', () => {
    const py = facts('hw', { language: 'Python' });
    expect(decide(py)).toEqual({ include: false, reasons: ['language Python not in repos.languages; manifest probe pending'], needsProbe: true });
    expect(decide({ ...py, manifests: { 'package.json': true } })).toEqual({ include: true, reasons: ['language Python, but package.json at the root'] });
    expect(decide({ ...py, manifests: { 'package.json': false, 'pubspec.yaml': true } }).reasons).toEqual(['language Python, but pubspec.yaml at the root']);
    expect(decide({ ...py, manifests: { 'package.json': false, 'pubspec.yaml': false } }))
      .toEqual({ include: false, reasons: ['language Python not in repos.languages; no package.json or pubspec.yaml at the root'] });
    expect(decide(facts('docs', { language: null }), { probe: false }))
      .toEqual({ include: false, reasons: ['no language detected (probe off)'] });
    expect(decide(py, { languages: [] })).toEqual({ include: true, reasons: ['language rule disabled (repos.languages: [])'] });
    expect(decide(py, { languages: ['python'] }).include).toBe(true);
  });

  it('the probe is only pending for repos no other rule excludes', () => {
    expect(decide(facts('hw', { language: 'C', archived: true })).needsProbe).toBeUndefined();
    expect(decide(facts('hw', { language: 'C', sizeKb: 900 * 1024 })).needsProbe).toBeUndefined();
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
