// `witness` stage core (PLAN.md §9): a deliberately dumb, independent second opinion
// on every would-be deletion candidate. Plain `node:fs` + regex over the consumers'
// checkouts; shares no code with the indexer/ingest path on purpose.
//
// Input: `findings` rows with verdict 'needs_review' whose reasons contain
// 'witness_pending' (written by analyze). For each such symbol S of package P, every
// consumer C of P is searched:
//   - manifest-declared consumers: package_deps.resolved_package_id = P; the files
//     scanned are those under C's package dir (minus nested org packages);
//   - ignored manifests (discover.json `repos[].ignoredManifests`: examples, templates,
//     fixtures… skipped as org packages, so unindexed and absent from package_deps)
//     whose deps resolve to P, or whose deps are unknown (unparseable manifest); the
//     files scanned are those under the manifest's dir (minus nested org packages).
//     PLAN §12: this unindexed code can only downgrade a verdict, never add edges.
// In each C:
//   1. files that import/require/re-export P (per-language regex, whole file);
//   2. in those files, any NAME of S as a whole identifier: S's declared name plus every
//      name an entry exports it under (symbol_exports.exported_as; an
//      `export { a as b }` consumer names only `b`). `default` is never searched as an
//      identifier (npm); instead, when S is named `default` (anonymous default export)
//      or exported as `default`, a default import of a matching module specifier is a
//      hit (the default-import rule below).
// Plus witness_files (ingest, from scoped sidecar unindexedImports): unindexed script /
// docs / test files of a consumer C importing P, scanned like C's own files (step 1 +
// 2, names only) whether or not C declares a dependency on P, consumer label C; a row
// with C = P (an own `.vue` / `.svelte` component importing own code relatively, or an
// own file importing P by name that SCIP could not follow: outside the program, or an
// indexed file whose self-import did not resolve) needs no import of P, is scanned even
// when it is an indexed document (the indexed-file rules below do not apply), and is
// labelled `self`.
// Comments never count: code files are read with comments blanked (not `.vue` / `.md`
// witness_files, whose markup is not JS).
// Entry vouching (npm): a file's import of P vouches for S only through a specifier that
// reaches one of S's symbol_exports entries (the matching of the default-import rule
// below: the bare specifier reaches the root entry, `P/react` the entry behind
// `./react`); a symbol with no symbol_exports row is never vouched for. Pub: any import.
// Indexed consumer files (documents of C): SCIP already resolved their identifiers, so a
// name match does not count when it is a member access (`screen.findByTestId(…)`,
// `x?.y`, Dart `..y`; not a `...spread`) or when SCIP has an occurrence of another
// symbol with that name on that line and none of S (over_react's tests: 7 false rows).
// The self steps read only P's own CODE files that are not generated
// (documents.is_generated or GENERATED_GLOBS: capnp-es generated files quote names and
// import P by name).
// SELF (codegen) step: P's own string literals that are CODE TEMPLATES naming P: the
// literal contains P's package name (`P`, `P/…`; pub `package:P/…`) and is shaped like
// generated import code (CODEGEN_CONTENT_RES: `import { X } from '…'`, `export * from`,
// Dart `import 'package:…'`, `require('…')`, `import('…')`; e.g.
// `` `import { X } from 'honox/vite/components'` ``). Literals come from a loose
// scanner (stringLiterals: comments skipped, so JSDoc code fences do not count; '…' /
// "…" single-line; backtick templates span lines, `${…}` skipped by brace counting;
// pub: also '''…''' / """…"""). Also a literal naming P passed to an AST builder:
// `*ImportDeclaration(` / `*ExportDeclaration(` (babel `importDeclaration`, TS
// `factory.createImportDeclaration`) opening within the 300 characters before it
// (honox's `importDeclaration([…HonoXIsland…], stringLiteral('honox/vite/components'))`).
// A plain `name: '@acme/x/bun'` does not qualify; a module specifier never does
// (`import … from 'P'`); nor does a MESSAGE literal (isMessageLiteral: an argument of
// `deprecated(` / `deprecate(` / `warn(` / `warning(` / `console.*(` / `logger.*(`, or
// content opening with `[deprecated]` / `Deprecated:` / `Warning:`), for the
// SELF-STRING step too: clerk-auth's deprecation notice quotes the import it retires.
// Only a name of S written INSIDE the qualifying literal (template content, `${…}` blanked) or inside the builder call up
// to the literal is a hit, consumer `self` (not every symbol of the file:
// `ClerkAuthVariables` beside a template importing `@hono/clerk-auth`).
// P is also its OWN consumer: P's own files (same walk and rules) that import P by its
// package name are scanned like any consumer's (step 1 + 2), with consumer `self`, but
// only files that are NOT indexed documents of P (usually outside the tsconfig
// program: codeup's `actions/*.ts` doing `import { defineAction } from "codeup"`; an
// indexed Dart `lib/` file importing `package:P/src/…` was seen by the indexer), with
// comments and non-specifier string literals blanked (an import inside a code template
// is the codegen step's business), and never counting directive lines
// (SELF_DIRECTIVE_LINE_RES: Dart `export`/`part`/`show`/`hide`, a TS re-export line).
// SELF-STRING step: a literal in P's own files (same walk and rules) whose content,
// with `${…}` interpolations blanked, holds a name of S in an import-clause shape
// (`{ N`, `N }`, `N as`, `as N`, `, N,`; e.g.
// `` `import { executeAsync as __x } from "${mod}"` ``), or holds the name as a whole
// word while SOME own file of P holds a codegen-shaped literal (package-wide: a
// template as above naming any module, `from ${JSON.stringify(m)}` included, or an
// AST-builder argument: unctx's `helperName: "executeAsync"`, capnp-es's
// `mask: "getFloat32Mask"` / `"$.BoolList"` in constants.ts with the template in
// generators/struct.ts; not `c.set('sentry', …)` or `name = 'MedleyRouter'` in a
// package that builds no import text), is a hit, consumer
// `self-string`: code we cannot follow may name S. Never a module specifier
// (`import { Enforcer } from 'casbin'` does not name `casbin` the symbol), never S's own
// definition line (`component = 'component'`). `'executeAsyncMode'` is not a hit.
// Any hit (or a consumer dir we cannot read) → needs_review with reasons
//   witness_mismatch:<consumer>:<file>:<line>      (1-based line, repo-relative file)
//   witness_mismatch:<consumer>:checkout missing
// where <consumer> is either a package id (`npm:<name>` / `pub:<name>`), `self` (P's
// own generated-import files, or own files importing P by name), `self-string` (a quoted
// name in P's own files), or, for an ignored manifest, `ignored:<repo>/<manifest>`
// with <repo> = `<org>/<name>` and <manifest> the repo-relative manifest file (ending in
// `package.json` or `pubspec.yaml`), e.g.
//   witness_mismatch:ignored:acme/app/examples/demo/package.json:examples/demo/src/x.ts:3
//   witness_mismatch:self:src/vite/island-components.ts:189
//   witness_mismatch:self-string:src/runtime/helpers.ts:12
// The `ignored:` / `self` / `self-string` labels cannot collide with a package id (always `npm:`/`pub:`).
//
// Default-import rule (npm). The default-bound forms are: `import X from`, `import
// type X from`, `import X, {…} from`, `import { default as X } from`,
// `export { default } from`, `require(…)`, `import(…)`. The specifier is P itself or
// `P/<subpath>`. For each file F that defines S as `default` (S.file when S is
// named `default`) or is an entry exporting S as `default` (symbol_exports.entry_file),
// with F' = F relative to P's dir, a hit is (dumb and over-inclusive on purpose):
//   - the bare specifier P (no subpath): matches only a default of P's ROOT entry: F' is
//     the target of `main` / `module` / `types` / `typings` or of `exports['.']` (a
//     conditions object or string `exports` too), compared like the exports-map rule
//     below; with none of those, an index file (`index.*`, `src/index.*`: manifests'
//     fallback);
//     an unreadable package.json matches every default (fail closed).
//     `import devServer from '@hono/vite-dev-server'` names `src/index.ts`'s default,
//     not the `bun` / `node` adapters' defaults (subpaths `./bun`, `./node`);
//   - a subpath whose last segment (extension stripped) is F's base name, or F's
//     parent dir name when F is an index file (`@acme/lib/d` for `src/d/index.ts`);
//   - a subpath equal (extension stripped) to F' minus a leading `src/` and its
//     extension, or, for an index file, minus `/index` too (`adapter/cloudflare-pages`);
//   - a subpath equal to a key of P's package.json `exports` map (read from the
//     checkout; packages.entry_points does not keep the map) whose target resolves to
//     F: target and F' are compared after stripping `./`, leading build/source dirs
//     (dist lib build out src esm cjs types es), extensions (incl. `.d.ts`) and a
//     trailing `/index`, one being a suffix of the other; for a pattern key
//     (`./plugins/*`), a target pattern matching F gives the `*` value to put in the key;
//   - an empty last segment (`@acme/lib/`).
//
// Test / docs globs (globs.ts, shared with analyze.sql) are matched against the
// repo-relative path for org packages (as analyze does) and against the path relative
// to the manifest dir for an ignored manifest (an example project under `examples/`
// is itself the consumer being checked; its own tests/docs are still skipped).
// Exception, mirroring analyze.sql `external_refs`: a consumer whose dependency on P is
// dev-only (package_deps.dev = 1) has its test files scanned too, whatever
// countTestsAsConsumers says (a test-support library is consumed by tests).
// No hit → witness_ok row and a deletion_candidate (the schema triggers still guard
// that insert).
// Then, in the same transaction, the outcomes propagate (analyze.ts): dead islands
// whose users the witness downgraded revert to unexport_candidate
// (reconcileDeadIslands), and the private_dead cascade is recomputed from the new
// findings (insertPrivateDead), so a downgraded candidate no longer unlocks helpers.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { analyzeSql, insertPrivateDead, reconcileDeadIslands, requireAnalyzed } from './analyze.ts';
import { matchGlob } from './glob.ts';
import { DOCS_GLOBS, GENERATED_GLOBS, TEST_GLOBS } from './globs.ts';
import { listFiles } from './manifests.ts';

