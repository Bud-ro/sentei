import { describe, expect, it } from 'vitest';
import { globToRegExp, matchGlob } from '../src/glob.ts';

describe('matchGlob', () => {
  it('* stays within one segment', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matchGlob('*.ts', 'a.ts')).toBe(true);
    expect(matchGlob('*.ts', 'src/a.ts')).toBe(false);
  });

  it('? matches exactly one non-slash character', () => {
    expect(matchGlob('a?.ts', 'ab.ts')).toBe(true);
    expect(matchGlob('a?.ts', 'a.ts')).toBe(false);
    expect(matchGlob('a?b', 'a/b')).toBe(false);
  });

  it('**/ matches zero or more segments', () => {
    expect(matchGlob('stories/**/*.tsx', 'stories/a.tsx')).toBe(true);
    expect(matchGlob('stories/**/*.tsx', 'stories/x/y/a.tsx')).toBe(true);
    expect(matchGlob('stories/**/*.tsx', 'other/a.tsx')).toBe(false);
    expect(matchGlob('**/*.test.ts', 'a.test.ts')).toBe(true);
    expect(matchGlob('**/*.test.ts', 'x/y/a.test.ts')).toBe(true);
    expect(matchGlob('**/test/**', 'pkg/test/a/b.dart')).toBe(true);
    expect(matchGlob('**/test/**', 'pkg/tests/a.dart')).toBe(false);
  });

  it('trailing ** matches everything below', () => {
    expect(matchGlob('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(matchGlob('src/**', 'srcx/a.ts')).toBe(false);
    expect(matchGlob('**', 'any/thing')).toBe(true);
  });

  it('treats regex metacharacters literally', () => {
    expect(matchGlob('a.(b)+[c].ts', 'a.(b)+[c].ts')).toBe(true);
    expect(matchGlob('a.ts', 'abts')).toBe(false);
    expect(globToRegExp('x$^{}|').test('x$^{}|')).toBe(true);
  });

  it('ignores a leading ./ on glob and path', () => {
    expect(matchGlob('./src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', './src/a.ts')).toBe(true);
  });
});
