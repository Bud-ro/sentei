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
//     accessed members are not statically known → `flags`. The same holds for
//     any namespace value (`await import('x')`, a `typeof import('x')` value)
//     whose use hides its members (rest element, computed key, widened type);
//     its destructured / accessed members are `namespaceMemberRefs`.
// Plus two upstream gaps recorded as checker-resolved references (ingest
// dedupes them against SCIP occurrences): namespace member accesses
// (`namespaceMemberRefs`) and shorthand properties (`shorthandRefs`); and
// value uses of any namespace import of org code, relative ones included
// (`namespaceSpreadRefs`: `{..._pkg}` reads members nobody can list).
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as core from '@sentei/core';
import { DOCS_GLOBS, inSurfaceDir, SCRIPT_GLOBS, TEST_GLOBS, matchGlob } from '@sentei/core';
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
  selfName: string | null = null,
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
  const nsTypes = new NamespaceTypes(checker, dirs, selfName);
  for (const sf of files) checkFile(sf, checker, orgPackageNames, toRepoRel, result, dirs, nsTypes);
  return result;
}

function checkFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  orgNames: ReadonlySet<string>,
  toRepoRel: (abs: string) => string,
  out: ConsumerCheckResult,
  orgDirs: readonly OrgPackageDir[],
  nsTypes: NamespaceTypes,
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

  // ---- Namespace values other than `import * as` bindings (see NamespaceTypes) ----
  // `const { a } = await import('@acme/x')`, `const m = await load(); m.a`,
  // `function f({ a }: typeof import('@acme/x'))`: scip-typescript 0.4.0 gives the
  // destructured binding a `local` symbol and records no reference to the member, so
  // the checker-resolved member is recorded in namespaceMemberRefs. A use that hides
  // which members are read (a rest element, a computed key, the value handed to a
  // wider type) is recorded like a value use of a namespace import: a
  // `namespace_dynamic` flag at another org package, plus a namespace spread ref.
  const dynSeen = new Set<string>();
  const dynamicUse = (node: ts.Node, modules: readonly NamespaceModule[], reason: string): void => {
    const at = pos(node);
    for (const m of modules) {
      const key = `${at.line}:${at.col}\0${m.pkg ?? ''}\0${m.file?.targetPackage ?? ''}\0${m.file?.targetFile ?? ''}`;
      if (dynSeen.has(key)) continue;
      dynSeen.add(key);
      if (m.pkg !== undefined) out.flags.push({ flag: 'namespace_dynamic', reason, targetPackage: m.pkg, ...at });
      if (m.file !== undefined) out.namespaceSpreadRefs.push({ ...at, ...m.file });
    }
  };
  /** Records member `text` of a namespace (position `nameNode`); a missing member of another org package is version skew. */
  const memberRef = (nameNode: ts.Node, text: string, ns: NsType): void => {
    const prop = checker.getPropertyOfType(ns.type, text);
    if (prop === undefined) {
      if (ns.module.pkg !== undefined) out.unresolvedImports.push({ module: ns.module.pkg, name: text, ...pos(nameNode) });
      return;
    }
    // A nested namespace (`export * as sub`): its own member reads are origins in turn.
    const resolved = prop.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(prop) : prop;
    if (resolved.declarations?.some(ts.isSourceFile) === true) return;
    const ref = declTarget(prop, checker, orgDirs, false);
    if (ref !== undefined) out.namespaceMemberRefs.push({ ...pos(nameNode), member: text, ...ref });
  };
  const nsish = (t: ts.Type | undefined): boolean => t !== undefined && nsTypes.of(t, true).length > 0;
  /**
   * Why a use of a namespace-typed expression hides which members are read, or
   * undefined when it does not (static member reads are recorded here). Pass-through
   * parents (`await`, parentheses, `as`, `!`, `??`, `||`, conditional arms) are climbed
   * while their type is still a namespace. `direct` false: the caller records a member
   * read directly on `e` itself (an `import * as` binding).
   */
  const classify = (e: ts.Expression, direct: boolean): string | undefined => {
    let cur: ts.Expression = e;
    while (isPassThrough(cur.parent, cur)) {
      const p = cur.parent as ts.Expression;
      if (!nsish(checker.getTypeAtLocation(p))) return `namespace value widened: ${truncate(p.getText(sf))}`;
      cur = p;
    }
    const p = cur.parent;
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === cur) {
      if (!direct && cur === e) return undefined;
      const plain = nsTypes.of(checker.getTypeAtLocation(cur), false);
      if (ts.isPropertyAccessExpression(p)) {
        if (plain.length > 0) {
          for (const n of plain) memberRef(p.name, p.name.text, n);
          return undefined;
        }
        // A promise of a namespace: `.then(cb)` hands it to cb, whose parameter is an
        // origin in turn when cb is written inline; `.catch` / `.finally` return the
        // promise again (a call: an origin).
        if (p.name.text === 'then' && ts.isCallExpression(p.parent) && p.parent.expression === p) {
          const cb = p.parent.arguments[0];
          if (cb !== undefined && !ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) {
            return `namespace promise handed to a callback: ${truncate(p.parent.getText(sf))}`;
          }
        }
        return undefined;
      }
      const arg = p.argumentExpression;
      if (plain.length === 0) return undefined; // an array / tuple element: the access is an origin in turn
      if (!ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg)) {
        return `namespace ${truncate(cur.getText(sf))} indexed with a computed key: ${truncate(p.getText(sf))}`;
      }
      for (const n of plain) memberRef(arg, arg.text, n);
      return undefined;
    }
    return sinkUse(cur);
  };
  /** Why handing the namespace value `c` to its parent hides members (undefined: tracked, or harmless). */
  const sinkUse = (c: ts.Expression): string | undefined => {
    const p = c.parent;
    const text = (): string => truncate(p.getText(sf));
    const valueUse = (): string => `namespace ${truncate(c.getText(sf))} used as a value: ${text()}`;
    if (
      (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isPropertyDeclaration(p)) &&
      p.initializer === c
    ) {
      // Destructured: the pattern walk resolves (or flags) each element; an array
      // pattern's elements are patterns or variables typed as the namespace in turn.
      if (ts.isObjectBindingPattern(p.name)) return undefined;
      if (ts.isArrayBindingPattern(p.name)) return nsish(checker.getTypeAtLocation(p.name)) ? undefined : valueUse();
      if (ts.isVariableDeclaration(p) && isExportedVariable(p)) return `namespace exported as a value: ${text()}`;
      // Kept in a location still typed as the namespace: its reads are origins in turn.
      return nsish(checker.getTypeAtLocation(p.name)) ? undefined : valueUse();
    }
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === c)) {
      const fn = ts.isArrowFunction(p) ? p : containingFunction(p);
      const sig = fn !== undefined ? checker.getSignatureFromDeclaration(fn) : undefined;
      return sig !== undefined && nsish(checker.getReturnTypeOfSignature(sig)) ? undefined : valueUse();
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (p.left === c) return undefined; // assigned to, not read
      const target = p.left;
      // `({ a, b: x } = <namespace>)`: a destructuring assignment.
      if (ts.isObjectLiteralExpression(target)) return destructuringAssignment(target, c);
      return !ts.isArrayLiteralExpression(target) && nsish(checker.getTypeAtLocation(target)) ? undefined : valueUse();
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(c) === true) {
      return nsish(checker.getContextualType(c)) ? undefined : valueUse();
    }
    if ((ts.isPropertyAssignment(p) && p.initializer === c) || (ts.isShorthandPropertyAssignment(p) && p.name === c)) {
      // An inferred object literal keeps the namespace type on the property (its reads
      // are origins); a contextually typed one must keep it too.
      const ctx = checker.getContextualType(p.parent);
      if (ctx === undefined) return undefined;
      const name = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : undefined;
      const prop = name !== undefined ? checker.getPropertyOfType(ctx, name) : undefined;
      return prop !== undefined && nsish(checker.getTypeOfSymbol(prop)) ? undefined : valueUse();
    }
    // Evaluated and discarded, or only tested: no member is read.
    if (ts.isExpressionStatement(p) || ts.isVoidExpression(p) || ts.isTypeOfExpression(p)) return undefined;
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return undefined;
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === c) return undefined;
    if (ts.isConditionalExpression(p) && p.condition === c) return undefined;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ||
        ((op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) && p.left === c) ||
        (op === ts.SyntaxKind.InKeyword && p.right === c)
      ) {
        return undefined;
      }
    }
    return valueUse();
  };
  /** `({ a, b: x, ...rest } = <namespace>)`: like a binding pattern. */
  const destructuringAssignment = (target: ts.ObjectLiteralExpression, value: ts.Expression): string | undefined => {
    const nss = nsTypes.of(checker.getTypeAtLocation(value), false);
    if (nss.length === 0) return `namespace destructured by assignment: ${truncate(target.getText(sf))}`;
    for (const prop of target.properties) {
      const key = ts.isShorthandPropertyAssignment(prop) || ts.isPropertyAssignment(prop) ? prop.name : undefined;
      const keyNode = key !== undefined && ts.isComputedPropertyName(key) ? key.expression : key;
      const literal = keyNode !== undefined && (ts.isStringLiteralLike(keyNode) || ts.isNumericLiteral(keyNode));
      if (keyNode === undefined || !(literal || (ts.isIdentifier(keyNode) && key === keyNode))) {
        return `namespace destructured by assignment: ${truncate(target.getText(sf))}`;
      }
      for (const n of nss) memberRef(keyNode, (keyNode as ts.Identifier | ts.StringLiteralLike | ts.NumericLiteral).text, n);
    }
    return undefined;
  };
  /** `const { a, b: c, ...rest } = <namespace>` (any binding position). */
  const bindingPattern = (pattern: ts.ObjectBindingPattern): void => {
    const nss = nsTypes.of(checker.getTypeAtLocation(pattern), false);
    if (nss.length === 0) return;
    const modules = nss.map((n) => n.module);
    for (const el of pattern.elements) {
      if (el.dotDotDotToken !== undefined) {
        dynamicUse(el, modules, `rest element in a namespace destructuring: ${truncate(pattern.getText(sf))}`);
        continue;
      }
      const key = el.propertyName ?? el.name;
      const keyNode = ts.isComputedPropertyName(key) ? key.expression : key;
      const literal = ts.isStringLiteralLike(keyNode) || ts.isNumericLiteral(keyNode);
      if (!(literal || (ts.isIdentifier(keyNode) && !ts.isComputedPropertyName(key)))) {
        dynamicUse(el, modules, `computed key in a namespace destructuring: ${truncate(el.getText(sf))}`);
        continue;
      }
      for (const n of nss) memberRef(keyNode, keyNode.text, n);
    }
  };
  /** The type of a potential namespace-valued expression, or undefined when it cannot be one. */
  const originType = (node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.CallExpression): ts.Type | undefined => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return undefined; // the access is the origin
      if (ts.isBindingElement(parent) && parent.propertyName === node) return undefined;
      if (ts.isQualifiedName(parent) || inTypePosition(node)) return undefined;
      const shorthand = ts.isShorthandPropertyAssignment(parent) && parent.name === node;
      const sym = shorthand ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
      if (sym === undefined || (sym.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.Property)) === 0) return undefined;
      if (!shorthand && sym.declarations?.some((d) => ts.getNameOfDeclaration(d) === node) === true) return undefined;
      return checker.getTypeOfSymbol(sym);
    }
    if (ts.isPropertyAccessExpression(node)) {
      let sym = checker.getSymbolAtLocation(node.name);
      if (sym === undefined) return undefined;
      if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const kinds = ts.SymbolFlags.Variable | ts.SymbolFlags.Property | ts.SymbolFlags.ValueModule | ts.SymbolFlags.GetAccessor;
      return sym.flags & kinds ? checker.getTypeOfSymbol(sym) : undefined;
    }
    return checker.getTypeAtLocation(node);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectBindingPattern(node)) {
      bindingPattern(node);
    } else if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
      const t = originType(node);
      const nss = t !== undefined ? nsTypes.of(t, true) : [];
      if (nss.length > 0) {
        const why = classify(node, true);
        if (why !== undefined) dynamicUse(node, nss.map((n) => n.module), why);
      }
    } else if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier === undefined && !node.isTypeOnly) {
      // `export { m }` of a local namespace-typed variable.
      const local = checker.getExportSpecifierLocalTargetSymbol(node);
      if (local !== undefined && local.flags & ts.SymbolFlags.Variable) {
        const nss = nsTypes.of(checker.getTypeOfSymbol(local), true);
        if (nss.length > 0) dynamicUse(node, nss.map((n) => n.module), `namespace exported as a value: ${truncate(node.getText(sf))}`);
      }
    }
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
      const use = namespaceValueUse(node, checker, namespaceModules, sf, classify);
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
  classify: (e: ts.Expression, direct: boolean) => string | undefined,
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
  if (ts.isExportSpecifier(parent)) return { reason: `namespace ${id.text} used as a value: ${truncate(parent.getText(sf))}`, module };
  // Destructured, or kept in a location still typed as the namespace (tracked from there).
  const reason = classify(id, false);
  return reason === undefined ? undefined : { reason, module };
}

