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
// (`namespaceMemberRefs`) and shorthand properties (`shorthandRefs`).
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type {
  ConsumerFlag,
  ConsumerPolicy,
  NamespaceMemberRef,
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

  // Namespace imports of org packages: the module symbol they alias → the org
  // package the specifier names (`hono/jsx` → `hono`).
  const namespaceModules = new Map<ts.Symbol, string>();
  const namespaceNames = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const module = stmt.moduleSpecifier.text;
      if (!checkModule(stmt.moduleSpecifier)) continue;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) checkNamed(module, el.name, el.propertyName ?? el.name);
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        const alias = checker.getSymbolAtLocation(bindings.name);
        if (alias !== undefined) {
          namespaceModules.set(alias.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(alias) : alias, barePackageName(module)!);
          namespaceNames.add(bindings.name.text);
        }
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
        out.flags.push({ flag: 'namespace_dynamic', reason: use.reason, targetPackage: use.targetPackage, ...pos(node) });
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
  modules: ReadonlyMap<ts.Symbol, string>,
  sf: ts.SourceFile,
): { reason: string; targetPackage: string } | undefined {
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
  const targetPackage = modules.get(target);
  if (targetPackage === undefined) return undefined;

  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) return undefined;
  if (ts.isElementAccessExpression(parent) && parent.expression === id) {
    if (ts.isStringLiteralLike(parent.argumentExpression)) return undefined;
    return { reason: `namespace ${id.text} indexed with a computed key: ${truncate(parent.getText(sf))}`, targetPackage };
  }
  if (ts.isQualifiedName(parent) && parent.left === id) return undefined; // `X.Type`
  if (inTypePosition(id)) return undefined;
  return { reason: `namespace ${id.text} used as a value: ${truncate(parent.getText(sf))}`, targetPackage };
}

/** True when `id` (the object of a member access) is an org namespace-import binding. */
function isNamespaceBinding(id: ts.Identifier, checker: ts.TypeChecker, modules: ReadonlyMap<ts.Symbol, unknown>): boolean {
  const sym = checker.getSymbolAtLocation(id);
  if (sym === undefined) return false;
  return modules.has(sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
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
    const declSf = decl.getSourceFile();
    let real: string;
    try {
      real = realpathSync(declSf.fileName);
    } catch {
      continue;
    }
    const owner = orgDirs.find((o) => real === o.dir || real.startsWith(o.dir + path.sep));
    if (owner === undefined || real.split(path.sep).slice(owner.dir.split(path.sep).length).includes('node_modules')) {
      continue;
    }
    const nameNode = ts.getNameOfDeclaration(decl) ?? decl;
    const { line, character } = declSf.getLineAndCharacterOfPosition(nameNode.getStart(declSf));
    return {
      targetPackage: owner.name,
      targetFile: path.relative(owner.dir, real).split(path.sep).join(path.posix.sep),
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
 * count as a consumer under the policy. Mirrors the test_files / doc_files views
 * in packages/core/sql/analyze.sql (PLAN.md §6.5 globs `**\/*.test.*`,
 * `**\/test/**`, `**\/__tests__/**`, `**\/docs/**`): references from such files
 * are ignored by analyze, so nothing found there can hide a counted use.
 */
export function isExcludedConsumerFile(file: string, policy: Partial<ConsumerPolicy> | undefined): boolean {
  const withSlash = `/${file}`;
  const base = file.slice(file.lastIndexOf('/') + 1);
  const isTest = /\.test\..+/.test(base) || /\/(?:test|__tests__)\//.test(withSlash);
  const isDocs = /\/docs\//.test(withSlash);
  return (isTest && policy?.countTestsAsConsumers !== true) || (isDocs && policy?.countDocsAsConsumers !== true);
}

// ---------------------------------------------------------------------------
// Unindexed files (config files outside every tsconfig)
// ---------------------------------------------------------------------------

/** Code files that can import an npm package. */
const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Directories never walked for unindexed files: dependencies, VCS and build /
 * tool output (generated, never hand-written consumers).
 */
const UNINDEXED_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'out',
  '.yarn', '.pnpm-store', '.turbo', '.next', '.nuxt', '.output', '.svelte-kit', '.wrangler', '.vercel', '.cache',
]);

/**
 * Module specifiers in a text scan (comments are not stripped: a commented-out
 * import errs toward blocking). Group 1 is the specifier.
 */
const SPECIFIER_RES: readonly RegExp[] = [
  // import x from 's' / import { a } from 's' / import type ... from 's' / import 's'
  /\bimport\s+(?:[\w*{}\s,$]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g,
  // export { a } from 's' / export * from 's' / export * as ns from 's'
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"\n]+)['"]/g,
  // require('s') / import('s') / require.resolve('s')
  /\b(?:require(?:\.resolve)?|import)\s*\(\s*(?:['"]([^'"\n]+)['"]|`([^`$\n]+)`)/g,
];

export interface UnindexedScanInput {
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
  /** Absolute paths of every file some indexed program has as a root file. */
  indexedFiles: ReadonlySet<string>;
  orgPackageNames: ReadonlySet<string>;
  /** This package's own npm name (self-imports are not consumers). */
  selfName: string | null;
  policy: Partial<ConsumerPolicy> | undefined;
}

/**
 * Text-scans code files in the package that no indexed program covers (e.g.
 * `eslint.config.mjs` outside every tsconfig) for imports of org packages. Such
 * a file consumes the org package invisibly to SCIP, so each hit is recorded
 * (ingest turns it into a targeted `unindexed_consumer` flag on that package).
 * Never a source of edges (PLAN.md §12).
 */
export function scanUnindexedImports(input: UnindexedScanInput): UnindexedImport[] {
  const out: UnindexedImport[] = [];
  const seen = new Set<string>();
  const nested = [...input.nestedPackageDirs, ...(input.ignoredDirs ?? [])].map((d) => path.resolve(d));
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (UNINDEXED_SKIP_DIRS.has(e.name) || nested.includes(abs)) continue;
        walk(abs);
      } else if (e.isFile() && CODE_FILE.test(e.name) && !input.indexedFiles.has(abs)) {
        const file = path.relative(input.repoRoot, abs).split(path.sep).join(path.posix.sep);
        if (isExcludedConsumerFile(file, input.policy)) continue;
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
            if (target === undefined || target === input.selfName || !input.orgPackageNames.has(target)) continue;
            const key = `${file}\0${module}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ file, module, targetPackage: target });
          }
        }
      }
    }
  };
  walk(path.resolve(input.pkgDir));
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.module < b.module ? -1 : a.module > b.module ? 1 : 0));
}
