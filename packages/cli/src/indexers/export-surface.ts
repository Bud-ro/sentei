// Export-surface sidecar for TypeScript/JavaScript packages.
//
// SCIP carries no export information (non-exported top-level functions get
// global symbols too), so this reads the package's export surface with the
// TypeScript compiler API: the same typescript major/minor scip-typescript
// bundles (5.9.3), so symbol resolution agrees with the `.scip` file.
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { checkConsumerFiles, type OrgPackageDir } from './consumer-checks.ts';
import type { ExportRecord, ExportsSidecar, SourcePosition } from './types.ts';

export interface ExportSurfaceInput {
  packageId: string;
  /** Absolute repo root. */
  repoRoot: string;
  /** Absolute package dir. */
  pkgDir: string;
  /** Absolute dirs of other packages nested inside `pkgDir` (their files are not ours). */
  nestedPackageDirs: string[];
  /** Entry points, repo-relative POSIX (from discover.json). */
  entryPoints: string[];
  /** Absolute tsconfig path, or undefined to build a program from the entry files. */
  tsconfig: string | undefined;
  /** npm names of all org packages (imports of these are checked for resolution). */
  orgPackageNames: ReadonlySet<string>;
  /** Org npm packages with their checkout dirs (realpath), for namespace member resolution. */
  orgPackageDirs: readonly OrgPackageDir[];
}

export interface ExportSurfaceResult {
  sidecar: ExportsSidecar;
  diagnostics: string[];
  /** Anything that makes the surface or the index uncertain. */
  partial: boolean;
}

/** Cap on compiler diagnostics copied into the result (the full count is always reported). */
const MAX_REPORTED_DIAGNOSTICS = 20;