/** Parents a namespace value passes through unchanged (when their type is still a namespace). */
function isPassThrough(p: ts.Node, c: ts.Node): boolean {
  if (
    ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isNonNullExpression(p) ||
    ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)
  ) {
    return true;
  }
  if (ts.isConditionalExpression(p)) return p.condition !== c;
  if (ts.isArrayLiteralExpression(p)) return true; // an array / tuple of namespaces (`Promise.all([import('x')])`)
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return true;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) return p.right === c;
  }
  return false;
}

function containingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let n = node.parent; n !== undefined && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return undefined;
}

function isExportedVariable(decl: ts.VariableDeclaration): boolean {
  const stmt = decl.parent.parent;
  return ts.isVariableStatement(stmt) && (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

/** A module namespace type (`typeof import('x')`) of an org module, as found in some type. */
interface NsType {
  module: NamespaceModule;
  /** The namespace object type (members are the module's exports). */
  type: ts.Type;
  /**
   * Where the namespace sits: `undefined` for the type itself (or a union member);
   * `promise` for the awaited type of a `Promise` / `PromiseLike` (`import('x')`);
   * `array` for an element of an array / tuple (`Promise.all([import('x'), ...])`).
   * Members are read only from a direct one; a container's reads yield it (`await`,
   * `arr[0]`, a `.then` callback parameter), which is an origin in turn.
   */
  container?: 'promise' | 'array';
}

/**
 * Finds module namespace types of org modules inside a type: the type itself, each
 * union member, the awaited type of a Promise and the element types of an array or
 * tuple (nested up to a small depth). `module.pkg` is the org package
 * (npm name) holding the module unless it is this package (`selfName`): the flag
 * target; `module.file` is always set (the spread-ref target). Cached per type.
 */
class NamespaceTypes {
  private readonly byType = new Map<ts.Type, NsType[]>();
  private readonly byModule = new Map<ts.Symbol, NamespaceModule | null>();
  private readonly checker: ts.TypeChecker;
  private readonly orgDirs: readonly OrgPackageDir[];
  private readonly selfName: string | null;
  constructor(checker: ts.TypeChecker, orgDirs: readonly OrgPackageDir[], selfName: string | null) {
    this.checker = checker;
    this.orgDirs = orgDirs;
    this.selfName = selfName;
  }

  /** Namespaces in `type`; with `contained` false, only direct ones (members can be read from those). */
  of(type: ts.Type, contained: boolean): NsType[] {
    let found = this.byType.get(type);
    if (found === undefined) {
      found = this.compute(type, undefined, 0);
      this.byType.set(type, found);
    }
    return contained ? found : found.filter((n) => n.container === undefined);
  }

  private compute(type: ts.Type, container: NsType['container'], depth: number): NsType[] {
    const out: NsType[] = [];
    for (const t of type.isUnion() ? type.types : [type]) {
      const direct = this.moduleOf(t);
      if (direct !== undefined) {
        out.push({ module: direct, type: t, ...(container !== undefined ? { container } : {}) });
        continue;
      }
      if (depth >= 3) continue;
      const name = t.getSymbol()?.name;
      if (name === 'Promise' || name === 'PromiseLike') {
        const awaited = this.checker.getAwaitedType(t);
        if (awaited !== undefined && awaited !== t) out.push(...this.compute(awaited, container ?? 'promise', depth + 1));
      } else if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) {
        for (const el of this.checker.getTypeArguments(t as ts.TypeReference)) out.push(...this.compute(el, container ?? 'array', depth + 1));
      }
    }
    return out;
  }

  private moduleOf(t: ts.Type): NamespaceModule | undefined {
    const sym = t.getSymbol();
    if (sym === undefined || (sym.flags & ts.SymbolFlags.ValueModule) === 0) return undefined;
    let m = this.byModule.get(sym);
    if (m === undefined) {
      const file = sym.declarations?.some(ts.isSourceFile) === true ? moduleTarget(sym, this.orgDirs) : undefined;
      m = file === undefined ? null : { ...(file.targetPackage !== this.selfName ? { pkg: file.targetPackage } : {}), file };
      this.byModule.set(sym, m);
    }
    return m ?? undefined;
  }
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
 * counted use. With `pkg` (the file's package: manager and repo-relative dir), a file
 * in one of its SURFACE_DIRS (a pub package's `lib/`) is never test or docs code,
 * as in the SQL views; without it, only the globs apply.
 */
export function isExcludedConsumerFile(file: string, policy: Partial<ConsumerPolicy> | undefined, pkg?: PackageLocation): boolean {
  if (pkg !== undefined && inSurfaceDir(file, pkg.manager, pkg.path)) return false;
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
 * to flags, whatever the consumer policy says. With `pkg`, a file in one of the
 * package's SURFACE_DIRS (a pub package's `lib/`) has no scope (see isExcludedConsumerFile).
 */
export function unindexedScope(file: string, pkg?: PackageLocation): UnindexedImport['scope'] {
  if (pkg !== undefined && inSurfaceDir(file, pkg.manager, pkg.path)) return undefined;
  if (TEST_GLOBS.some((g) => matchGlob(g, file))) return 'test';
  if (DOCS_GLOBS.some((g) => matchGlob(g, file))) return 'docs';
  if (SCRIPT_DIR_GLOBS.some((g) => matchGlob(g, file))) return 'script';
  return undefined;
}

/** A package's manager and dir (repo-relative POSIX, '.' for the repo root), for core `inSurfaceDir`. */
export interface PackageLocation {
  manager: string;
  path: string;
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
  /** This package's own npm name (imports of it by name and relative SFC imports target it). */
  selfName: string | null;
  /** Files already walked (`walkPackageFiles`); walked here when absent. */
  files?: readonly string[];
  /** The package's manager (default `npm`): its SURFACE_DIRS are never scoped. */
  manager?: string;
}

/**
 * Text-scans files in the package that no indexed program covers for imports
 * SCIP cannot see (never a source of edges, PLAN.md §12):
 *  - code files outside every tsconfig (`eslint.config.mjs`, `scripts/*.mjs`,
 *    `test/*.mjs`) and SFC files (`.vue`, `.svelte`, `.astro`, `.marko`, `.mdx`):
 *    each import of an org package by name is recorded with the specifier
 *    as `module` (ingest: a targeted `unindexed_consumer` flag, or a witness file
 *    when `scope` is set). An import of this package itself by name
 *    (`eslint.config.mjs` importing the package) is recorded the same way with
 *    `targetPackage` = `selfName` (core: the self-witness covers the file);
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
  const pkgLocation: PackageLocation = { manager: input.manager ?? 'npm', path: toRepoRel(pkgDir) || '.' };
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
    const scope = unindexedScope(file, pkgLocation);
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
          // The package imported by its own name counts too (`targetPackage` = self):
          // core's self-witness reads such files, since SCIP never sees them.
          if (target !== input.selfName && !input.orgPackageNames.has(target)) continue;
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
