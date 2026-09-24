// Export-surface sidecar for TypeScript/JavaScript packages.
//
// SCIP carries no export information (non-exported top-level functions get
// global symbols too), so this reads the package's export surface with the
// TypeScript compiler API: the same typescript major/minor scip-typescript
// bundles (5.9.3), so symbol resolution agrees with the `.scip` file.
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  checkConsumerFiles,
  isExcludedConsumerFile,
  scanUnindexedImports,
  type ConsumerCheckResult,
  type OrgPackageDir,
} from './consumer-checks.ts';
import type { ConsumerPolicy, ExportRecord, ExportsSidecar, SourcePosition } from './types.ts';

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
  /** This package's npm name (its self-imports are not consumers of an org package). */
  packageName?: string | null;
  /** Consumer policy; absent keys: tests and docs do not count. */
  policy?: Partial<ConsumerPolicy>;
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

  const specs = createPrograms(input, diagnostics);
  if (specs === undefined) {
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
        unindexedImports: [],
        entrySymbols: [],
      },
      diagnostics,
      partial: true,
    };
  }

  const isOwnFile = (fileName: string): boolean => {
    const abs = path.resolve(fileName);
    if (!isInside(abs, input.pkgDir)) return false;
    if (abs.split(path.sep).includes('node_modules')) return false;
    return !input.nestedPackageDirs.some((d) => isInside(abs, d));
  };

  const exports: ExportRecord[] = [];
  const readEntry = (entry: string, sf: ts.SourceFile, checker: ts.TypeChecker): void => {
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (moduleSymbol === undefined) return; // a script file, not a module: it exports nothing

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
  };

  // Programs are built one at a time and dropped after use: a monorepo root whose
  // tsconfig references every workspace package would not fit in memory at once.
  // A referenced program with no root file of this package (and no pending entry)
  // is not built at all: every file it indexes belongs to another package.
  //
  // Only symbol-resolution failures affect linking (see consumer-checks.ts), and
  // they are detected from the AST + checker, never from diagnostic messages.
  // An org module that does not resolve drops references silently → partial.
  // A missing named import is version skew → recorded, status unchanged.
  // Each own file is checked once, with the first program (root first) that has it;
  // each entry is read from the first program that contains it.
  const consumer: ConsumerCheckResult = { unresolvedOrgModules: [], unresolvedImports: [], flags: [], namespaceMemberRefs: [] };
  const compilerErrors = new Set<string>();
  const checked = new Set<string>();
  const pending = new Map(input.entryPoints.map((e) => [e, path.resolve(input.repoRoot, ...e.split('/'))] as const));
  const found = new Set<string>();
  const indexedFiles = new Set<string>();
  for (const spec of specs) {
    const roots = spec.rootNames.map((f) => path.resolve(f));
    roots.forEach((f) => indexedFiles.add(f));
    const rootSet = new Set(roots);
    if (!roots.some(isOwnFile) && ![...pending.values()].some((abs) => rootSet.has(abs))) continue;
    const program = spec.create();
    const checker = program.getTypeChecker();
    const files = program
      .getSourceFiles()
      .filter((sf) => isOwnFile(sf.fileName) && !checked.has(path.resolve(sf.fileName)));
    for (const sf of files) checked.add(path.resolve(sf.fileName));
    const r = checkConsumerFiles(files, checker, input.orgPackageNames, toRepoRel, input.orgPackageDirs);
    consumer.unresolvedOrgModules.push(...r.unresolvedOrgModules);
    consumer.unresolvedImports.push(...r.unresolvedImports);
    consumer.flags.push(...r.flags);
    consumer.namespaceMemberRefs.push(...r.namespaceMemberRefs);
    // Every other compiler error is informational: it does not change what SCIP links.
    // Per own file (plus the program's global/options diagnostics), deduplicated.
    const fileDiags = files.length > 0 ? files.flatMap((sf) => ts.getPreEmitDiagnostics(program, sf)) : [];
    for (const d of fileDiags) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      if (d.file !== undefined && !isOwnFile(d.file.fileName)) continue;
      compilerErrors.add(formatDiagnostic(d, toRepoRel));
    }
    for (const [entry, abs] of pending) {
      const sf = program.getSourceFile(abs);
      if (sf === undefined) continue;
      pending.delete(entry);
      found.add(entry);
      readEntry(entry, sf, checker);
    }
  }
  if (specs.length > 1) {
    diagnostics.push(`info: export surface read from ${specs.length} tsconfig projects (tsconfig + project references)`);
  }

  // Test/docs files that the policy does not count as consumers: analyze ignores
  // their references, so neither an unresolved org module nor a dynamic construct
  // there can hide a counted use.
  const excluded = (f: { file: string }): boolean => isExcludedConsumerFile(f.file, input.policy);
  for (const m of consumer.unresolvedOrgModules) {
    const where = `'${m.module}' at ${m.file}:${m.line + 1}:${m.col + 1}`;
    if (excluded(m)) {
      diagnostics.push(`warn: unresolved org module ${where} (test/docs file, not a counted consumer; status unaffected)`);
    } else {
      partial = true;
      diagnostics.push(`error: unresolved org module ${where}`);
    }
  }
  for (const u of consumer.unresolvedImports) {
    diagnostics.push(`warn: '${u.name}' is not exported by org module '${u.module}' at ${u.file}:${u.line + 1}:${u.col + 1}`);
  }
  const flags = consumer.flags.filter((f) => !excluded(f));
  for (const f of consumer.flags) {
    diagnostics.push(
      `warn: ${f.flag} at ${f.file}:${f.line + 1}:${f.col + 1}: ${f.reason}` +
        (excluded(f) ? ' (test/docs file, not a counted consumer; dropped)' : ''),
    );
  }
  if (compilerErrors.size > 0) {
    diagnostics.push(`warn: ${compilerErrors.size} TypeScript error diagnostic(s) in the package (status unaffected)`);
    for (const d of [...compilerErrors].slice(0, MAX_REPORTED_DIAGNOSTICS)) diagnostics.push(`warn: ${d}`);
  }

  // Code files no program indexes (scip-typescript indexes exactly each config's root files).
  const unindexedImports = scanUnindexedImports({
    repoRoot: input.repoRoot,
    pkgDir: input.pkgDir,
    nestedPackageDirs: input.nestedPackageDirs,
    indexedFiles,
    orgPackageNames: input.orgPackageNames,
    selfName: input.packageName ?? null,
    policy: input.policy,
  });
  for (const u of unindexedImports) {
    diagnostics.push(`warn: ${u.file} is in no tsconfig and imports org module '${u.module}' (unindexed consumer of ${u.targetPackage})`);
  }

  const entryPoints = input.entryPoints.filter((e) => found.has(e));
  const missingEntryPoints = input.entryPoints.filter((e) => !found.has(e));

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
      flags,
      namespaceMemberRefs: consumer.namespaceMemberRefs,
      unindexedImports,
      entrySymbols: [],
    },
    diagnostics,
    partial,
  };
}

