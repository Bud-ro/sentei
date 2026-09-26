// The version-constraint matcher behind discover's `constraint` dependency resolution.
import { describe, expect, it } from 'vitest';
import { npmSatisfies, parseVersion, pubSatisfies } from '../src/semver.ts';

describe('parseVersion', () => {
  it('parses full versions only', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3], pre: [] });
    expect(parseVersion('v1.2.3-rc.1+build.5')).toEqual({ core: [1, 2, 3], pre: ['rc', '1'] });
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('npmSatisfies', () => {
  const yes = (v: string, r: string): void => expect(npmSatisfies(v, r), `${v} ${r}`).toBe(true);
  const no = (v: string, r: string): void => expect(npmSatisfies(v, r), `${v} ${r}`).toBe(false);

  it('caret', () => {
    yes('0.12.7', '^0.12.5');
    no('0.3.0', '^0.12.5');
    no('0.13.0', '^0.12.5');
    yes('1.9.0', '^1.2.3');
    no('2.0.0', '^1.2.3');
    yes('0.0.3', '^0.0.3');
    no('0.0.4', '^0.0.3');
    yes('0.0.9', '^0.0');
    no('0.1.0', '^0.0');
    yes('1.5.0', '^1');
    yes('0.9.0', '^0.x');
  });

  it('tilde, exact, x-ranges, comparators, hyphen, unions, any', () => {
    yes('1.2.9', '~1.2.3');
    no('1.3.0', '~1.2.3');
    yes('1.9.9', '~1');
    yes('1.2.3', '1.2.3');
    yes('1.2.3', '=v1.2.3');
    no('1.2.4', '1.2.3');
    yes('1.2.4', '1.2.x');
    yes('1.9.0', '1.x');
    yes('1.9.0', '1');
    no('2.0.0', '1');
    yes('1.5.0', '>=1.2.0 <2');
    yes('1.5.0', '>= 1.2.0 < 2.0.0');
    no('2.0.0', '>=1.2.0 <2');
    yes('1.3.0', '>1.2');
    no('1.2.9', '>1.2');
    yes('1.2.9', '<=1.2');
    no('1.3.0', '<=1.2');
    yes('1.5.0', '1.0.0 - 2.0.0');
    yes('2.0.5', '1.0.0 - 2.0');
    no('2.1.0', '1.0.0 - 2.0');
    yes('3.1.0', '^1.0.0 || ^3.0.0');
    no('2.1.0', '^1.0.0 || ^3.0.0');
    yes('9.9.9', '*');
    yes('9.9.9', '');
    yes('2.0.0', 'npm:@acme/x@^2');
  });

  it('prereleases compare by precedence (lenient: no same-tuple exclusion)', () => {
    yes('1.3.0-rc.1', '^1.2.0');
    no('1.2.0-rc.1', '>=1.2.0');
    yes('1.2.0-rc.10', '>1.2.0-rc.2');
  });

  it('null for what is not a version range', () => {
    for (const r of ['latest', 'next', 'workspace:*', 'workspace:^1.0.0', 'file:../x', 'link:../x', 'github:a/b', 'a/b', 'https://x/y.tgz', '^1.2.3.4']) {
      expect(npmSatisfies('1.2.3', r), r).toBeNull();
    }
    expect(npmSatisfies('garbage', '^1.0.0')).toBeNull();
  });
});

describe('pubSatisfies', () => {
  it("pub's caret: ^0.x.y allows <0.(x+1).0, also for 0.0.x", () => {
    expect(pubSatisfies('0.1.9', '^0.1.0')).toBe(true);
    expect(pubSatisfies('0.2.0', '^0.1.0')).toBe(false);
    expect(pubSatisfies('0.0.9', '^0.0.3')).toBe(true);
    expect(pubSatisfies('0.1.0', '^0.0.3')).toBe(false);
    expect(pubSatisfies('1.9.0', '^1.2.3')).toBe(true);
    expect(pubSatisfies('2.0.0', '^1.2.3')).toBe(false);
  });

  it('ranges, exact, any; null for path / git / sdk deps', () => {
    expect(pubSatisfies('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(pubSatisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(pubSatisfies('1.0.0', '1.0.0')).toBe(true);
    expect(pubSatisfies('1.0.1', '1.0.0')).toBe(false);
    expect(pubSatisfies('7.0.0', 'any')).toBe(true);
    for (const c of ['path:../x', 'git:https://x', 'sdk:flutter']) expect(pubSatisfies('1.0.0', c), c).toBeNull();
  });
});
