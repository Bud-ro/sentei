// Consumer-side checks over a package's own source files (syntactic walk +
// checker symbol resolution; compiler diagnostic messages are never parsed).
//
// Why only resolution failures matter: the SCIP index links a reference to an
// org package's symbol only when TypeScript resolved it. A type error elsewhere
// (wrong argument type, missing property on a local object, ...) does not
// change which symbols a reference points at, so it cannot make an org symbol
// look unused. What can:
//   - an org module specifier that does not resolve: every reference through it
//     is silently dropped → `unresolvedOrgModules` (status partial, fail closed);
//   - a named import the org module does not export: the consumer names a
//     symbol that no longer exists (version skew) → `unresolvedImports`;
//   - a namespace import used as a value, or a computed require/import: the
//     accessed members are not statically known → `flags`.
// Plus two upstream gaps recorded as checker-resolved references (ingest
// dedupes them against SCIP occurrences): namespace member accesses
// (`namespaceMemberRefs`) and shorthand properties (`shorthandRefs`); and
// value uses of any namespace import of org code, relative ones included
// (`namespaceSpreadRefs`: `{..._pkg}` reads members nobody can list).
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as core from '@sentei/core';
import { DOCS_GLOBS, SCRIPT_GLOBS, TEST_GLOBS, matchGlob } from '@sentei/core';
import type {
  ConsumerFlag,
  ConsumerPolicy,
  NamespaceMemberRef,
  NamespaceSpreadRef,
  ShorthandRef,
  SourcePosition,
  UnindexedImport,
  UnresolvedImport,
} from './types.ts';

/** An org npm package and its checkout dir (realpath). */
export interface OrgPackageDir {
  name: string;
  dir: string;
}

export interface ConsumerCheckResult {
  /** Org module specifiers that did not resolve (fail closed: partial). */
  unresolvedOrgModules: Array<SourcePosition & { module: string }>;
  unresolvedImports: UnresolvedImport[];
  flags: ConsumerFlag[];
  namespaceMemberRefs: NamespaceMemberRef[];
  shorthandRefs: ShorthandRef[];
  namespaceSpreadRefs: NamespaceSpreadRef[];
}

/** Bare package name of a module specifier (`@a/b/c` → `@a/b`, `x/y` → `x`), or undefined if relative/absolute. */
export function barePackageName(spec: string): string | undefined {
  if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('node:')) {
    return undefined;
  }
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

export function checkConsumerFiles(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  orgPackageNames: ReadonlySet<string>,
  toRepoRel: (abs: string) => string,
  orgPackageDirs: readonly OrgPackageDir[] = [],
): ConsumerCheckResult {
  const result: ConsumerCheckResult = {
    unresolvedOrgModules: [],
    unresolvedImports: [],
    flags: [],
    namespaceMemberRefs: [],
    shorthandRefs: [],
    namespaceSpreadRefs: [],
  };
  // Longest dir first, so a nested package wins over its parent.
  const dirs = [...orgPackageDirs].sort((a, b) => b.dir.length - a.dir.length);
  for (const sf of files) checkFile(sf, checker, orgPackageNames, toRepoRel, result, dirs);
  return result;
}

function checkFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  orgNames: ReadonlySet<string>,
  toRepoRel: (abs: string) => string,
  out: ConsumerCheckResult,
  orgDirs: readonly OrgPackageDir[],
): void {
  const pos = (node: ts.Node): SourcePosition => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: toRepoRel(path.resolve(sf.fileName)), line, col: character };
  };
  const isOrg = (spec: string): boolean => {
    const name = barePackageName(spec);
    return name !== undefined && orgNames.has(name);
  };
  /** Checks an org module specifier resolves; returns false when it does not. */
  const checkModule = (lit: ts.StringLiteralLike): boolean => {
    if (!isOrg(lit.text)) return false;
    if (checker.getSymbolAtLocation(lit) === undefined) {
      out.unresolvedOrgModules.push({ module: lit.text, ...pos(lit) });
      return false;
    }
    return true;
  };
  const checkNamed = (module: string, local: ts.Identifier, imported: ts.ModuleExportName): void => {
    const sym = checker.getSymbolAtLocation(local);
    const target = sym !== undefined && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    if (target === undefined || (target.declarations ?? []).length === 0) {
      out.unresolvedImports.push({ module, name: imported.text, ...pos(imported) });
    }
  };

  // Namespace imports: the module symbol they alias → the org package the
  // specifier names (`hono/jsx` → `hono`; set only for a bare org specifier)
  // and the org file the module resolves to (set for any specifier, relative
  // ones included, whose module file is inside an org package checkout).
  const namespaceModules = new Map<ts.Symbol, NamespaceModule>();
  const namespaceNames = new Set<string>();
  const addNamespace = (bindings: ts.NamespaceImport, bareOrg: string | undefined): void => {
    const alias = checker.getSymbolAtLocation(bindings.name);
    if (alias === undefined) return;
    const mod = alias.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(alias) : alias;
    const file = moduleTarget(mod, orgDirs);
    if (bareOrg === undefined && file === undefined) return;
    namespaceModules.set(mod, { ...(bareOrg !== undefined ? { pkg: bareOrg } : {}), ...(file !== undefined ? { file } : {}) });
    namespaceNames.add(bindings.name.text);
  };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const module = stmt.moduleSpecifier.text;
      const bindings = stmt.importClause?.namedBindings;
      if (!checkModule(stmt.moduleSpecifier)) {
        // Not a resolvable org specifier: a relative namespace import of org code still counts.
        if (bindings !== undefined && ts.isNamespaceImport(bindings) && !isOrg(module)) addNamespace(bindings, undefined);
        continue;
      }
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) checkNamed(module, el.name, el.propertyName ?? el.name);
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        addNamespace(bindings, barePackageName(module)!);
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const module = stmt.moduleSpecifier.text;
      if (!checkModule(stmt.moduleSpecifier)) continue;
      if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const imported = el.propertyName ?? el.name;
          // For `export { a as b } from`, the symbol hangs off the exported name.
          const sym = checker.getSymbolAtLocation(el.name);
          const target = sym !== undefined && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
          if (target === undefined || (target.declarations ?? []).length === 0) {
            out.unresolvedImports.push({ module, name: imported.text, ...pos(imported) });
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      ts.isStringLiteral(stmt.moduleReference.expression)
    ) {
      checkModule(stmt.moduleReference.expression);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isRequireOrImport(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) {
        checkModule(arg);
      } else if (arg === undefined || !isExemptComputed(arg, checker)) {
        const what = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import()' : 'require()';
        out.flags.push({
          flag: 'dynamic_access',
          reason: `${what} with a non-literal specifier: ${truncate(arg?.getText(sf) ?? '(no argument)')}`,
          ...pos(node),
        });
      }
    } else if (
      (ts.isPropertyAccessExpression(node) ||
        (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))) &&
      ts.isIdentifier(node.expression) &&
      namespaceNames.has(node.expression.text) &&
      isNamespaceBinding(node.expression, checker, namespaceModules)
    ) {
      const member = ts.isPropertyAccessExpression(node) ? node.name : (node.argumentExpression as ts.StringLiteralLike);
      const ref = declTarget(checker.getSymbolAtLocation(member), checker, orgDirs, false);
      if (ref !== undefined) out.namespaceMemberRefs.push({ ...pos(member), member: member.text, ...ref });
    } else if (ts.isShorthandPropertyAssignment(node)) {
      // `{ grade }`: SCIP links only the contextual property, not the value.
      const ref = declTarget(checker.getShorthandAssignmentValueSymbol(node), checker, orgDirs, true);
      if (ref !== undefined) out.shorthandRefs.push({ ...pos(node.name), member: node.name.text, ...ref });
    }
    if (ts.isIdentifier(node) && namespaceNames.has(node.text)) {
      const use = namespaceValueUse(node, checker, namespaceModules, sf);
      if (use !== undefined) {
        // The namespace's module is known, so the flag blocks only that package.
        if (use.module.pkg !== undefined) {
          out.flags.push({ flag: 'namespace_dynamic', reason: use.reason, targetPackage: use.module.pkg, ...pos(node) });
        }
        if (use.module.file !== undefined) out.namespaceSpreadRefs.push({ ...pos(node), ...use.module.file });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
}

function isRequireOrImport(call: ts.CallExpression): boolean {
  return (
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === 'require')
  );
}