/** The part of work/discover.json (DiscoverModel) the witness reads. */
export interface WitnessDiscoverInput {
  repos: Array<{
    repo: string;
    localPath: string;
    packages: Array<{ packageId: string; path: string }>;
    /** Optional (older discover.json files lack it); default []. */
    ignoredManifests?: Array<{
      path: string;
      manifest: string;
      deps: Array<{ resolvedPackageId: string | null }>;
      /** Unparseable manifest: scanned for every package. Default false. */
      depsUnknown?: boolean;
    }>;
  }>;
}

export interface RunWitnessOptions {
  db: DatabaseSync;
  discover: WitnessDiscoverInput;
  /** Epoch seconds for witness_ok.checked_at; defaults to now. */
  now?: number;
  log: (line: string) => void;
}

export interface WitnessCounts {
  checked: number;
  passed: number;
  mismatched: number;
}

/** Max witness_mismatch reasons recorded per symbol. */
const MAX_HITS = 5;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.dart']);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Regexes (global, whole-file) that find a module specifier of P; group 1 = `/subpath` or undefined. */
function mentionRegexes(manager: 'npm' | 'pub', name: string): RegExp[] {
  const p = escapeRe(name);
  if (manager === 'pub') return [new RegExp(`\\b(?:import|export)\\s+['"]package:${p}(/[^'"]*)['"]`, 'g')];
  const spec = `['"]${p}(/[^'"]*)?['"]`;
  return [
    new RegExp(`\\b(?:import|export)\\b[^;]*?\\bfrom\\s*${spec}`, 'gs'), // import … from / export … from
    new RegExp(`\\bimport\\s*${spec}`, 'g'), // side-effect import
    new RegExp(`\\brequire\\(\\s*${spec}`, 'g'),
    new RegExp(`\\bimport\\(\\s*${spec}`, 'g'),
  ];
}

/**
 * Regexes that bind P's *default* export; group 1 = `/subpath` or undefined. Default
 * import (optionally `type`, optionally followed by `, {…}`/`, * as x`), `{ default … }`
 * named import/re-export, CJS require, dynamic import.
 */
function defaultRegexes(name: string): RegExp[] {
  const p = escapeRe(name);
  const spec = `['"]${p}(/[^'"]*)?['"]`;
  return [
    new RegExp(`\\bimport\\s+(?:type\\s+)?[A-Za-z_$][\\w$]*\\s*(?:,[^;]*?)?\\bfrom\\s*${spec}`, 'gs'),
    new RegExp(`\\b(?:import|export)\\s*(?:type\\s*)?\\{[^}]*\\bdefault\\b[^}]*\\}\\s*from\\s*${spec}`, 'gs'),
    new RegExp(`\\brequire\\(\\s*${spec}\\s*\\)`, 'g'),
    new RegExp(`\\bimport\\(\\s*${spec}\\s*\\)`, 'g'),
  ];
}

/**
 * String literals of a JS/TS (or Dart) source text, found by a loose scanner: `//` and
 * `/* *\/` comments are skipped (so JSDoc code fences are not templates), '…' / "…"
 * end at the matching quote or the end of the line, backtick templates (JS) may span
 * lines and skip `${…}` by brace counting, Dart '''…''' / """…""" may span lines.
 * Regex literals are not recognised (a quote inside one may pair wrongly: loose).
 */
export function stringLiterals(text: string, dart = false): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const e = text.indexOf('\n', i);
      i = e === -1 ? n : e;
    } else if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
    } else if (dart && (c === "'" || c === '"') && text.startsWith(c.repeat(3), i)) {
      const q = c.repeat(3);
      const e = text.indexOf(q, i + 3);
      const end = e === -1 ? n : e + 3;
      out.push({ start: i, text: text.slice(i, end) });
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      const end = text[j] === c ? j + 1 : Math.min(n, j);
      out.push({ start: i, text: text.slice(i, end) });
      i = end;
    } else if (c === '`' && !dart) {
      let j = i + 1;
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') {
          j += 2;
        } else if (text[j] === '$' && text[j + 1] === '{') {
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (text[j] === '{') depth += 1;
            else if (text[j] === '}') depth -= 1;
            j += 1;
          }
        } else {
          j += 1;
        }
      }
      const end = Math.min(n, j + 1);
      out.push({ start: i, text: text.slice(i, end) });
      i = end;
    } else {
      i += 1;
    }
  }
  return out;
}