export function computeExportSurface(input: ExportSurfaceInput): ExportSurfaceResult {
  const diagnostics: string[] = [];
  let partial = false;
  const unresolved = new Set<string>();
  const toRepoRel = (abs: string): string =>
    path.relative(input.repoRoot, abs).split(path.sep).join(path.posix.sep);

  const program = createProgram(input, diagnostics);
  if (program === undefined) {
    return {
      sidecar: {
        packageId: input.packageId,
        entryPoints: [],
        missingEntryPoints: [...input.entryPoints],
        exports: [],
        unresolved: [],
        unresolvedImports: [],
        flags: [],
        namespaceMemberRefs: [],
      },
      diagnostics,
      partial: true,
    };
  }
  const checker = program.getTypeChecker();

  const isOwnFile = (fileName: string): boolean => {
    const abs = path.resolve(fileName);
    if (!isInside(abs, input.pkgDir)) return false;
    if (abs.split(path.sep).includes('node_modules')) return false;
    return !input.nestedPackageDirs.some((d) => isInside(abs, d));
  };

  // Only symbol-resolution failures affect linking (see consumer-checks.ts), and
  // they are detected from the AST + checker, never from diagnostic messages.
  // An org module that does not resolve drops references silently → partial.
  // A missing named import is version skew → recorded, status unchanged.
  const ownFiles = program.getSourceFiles().filter((sf) => isOwnFile(sf.fileName));
  const consumer = checkConsumerFiles(ownFiles, checker, input.orgPackageNames, toRepoRel, input.orgPackageDirs);
  for (const m of consumer.unresolvedOrgModules) {
    partial = true;
    diagnostics.push(`error: unresolved org module '${m.module}' at ${m.file}:${m.line + 1}:${m.col + 1}`);
  }
  for (const u of consumer.unresolvedImports) {
    diagnostics.push(`warn: '${u.name}' is not exported by org module '${u.module}' at ${u.file}:${u.line + 1}:${u.col + 1}`);
  }
  for (const f of consumer.flags) {
    diagnostics.push(`warn: ${f.flag} at ${f.file}:${f.line + 1}:${f.col + 1}: ${f.reason}`);
  }

  // Every other compiler error is informational: it does not change what SCIP links.
  const compilerErrors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .filter((d) => d.file === undefined || isOwnFile(d.file.fileName));
  if (compilerErrors.length > 0) {
    diagnostics.push(`warn: ${compilerErrors.length} TypeScript error diagnostic(s) in the package (status unaffected)`);
    for (const d of compilerErrors.slice(0, MAX_REPORTED_DIAGNOSTICS)) {
      diagnostics.push(`warn: ${formatDiagnostic(d, toRepoRel)}`);
    }
  }

  const entryPoints: string[] = [];
  const missingEntryPoints: string[] = [];
  const exports: ExportRecord[] = [];

  for (const entry of input.entryPoints) {
    const sf = program.getSourceFile(path.resolve(input.repoRoot, ...entry.split('/')));
    if (sf === undefined) {
      missingEntryPoints.push(entry);
      continue;
    }
    entryPoints.push(entry);
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) continue; // a script file, not a module: it exports nothing

    const sites = collectExportSites(sf, checker, isOwnFile, unresolved, toRepoRel);
    const seen = new Set<ts.Symbol>();

    const addExports = (mod: ts.Symbol, prefix: string): void => {
      let members: ts.Symbol[];
      try {
        members = checker.getExportsOfModule(mod);
      } catch (err) {
        unresolved.add(entry);
        diagnostics.push(`error: getExportsOfModule failed for ${entry}: ${(err as Error).message}`);
        return;
      }
      for (const exp of members) {
        const exportedAs = prefix + exp.name;
        const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
        const decls = target.declarations ?? [];
        if (decls.length === 0) {
          // An alias that resolves to nothing (`unknown` symbol).
          unresolved.add(`${entry}#${exportedAs}`);
          continue;
        }
        // `export * as ns from './x'` / `export { ns }` of a namespace import:
        // every export of that module is reachable through the entry.
        const moduleDecl = decls.find(ts.isSourceFile);
        if (moduleDecl !== undefined) {
          if (isOwnFile(moduleDecl.fileName) && !seen.has(target)) {
            seen.add(target);
            addExports(target, `${exportedAs}.`);
          }
          continue;
        }
        for (const decl of decls) {
          const declSf = decl.getSourceFile();
          if (!isOwnFile(declSf.fileName)) continue;
          const { node, name, note } = nameOf(decl, target);
          const pos = position(declSf, node.getStart(declSf), toRepoRel);
          const record: ExportRecord = { entry, exportedAs, name, ...pos, sites: sites.get(target) ?? [] };
          if (note !== undefined) record.note = note;
          exports.push(record);
        }
      }
    };
    addExports(moduleSymbol, '');
  }

  if (missingEntryPoints.length > 0) {
    partial = true;
    diagnostics.push(
      `warn: entry point(s) not in the TypeScript program, export surface unknown: ${missingEntryPoints.join(', ')}`,
    );
  }
  if (unresolved.size > 0) {
    partial = true;
    diagnostics.push(`warn: unresolved re-exports: ${[...unresolved].join(', ')}`);
  }

  exports.sort(
    (a, b) =>
      cmp(a.entry, b.entry) || cmp(a.exportedAs, b.exportedAs) || cmp(a.file, b.file) || a.line - b.line || a.col - b.col,
  );
  return {
    sidecar: {
      packageId: input.packageId,
      entryPoints,
      missingEntryPoints,
      exports,
      unresolved: [...unresolved].sort(),
      unresolvedImports: consumer.unresolvedImports,
      flags: consumer.flags,
      namespaceMemberRefs: consumer.namespaceMemberRefs,
    },
    diagnostics,
    partial,
  };
}

function createProgram(input: ExportSurfaceInput, diagnostics: string[]): ts.Program | undefined {
  if (input.tsconfig !== undefined && existsSync(input.tsconfig)) {
    let fatal: ts.Diagnostic | undefined;
    const parsed = ts.getParsedCommandLineOfConfigFile(input.tsconfig, undefined, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        fatal = d;
      },
    });
    if (parsed === undefined) {
      diagnostics.push(`error: cannot read ${input.tsconfig}: ${fatal ? flatten(fatal) : 'unknown error'}`);
      return undefined;
    }
    // TS18003 "no inputs" is reported by scip-typescript itself (no documents).
    const errors = parsed.errors.filter((d) => d.code !== 18003 && d.category === ts.DiagnosticCategory.Error);
    for (const d of errors) diagnostics.push(`error: tsconfig: ${flatten(d)}`);
    return ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
      ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
    });
  }
  // No tsconfig: default options from the entry files (allowJs so JS entries load).
  const rootNames = input.entryPoints.map((e) => path.resolve(input.repoRoot, ...e.split('/')));
  diagnostics.push('info: export surface computed from entry files with default compiler options');
  return ts.createProgram({ rootNames, options: { ...ts.getDefaultCompilerOptions(), allowJs: true, noEmit: true } });
}

