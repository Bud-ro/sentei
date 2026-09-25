import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSymbolVersion, parseDescriptors, parseScipSymbol, readScipIndex, SymbolRole } from '../src/scip/read.ts';
import { IndexSchema } from '../src/scip/scip_pb.ts';

describe('parseScipSymbol', () => {
  it('parses scip-typescript global symbols', () => {
    expect(parseScipSymbol('scip-typescript npm @acme/core 1.0.0 src/`fns.ts`/usedFn().')).toEqual({
      local: false, scheme: 'scip-typescript', manager: 'npm', name: '@acme/core', version: '1.0.0',
      descriptors: 'src/`fns.ts`/usedFn().',
    });
    expect(parseScipSymbol('scip-typescript npm @acme/core 1.0.0 src/`index.ts`/')).toMatchObject({
      local: false, name: '@acme/core', descriptors: 'src/`index.ts`/',
    });
  });

  it('parses local symbols', () => {
    expect(parseScipSymbol('local 3')).toEqual({ local: true, id: '3' });
  });

  it('turns the "." placeholder into empty components', () => {
    expect(parseScipSymbol('scip-typescript npm . . lib/`x.ts`/f().')).toMatchObject({
      manager: 'npm', name: '', version: '', descriptors: 'lib/`x.ts`/f().',
    });
  });

  it('unescapes double spaces in package components', () => {
    expect(parseScipSymbol('my  scheme npm my  pkg 1.0  beta a/')).toMatchObject({
      scheme: 'my scheme', manager: 'npm', name: 'my pkg', version: '1.0 beta', descriptors: 'a/',
    });
  });

  it('keeps descriptors containing spaces and backticked "/" verbatim', () => {
    expect(parseScipSymbol('s npm p 1 src/`a b/c.ts`/f().')).toMatchObject({ descriptors: 'src/`a b/c.ts`/f().' });
  });

  it('rejects truncated symbols', () => {
    expect(() => parseScipSymbol('scip-typescript npm @acme/core')).toThrow(/malformed SCIP symbol/);
    expect(() => parseScipSymbol('')).toThrow(/malformed SCIP symbol/);
  });
});

describe('normalizeSymbolVersion', () => {
  it('replaces the version with "."', () => {
    expect(normalizeSymbolVersion('scip-typescript npm @acme/core 1.0.0 src/`fns.ts`/usedFn().'))
      .toBe('scip-typescript npm @acme/core . src/`fns.ts`/usedFn().');
    expect(normalizeSymbolVersion('scip-typescript npm @acme/core 2.3.4 src/`fns.ts`/usedFn().'))
      .toBe('scip-typescript npm @acme/core . src/`fns.ts`/usedFn().');
  });

  it('keeps escaping and placeholders, and leaves locals alone', () => {
    expect(normalizeSymbolVersion('my  scheme npm my  pkg 1.0  beta a/')).toBe('my  scheme npm my  pkg . a/');
    expect(normalizeSymbolVersion('s npm . . a/')).toBe('s npm . . a/');
    expect(normalizeSymbolVersion('local 3')).toBe('local 3');
  });
});

describe('parseDescriptors', () => {
  it('splits namespace / term / method / type / parameter descriptors', () => {
    expect(parseDescriptors('src/`fns.ts`/usedFn().').map((d) => [d.name, d.suffix, d.text])).toEqual([
      ['src', 'namespace', 'src/'],
      ['fns.ts', 'namespace', '`fns.ts`/'],
      ['usedFn', 'method', 'usedFn().'],
    ]);
    expect(parseDescriptors('src/`a.ts`/Foo#bar().(x)').map((d) => [d.name, d.suffix])).toEqual([
      ['src', 'namespace'], ['a.ts', 'namespace'], ['Foo', 'type'], ['bar', 'method'], ['x', 'parameter'],
    ]);
    expect(parseDescriptors('`a.ts`/Foo#[T]x.').map((d) => d.suffix)).toEqual(['namespace', 'type', 'type_parameter', 'term']);
    expect(parseDescriptors('`a.ts`/f(+1).')[1]).toMatchObject({ name: 'f', suffix: 'method', disambiguator: '+1' });
    expect(parseDescriptors('m:x!').map((d) => d.suffix)).toEqual(['meta', 'macro']);
  });

  it('handles backticked names containing "/", "#", "." and escaped backticks', () => {
    expect(parseDescriptors('`src/deep/a.ts`/`we#ird.`().').map((d) => d.name)).toEqual(['src/deep/a.ts', 'we#ird.']);
    expect(parseDescriptors('`a``b`.')[0]!.name).toBe('a`b');
  });

  it('rejects malformed descriptors', () => {
    expect(() => parseDescriptors('`unterminated/')).toThrow(/malformed SCIP descriptors/);
    expect(() => parseDescriptors('f(x')).toThrow(/malformed SCIP descriptors/);
    expect(() => parseDescriptors('a?')).toThrow(/malformed SCIP descriptors/);
  });
});

describe('readScipIndex', () => {
  it('round-trips an Index through the generated bindings', () => {
    const dir = mkdtempSync(join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-scip-'));
    try {
      const idx = create(IndexSchema, {
        metadata: { projectRoot: 'file:///x', toolInfo: { name: 't', version: '1' } },
        documents: [{ relativePath: 'src/a.ts', occurrences: [{ range: [1, 2, 5], symbol: 'local 0', symbolRoles: SymbolRole.Definition }] }],
      });
      const file = join(dir, 'a.scip');
      writeFileSync(file, toBinary(IndexSchema, idx));
      const back = readScipIndex(file);
      expect(back.metadata?.toolInfo?.name).toBe('t');
      expect(back.documents[0]!.relativePath).toBe('src/a.ts');
      expect(back.documents[0]!.occurrences[0]!.range).toEqual([1, 2, 5]);
      expect(back.documents[0]!.occurrences[0]!.symbolRoles).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
