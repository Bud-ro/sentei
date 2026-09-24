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
// Plus the SELF step: P's own files (same walk and test/docs rules) that generate
// import statements of P at build time. A file qualifies when one of its string
// literals is a CODE TEMPLATE naming P: the literal contains P's package name (`P`,
// `P/…`; pub `package:P/…`) and one of the words import / require / from / export
// (e.g. `` `import { X } from 'honox/vite/components'` ``). Literals come
// from a loose scanner (stringLiterals: comments skipped, so JSDoc code fences do not
// count; '…' / "…" single-line; backtick templates span lines, `${…}` skipped by brace
// counting; pub: also '''…''' / """…""").
// Also a literal naming P passed to an AST builder: `*ImportDeclaration(` /
// `*ExportDeclaration(` (babel `importDeclaration`, TS `factory.createImportDeclaration`)
// opening within the 300 characters before it (honox's
// `importDeclaration([…HonoXIsland…], stringLiteral('honox/vite/components'))`).
// A plain `name: '@acme/x/bun'` or a deprecation message does not qualify; a real
// `import … from 'P'` does not either (the literal `'P'` has no keyword). In a
// qualifying file, a line naming S (any name) is a hit, consumer `self`.
// P is also its OWN consumer: P's own files (same walk and rules) that import P by its
// package name are scanned like any consumer's (step 1 + 2), with consumer `self`. Such
// files are usually outside the tsconfig program (codeup's `actions/*.ts` doing
// `import { defineAction } from "codeup"`), so the indexer never saw the use. Own files
// importing only relatively do not mention P and are unaffected (they are indexed).
// SELF-STRING step: any literal in P's own files (same walk and rules) whose content,
// with `${…}` interpolations blanked, IS a name of S (`helperName: "executeAsync"`,
// auto-import lists) or holds it in an import-clause shape (`{ N`, `N }`, `N as`,
// `as N`, `, N,`; e.g. `` `import { executeAsync as __x } from "${mod}"` ``) is a hit,
// consumer `self-string`: code we cannot follow may name S. `'executeAsyncMode'` is not.
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
//   - the bare specifier P (no subpath): matches every default of P;
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { requireAnalyzed } from './analyze.ts';
import { matchGlob } from './glob.ts';
import { DOCS_GLOBS, TEST_GLOBS } from './globs.ts';
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

/**
 * Add the subpaths that bind a `default` defined in / exported from repo-relative
 * `file` of P (package dir `pkgPath`, P's parsed package.json `exportsMap` or undefined).
 */