/**
 * The programs scip-typescript indexes for this package: the tsconfig's own
 * program and, recursively (deduplicated), one per project reference, the way
 * scip-typescript's `indexSingleProject` walks them (references first, each
 * created without `projectReferences`, configs with no files skipped). A
 * solution-style tsconfig (`"files": []` + `references`) has only referenced
 * programs. Order: the root first, then references depth-first; an entry file
 * is read from the first program that contains it.
 */
interface ProgramSpec {
  rootNames: readonly string[];
  create: () => ts.Program;
}

function createPrograms(input: ExportSurfaceInput, diagnostics: string[]): ProgramSpec[] | undefined {
  if (input.tsconfig !== undefined && existsSync(input.tsconfig)) {
    const programs: ProgramSpec[] = [];
    const seen = new Set<string>();
    const visit = (configFile: string, isRoot: boolean): boolean => {
      const key = path.resolve(configFile);
      if (seen.has(key)) return true;
      seen.add(key);
      const rel = path.relative(input.pkgDir, key) || path.basename(key);
      if (!existsSync(key)) {
        diagnostics.push(`warn: project reference ${rel} does not exist; skipped`);
        return true;
      }
      let fatal: ts.Diagnostic | undefined;
      const parsed = ts.getParsedCommandLineOfConfigFile(key, undefined, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
          fatal = d;
        },
      });
      if (parsed === undefined) {
        diagnostics.push(`error: cannot read ${key}: ${fatal ? flatten(fatal) : 'unknown error'}`);
        return !isRoot;
      }
      // TS18003 "no inputs" is expected for solution-style configs (and reported by scip-typescript).
      const errors = parsed.errors.filter((d) => d.code !== 18003 && d.category === ts.DiagnosticCategory.Error);
      for (const d of errors) diagnostics.push(`error: tsconfig${isRoot ? '' : ` ${rel}`}: ${flatten(d)}`);
      if (parsed.fileNames.length > 0) {
        const { fileNames, options } = parsed;
        programs.push({ rootNames: fileNames, create: () => ts.createProgram({ rootNames: fileNames, options: { ...options, noEmit: true } }) });
      }
      for (const ref of parsed.projectReferences ?? []) visit(ts.resolveProjectReferencePath(ref), false);
      return true;
    };
    if (!visit(input.tsconfig, true)) return undefined;
    return programs;
  }
  // No tsconfig: default options from the entry files (allowJs so JS entries load).
  const rootNames = input.entryPoints.map((e) => path.resolve(input.repoRoot, ...e.split('/')));
  diagnostics.push('info: export surface computed from entry files with default compiler options');
  const options = { ...ts.getDefaultCompilerOptions(), allowJs: true, noEmit: true };
  return [{ rootNames, create: () => ts.createProgram({ rootNames, options }) }];
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
