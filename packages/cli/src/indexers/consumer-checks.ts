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
import path from 'node:path';
import ts from 'typescript';
import type { ConsumerFlag, SourcePosition, UnresolvedImport } from './types.ts';

export interface ConsumerCheckResult {
  /** Org module specifiers that did not resolve (fail closed: partial). */
  unresolvedOrgModules: Array<SourcePosition & { module: string }>;
  unresolvedImports: UnresolvedImport[];
  flags: ConsumerFlag[];
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
): ConsumerCheckResult {
  const result: ConsumerCheckResult = { unresolvedOrgModules: [], unresolvedImports: [], flags: [] };
  for (const sf of files) checkFile(sf, checker, orgPackageNames, toRepoRel, result);
  return result;
}

function checkFile(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  orgNames: ReadonlySet<string>,
  toRepoRel: (abs: string) => string,
  out: ConsumerCheckResult,
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

  // Namespace imports of org packages, keyed by the module symbol they alias.
  const namespaceModules = new Set<ts.Symbol>();
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
          namespaceModules.add(alias.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(alias) : alias);
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
      } else if (arg === undefined || !isRelativeComputed(arg)) {
        const what = node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import()' : 'require()';
        out.flags.push({
          flag: 'dynamic_access',
          reason: `${what} with a non-literal specifier: ${truncate(arg?.getText(sf) ?? '(no argument)')}`,
          ...pos(node),
        });
      }
    } else if (ts.isIdentifier(node) && namespaceNames.has(node.text)) {
      const reason = namespaceValueUse(node, checker, namespaceModules, sf);
      if (reason !== undefined) out.flags.push({ flag: 'namespace_dynamic', reason, ...pos(node) });
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

/** A template literal or `+` concatenation whose leading literal text is a relative/absolute path. */
function isRelativeComputed(arg: ts.Expression): boolean {
  let lead: string | undefined;
  if (ts.isTemplateExpression(arg)) {
    lead = arg.head.text;
  } else if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    let left: ts.Expression = arg;
    while (ts.isBinaryExpression(left) && left.operatorToken.kind === ts.SyntaxKind.PlusToken) left = left.left;
    while (ts.isParenthesizedExpression(left)) left = left.expression;
    if (ts.isStringLiteralLike(left)) lead = left.text;
  }
  return lead !== undefined && (lead.startsWith('./') || lead.startsWith('../') || lead.startsWith('/'));
}

/**
 * Why a reference to an org namespace-import binding is dynamic, or undefined
 * when it is a static member access, a type position, or the binding itself.
 */
function namespaceValueUse(
  id: ts.Identifier,
  checker: ts.TypeChecker,
  modules: ReadonlySet<ts.Symbol>,
  sf: ts.SourceFile,
): string | undefined {
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
  if (!modules.has(target)) return undefined;

  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) return undefined;
  if (ts.isElementAccessExpression(parent) && parent.expression === id) {
    if (ts.isStringLiteralLike(parent.argumentExpression)) return undefined;
    return `namespace ${id.text} indexed with a computed key: ${truncate(parent.getText(sf))}`;
  }
  if (ts.isQualifiedName(parent) && parent.left === id) return undefined; // `X.Type`
  if (inTypePosition(id)) return undefined;
  return `namespace ${id.text} used as a value: ${truncate(parent.getText(sf))}`;
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