function addDefaultTargets(t: DefaultTargets, file: string, pkgPath: string | null, exportsMap: unknown): void {
  const base = stripExt(file);
  t.segs.add(base);
  const isIndex = base === 'index';
  if (isIndex) {
    const parent = basename(dirname(file));
    if (parent && parent !== '.') t.segs.add(parent);
  }
  if (pkgPath === null) return;
  const rel = pkgPath === '.' ? file : file.startsWith(`${pkgPath}/`) ? file.slice(pkgPath.length + 1) : null;
  if (rel === null) return;
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
    const hit = leaves.some((l) => {
      const n = normEntryPath(l);
      return n === want || n.endsWith(`/${want}`) || (n !== '' && want.endsWith(`/${n}`));
    });
    if (hit) t.paths.add(stripPathExt(k));
  }
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

  /** readText with comments blanked (blankComments), for P's own files. */
  const codeCache = new Map<string, string>();
  const readCode = (consumer: string, rel: string): string => {
    const key = `${consumer}\0${rel}`;
    let t = codeCache.get(key);
    if (t === undefined) {
      t = blankComments(readText(consumer, rel), extname(rel) === '.dart');
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

  /**
   * Hits in consumer C (`label`: the consumer named in the reason; default C itself).
   * `label` 'self' (P scanned as its own consumer) reads the files with comments
   * blanked: a JSDoc `@example import { S } from 'P'` on S itself is not a use.
   */
  const findHits = (row: PendingRow, plan: SearchPlan, consumer: string, withTests = false, label = consumer): Hit[] => {
    const files = consumerFiles(consumer, withTests);
    if (files === null) return [{ consumer: label, file: null, line: 0 }];
    const read = label === 'self' ? readCode : readText;
    const hits: Hit[] = [];
    for (const f of mentioning(consumer, files, row.manager, row.pkg_name, withTests, read)) {
      const text = read(consumer, f);
      const lines = new Set<number>(nameLines(text, plan.names));
      if (plan.defaults) {
        const t = plan.defaults;
        for (const re of defaultRegexes(row.pkg_name)) {
          re.lastIndex = 0;
          for (let m = re.exec(text); m; m = re.exec(text)) {
            const sub = m[1];
            const segs = sub === undefined ? [] : sub.split('/').filter(Boolean);
            const seg = sub === undefined ? undefined : stripExt(segs.at(-1) ?? '');
            const whole = segs.join('/');
            if (sub === undefined || seg === '' || t.segs.has(seg!) || t.paths.has(whole) || t.paths.has(stripPathExt(whole))
) {
              lines.add(lineAt(text, m.index));
            }
          }
        }
      }
      for (const line of [...lines].sort((a, b) => a - b)) hits.push({ consumer: label, file: f, line });
    }
    return hits;
  };

  /** P's own files holding a code template (or AST-builder literal) naming P (header), per package; null if P's checkout is missing. */
  const selfCache = new Map<string, string[] | null>();
  const selfGenFiles = (row: PendingRow): string[] | null => {
    let out = selfCache.get(row.package_id);
    if (out !== undefined) return out;
    const files = consumerFiles(row.package_id);
    if (files === null) {
      out = null;
    } else {
      const p = escapeRe(row.pkg_name);
      // P as a whole specifier inside the literal: not part of a longer name (`@acme/lib-x`).
      const nameRe = row.manager === 'pub'
        ? new RegExp(`package:${p}(?![\\w])`)
        : new RegExp(`(?<![\\w@./-])${p}(?![\\w.-])`);
      const keywordRe = /\b(?:import|require|from|export)\b/;
      const builderRe = /\w*(?:Import|Export|import|export)\w*Declaration\s*\(/;
      const qualifies = (text: string): boolean => {
        for (const lit of stringLiterals(text, row.manager === 'pub')) {
          if (!nameRe.test(lit.text)) continue;
          if (keywordRe.test(lit.text)) return true;
          if (builderRe.test(text.slice(Math.max(0, lit.start - 300), lit.start))) return true;
        }
        return false;
      };
      out = files.filter((f) => qualifies(readText(row.package_id, f)));
    }
    selfCache.set(row.package_id, out);
    return out;
  };

  const selfHits = (row: PendingRow, plan: SearchPlan): Hit[] => {
    const files = selfGenFiles(row);
    if (files === null) return [{ consumer: 'self', file: null, line: 0 }];
    return files.flatMap((f) => nameLines(readText(row.package_id, f), plan.names).map((line) => ({ consumer: 'self', file: f, line })));
  };

  /**
   * String literals of P's own files (same walk and test/docs rules), per package, with
   * their content: delimiters stripped and every `${…}` interpolation blanked to spaces
   * (same length, so offsets still map to lines; an interpolation is code the indexer
   * sees, not a quoted name). null if P's checkout is missing.
   */
  const literalCache = new Map<string, Array<{ file: string; offset: number; content: string }> | null>();
  const ownLiterals = (row: PendingRow): Array<{ file: string; offset: number; content: string }> | null => {
    let out = literalCache.get(row.package_id);
    if (out !== undefined) return out;
    const files = consumerFiles(row.package_id);
    out = files === null ? null : files.flatMap((f) => {
      const dart = row.manager === 'pub';
      return stringLiterals(readText(row.package_id, f), dart).map((lit) => {
        const q = dart && (lit.text.startsWith("'''") || lit.text.startsWith('"""')) ? 3 : 1;
        const close = lit.text.length >= 2 * q && lit.text.endsWith(lit.text.slice(0, q)) ? q : 0;
        return { file: f, offset: lit.start + q, content: blankInterpolations(lit.text.slice(q, lit.text.length - close)) };
      });
    });
    literalCache.set(row.package_id, out);
    return out;
  };

  /**
   * SELF-STRING step: a literal in P's own sources that quotes a name of S (header):
   * its content IS the name (`helperName: "executeAsync"`, an auto-import list), or it
   * holds the name in an import-clause shape (`{ N`, `N }`, `N as`, `as N`, `, N,`),
   * i.e. generated code naming S with a module path we cannot follow.
   */
  const selfStringHits = (row: PendingRow, plan: SearchPlan): Hit[] => {
    const lits = ownLiterals(row);
    if (lits === null) return [{ consumer: 'self-string', file: null, line: 0 }];
    const hits: Hit[] = [];
    for (const name of plan.names) {
      const e = escapeRe(name);
      const clause = new RegExp(
        `\\{\\s*${e}(?![\\w$])|(?<![\\w$])${e}\\s*\\}|(?<![\\w$])${e}\\s+as\\b|\\bas\\s+${e}(?![\\w$])|,\\s*${e}\\s*,`,
      );
      for (const lit of lits) {
        if (!lit.content.includes(name)) continue;
        let at = -1;
        if (lit.content === name) at = 0;
        else {
          const m = clause.exec(lit.content);
          if (m) at = m.index;
        }
        if (at >= 0) hits.push({ consumer: 'self-string', file: lit.file, line: lineAt(readText(row.package_id, lit.file), lit.offset + at) });
      }
    }
    return hits;
  };

  /** P's package.json `exports` (undefined if absent/unreadable), per package. */
  const exportsMapCache = new Map<string, unknown>();
  const exportsMapOf = (packageId: string): unknown => {
    if (exportsMapCache.has(packageId)) return exportsMapCache.get(packageId);
    let v: unknown;
    const loc = locs.get(packageId);
    if (loc) {
      try {
        const json = JSON.parse(readFileSync(join(loc.repoDir, loc.pkgPath, 'package.json'), 'utf8')) as Record<string, unknown>;
        v = json['exports'];
      } catch {
        v = undefined;
      }
    }
    exportsMapCache.set(packageId, v);
    return v;
  };

  const aliasesOf = db.prepare(
    'SELECT DISTINCT entry_file, exported_as FROM symbol_exports WHERE symbol_id = ? ORDER BY entry_file, exported_as',
  );
  const planFor = (row: PendingRow): SearchPlan => {
    const aliases = aliasesOf.all(row.symbol_id) as Array<{ entry_file: string; exported_as: string }>;
    const all = [...new Set([row.name, ...aliases.map((a) => a.exported_as)])];
    if (row.manager !== 'npm') return { names: all, defaults: null };
    const defaultFiles = [
      ...(row.name === 'default' ? [row.file] : []),
      ...aliases.filter((a) => a.exported_as === 'default').map((a) => a.entry_file),
    ];
    let defaults: DefaultTargets | null = null;
    if (defaultFiles.length > 0) {
      defaults = { segs: new Set(), paths: new Set() };
      const pkgPath = locs.get(row.package_id)?.pkgPath ?? null;
      for (const f of new Set(defaultFiles)) addDefaultTargets(defaults, f, pkgPath, exportsMapOf(row.package_id));
    }
    return { names: all.filter((n) => n !== 'default'), defaults };
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
