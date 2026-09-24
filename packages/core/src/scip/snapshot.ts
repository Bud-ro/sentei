// Deterministic text rendering of a decoded SCIP index, in the spirit of the
// `scip snapshot` CLI (we do not ship that Go binary; this format is our own and
// must stay stable). Used for the PLAN.md §6.6 indexer snapshot rule: the
// rendering of every fixture package is checked into
// `fixtures/snapshots/<indexer>@<version>/` and diffed when an indexer changes.
//
// Format:
//   # sentei scip snapshot: <tool name> <tool version>
//   # positions are 0-based line:character (UTF-16); symbol versions normalised to `.`
//
//   ## <document relative path>
//     <source line, indented by two spaces>
//   //<spaces to the column>^^^^ definition|reference[ <extra roles>] <symbol>[ enclosing [l:c-l:c]]
//
// Documents are sorted by relative path; occurrences by range, then symbol.
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeSymbolVersion, occurrenceEnclosingSpan, type Span } from './read.ts';
import type { Document, Index, Occurrence } from './scip_pb.ts';

export interface SnapshotOptions {
  /**
   * Source text of a document when the index does not embed it (`Document.text`).
   * Default: read `<metadata.project_root>/<relative_path>` from disk.
   */
  readSource?: (relativePath: string) => string | undefined;
}

/** Extra role bits printed after `definition`/`reference` (SCIP `SymbolRole`). */
const EXTRA_ROLES: ReadonlyArray<[number, string]> = [
  [2, 'import'],
  [4, 'write'],
  [8, 'read'],
  [16, 'generated'],
  [32, 'test'],
  [64, 'forward_definition'],
];

function occurrenceSpan(occ: Occurrence): Span | undefined {
  const r = occ.range;
  if (r.length === 3) return { startLine: r[0]!, startCol: r[1]!, endLine: r[0]!, endCol: r[2]! };
  if (r.length === 4) return { startLine: r[0]!, startCol: r[1]!, endLine: r[2]!, endCol: r[3]! };
  const t = occ.typedRange;
  if (t.case === 'singleLineRange') {
    return { startLine: t.value.line, startCol: t.value.startCharacter, endLine: t.value.line, endCol: t.value.endCharacter };
  }
  if (t.case === 'multiLineRange') {
    return { startLine: t.value.startLine, startCol: t.value.startCharacter, endLine: t.value.endLine, endCol: t.value.endCharacter };
  }
  return undefined;
}

const fmtSpan = (s: Span): string => `${s.startLine}:${s.startCol}-${s.endLine}:${s.endCol}`;

/**
 * Symbols are printed verbatim except the package version, which is replaced by
 * the `.` placeholder (normalizeSymbolVersion): a version bump in a fixture's
 * package.json/pubspec.yaml (or the Dart SDK version in `dart:core` symbols)
 * would otherwise churn every line of every snapshot.
 */
function printSymbol(sym: string): string {
  if (sym === '') return '<no symbol>';
  try {
    return normalizeSymbolVersion(sym);
  } catch {
    return sym;
  }
}

function describeOccurrence(occ: Occurrence, span: Span | undefined): string {
  const roles = occ.symbolRoles;
  const words = [(roles & 1) !== 0 ? 'definition' : 'reference'];
  for (const [bit, name] of EXTRA_ROLES) if ((roles & bit) !== 0) words.push(name);
  words.push(printSymbol(occ.symbol));
  if (span === undefined) words.push(`[bad range ${JSON.stringify(occ.range)}]`);
  else if (span.endLine !== span.startLine) words.push(`[to ${span.endLine}:${span.endCol}]`);
  if ((roles & 1) !== 0) {
    const enc = occurrenceEnclosingSpan(occ);
    if (enc !== undefined) words.push(`enclosing [${fmtSpan(enc)}]`);
  }
  return words.join(' ');
}

function compareOcc(a: { span: Span | undefined; text: string }, b: { span: Span | undefined; text: string }): number {
  const ka = a.span ? [a.span.startLine, a.span.startCol, a.span.endLine, a.span.endCol] : [-1, -1, -1, -1];
  const kb = b.span ? [b.span.startLine, b.span.startCol, b.span.endLine, b.span.endCol] : [-1, -1, -1, -1];
  for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/** The annotation line: `//` then padding that mirrors tabs in the source, then carets. */
function annotation(source: string | undefined, span: Span, text: string): string {
  const line = source ?? '';
  let pad = '';
  for (let i = 0; i < span.startCol; i++) pad += line[i] === '\t' ? '\t' : ' ';
  const end = span.endLine === span.startLine ? span.endCol : Math.max(line.length, span.startCol + 1);
  return `//${pad}${'^'.repeat(Math.max(1, end - span.startCol))} ${text}`;
}

function renderDocument(doc: Document, source: string | undefined): string[] {
  const out = [`## ${doc.relativePath}`];
  const lines = source === undefined ? undefined : source.split(/\r?\n/);
  if (lines !== undefined && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const occs = doc.occurrences
    .map((occ) => {
      const span = occurrenceSpan(occ);
      return { span, text: describeOccurrence(occ, span) };
    })
    .sort(compareOcc);

  if (lines === undefined) {
    out.push('# (source unavailable)');
    for (const o of occs) out.push(`// ${o.span ? `[${fmtSpan(o.span)}]` : '[?]'} ${o.text}`);
    return out;
  }
  const byLine = new Map<number, typeof occs>();
  const orphans: typeof occs = [];
  for (const o of occs) {
    if (o.span === undefined || o.span.startLine >= lines.length) {
      orphans.push(o);
      continue;
    }
    const list = byLine.get(o.span.startLine) ?? [];
    list.push(o);
    byLine.set(o.span.startLine, list);
  }
  lines.forEach((l, i) => {
    out.push(l === '' ? '' : `  ${l}`);
    for (const o of byLine.get(i) ?? []) out.push(annotation(l, o.span!, o.text));
  });
  for (const o of orphans) out.push(`// ${o.span ? `[${fmtSpan(o.span)}]` : '[?]'} (outside source) ${o.text}`);
  return out;
}

function defaultReadSource(index: Index): (rel: string) => string | undefined {
  const rootUri = index.metadata?.projectRoot ?? '';
  let root: string | undefined;
  try {
    root = rootUri.startsWith('file:') ? fileURLToPath(rootUri) : rootUri || undefined;
  } catch {
    root = undefined;
  }
  return (rel) => {
    if (root === undefined) return undefined;
    const p = path.join(root, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };
}

/** Render a decoded SCIP index as stable, human-readable text (ends with a newline). */
export function snapshotScip(index: Index, opts: SnapshotOptions = {}): string {
  const readSource = opts.readSource ?? defaultReadSource(index);
  const tool = index.metadata?.toolInfo;
  const out = [
    `# sentei scip snapshot: ${tool ? `${tool.name} ${tool.version}`.trim() : '(unknown tool)'}`,
    '# positions are 0-based line:character (UTF-16); symbol versions normalised to `.`',
  ];
  const docs = [...index.documents].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  for (const doc of docs) {
    out.push('');
    out.push(...renderDocument(doc, doc.text !== '' ? doc.text : readSource(doc.relativePath)));
  }
  return `${out.join('\n')}\n`;
}
