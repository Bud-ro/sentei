import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { IndexSchema } from '../src/scip/scip_pb.ts';
import { snapshotScip } from '../src/scip/snapshot.ts';

describe('snapshotScip', () => {
  it('renders documents sorted, occurrences sorted by range, versions normalised', () => {
    const sym = (d: string): string => `scip-typescript npm @acme/core 1.2.3 ${d}`;
    const index = create(IndexSchema, {
      metadata: { toolInfo: { name: 'scip-typescript', version: '0.4.0' }, projectRoot: 'file:///nowhere' },
      documents: [
        {
          relativePath: 'src/b.ts',
          text: 'export function f() {}\n',
          occurrences: [
            { range: [0, 16, 17], symbol: sym('src/`b.ts`/f().'), symbolRoles: 1, enclosingRange: [0, 0, 22] },
          ],
        },
        {
          relativePath: 'src/a.ts',
          text: "import { f } from './b';\n\n\tf();\n",
          occurrences: [
            // Deliberately out of order.
            { range: [2, 1, 2], symbol: sym('src/`b.ts`/f().') },
            { range: [0, 9, 10], symbol: sym('src/`b.ts`/f().'), symbolRoles: 2 },
            { range: [0, 0, 0], symbol: 'local 0', symbolRoles: 1 },
          ],
        },
      ],
    });
    expect(snapshotScip(index)).toBe(
      [
        '# sentei scip snapshot: scip-typescript 0.4.0',
        '# positions are 0-based line:character (UTF-16); symbol versions normalised to `.`',
        '',
        '## src/a.ts',
        "  import { f } from './b';",
        '//^ definition local 0',
        '//         ^ reference import scip-typescript npm @acme/core . src/`b.ts`/f().',
        '',
        '  \tf();',
        '//\t^ reference scip-typescript npm @acme/core . src/`b.ts`/f().',
        '',
        '## src/b.ts',
        '  export function f() {}',
        '//                ^ definition scip-typescript npm @acme/core . src/`b.ts`/f(). enclosing [0:0-0:22]',
        '',
      ].join('\n'),
    );
  });

  it('falls back to readSource, and lists occurrences when no source is available', () => {
    const index = create(IndexSchema, {
      documents: [
        { relativePath: 'x.ts', occurrences: [{ range: [0, 0, 1], symbol: 'local 1' }] },
        { relativePath: 'y.ts', occurrences: [{ range: [5, 0, 1], symbol: 'local 2' }] },
      ],
    });
    const out = snapshotScip(index, { readSource: (rel) => (rel === 'x.ts' ? 'x\n' : undefined) });
    expect(out).toContain('## x.ts\n  x\n//^ reference local 1\n');
    expect(out).toContain('## y.ts\n# (source unavailable)\n// [5:0-5:1] reference local 2\n');
  });
});