/**
 * Leading literal texts that can never name an org package: relative/absolute
 * paths and URL-ish specifiers (`data:` modules built at runtime, `node:`
 * builtins, `file:` / `http(s):` URLs).
 */
const EXEMPT_LEADS = ['./', '../', '/', 'data:', 'node:', 'file:', 'http:', 'https:'];

/**
 * A computed specifier whose leading literal text is exempt (see EXEMPT_LEADS):
 * a template literal, a `+` concatenation, or an identifier bound by `const` to
 * one of those (one hop, e.g. `const url = \`data:...${x}\`; import(url)`).
 */
function isExemptComputed(arg: ts.Expression, checker: ts.TypeChecker, hops = 1): boolean {
  while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
  let lead: string | undefined;
  if (ts.isTemplateExpression(arg)) {
    lead = arg.head.text;
  } else if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left: ts.Expression = arg;
    while (ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken) left = left.left;
    while (ts.isParenthesizedExpression(left)) left = left.expression;
    if (ts.isStringLiteralLike(left)) lead = left.text;
  } else if (ts.isIdentifier(arg) && hops > 0) {
    const decl = checker.getSymbolAtLocation(arg)?.valueDeclaration;
    if (
      decl !== undefined &&
      ts.isVariableDeclaration(decl) &&
      decl.initializer !== undefined &&
      ts.isVariableDeclarationList(decl.parent) &&
      (decl.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const init = decl.initializer;
      if (ts.isStringLiteralLike(init)) lead = init.text;
      else return isExemptComputed(init, checker, hops - 1);
    }
  }
  return lead !== undefined && EXEMPT_LEADS.some((p) => lead.startsWith(p));
}

/**
 * Why a reference to an org namespace-import binding is dynamic, or undefined
 * when it is a static member access, a type position, or the binding itself.
 */
function namespaceValueUse(
  id: ts.Identifier,
  checker: ts.TypeChecker,
  modules: ReadonlyMap<ts.Symbol, NamespaceModule>,
  sf: ts.SourceFile,
): { reason: string; module: NamespaceModule } | undefined {
  const parent = id.parent;
  if (ts.isNamespaceImport(parent)) return undefined; // the declaration
  // Is this identifier really the namespace binding?
  let sym: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    sym = checker.getShorthandAssignmentValueSymbol(parent);
  } else if (ts.isExportSpecifier(parent)) {
    sym = checker.getExportSpecifierLocalTargetSymbol(parent);
  } else {
    sym = checker.getSymbolAtLocation(id);
  }
  if (sym === undefined) return undefined;
  const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const module = modules.get(target);
  if (module === undefined) return undefined;

  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) return undefined;
  if (ts.isElementAccessExpression(parent) && parent.expression === id) {
    if (ts.isStringLiteralLike(parent.argumentExpression)) return undefined;
    return { reason: `namespace ${id.text} indexed with a computed key: ${truncate(parent.getText(sf))}`, module };
  }
  if (ts.isQualifiedName(parent) && parent.left === id) return undefined; // `X.Type`
  if (inTypePosition(id)) return undefined;
  return { reason: `namespace ${id.text} used as a value: ${truncate(parent.getText(sf))}`, module };
}

/** A namespace import's module, as far as it concerns org code. */
interface NamespaceModule {
  /** npm name of the org package a bare specifier names (the `namespace_dynamic` flag target). */
  pkg?: string;
  /** The module file inside an org package checkout (the `namespaceSpreadRefs` target). */
  file?: Pick<NamespaceSpreadRef, 'targetPackage' | 'targetFile'>;
}

/** The org package and package-relative file a module symbol's source file lives in, if any. */
function moduleTarget(mod: ts.Symbol, orgDirs: readonly OrgPackageDir[]): NamespaceModule['file'] {
  const sf = mod.declarations?.find(ts.isSourceFile);
  if (sf === undefined) return undefined;
  const owner = orgOwner(sf.fileName, orgDirs);
  return owner === undefined ? undefined : { targetPackage: owner.pkg.name, targetFile: owner.rel };
}