/**
 * Positions of identifiers inside export statements reachable from `entry`,
 * and of import bindings in those same files (`import { a }; export { a }`),
 * keyed by the symbol they finally resolve to. These occurrences are not uses
 * and must not count as internal references. Follows `export ... from` and
 * `export *` into the package's own files; an unresolvable module specifier on
 * the chain is recorded in `unresolved`.
 */
function collectExportSites(
  entry: ts.SourceFile,
  checker: ts.TypeChecker,
  isOwnFile: (fileName: string) => boolean,
  unresolved: Set<string>,
  toRepoRel: (abs: string) => string,
): Map<ts.Symbol, SourcePosition[]> {
  const sites = new Map<ts.Symbol, SourcePosition[]>();
  const visited = new Set<ts.SourceFile>();
  const queue: ts.SourceFile[] = [entry];

  const resolve = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (sym === undefined) return undefined;
    return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  };
  const add = (target: ts.Symbol | undefined, sf: ts.SourceFile, node: ts.Node): void => {
    if (target === undefined) return;
    const list = sites.get(target) ?? [];
    list.push(position(sf, node.getStart(sf), toRepoRel));
    sites.set(target, list);
  };

  while (queue.length > 0) {
    const sf = queue.shift()!;
    if (visited.has(sf)) continue;
    visited.add(sf);
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt)) {
        if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
          for (const spec of stmt.exportClause.elements) {
            const target = resolve(checker.getSymbolAtLocation(spec.name));
            if (spec.propertyName !== undefined) add(target, sf, spec.propertyName);
            add(target, sf, spec.name);
          }
        }
        if (stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const mod = checker.getSymbolAtLocation(stmt.moduleSpecifier);
          const modFile = mod?.declarations?.find(ts.isSourceFile);
          if (mod === undefined) {
            unresolved.add(stmt.moduleSpecifier.text);
          } else if (modFile !== undefined && isOwnFile(modFile.fileName)) {
            queue.push(modFile);
          }
        }
      } else if (ts.isImportDeclaration(stmt) && stmt.importClause !== undefined) {
        const clause = stmt.importClause;
        if (clause.name !== undefined) add(resolve(checker.getSymbolAtLocation(clause.name)), sf, clause.name);
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          add(resolve(checker.getSymbolAtLocation(bindings.name)), sf, bindings.name);
        } else if (bindings !== undefined) {
          for (const el of bindings.elements) {
            const target = resolve(checker.getSymbolAtLocation(el.name));
            if (el.propertyName !== undefined) add(target, sf, el.propertyName);
            add(target, sf, el.name);
          }
        }
      } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
        // `export default foo;` / `export = foo;`
        add(resolve(checker.getSymbolAtLocation(stmt.expression)), sf, stmt.expression);
      }
    }
  }
  return sites;
}

/** The node whose position identifies a declaration, and its declared name. */
function nameOf(decl: ts.Declaration, target: ts.Symbol): { node: ts.Node; name: string; note?: string } {
  const nameNode = ts.getNameOfDeclaration(decl);
  if (nameNode !== undefined && !ts.isSourceFile(decl)) {
    const name = ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode) ? nameNode.text : target.name;
    return { node: nameNode, name };
  }
  // `export default function () {}`, `export default class {}`, `export default <expr>`.
  const kw = findDefaultKeyword(decl);
  if (kw !== undefined) return { node: kw, name: 'default', note: 'default-keyword' };
  return { node: decl, name: target.name };
}

function findDefaultKeyword(decl: ts.Node): ts.Node | undefined {
  if (ts.canHaveModifiers(decl)) {
    const kw = ts.getModifiers(decl)?.find((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (kw !== undefined) return kw;
  }
  if (ts.isExportAssignment(decl)) {
    return decl.getChildren().find((c) => c.kind === ts.SyntaxKind.DefaultKeyword);
  }
  return undefined;
}

function position(sf: ts.SourceFile, pos: number, toRepoRel: (abs: string) => string): SourcePosition {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return { file: toRepoRel(path.resolve(sf.fileName)), line, col: character };
}

function isInside(abs: string, dir: string): boolean {
  const rel = path.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function flatten(d: ts.Diagnostic): string {
  return `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
}

function formatDiagnostic(d: ts.Diagnostic, toRepoRel: (abs: string) => string): string {
  if (d.file === undefined || d.start === undefined) return flatten(d);
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return `${toRepoRel(path.resolve(d.file.fileName))}:${line + 1}:${character + 1} ${flatten(d)}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