/**
 * `text` with every `//` / `/* *\/` comment blanked to spaces (newlines kept, so lines
 * and offsets are unchanged); strings and templates are skipped with the same loose
 * rules as stringLiterals, so `'http://x'` is not a comment.
 */
export function blankComments(text: string, dart = false): string {
  const lits = stringLiterals(text, dart);
  let out = '';
  let i = 0;
  const blankTo = (end: number): void => {
    out += text.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  };
  for (const lit of [...lits, { start: text.length, text: '' }]) {
    // Between literals: find comments.
    while (i < lit.start) {
      const a = text.indexOf('//', i);
      const b = text.indexOf('/*', i);
      const next = [a, b].filter((x) => x !== -1 && x < lit.start).sort((x, y) => x - y)[0];
      if (next === undefined) {
        out += text.slice(i, lit.start);
        i = lit.start;
        break;
      }
      out += text.slice(i, next);
      i = next;
      if (next === a) {
        const e = text.indexOf('\n', i);
        blankTo(e === -1 ? text.length : e);
      } else {
        const e = text.indexOf('*/', i + 2);
        blankTo(e === -1 ? text.length : e + 2);
      }
    }
    if (i > lit.start) continue; // (a comment ran past this literal: it was not a real literal)
    out += lit.text;
    i = lit.start + lit.text.length;
  }
  return out;
}

/** `${…}` interpolations (brace-counted) replaced by spaces, newlines kept, so offsets are unchanged. */
function blankInterpolations(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
    } else if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      do {
        if (s[j] === '{') depth += 1;
        else if (s[j] === '}') depth -= 1;
        j += 1;
      } while (j < s.length && depth > 0);
      out += s.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** 1-based line of a string offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line += 1;
  return line;
}

const stripExt = (f: string): string => basename(f, extname(f));
/** `a/b.ts` -> `a/b`; `a/b.d.ts` -> `a/b`. */
const stripPathExt = (f: string): string => f.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, '');

/** What a default-import subpath of P may be to bind a given `default` (header comment). */
interface DefaultTargets {
  /** Some default file is P's root entry: the bare specifier P binds it. */
  root: boolean;
  /** Last-segment names (base names, index parent dirs). */
  segs: Set<string>;
  /** Whole subpaths, extension-stripped, without leading `/`. */
  paths: Set<string>;
}