/**
 * The org package whose checkout holds `fileName` (realpath; longest dir first
 * in `orgDirs`) and the file relative to it, unless it sits in that package's
 * node_modules.
 */
function orgOwner(fileName: string, orgDirs: readonly OrgPackageDir[]): { pkg: OrgPackageDir; rel: string } | undefined {
  let real: string;
  try {
    real = realpathSync(fileName);
  } catch {
    return undefined;
  }
  const owner = orgDirs.find((o) => real === o.dir || real.startsWith(o.dir + path.sep));
  if (owner === undefined) return undefined;
  const rel = path.relative(owner.dir, real);
  if (rel.split(path.sep).includes('node_modules')) return undefined;
  return { pkg: owner, rel: rel.split(path.sep).join(path.posix.sep) };
}

/** True when `id` (the object of a member access) is a namespace-import binding of an org package named by a bare specifier. */
function isNamespaceBinding(id: ts.Identifier, checker: ts.TypeChecker, modules: ReadonlyMap<ts.Symbol, NamespaceModule>): boolean {
  const sym = checker.getSymbolAtLocation(id);
  if (sym === undefined) return false;
  return modules.get(sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym)?.pkg !== undefined;
}

/**
 * Resolves a symbol (aliases followed) to its first declaration inside an org
 * package checkout (not that package's node_modules), if any. With
 * `skipLocals`, a module (namespace) symbol and a declaration inside a function
 * or block (a `local N` symbol in SCIP) resolve to nothing.
 */
function declTarget(
  start: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  orgDirs: readonly OrgPackageDir[],
  skipLocals: boolean,
): Omit<NamespaceMemberRef, 'file' | 'line' | 'col' | 'member'> | undefined {
  let sym = start;
  for (let guard = 0; sym !== undefined && sym.flags & ts.SymbolFlags.Alias && guard < 100; guard++) {
    sym = checker.getAliasedSymbol(sym);
  }
  for (const decl of sym?.declarations ?? []) {
    if (skipLocals && (ts.isSourceFile(decl) || ts.isModuleDeclaration(decl) || isFunctionLocal(decl))) continue;
    // A top-level destructured binding (`export const { a } = f()`) is a `local N`
    // symbol in scip-typescript 0.4.0: a reference to it can never match.
    if (ts.isBindingElement(decl)) continue;
    const declSf = decl.getSourceFile();
    const owner = orgOwner(declSf.fileName, orgDirs);
    if (owner === undefined) continue;
    const nameNode = ts.getNameOfDeclaration(decl) ?? decl;
    const { line, character } = declSf.getLineAndCharacterOfPosition(nameNode.getStart(declSf));
    return {
      targetPackage: owner.pkg.name,
      targetFile: owner.rel,
      targetLine: line,
      targetCol: character,
    };
  }
  return undefined;
}

/** True when a declaration sits inside a function body, parameter list or block. */
function isFunctionLocal(decl: ts.Node): boolean {
  for (let n = decl.parent; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isBlock(n) || ts.isCatchClause(n) || ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) {
      return true;
    }
  }
  return false;
}

