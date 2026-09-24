// SCIP decoding. The only module (with ingest.ts) allowed to touch SCIP types;
// nothing after ingest may reference them (PLAN.md §3).
import { readFileSync } from 'node:fs';
import { fromBinary } from '@bufbuild/protobuf';
import { IndexSchema, type Index, type Occurrence } from './scip_pb.ts';

export { SymbolInformation_Kind, SymbolRole } from './scip_pb.ts';
export type { Document, Index, Occurrence, SymbolInformation } from './scip_pb.ts';

/** Decode a `.scip` file (a serialized `scip.Index`). */
export function readScipIndex(file: string): Index {
  return fromBinary(IndexSchema, readFileSync(file));
}

/** Parsed SCIP symbol string (https://github.com/sourcegraph/scip/blob/main/scip.proto, `Symbol`). */
export type ParsedScipSymbol =
  | { local: true; id: string }
  | {
      local: false;
      scheme: string;
      /** Package components; `.` (the "empty" placeholder) is returned as ''. */
      manager: string;
      name: string;
      version: string;
      /** Everything after the version, verbatim (still escaped). */
      descriptors: string;
    };

/**
 * Parse a SCIP symbol string into scheme / package / descriptors.
 *
 * Grammar: `<scheme> ' ' <manager> ' ' <name> ' ' <version> ' ' <descriptors>` or
 * `local <id>`. Scheme and package components escape a literal space as two
 * spaces; the placeholder `.` means "empty". Descriptors are kept verbatim.
 * Throws on malformed input.
 */
export function parseScipSymbol(str: string): ParsedScipSymbol {
  if (str.startsWith('local ')) return { local: true, id: str.slice('local '.length) };
  let pos = 0;
  const component = (): string => {
    let out = '';
    for (;;) {
      if (pos >= str.length) throw new Error(`sentei: malformed SCIP symbol (truncated): ${JSON.stringify(str)}`);
      const ch = str[pos]!;
      if (ch === ' ') {
        if (str[pos + 1] === ' ') {
          out += ' ';
          pos += 2;
          continue;
        }
        pos += 1;
        return out;
      }
      out += ch;
      pos += 1;
    }
  };
  const scheme = component();
  const manager = component();
  const name = component();
  const version = component();
  if (scheme === '') throw new Error(`sentei: malformed SCIP symbol (empty scheme): ${JSON.stringify(str)}`);
  const dot = (s: string): string => (s === '.' ? '' : s);
  return { local: false, scheme, manager: dot(manager), name: dot(name), version: dot(version), descriptors: str.slice(pos) };
}

/** Escape a package component for a SCIP symbol string ('' becomes the `.` placeholder). */
function escapeComponent(s: string): string {
  return s === '' ? '.' : s.replaceAll(' ', '  ');
}

/**
 * Rewrite a global symbol with its package version replaced by the `.` placeholder,
 * so a consumer indexed against another version of an org package still links.
 * Local symbols are returned unchanged.
 */
export function normalizeSymbolVersion(str: string): string {
  const p = parseScipSymbol(str);
  if (p.local) return str;
  return [p.scheme.replaceAll(' ', '  '), escapeComponent(p.manager), escapeComponent(p.name), '.', p.descriptors].join(' ');
}

/** One parsed descriptor; `text` is its verbatim (escaped) source text, suffix included. */
export interface Descriptor {
  name: string;
  suffix: 'namespace' | 'type' | 'term' | 'method' | 'type_parameter' | 'parameter' | 'meta' | 'macro';
  disambiguator?: string;
  text: string;
}

/**
 * Split a descriptors string into descriptors. Names are either simple identifiers
 * (`[A-Za-z0-9_+\-$]+`) or backtick-quoted with `` `` `` escaping a backtick, so a
 * quoted name may contain `/`, `.`, `#` etc.
 */