/** Dumb normalization of a package-relative path for exports-map comparison. */
function normEntryPath(p: string): string {
  let n = stripPathExt(p.replace(/^\.\//, ''));
  while (/^(?:dist|lib|build|out|src|esm|cjs|types|es)\//.test(n)) n = n.slice(n.indexOf('/') + 1);
  return n.replace(/(?:^|\/)index$/, '');
}

function exportLeaves(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => exportLeaves(x, out));
  else if (v !== null && typeof v === 'object') Object.values(v).forEach((x) => exportLeaves(x, out));
}

/** Normalized target and entry path name the same file (the exports-map comparison). */
function sameEntry(target: string, want: string): boolean {
  const n = normEntryPath(target);
  return n === want || n.endsWith(`/${want}`) || (n !== '' && want.endsWith(`/${n}`));
}

/**
 * Whether package-relative `rel` is P's root entry (what the bare specifier P loads):
 * a `main` / `module` / `types` / `typings` target or an `exports['.']` leaf (a string,
 * array or conditions-object `exports` is all `.`); with none declared, an index file
 * (`index.*`, `src/index.*`). `manifest` undefined (unreadable): true, fail closed.
 */
function isRootEntry(rel: string, manifest: Record<string, unknown> | undefined): boolean {
  if (manifest === undefined) return true;
  const leaves: string[] = [];
  for (const k of ['main', 'module', 'types', 'typings']) if (typeof manifest[k] === 'string') leaves.push(manifest[k]);
  const ex = manifest['exports'];
  if (ex !== null && typeof ex === 'object' && !Array.isArray(ex) && Object.keys(ex).some((k) => k.startsWith('.'))) {
    exportLeaves((ex as Record<string, unknown>)['.'], leaves);
  } else {
    exportLeaves(ex, leaves);
  }
  const want = normEntryPath(rel);
  if (leaves.length === 0) return want === ''; // index.ts, src/index.ts (as manifests' fallback)
  return leaves.some((l) => sameEntry(l, want));
}

/**
 * Add the subpaths that bind a `default` defined in / exported from repo-relative
 * `file` of P (package dir `pkgPath`, P's parsed package.json `manifest` or undefined).
 */
function addDefaultTargets(t: DefaultTargets, file: string, pkgPath: string | null, manifest: Record<string, unknown> | undefined): void {
  const base = stripExt(file);
  t.segs.add(base);
  const isIndex = base === 'index';
  if (isIndex) {
    const parent = basename(dirname(file));
    if (parent && parent !== '.') t.segs.add(parent);
  }
  if (pkgPath === null) {
    t.root = true; // P's location unknown: fail closed
    return;
  }
  const rel = pkgPath === '.' ? file : file.startsWith(`${pkgPath}/`) ? file.slice(pkgPath.length + 1) : null;
  if (rel === null) {
    t.root = true;
    return;
  }
  if (isRootEntry(rel, manifest)) t.root = true;
  const exportsMap = manifest?.['exports'];
  const noSrc = stripPathExt(rel.replace(/^src\//, ''));
  t.paths.add(noSrc);
  if (isIndex) t.paths.add(noSrc.replace(/(?:^|\/)index$/, ''));
  if (exportsMap === null || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) return;
  const want = normEntryPath(rel);
  for (const [key, value] of Object.entries(exportsMap as Record<string, unknown>)) {
    if (!key.startsWith('.')) continue; // a conditions object, not a subpath map
    const k = key.replace(/^\.\/?/, '');
    const leaves: string[] = [];
    exportLeaves(value, leaves);
    if (k.includes('*')) {
      // Pattern key: a target pattern matching F gives the `*` value to substitute.
      for (const l of leaves) {
        if (!l.includes('*')) continue;
        const re = new RegExp(`^(?:.*/)?${normEntryPath(l).split('*').map(escapeRe).join('(.+)')}$`);
        const m = re.exec(want);
        if (m?.[1] !== undefined) t.paths.add(stripPathExt(k.replaceAll('*', m[1])));
      }
      continue;
    }
    if (leaves.some((l) => sameEntry(l, want))) t.paths.add(stripPathExt(k));
  }
}

/** Directive lines never counted for the `self` consumer (P naming S in its own export/part directives). */
const SELF_DIRECTIVE_LINE_RES: Record<'npm' | 'pub', RegExp[]> = {
  pub: [/^\s*(?:export|part)\b/, /^\s*(?:show|hide)\b/, /^\s*import\s+['"].*\b(?:show|hide)\b/],
  npm: [/^\s*export\b.*\bfrom\s*['"]/],
};

/** Text right before a literal that makes it a module specifier (import/export … from, require(, import(, Dart part). */
const SPECIFIER_BEFORE_RE = /(?:\bfrom|\bimport|\bexport|\bpart(?:\s+of)?|\brequire\s*\(|\bimport\s*\(|\bmodule)\s*$/;
/**
 * A literal's raw content (interpolations kept) shaped like generated import/export code.
 * The module after `from` may be quoted or computed: a `${…}` interpolation,
 * `JSON.stringify(…)`, a variable or a concatenation (unctx:
 * `` `import { ${x} as __x } from ${JSON.stringify(m)};` ``).
 */
const CODEGEN_CONTENT_RES = [
  /\b(?:import|export)\s*(?:type\s+)?[{*\w$][\s\S]*?\bfrom\s*(?:['"`]|\$\{|JSON\.stringify|[A-Za-z_$])/, // import { a } from "…" / from ${m} / export * from "…"
  /\b(?:import|export)\s+['"][^'"\n]+['"]/, // import 'package:x/y.dart' (Dart) / side-effect import
  /\brequire\s*\(\s*['"]/, // require("…")
  /\bimport\s*\(\s*['"]/, // import("…")
];
/** An AST builder for an import/export declaration (babel `importDeclaration(`, TS `factory.createImportDeclaration(`). */
const BUILDER_RE = /\w*(?:Import|Export|import|export)\w*Declaration\s*\(/g;

/** Callees whose string arguments are messages for people, not code (last name of the chain). */
const MESSAGE_CALLEES: ReadonlySet<string> = new Set(['deprecated', 'deprecate', 'warn', 'warning']);
/** Objects whose method arguments are messages (`console.warn(…)`, `this.logger.info(…)`). */
const MESSAGE_OBJECTS: ReadonlySet<string> = new Set(['console', 'logger']);
/** A literal that opens like a warning (`[deprecated] …`, `Deprecated: …`, `Warning: …`). */
const MESSAGE_PREFIX_RE = /^\s*(?:\[(?:deprecated|deprecation|warn|warning)\]|(?:deprecated|deprecation|warning)\s*:)/i;

/**
 * Whether the literal at `start` is a message for people: its content opens like a
 * warning (MESSAGE_PREFIX_RE), or it is an argument (possibly inside an object or array
 * argument) of a call to `deprecated` / `deprecate` / `warn` / `warning` (the last name
 * of the callee chain) or to a `console.*` / `logger.*` method. `skeleton` is the file
 * with comments and every literal's content blanked (same offsets), so the backward
 * bracket walk sees code only. A block body (`{` after `)` or `=>`), a `;` at depth 0 or
 * 2000 characters end the walk: the literal is a statement's, not an argument. clerk-auth's
 * `deprecated('@hono/clerk-auth', 'Use … - import { clerkMiddleware } from
 * "@hono/clerk-auth" …')` shows the import it deprecates; it generates no code.
 */
function isMessageLiteral(skeleton: string, start: number, content: string): boolean {
  if (MESSAGE_PREFIX_RE.test(content)) return true;
  let depth = 0;
  for (let i = start - 1; i >= Math.max(0, start - 2000); i -= 1) { // (bounded: files without `;`)
    const c = skeleton[i]!;
    if (c === ')' || c === ']' || c === '}') {
      depth += 1;
    } else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      const before = skeleton.slice(Math.max(0, i - 200), i);
      if (c === '{' && /(?:\)|=>)\s*$/.test(before)) return false; // a block body
      if (c !== '(') continue; // an object / array argument: look further out
      const m = /([\w$.]+)\s*$/.exec(before);
      if (!m) return false;
      const parts = m[1]!.split('.');
      return MESSAGE_CALLEES.has(parts.at(-1)!) || parts.slice(0, -1).some((p) => MESSAGE_OBJECTS.has(p));
    } else if (c === ';' && depth === 0) {
      return false;
    }
  }
  return false;
}

/**
 * Whether a literal is codegen-shaped, and the region that is "generated code": the
 * literal itself for a code template (raw content matches CODEGEN_CONTENT_RES), or the
 * text from the nearest AST-builder call opening within the 300 characters before it
 * to the end of the literal. null otherwise.
 */
function codegenRegion(text: string, start: number, length: number, raw: string): { start: number; end: number } | null {
  if (CODEGEN_CONTENT_RES.some((re) => re.test(raw))) return { start, end: start + length };
  const from = Math.max(0, start - 300);
  const window = text.slice(from, start);
  let last = -1;
  BUILDER_RE.lastIndex = 0;
  for (let m = BUILDER_RE.exec(window); m; m = BUILDER_RE.exec(window)) last = m.index;
  return last === -1 ? null : { start: from + last, end: start + length };
}

interface Hit {
  consumer: string;
  /** Repo-relative POSIX path, or null when the checkout is missing. */
  file: string | null;
  line: number;
}

interface ConsumerLoc {
  repoDir: string;
  /** Package dir, repo-relative POSIX; '.' for the root. */
  pkgPath: string;
  /** Test/docs globs are matched against paths relative to this dir ('.' = repo-relative). */
  globBase: string;
  /** Other org package dirs in the same repo (repo-relative); those nested under pkgPath are skipped. */
  nestedPaths: Set<string>;
}

interface PendingRow {
  symbol_id: number;
  reasons: string;
  blocked_by: string;
  name: string;
  file: string;
  /** 0-based definition line (symbols.line), or null. */
  line: number | null;
  package_id: string;
  manager: 'npm' | 'pub';
  pkg_name: string;
}

/** What to search for one pending symbol. */
interface SearchPlan {
  /** Identifier names (declared name + export aliases; never `default` for npm). */
  names: string[];
  /** Default-import targets, or null when S is not a default export (or pub). */
  defaults: DefaultTargets | null;
  /**
   * npm: the specifiers of P that reach S by name (every symbol_exports entry of S, same
   * matching as defaults): a file importing P only through other entries does not vouch
   * for S. Empty targets (S has no symbol_exports row) are never reached. null (pub):
   * any import of P vouches (Dart imports `package:P/src/…` directly).
   */
  entries: DefaultTargets | null;
}

/** The `/subpath` (or undefined for the bare specifier) of every module specifier of P in `text`. */
function specifiersOf(text: string, manager: 'npm' | 'pub', name: string): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  for (const re of mentionRegexes(manager, name)) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]);
  }
  return out;
}

/** Whether a specifier subpath of P (undefined = bare) binds an entry of `t` (header: default-import rule). */
function subpathMatches(t: DefaultTargets, sub: string | undefined): boolean {
  if (sub === undefined) return t.root;
  const segs = sub.split('/').filter(Boolean);
  const seg = stripExt(segs.at(-1) ?? '');
  const whole = segs.join('/');
  return seg === '' || t.segs.has(seg) || t.paths.has(whole) || t.paths.has(stripPathExt(whole));
}

/** Offsets where each line starts (for many offset -> line lookups). */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

/** 1-based line of `index` given lineStarts. */
function lineOf(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function policyBool(db: DatabaseSync, key: string): boolean {
  const row = db.prepare("SELECT json_extract(value, '$') AS v FROM policy WHERE key = ?").get(key) as
    | { v: unknown }
    | undefined;
  return row?.v === 1 || row?.v === true;
}

/** Run the text witness over every witness_pending finding, in one transaction. */
export function runWitness(opts: RunWitnessOptions): WitnessCounts {
  const { db, discover, log } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  requireAnalyzed(db, 'witness');

  const locs = new Map<string, ConsumerLoc>();
  /** Ignored-manifest consumers by resolved package id; `anyPackage` = deps unknown. */
  const ignoredConsumers = new Map<string, Set<string>>();
  const ignoredAnyPackage: string[] = [];
  for (const r of discover.repos) {
    for (const p of r.packages) {
      locs.set(p.packageId, {
        repoDir: r.localPath,
        pkgPath: p.path,
        globBase: '.',
        nestedPaths: new Set(r.packages.filter((q) => q.packageId !== p.packageId).map((q) => q.path)),
      });
    }
    for (const m of r.ignoredManifests ?? []) {
      const key = `ignored:${r.repo}/${m.manifest}`;
      locs.set(key, {
        repoDir: r.localPath,
        pkgPath: m.path,
        globBase: m.path,
        // Org packages nested under the ignored dir are indexed consumers in their own right.
        nestedPaths: new Set(r.packages.map((q) => q.path).filter((q) => q !== m.path)),
      });
      if (m.depsUnknown === true) ignoredAnyPackage.push(key);
      for (const d of m.deps) {
        if (d.resolvedPackageId === null) continue;
        let set = ignoredConsumers.get(d.resolvedPackageId);
        if (!set) ignoredConsumers.set(d.resolvedPackageId, (set = new Set()));
        set.add(key);
      }
    }
  }

  const countTests = policyBool(db, 'countTestsAsConsumers');
  const countDocs = policyBool(db, 'countDocsAsConsumers');
  const excluded = (relFile: string, globBase: string, withTests: boolean): boolean => {
    const f = globBase === '.' ? relFile : relFile.slice(globBase.length + 1);
    return (!countTests && !withTests && TEST_GLOBS.some((g) => matchGlob(g, f))) ||
      (!countDocs && DOCS_GLOBS.some((g) => matchGlob(g, f)));
  };

  /**
   * Candidate code files of a consumer (repo-relative), or null if its checkout is
   * missing. The repo's files come from discover's listFiles (git ls-files in a
   * checkout, so ignored build output is skipped but a real package named `build` is
   * not), restricted to the consumer's dir minus org packages nested under it.
   * `withTests`: keep test files even when countTestsAsConsumers is off (dev-only dep).
   */
  const repoFileCache = new Map<string, string[]>();
  const fileCache = new Map<string, string[] | null>();
  const under = (file: string, dir: string): boolean => dir === '.' || file.startsWith(`${dir}/`);
  const consumerFiles = (consumer: string, withTests = false): string[] | null => {
    const cacheKey = `${consumer}\0${withTests ? 1 : 0}`;
    if (fileCache.has(cacheKey)) return fileCache.get(cacheKey)!;
    const loc = locs.get(consumer);
    let files: string[] | null = null;
    if (loc) {
      const root = loc.pkgPath === '.' ? loc.repoDir : join(loc.repoDir, loc.pkgPath);
      if (existsSync(root) && statSync(root).isDirectory()) {
        let all = repoFileCache.get(loc.repoDir);
        if (!all) repoFileCache.set(loc.repoDir, (all = listFiles(loc.repoDir)));
        const nested = [...loc.nestedPaths].filter((q) => q !== loc.pkgPath && q !== '.' && under(q, loc.pkgPath));
        files = all
          .filter((f) => under(f, loc.pkgPath) && !nested.some((q) => under(f, q)))
          .filter((f) => CODE_EXTS.has(extname(f)) && !excluded(f, loc.globBase, withTests))
          .sort(cmp);
      }
    }
    fileCache.set(cacheKey, files);
    return files;
  };

  const textCache = new Map<string, string>();
  const readText = (consumer: string, rel: string): string => {
    const key = `${consumer}\0${rel}`;
    let t = textCache.get(key);
    if (t === undefined) {
      t = readFileSync(join(locs.get(consumer)!.repoDir, rel), 'utf8');
      textCache.set(key, t);
    }
    return t;
  };

  /**
   * readText with comments blanked (blankComments) and every string literal that is not
   * a module specifier blanked too, for P's own files scanned as the `self` consumer: an
   * import of P written inside a code template (`` `import { X } from 'P'` ``) is
   * generated code (the self codegen step's business), not an import by this file.
   */
  const codeCache = new Map<string, string>();
  const readCode = (consumer: string, rel: string): string => {
    const key = `${consumer}\0${rel}`;
    let t = codeCache.get(key);
    if (t === undefined) {
      const dart = extname(rel) === '.dart';
      const code = blankComments(readText(consumer, rel), dart);
      // Linear rebuild (a slice-and-concat per literal was quadratic: 10 s on Workiva).
      const parts: string[] = [];
      let at = 0;
      for (const lit of stringLiterals(code, dart)) {
        if (SPECIFIER_BEFORE_RE.test(code.slice(Math.max(0, lit.start - 40), lit.start))) continue;
        parts.push(code.slice(at, lit.start), lit.text.replace(/[^\n]/g, ' '));
        at = lit.start + lit.text.length;
      }
      parts.push(code.slice(at));
      t = parts.join('');
      codeCache.set(key, t);
    }
    return t;
  };

  /** Files of C mentioning P (keyed C\0P\0withTests\0code). */
  const mentionCache = new Map<string, string[]>();
  const mentioning = (
    consumer: string, files: string[], manager: 'npm' | 'pub', pkgName: string, withTests: boolean, read = readText,
  ): string[] => {
    const key = `${consumer}\0${manager}:${pkgName}\0${withTests ? 1 : 0}\0${read === readCode ? 1 : 0}`;
    let out = mentionCache.get(key);
    if (!out) {
      const res = mentionRegexes(manager, pkgName);
      out = files.filter((f) => {
        const text = read(consumer, f);
        return res.some((re) => {
          re.lastIndex = 0;
          return re.test(text);
        });
      });
      mentionCache.set(key, out);
    }
    return out;
  };

  /** Lines (1-based) of `text` naming any of `names` as a whole identifier. */
  const nameLines = (text: string, names: readonly string[]): number[] => {
    if (names.length === 0) return [];
    // `$` is an identifier char on the right; on the left only \w blocks a match, so a
    // Dart `'$name'` interpolation (and a JS `$name`, a harmless false positive) still hits.
    const lineRe = new RegExp(`(?<!\\w)(?:${names.map(escapeRe).join('|')})(?![\\w$])`);
    const out: number[] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) if (lineRe.test(lines[i]!)) out.push(i + 1);
    return out;
  };

  /** Indexed documents of a package (repo-relative files), per package. */
  const docsOf = db.prepare('SELECT file FROM documents WHERE package_id = ?');
  const indexedCache = new Map<string, Set<string>>();
  const indexedFiles = (packageId: string): Set<string> => {
    let out = indexedCache.get(packageId);
    if (!out) indexedCache.set(packageId, (out = new Set((docsOf.all(packageId) as Array<{ file: string }>).map((r) => r.file))));
    return out;
  };
  /**
   * Generated files of P (documents.is_generated, or a GENERATED_GLOBS path for files
   * the indexer never saw): never self-scanned. capnp-es generated files carry
   * `displayName: "X"` strings and import the package by name.
   */
  const generatedOf = db.prepare('SELECT file FROM documents WHERE package_id = ? AND is_generated = 1');
  const generatedCache = new Map<string, Set<string>>();
  const isGenerated = (packageId: string, file: string): boolean => {
    let set = generatedCache.get(packageId);
    if (!set) generatedCache.set(packageId, (set = new Set((generatedOf.all(packageId) as Array<{ file: string }>).map((r) => r.file))));
    return set.has(file) || GENERATED_GLOBS.some((g) => matchGlob(g, file));
  };

  /** readText with comments blanked (lines and offsets kept), per consumer file. */
  const noCommentCache = new Map<string, string>();
  const readNoComments = (consumer: string, rel: string): string => {
    const key = `${consumer}\0${rel}`;
    let t = noCommentCache.get(key);
    if (t === undefined) noCommentCache.set(key, (t = blankComments(readText(consumer, rel), extname(rel) === '.dart')));
    return t;
  };

  /**
   * SCIP occurrences in consumer C's file, by 0-based line: the names (symbols.name) and
   * symbol ids the indexer resolved there.
   */
  const occAt = db.prepare(`SELECT o.line, s.name, o.symbol_id FROM occurrences o JOIN symbols s ON s.symbol_id = o.symbol_id
    WHERE o.package_id = ? AND o.file = ? AND o.line IS NOT NULL`);
  const occCache = new Map<string, Map<number, Array<{ name: string; id: number }>>>();
  const occurrencesOf = (consumer: string, file: string): Map<number, Array<{ name: string; id: number }>> => {
    const key = `${consumer}\0${file}`;
    let m = occCache.get(key);
    if (!m) {
      m = new Map();
      for (const r of occAt.all(consumer, file) as Array<{ line: number; name: string; symbol_id: number }>) {
        let list = m.get(r.line);
        if (!list) m.set(r.line, (list = []));
        list.push({ name: r.name, id: r.symbol_id });
      }
      occCache.set(key, m);
    }
    return m;
  };

  /**
   * nameLines for a file that is an INDEXED document of consumer C: SCIP already
   * resolved its identifiers, so a match does not count when it is a member access
   * (preceded by `.`, `?.`, Dart `..`: `screen.findByTestId(…)` is
   * `ScreenQueries#findByTestId`, not the top-level `findByTestId`), or when SCIP has an
   * occurrence of a symbol with that name on that line and none of S itself (SCIP knows
   * what the identifier is). A name SCIP has nothing for still counts.
   */
  const indexedNameLines = (consumer: string, file: string, text: string, names: readonly string[], symbolId: number): number[] => {
    if (names.length === 0) return [];
    const re = new RegExp(`(?<!\\w)(?:${names.map(escapeRe).join('|')})(?![\\w$])`, 'g');
    const starts = lineStarts(text);
    const occ = occurrencesOf(consumer, file);
    const out = new Set<number>();
    for (let m = re.exec(text); m; m = re.exec(text)) {
      // Member access (`.x`, `?.x`, Dart `..x`), not a spread (`...x`).
      if (/(?:^|[^.])\.{1,2}\s*$/.test(text.slice(Math.max(0, m.index - 80), m.index))) continue;
      const line = lineOf(starts, m.index);
      const here = (occ.get(line - 1) ?? []).filter((o) => o.name === m![0]);
      if (here.length > 0 && !here.some((o) => o.id === symbolId)) continue; // SCIP resolved it elsewhere
      out.add(line);
    }
    return [...out].sort((a, b) => a - b);
  };

  /**
   * Hits in consumer C (`label`: the consumer named in the reason; default C itself).
   * `label` 'self' (P scanned as its own consumer) reads the files with comments
   * blanked (a JSDoc `@example import { S } from 'P'` on S itself is not a use), scans
   * only P's files that are NOT indexed documents of P (the point of the step: files
   * outside the program; an indexed Dart `lib/` file routinely imports/exports
   * `package:P/src/…` and the indexer already saw it), and ignores directive lines
   * (SELF_DIRECTIVE_LINE_RES: `export '…' show S`, `part`, a re-export `export … from`).
   */
  const findHits = (row: PendingRow, plan: SearchPlan, consumer: string, withTests = false, label = consumer): Hit[] => {
    let files = consumerFiles(consumer, withTests);
    if (files === null) return [{ consumer: label, file: null, line: 0 }];
    const self = label === 'self';
    if (self) {
      const indexed = indexedFiles(consumer);
      files = files.filter((f) => !indexed.has(f) && !isGenerated(consumer, f));
    }
    const read = self ? readCode : readText;
    const indexed = self ? null : indexedFiles(consumer);
    const hits: Hit[] = [];
    for (const f of mentioning(consumer, files, row.manager, row.pkg_name, withTests, read)) {
      // Comments never count (a commented-out import or use is not code).
      const text = self ? readCode(consumer, f) : readNoComments(consumer, f);
      // Named hits only in a file importing P through a specifier that reaches S.
      const vouched = plan.entries === null
        || specifiersOf(text, row.manager, row.pkg_name).some((sub) => subpathMatches(plan.entries!, sub));
      let named = !vouched ? [] : indexed?.has(f) ? indexedNameLines(consumer, f, text, plan.names, row.symbol_id) : nameLines(text, plan.names);
      if (self) {
        const res = SELF_DIRECTIVE_LINE_RES[row.manager];
        const src = text.split(/\r?\n/);
        named = named.filter((l) => !res.some((re) => re.test(src[l - 1] ?? '')));
      }
      const lines = new Set<number>(named);
      if (plan.defaults) {
        const t = plan.defaults;
        for (const re of defaultRegexes(row.pkg_name)) {
          re.lastIndex = 0;
          for (let m = re.exec(text); m; m = re.exec(text)) {
            if (subpathMatches(t, m[1])) lines.add(lineAt(text, m.index));
          }
        }
      }
      for (const line of [...lines].sort((a, b) => a - b)) hits.push({ consumer: label, file: f, line });
    }
    return hits;
  };

  /** A literal found in one of P's own files (ownLiterals). */
  interface OwnLiteral {
    file: string;
    /** Offset of the literal's opening delimiter in the file. */
    start: number;
    /** Offset of the content (after the delimiter). */
    offset: number;
    /** Raw literal text, delimiters included. */
    text: string;
    /** Content: delimiters stripped, `${…}` blanked (same length). */
    content: string;
    /** The target of `import`/`export … from`/`require(`/`import(`/Dart `part`: never a quoted name. */
    specifier: boolean;
    /**
     * A message for people (isMessageLiteral: a deprecation / warning / log argument):
     * never codegen, never a self-string hit, whatever import text it quotes.
     */
    message: boolean;
    /** A code template (import-clause shape) or an AST-builder argument (codegenRegion). */
    codegen: { start: number; end: number } | null;
  }

  /**
   * String literals of P's own code files (same walk and test/docs rules, and only
   * P's own language: `.dart` for pub, JS/TS for npm, so a vendored `.js` bundle in a
   * pub package is not read; never a generated file), per package; null if P's
   * checkout is missing.
   */
  const literalCache = new Map<string, OwnLiteral[] | null>();
  const ownLiterals = (row: PendingRow): OwnLiteral[] | null => {
    let out = literalCache.get(row.package_id);
    if (out !== undefined) return out;
    const files = consumerFiles(row.package_id);
    const dart = row.manager === 'pub';
    out = files === null ? null : files.filter((f) => (extname(f) === '.dart') === dart && !isGenerated(row.package_id, f)).flatMap((f) => {
      const text = readText(row.package_id, f);
      const lits = stringLiterals(text, dart);
      // Comments and literal contents blanked (offsets kept): the message-call walk's view.
      const code = blankComments(text, dart);
      const parts: string[] = [];
      let at = 0;
      for (const lit of lits) {
        parts.push(code.slice(at, lit.start), lit.text.replace(/[^\n]/g, ' '));
        at = lit.start + lit.text.length;
      }
      parts.push(code.slice(at));
      const skeleton = parts.join('');
      return lits.map((lit): OwnLiteral => {
        const q = dart && (lit.text.startsWith("'''") || lit.text.startsWith('"""')) ? 3 : 1;
        const close = lit.text.length >= 2 * q && lit.text.endsWith(lit.text.slice(0, q)) ? q : 0;
        const raw = lit.text.slice(q, lit.text.length - close);
        const content = blankInterpolations(raw);
        const specifier = SPECIFIER_BEFORE_RE.test(text.slice(Math.max(0, lit.start - 40), lit.start));
        const message = !specifier && isMessageLiteral(skeleton, lit.start, content);
        return {
          file: f, start: lit.start, offset: lit.start + q, text: lit.text, content, specifier, message,
          codegen: specifier || message ? null : codegenRegion(text, lit.start, lit.text.length, raw),
        };
      });
    });
    literalCache.set(row.package_id, out);
    return out;
  };

  /**
   * SELF (codegen) step: P's own literals that are code templates or AST-builder
   * arguments naming P (header). Only the names written INSIDE such a literal (or, for
   * an AST builder, inside the builder call up to the literal) are hits: another symbol
   * merely declared or used elsewhere in the same file is not generated code
   * (`ClerkAuthVariables` next to a template importing `@hono/clerk-auth`).
   */
  const selfHits = (row: PendingRow, plan: SearchPlan): Hit[] => {
    const lits = ownLiterals(row);
    if (lits === null) return [{ consumer: 'self', file: null, line: 0 }];
    if (plan.names.length === 0) return [];
    const p = escapeRe(row.pkg_name);
    // P as a whole specifier inside the literal: not part of a longer name (`@acme/lib-x`).
    const nameRe = row.manager === 'pub'
      ? new RegExp(`package:${p}(?![\\w])`)
      : new RegExp(`(?<![\\w@./-])${p}(?![\\w.-])`);
    const identRe = new RegExp(`(?<!\\w)(?:${plan.names.map(escapeRe).join('|')})(?![\\w$])`, 'g');
    const hits: Hit[] = [];
    for (const lit of lits) {
      if (lit.codegen === null || !nameRe.test(lit.text)) continue;
      const text = readText(row.package_id, lit.file);
      // A template: its content (interpolations blanked: they are code the indexer sees).
      // A builder call: the raw text from the call to the end of the literal.
      const region = lit.codegen.start === lit.start ? lit.content : text.slice(lit.codegen.start, lit.codegen.end);
      const base = lit.codegen.start === lit.start ? lit.offset : lit.codegen.start;
      identRe.lastIndex = 0;
      for (let m = identRe.exec(region); m; m = identRe.exec(region)) {
        hits.push({ consumer: 'self', file: lit.file, line: lineAt(text, base + m.index) });
      }
    }
    return hits;
  };

  /**
   * SELF-STRING step: a literal in P's own sources that quotes a name of S (header):
   * it holds the name in an import-clause shape (`{ N`, `N }`, `N as`, `as N`, `, N,`),
   * i.e. generated code naming S with a module path we cannot follow; or it holds the
   * name as a whole word (`"executeAsync"`, `mask: "getFloat32Mask"`, `"$.BoolList"`,
   * an auto-imports list) while SOME own file of P (non-test, non-generated) holds a
   * codegen-shaped literal: P builds import text, so any quoted name may end up in it
   * (capnp-es: the template in generators/struct.ts, the names in constants.ts). Without
   * one, `c.set('sentry', …)`, `name = 'MedleyRouter'` or a default title do not count.
   * Module specifiers and messages never count (`import { Enforcer } from 'casbin'` is
   * no mention of `casbin`), nor does S's own definition line (`component = 'component'`).
   */
  const selfStringHits = (row: PendingRow, plan: SearchPlan): Hit[] => {
    const lits = ownLiterals(row);
    if (lits === null) return [{ consumer: 'self-string', file: null, line: 0 }];
    const codegenPackage = lits.some((l) => l.codegen !== null);
    const hits: Hit[] = [];
    for (const name of plan.names) {
      const e = escapeRe(name);
      const clause = new RegExp(
        `\\{\\s*${e}(?![\\w$])|(?<![\\w$])${e}\\s*\\}|(?<![\\w$])${e}\\s+as\\b|\\bas\\s+${e}(?![\\w$])|,\\s*${e}\\s*,`,
      );
      const word = new RegExp(`(?<![\\w$])${e}(?![\\w$])`);
      for (const lit of lits) {
        if (lit.specifier || lit.message || !lit.content.includes(name)) continue;
        const m = clause.exec(lit.content) ?? (codegenPackage ? word.exec(lit.content) : null);
        const at = m ? m.index : -1;
        if (at < 0) continue;
        const line = lineAt(readText(row.package_id, lit.file), lit.offset + at);
        if (lit.file === row.file && row.line !== null && line === row.line + 1) continue;
        hits.push({ consumer: 'self-string', file: lit.file, line });
      }
    }
    return hits;
  };

  /** P's parsed package.json (undefined if unreadable or not an object), per package. */
  const manifestCache = new Map<string, Record<string, unknown> | undefined>();
  const manifestOf = (packageId: string): Record<string, unknown> | undefined => {
    if (manifestCache.has(packageId)) return manifestCache.get(packageId);
    let v: Record<string, unknown> | undefined;
    const loc = locs.get(packageId);
    if (loc) {
      try {
        const json: unknown = JSON.parse(readFileSync(join(loc.repoDir, loc.pkgPath, 'package.json'), 'utf8'));
        if (json !== null && typeof json === 'object' && !Array.isArray(json)) v = json as Record<string, unknown>;
      } catch {
        v = undefined;
      }
    }
    manifestCache.set(packageId, v);
    return v;
  };

  const aliasesOf = db.prepare(
    'SELECT DISTINCT entry_file, exported_as FROM symbol_exports WHERE symbol_id = ? ORDER BY entry_file, exported_as',
  );
  const planFor = (row: PendingRow): SearchPlan => {
    const aliases = aliasesOf.all(row.symbol_id) as Array<{ entry_file: string; exported_as: string }>;
    const all = [...new Set([row.name, ...aliases.map((a) => a.exported_as)])];
    if (row.manager !== 'npm') return { names: all, defaults: null, entries: null };
    const pkgPath = locs.get(row.package_id)?.pkgPath ?? null;
    const entries: DefaultTargets = { root: false, segs: new Set(), paths: new Set() };
    for (const f of new Set(aliases.map((a) => a.entry_file))) addDefaultTargets(entries, f, pkgPath, manifestOf(row.package_id));
    const defaultFiles = [
      ...(row.name === 'default' ? [row.file] : []),
      ...aliases.filter((a) => a.exported_as === 'default').map((a) => a.entry_file),
    ];
    let defaults: DefaultTargets | null = null;
    if (defaultFiles.length > 0) {
      defaults = { root: false, segs: new Set(), paths: new Set() };
      for (const f of new Set(defaultFiles)) addDefaultTargets(defaults, f, pkgPath, manifestOf(row.package_id));
    }
    return { names: all.filter((n) => n !== 'default'), defaults, entries };
  };

  const pending = db
    .prepare(
      `SELECT f.symbol_id, f.reasons, f.blocked_by, s.name, s.file, s.line, s.package_id,
              p.manager, p.name AS pkg_name
       FROM findings f
       JOIN symbols s ON s.symbol_id = f.symbol_id
       JOIN packages p ON p.package_id = s.package_id
       WHERE f.verdict = 'needs_review'
         AND EXISTS (SELECT 1 FROM json_each(f.reasons) WHERE value = 'witness_pending')
       ORDER BY f.symbol_id`,
    )
    .all() as unknown as PendingRow[];
  // dev = 1 when some dependency row of C on P is dev-only (same EXISTS rule as analyze.sql).
  const consumersOf = db.prepare(
    `SELECT consumer_package_id AS c, max(dev) AS dev FROM package_deps
     WHERE resolved_package_id = ? GROUP BY consumer_package_id ORDER BY consumer_package_id`,
  );
  /**
   * witness_files: unindexed script / docs / test files of a consumer C that import P
   * (ingest, scoped sidecar unindexedImports). Scanned like C's own files (the file
   * must import P; a name of S on any line is a hit; test/docs files only under the
   * same policy / dev-dependency rules), whether or not C declares P as a dependency.
   * A row with C = P (an own SFC importing own code relatively, or an own file importing
   * P by name, indexed or not) needs no import of P and is reported as consumer `self`.
   * Otherwise the import must reach an entry of S (entry vouching).
   */
  const witnessFilesOf = db.prepare(
    'SELECT consumer_package_id AS c, file FROM witness_files WHERE target_package_id = ? ORDER BY consumer_package_id, file',
  );
  const devOf = db.prepare('SELECT max(dev) AS dev FROM package_deps WHERE consumer_package_id = ? AND resolved_package_id = ?');
  const extraFileHits = (row: PendingRow, plan: SearchPlan): Hit[] => {
    const hits: Hit[] = [];
    for (const { c, file } of witnessFilesOf.all(row.package_id) as Array<{ c: string; file: string }>) {
      const loc = locs.get(c);
      if (!loc) {
        hits.push({ consumer: c, file: null, line: 0 });
        continue;
      }
      const dev = (devOf.get(c, row.package_id) as { dev: number | null } | undefined)?.dev === 1;
      if (excluded(file, loc.globBase, dev)) continue;
      let text: string;
      try {
        // Comments blanked in code files (not in `.vue` / `.svelte` / `.md`: their
        // markup is not JS, and a `//` in text would blank a real use).
        text = CODE_EXTS.has(extname(file)) ? readNoComments(c, file) : readText(c, file);
      } catch {
        hits.push({ consumer: c, file: null, line: 0 }); // listed but unreadable: fail closed
        continue;
      }
      // A self row (consumer = P: an own `.vue` / `.svelte` component importing an own
      // module relatively) names P's code without naming P: no import-of-P check.
      // Otherwise the file must import P through a specifier that reaches S.
      if (c !== row.package_id) {
        const subs = specifiersOf(text, row.manager, row.pkg_name);
        if (subs.length === 0) continue;
        if (plan.entries !== null && !subs.some((sub) => subpathMatches(plan.entries!, sub))) continue;
      }
      for (const line of nameLines(text, plan.names)) hits.push({ consumer: c === row.package_id ? 'self' : c, file, line });
    }
    return hits;
  };

  const del = db.prepare("DELETE FROM findings WHERE symbol_id = ? AND verdict = 'needs_review'");
  const insFinding = db.prepare('INSERT INTO findings (symbol_id, verdict, reasons, blocked_by) VALUES (?, ?, ?, ?)');
  const insOk = db.prepare('INSERT OR REPLACE INTO witness_ok (symbol_id, checked_at) VALUES (?, ?)');

  const counts: WitnessCounts = { checked: 0, passed: 0, mismatched: 0 };
  db.exec('BEGIN');
  try {
    for (const row of pending) {
      counts.checked += 1;
      const base = (JSON.parse(row.reasons) as string[]).filter((r) => r !== 'witness_pending');
      const consumers: Array<{ c: string; dev: boolean }> = [
        ...(consumersOf.all(row.package_id) as Array<{ c: string; dev: number }>).map((r) => ({ c: r.c, dev: r.dev === 1 })),
        ...[...new Set([...(ignoredConsumers.get(row.package_id) ?? []), ...ignoredAnyPackage])].map((c) => ({ c, dev: false })),
      ];
      const plan = planFor(row);
      const all = [
        ...consumers.flatMap(({ c, dev }) => findHits(row, plan, c, dev)),
        ...extraFileHits(row, plan),
        // P is its own consumer for own files that import it BY NAME (unindexed files
        // outside the tsconfig program, e.g. codeup's `actions/*.ts` importing "codeup").
        // The definition line itself is not a use (a Dart file routinely imports its own
        // package by name, and so names S where it declares it).
        ...findHits(row, plan, row.package_id, false, 'self')
          .filter((h) => !(h.file === row.file && row.line !== null && h.line === row.line + 1)),
        ...selfHits(row, plan),
        ...selfStringHits(row, plan),
      ];
      // One reason per position; the self steps share a key (a codegen template naming S
      // is both a `self` and a `self-string` hit: the first, `self`, is kept).
      const seen = new Set<string>();
      const hits = all.filter((h) => {
        const k = `${h.consumer.startsWith('self') ? 'self' : h.consumer}\0${h.file ?? ''}\0${h.line}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      del.run(row.symbol_id);
      if (hits.length > 0) {
        hits.sort((a, b) => cmp(a.consumer, b.consumer) || cmp(a.file ?? '', b.file ?? '') || a.line - b.line);
        const reasons = hits
          .slice(0, MAX_HITS)
          .map((h) => `witness_mismatch:${h.consumer}:${h.file === null ? 'checkout missing' : `${h.file}:${h.line}`}`);
        insFinding.run(row.symbol_id, 'needs_review', JSON.stringify([...base, ...reasons]), row.blocked_by);
        counts.mismatched += 1;
        log(`[witness] mismatch ${row.package_id}#${row.name} (${row.file}): ${reasons.join(', ')}${hits.length > MAX_HITS ? ` (+${hits.length - MAX_HITS} more)` : ''}`);
      } else {
        insOk.run(row.symbol_id, now);
        insFinding.run(row.symbol_id, 'deletion_candidate', JSON.stringify(base), row.blocked_by);
        counts.passed += 1;
      }
    }
    // Propagate the outcomes (header): current views, dead islands, private_dead cascade.
    db.exec(analyzeSql());
    const reverted = reconcileDeadIslands(db);
    if (reverted > 0) log(`[witness] ${reverted} dead island(s) reverted to unexport_candidate (their users were downgraded)`);
    insertPrivateDead(db);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0) throw new Error(`sentei witness: foreign_key_check failed: ${JSON.stringify(fk.slice(0, 5))}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log(`[witness] checked ${counts.checked}: ${counts.passed} passed, ${counts.mismatched} mismatched`);
  return counts;
}