/** True when the node sits inside a type annotation / type query (not a value). */
function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent !== undefined; n = n.parent) {
    // Heritage clauses (`extends X`) are values even though they parse as ExpressionWithTypeArguments.
    if (ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)) {
      return n.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(n.parent.parent);
    }
    if (ts.isTypeNode(n)) return true;
    if (ts.isStatement(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

function truncate(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ---------------------------------------------------------------------------
// Consumer policy (tests / docs)
// ---------------------------------------------------------------------------

/**
 * True when a repo-relative POSIX file is a test or docs file that does not
 * count as a consumer under the policy. Uses the same TEST_GLOBS / DOCS_GLOBS
 * lists as the witness; a core test keeps those lists identical to the
 * test_files / doc_files views in packages/core/sql/analyze.sql, so references
 * from such files are ignored by analyze and nothing found there can hide a
 * counted use.
 */
export function isExcludedConsumerFile(file: string, policy: Partial<ConsumerPolicy> | undefined): boolean {
  const isTest = TEST_GLOBS.some((g) => matchGlob(g, file));
  const isDocs = DOCS_GLOBS.some((g) => matchGlob(g, file));
  return (isTest && policy?.countTestsAsConsumers !== true) || (isDocs && policy?.countDocsAsConsumers !== true);
}

// ---------------------------------------------------------------------------
// Unindexed files (config files, scripts, tests and components outside every
// tsconfig) and generated files
// ---------------------------------------------------------------------------

/** Code files that can import an npm package. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Single-file components and MDX: TypeScript cannot load them, so they are
 * never in an indexed program (scip-typescript sees no `.vue` file even when a
 * tsconfig includes it). Their whole text is scanned.
 */
const SFC_FILE = /\.(?:vue|svelte|astro|marko|mdx)$/;

/** Resolution order for a relative import from an SFC (TypeScript-style, `.js` → `.ts` included). */
const RELATIVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directories never walked for unindexed files: dependencies, VCS and build /
 * tool output (generated, never hand-written consumers).
 */
const UNINDEXED_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out',
  '.yarn', '.pnpm-store', '.turbo', '.next', '.nuxt', '.output', '.svelte-kit', '.wrangler', '.vercel', '.cache',
]);

/**
 * Tool-output directories that can still be part of a TypeScript program (Nuxt's
 * `.nuxt/tsconfig.json` includes `.nuxt/*.d.ts`): every own file under one is generated.
 */
const GENERATED_DIRS = new Set(['.nuxt', '.output', '.svelte-kit', '.next', '.astro', '.vercel', '.wrangler']);

/**
 * Module specifiers in a text scan (comments are not stripped: a commented-out
 * import errs toward blocking). Group 1 (or 2) is the specifier.
 */
const SPECIFIER_RES: readonly RegExp[] = [
  // import x from 's' / import { a } from 's' / import type ... from 's' / import 's'
  /\bimport\s+(?:[\w*{}\s,$]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g,
  // export { a } from 's' / export * from 's' / export * as ns from 's'
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g,
  // require('s') / import('s') / require.resolve('s')
  /\b(?:require(?:\.resolve)?|import)\s*\(\s*(?:['"]([^'"\n]+)['"]|`([^`$\n]+)`)/g,
];

/**
 * Script dirs of core SCRIPT_GLOBS (the `**\/<dir>/**` shapes: playground/,
 * bench/, scripts/, ...). The file shapes (`*.config.*`, `*.workspace.*`) are left
 * out on purpose: a tool config importing an org package (an ESLint config
 * package) is a real consumer, so it stays unscoped and keeps blocking its target.
 */
const SCRIPT_DIR_GLOBS = SCRIPT_GLOBS.filter((g) => g.endsWith('/**'));

/**
 * The `scope` of an unindexed file: `test` (core TEST_GLOBS), else `docs`
 * (DOCS_GLOBS), else `script` (the directory shapes of SCRIPT_GLOBS), else
 * undefined. Core routes scoped entries to the witness (`witness_files`), never
 * to flags, whatever the consumer policy says.
 */
export function unindexedScope(file: string): UnindexedImport['scope'] {
  if (TEST_GLOBS.some((g) => matchGlob(g, file))) return 'test';
  if (DOCS_GLOBS.some((g) => matchGlob(g, file))) return 'docs';
  if (SCRIPT_DIR_GLOBS.some((g) => matchGlob(g, file))) return 'script';
  return undefined;
}

export interface PackageWalkInput {
  repoRoot: string;
  pkgDir: string;
  /** Absolute dirs of other packages nested inside `pkgDir` (not walked). */
  nestedPackageDirs: readonly string[];
  /**
   * Absolute dirs of ignored manifests (discover's `ignoredManifests`: examples,
   * templates, fixtures) inside `pkgDir`: not walked. Such a subtree is not an
   * org package; the witness covers it.
   */
  ignoredDirs?: readonly string[];
}

/**
 * Absolute paths of the package's own code and SFC files, outside
 * UNINDEXED_SKIP_DIRS, nested packages and ignored manifests (sorted walk order).
 */
export function walkPackageFiles(input: PackageWalkInput): string[] {
  const out: string[] = [];
  const skip = [...input.nestedPackageDirs, ...(input.ignoredDirs ?? [])].map((d) => path.resolve(d));
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (UNINDEXED_SKIP_DIRS.has(e.name) || skip.includes(abs)) continue;
        walk(abs);
      } else if (e.isFile() && (CODE_FILE.test(e.name) || SFC_FILE.test(e.name))) {
        out.push(abs);
      }
    }
  };
  walk(path.resolve(input.pkgDir));
  return out;
}