export function parseDescriptors(descriptors: string): Descriptor[] {
  const out: Descriptor[] = [];
  let pos = 0;
  const bad = (why: string): never => {
    throw new Error(`sentei: malformed SCIP descriptors (${why}): ${JSON.stringify(descriptors)}`);
  };
  const isSimple = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_+\-$]/.test(ch);
  const readName = (): string => {
    if (descriptors[pos] === '`') {
      let out = '';
      pos += 1;
      for (;;) {
        if (pos >= descriptors.length) bad('unterminated backtick');
        if (descriptors[pos] === '`') {
          if (descriptors[pos + 1] === '`') {
            out += '`';
            pos += 2;
            continue;
          }
          pos += 1;
          return out;
        }
        out += descriptors[pos];
        pos += 1;
      }
    }
    const start = pos;
    while (isSimple(descriptors[pos])) pos += 1;
    return descriptors.slice(start, pos);
  };
  while (pos < descriptors.length) {
    const start = pos;
    const ch = descriptors[pos];
    if (ch === '(' || ch === '[') {
      pos += 1;
      const name = readName();
      const close = ch === '(' ? ')' : ']';
      if (descriptors[pos] !== close) bad(`expected ${close}`);
      pos += 1;
      out.push({ name, suffix: ch === '(' ? 'parameter' : 'type_parameter', text: descriptors.slice(start, pos) });
      continue;
    }
    const name = readName();
    const suffix = descriptors[pos];
    pos += 1;
    switch (suffix) {
      case '/': out.push({ name, suffix: 'namespace', text: descriptors.slice(start, pos) }); break;
      case '#': out.push({ name, suffix: 'type', text: descriptors.slice(start, pos) }); break;
      case '.': out.push({ name, suffix: 'term', text: descriptors.slice(start, pos) }); break;
      case ':': out.push({ name, suffix: 'meta', text: descriptors.slice(start, pos) }); break;
      case '!': out.push({ name, suffix: 'macro', text: descriptors.slice(start, pos) }); break;
      case '(': {
        const dStart = pos;
        while (pos < descriptors.length && descriptors[pos] !== ')') pos += 1;
        const disambiguator = descriptors.slice(dStart, pos);
        if (descriptors[pos] !== ')' || descriptors[pos + 1] !== '.') bad('expected ).');
        pos += 2;
        out.push({ name, suffix: 'method', disambiguator, text: descriptors.slice(start, pos) });
        break;
      }
      default:
        bad(`unexpected ${JSON.stringify(suffix)} at ${pos - 1}`);
    }
  }
  return out;
}

/** Start `(line, col)` of an occurrence (legacy `range` or typed `single/multi_line_range`). */
export function occurrenceStart(occ: Occurrence): { line: number; col: number } | undefined {
  if (occ.range.length >= 3) return { line: occ.range[0]!, col: occ.range[1]! };
  const t = occ.typedRange;
  if (t.case === 'singleLineRange') return { line: t.value.line, col: t.value.startCharacter };
  if (t.case === 'multiLineRange') return { line: t.value.startLine, col: t.value.startCharacter };
  return undefined;
}

/** Half-open `[start, end)` span in (line, col) order. */
export interface Span { startLine: number; startCol: number; endLine: number; endCol: number }

function spanOf(r: readonly number[]): Span | undefined {
  if (r.length === 3) return { startLine: r[0]!, startCol: r[1]!, endLine: r[0]!, endCol: r[2]! };
  if (r.length === 4) return { startLine: r[0]!, startCol: r[1]!, endLine: r[2]!, endCol: r[3]! };
  return undefined;
}

/** The occurrence's `enclosing_range`, if the indexer emitted one. */
export function occurrenceEnclosingSpan(occ: Occurrence): Span | undefined {
  if (occ.enclosingRange.length > 0) return spanOf(occ.enclosingRange);
  const t = occ.typedEnclosingRange;
  if (t.case === 'singleLineEnclosingRange') {
    return { startLine: t.value.line, startCol: t.value.startCharacter, endLine: t.value.line, endCol: t.value.endCharacter };
  }
  if (t.case === 'multiLineEnclosingRange') {
    return { startLine: t.value.startLine, startCol: t.value.startCharacter, endLine: t.value.endLine, endCol: t.value.endCharacter };
  }
  return undefined;
}