export interface UnindexedScanInput extends PackageWalkInput {
  /** Absolute paths of every file some indexed program has as a root file. */
  indexedFiles: ReadonlySet<string>;
  orgPackageNames: ReadonlySet<string>;
  /** This package's own npm name (self-imports are not consumers; relative SFC imports target it). */
  selfName: string | null;
  /** Files already walked (`walkPackageFiles`); walked here when absent. */
  files?: readonly string[];
}

/**
 * Text-scans files in the package that no indexed program covers for imports
 * SCIP cannot see (never a source of edges, PLAN.md §12):
 *  - code files outside every tsconfig (`eslint.config.mjs`, `scripts/*.mjs`,
 *    `test/*.mjs`) and SFC files (`.vue`, `.svelte`, `.astro`, `.marko`, `.mdx`):
 *    each import of another org package by name is recorded with the specifier
 *    as `module` (ingest: a targeted `unindexed_consumer` flag, or a witness file
 *    when `scope` is set);
 *  - SFC files only: each relative import of one of the package's own code files
 *    (`import { x } from '../samples/components.ts'` in `pages/playground.vue`) is
 *    recorded with `relative: true`, `module` = the resolved file (repo-relative
 *    POSIX) and `targetPackage` = this package, so core can keep that file's
 *    declarations alive. Imports of other SFCs, assets and aliases (`~/`, `@/`)
 *    are not resolved.
 * Every entry carries the file's `scope` (see `unindexedScope`) when it has one.
 */
export function scanUnindexedImports(input: UnindexedScanInput): UnindexedImport[] {
  const out: UnindexedImport[] = [];
  const seen = new Set<string>();
  const pkgDir = path.resolve(input.pkgDir);
  const nested = input.nestedPackageDirs.map((d) => path.resolve(d));
  const toRepoRel = (abs: string): string => path.relative(input.repoRoot, abs).split(path.sep).join(path.posix.sep);
  const isOwnCode = (abs: string): boolean =>
    isInside(abs, pkgDir) && !abs.split(path.sep).includes('node_modules') && !nested.some((d) => isInside(abs, d));
  const push = (u: UnindexedImport): void => {
    const key = `${u.file}\0${u.module}\0${u.relative === true ? 'r' : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u);
  };
  for (const abs of input.files ?? walkPackageFiles(input)) {
    const sfc = SFC_FILE.test(abs);
    if (!sfc && (!CODE_FILE.test(abs) || input.indexedFiles.has(abs))) continue;
    const file = toRepoRel(abs);
    const scope = unindexedScope(file);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const re of SPECIFIER_RES) {
      for (const m of text.matchAll(re)) {
        const module = m[1] ?? m[2];
        if (module === undefined) continue;
        const target = barePackageName(module);
        if (target !== undefined) {
          if (target === input.selfName || !input.orgPackageNames.has(target)) continue;
          push({ file, module, targetPackage: target, ...(scope !== undefined ? { scope } : {}) });
        } else if (sfc && input.selfName !== null && (module.startsWith('./') || module.startsWith('../'))) {
          const resolved = resolveRelative(path.dirname(abs), module);
          if (resolved === undefined || !isOwnCode(resolved)) continue;
          push({
            file,
            module: toRepoRel(resolved),
            targetPackage: input.selfName,
            relative: true,
            ...(scope !== undefined ? { scope } : {}),
          });
        }
      }
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || cmp(a.module, b.module));
}

/** An own code file a relative specifier names (exact, `.js` → `.ts`, added extension, `/index.*`), or undefined. */
function resolveRelative(fromDir: string, spec: string): string | undefined {
  const base = path.resolve(fromDir, spec.replace(/[?#].*$/, ''));
  const candidates = [base];
  const js = /\.([cm]?)js(x?)$/.exec(base);
  if (js !== null) candidates.push(`${base.slice(0, -js[0].length)}.${js[1]}ts${js[2]}`);
  for (const ext of RELATIVE_EXTS) candidates.push(base + ext);
  for (const ext of RELATIVE_EXTS) candidates.push(path.join(base, `index${ext}`));
  for (const c of candidates) {
    if (!CODE_FILE.test(c)) continue;
    try {
      if (statSync(c).isFile()) return realpathOr(c);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isInside(abs: string, dir: string): boolean {
  return abs === dir || abs.startsWith(dir + path.sep);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Core GENERATED_GLOBS. Read through the namespace because `@sentei/core`'s index
 * does not export it yet (packages/core/src/globs.ts has it); without the export
 * only the header and tool-dir rules apply here (core's `generated_files` view
 * applies the globs itself). Replace with a named import once it is exported.
 */
const GENERATED_GLOBS: readonly string[] = ((core as Record<string, unknown>)['GENERATED_GLOBS'] as readonly string[] | undefined) ?? [];

/**
 * Header phrases that mark a generated file (first 20 lines, comments only):
 * `@generated` (the Meta/Buck marker), "automatically
 * generated", "auto-generated", "do not edit", "generated by " (Wrangler's
 * `// Generated by Wrangler by running \`wrangler types\``), "this file was
 * generated", "code generated" (Go's `// Code generated ... DO NOT EDIT.`).
 */
const GENERATED_HEADERS: readonly RegExp[] = [
  /@generated|automatically generated|auto-generated|do not edit/i,
  /generated by /i,
  /this file was generated/i,
  /code generated/i,
];

/** File names that are generated whatever their header: Wrangler's `worker-configuration.d.ts`, `*.generated.d.ts`. */
const GENERATED_NAME = /^(?:worker-configuration\.d\.ts|.+\.generated\.d\.ts)$/;
const HEADER_LINES = 20;
/** Bytes read for the header check (20 lines of any sane generated file). */
const HEADER_BYTES = 16 * 1024;

/**
 * True when a file is generated: its repo-relative path matches core
 * GENERATED_GLOBS or lies under a tool-output dir (`.nuxt/`, ...), its name is
 * `worker-configuration.d.ts` or `*.generated.d.ts`, or a comment in its first
 * 20 lines says so (GENERATED_HEADERS). Only comment text counts: a generator's
 * source holding the header as a string literal (capnp-es
 * `SOURCE_COMMENT = \`// This file has been automatically generated...\``) is
 * hand-written code. `head` is the file's start (read when absent).
 */
export function isGeneratedFile(abs: string, repoRel: string, head?: string): boolean {
  if (GENERATED_GLOBS.some((g) => matchGlob(g, repoRel))) return true;
  const segs = repoRel.split('/');
  if (segs.some((seg) => GENERATED_DIRS.has(seg))) return true;
  if (GENERATED_NAME.test(segs[segs.length - 1]!)) return true;
  const text = head ?? readHead(abs);
  return text !== undefined && headerComments(text).some((c) => GENERATED_HEADERS.some((re) => re.test(c)));
}

function readHead(abs: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Comment texts within the first HEADER_LINES lines (`//`, `#`, `/* *\/`, `<!-- -->`, `{/* *\/}` in MDX). */
function headerComments(text: string): string[] {
  const out: string[] = [];
  let close: string | undefined; // the terminator of the open block comment
  for (const raw of text.split(/\r?\n/, HEADER_LINES)) {
    let line = raw;
    while (line.length > 0) {
      if (close !== undefined) {
        const end = line.indexOf(close);
        out.push(end < 0 ? line : line.slice(0, end));
        if (end < 0) break;
        line = line.slice(end + close.length);
        close = undefined;
        continue;
      }
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('#')) {
        out.push(t);
        break;
      }
      // A block comment counts only where it starts the (rest of the) line.
      const open = /^(?:\{?\/\*|<!--)/.exec(t);
      if (open === null) break;
      close = open[0] === '<!--' ? '-->' : '*/';
      line = t.slice(open[0].length);
    }
  }
  return out;
}
