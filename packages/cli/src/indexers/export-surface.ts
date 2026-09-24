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
  barePackageName,
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
  /** Absolute dirs of discover's ignored manifests inside `pkgDir` (skipped by the out-of-program scan only). */
  ignoredDirs?: string[];
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
        shorthandRefs: [],
        namespaceSpreadRefs: [],
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

  // The files scip-typescript indexes: exactly each program's root files (its
  // ProjectIndexer skips every other source file of the program). Without a
  // tsconfig, the surface program is built from the entry files alone while
  // scip-typescript infers a tsconfig of its own, so the sets are not comparable
  // and no declaration is dropped for this reason.
  const indexedFiles = new Set(specs.flatMap((spec) => spec.rootNames.map((f) => path.resolve(f))));
  const rootsKnown = input.tsconfig !== undefined && existsSync(input.tsconfig);
  const skipped = { bindings: 0, typedefs: 0, expandos: 0, json: new Set<string>() };

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
      for (const decl of expandAliasDeclarations(decls, checker)) {
        const declSf = decl.getSourceFile();
        if (!isOwnFile(declSf.fileName)) continue;
        // Declarations scip-typescript 0.4.0 gives no global definition at this
        // position; a record for them could never match a SCIP symbol.
        if (ts.isBindingElement(decl)) {
          // `export const { a, b } = f()`: SCIP defines a `local N` symbol there,
          // never a verdict subject; its uses resolve to the source property.
          skipped.bindings++;
          continue;
        }
        if (ts.isJSDocTypedefTag(decl) || ts.isJSDocCallbackTag(decl) || ts.isJSDocEnumTag(decl)) {
          // `/** @typedef {import('./types').X} X */` in a JS file: SCIP emits nothing for JSDoc.
          skipped.typedefs++;
          continue;
        }
        if (isExpandoDeclaration(decl) && decls.some((d) => !isExpandoDeclaration(d))) {
          // `fn.prop = ...` adds a declaration to `fn` itself; the function
          // declaration is recorded, the assignment is not a definition.
          skipped.expandos++;
          continue;
        }
        if (rootsKnown && !indexedFiles.has(path.resolve(declSf.fileName))) {
          const rel = toRepoRel(path.resolve(declSf.fileName));
          if (declSf.flags & ts.NodeFlags.JsonFile || /\.json$/i.test(declSf.fileName)) {
            // `export { version } from '../package.json'`: data, never code to report.
            skipped.json.add(rel);
          } else {
            // Declared in a file no tsconfig lists (a hand-written `lib/*.d.mts`
            // entry, a file only reached by import): SCIP has no symbol for it,
            // so neither the export nor any reference inside that file is
            // visible. Unknown surface: fail closed.
            unresolved.add(`${entry}#${exportedAs} (declared in ${rel}, which is in no tsconfig's files, so scip-typescript did not index it)`);
          }
          continue;
        }
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
  const consumer: ConsumerCheckResult = {
    unresolvedOrgModules: [],
    unresolvedImports: [],
    flags: [],
    namespaceMemberRefs: [],
    shorthandRefs: [],
    namespaceSpreadRefs: [],
  };
  const compilerErrors = new Set<string>();
  const ambient: Array<SourcePosition & { name: string; dts: boolean }> = [];
  const checked = new Set<string>();
  const pending = new Map(input.entryPoints.map((e) => [e, path.resolve(input.repoRoot, ...e.split('/'))] as const));
  const found = new Set<string>();
  for (const spec of specs) {
    const roots = spec.rootNames.map((f) => path.resolve(f));
    const rootSet = new Set(roots);
    if (!roots.some(isOwnFile) && ![...pending.values()].some((abs) => rootSet.has(abs))) continue;
    const program = spec.create();
    const checker = program.getTypeChecker();
    const files = program
      .getSourceFiles()
      .filter((sf) => isOwnFile(sf.fileName) && !checked.has(path.resolve(sf.fileName)));
    for (const sf of files) checked.add(path.resolve(sf.fileName));
    for (const sf of files) {
      // Only files SCIP indexes can match a definition (see indexedFiles above).
      if (rootsKnown && !indexedFiles.has(path.resolve(sf.fileName))) continue;
      ambient.push(...collectAmbientDeclarations(sf, toRepoRel));
    }
    const r = checkConsumerFiles(files, checker, input.orgPackageNames, toRepoRel, input.orgPackageDirs);
    consumer.unresolvedOrgModules.push(...r.unresolvedOrgModules);
    consumer.unresolvedImports.push(...r.unresolvedImports);
    consumer.flags.push(...r.flags);
    consumer.namespaceMemberRefs.push(...r.namespaceMemberRefs);
    consumer.shorthandRefs.push(...r.shorthandRefs);
    consumer.namespaceSpreadRefs.push(...r.namespaceSpreadRefs);
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
    } else if (isDeepDistImport(m.module)) {
      // A deep dist import (`hono/dist/types/router`) is a private-path import
      // of build output: the checkout has no dist/ and we cannot map its members
      // to source declarations. Blocking every verdict of this consumer (partial)
      // for it is disproportionate; it is recorded in `unresolvedImports` (name
      // `*`) instead, so it surfaces as version skew on the target package.
      consumer.unresolvedImports.push({ module: m.module, name: '*', file: m.file, line: m.line, col: m.col });
      diagnostics.push(`warn: unresolved deep dist import ${where} (private build-output path; recorded as unresolved import '*', status unaffected)`);
    } else {
      partial = true;
      diagnostics.push(`error: unresolved org module ${where}`);
    }
  }
  for (const u of consumer.unresolvedImports) {
    if (u.name === '*') continue; // deep dist import, reported above
    diagnostics.push(`warn: '${u.name}' is not exported by org module '${u.module}' at ${u.file}:${u.line + 1}:${u.col + 1}`);
  }
  const flags = consumer.flags.filter((f) => !excluded(f));
  for (const f of consumer.flags) {
    diagnostics.push(
      `warn: ${f.flag} at ${f.file}:${f.line + 1}:${f.col + 1}: ${f.reason}` +
        (f.targetPackage !== undefined ? ` (targets ${f.targetPackage})` : '') +
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
    ...(input.ignoredDirs !== undefined ? { ignoredDirs: input.ignoredDirs } : {}),
    indexedFiles,
    orgPackageNames: input.orgPackageNames,
    selfName: input.packageName ?? null,
    policy: input.policy,
  });
  for (const u of unindexedImports) {
    diagnostics.push(`warn: ${u.file} is in no tsconfig and imports org module '${u.module}' (unindexed consumer of ${u.targetPackage})`);
  }

  if (skipped.bindings > 0) {
    diagnostics.push(`info: ${skipped.bindings} export(s) declared by destructuring (\`export const { a } = ...\`) not recorded: scip-typescript defines them as locals`);
  }
  if (skipped.typedefs > 0) diagnostics.push(`info: ${skipped.typedefs} JSDoc @typedef/@callback export(s) not recorded: scip-typescript does not index JSDoc`);
  if (skipped.expandos > 0) diagnostics.push(`info: ${skipped.expandos} expando assignment declaration(s) (\`fn.prop = ...\`) not recorded`);
  if (skipped.json.size > 0) diagnostics.push(`info: exports declared in JSON modules not recorded: ${[...skipped.json].sort().join(', ')}`);

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
  // Ambient contributions (see collectAmbientDeclarations): top-level `.d.ts`
  // declarations already on the export surface stay ordinary exports.
  const exportedAt = new Set(exports.map((e) => `${e.file}:${e.line}:${e.col}`));
  const entrySymbols = ambient
    .filter((a) => !(a.dts && exportedAt.has(`${a.file}:${a.line}:${a.col}`)))
    .map(({ file, line, col, name }) => ({ file, line, col, name }))
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || a.col - b.col);
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
      shorthandRefs: consumer.shorthandRefs,
      namespaceSpreadRefs: consumer.namespaceSpreadRefs,
      unindexedImports,
      entrySymbols,
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

/**
 * Declarations that contribute to another scope rather than being used by
 * reference, so they can never be "unreachable":
 *  - everything inside an ambient module augmentation (`declare module 'x' {}`)
 *    or a global augmentation (`declare global {}`), at any nesting, plus the
 *    module declaration's own name: they merge into the augmented module or the
 *    global scope, which consumes them;
 *  - top-level declarations of a `.d.ts` file (`declare const process`,
 *    `declare namespace JSX`): ambient script declarations. `dts: true` marks
 *    them so the caller drops those that are on the export surface. A
 *    declaration with `export` in a module `.d.ts` is imported like any other
 *    and is not included.
 * Members of ordinary namespaces are not included; members of recorded
 * declarations are reachable through their owner.
 */
function collectAmbientDeclarations(
  sf: ts.SourceFile,
  toRepoRel: (abs: string) => string,
): Array<SourcePosition & { name: string; dts: boolean }> {
  const out: Array<SourcePosition & { name: string; dts: boolean }> = [];
  const add = (nameNode: ts.Node, name: string, dts: boolean): void => {
    out.push({ ...position(sf, nameNode.getStart(sf), toRepoRel), name, dts });
  };
  const isAmbientModule = (s: ts.Statement): s is ts.ModuleDeclaration =>
    ts.isModuleDeclaration(s) && (ts.isStringLiteral(s.name) || (s.flags & ts.NodeFlags.GlobalAugmentation) !== 0);
  /** Names declared by one statement (with the name node), not descending into bodies. */
  const declared = (s: ts.Statement): Array<[ts.Node, string]> => {
    if (ts.isVariableStatement(s)) {
      return s.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => [d.name, (d.name as ts.Identifier).text]);
    }
    if (
      ts.isFunctionDeclaration(s) ||
      ts.isClassDeclaration(s) ||
      ts.isInterfaceDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      ts.isEnumDeclaration(s) ||
      ts.isModuleDeclaration(s)
    ) {
      if (s.name === undefined) return []; // `export default class {}`
      return [[s.name, s.name.text]];
    }
    return [];
  };
  /** Every declaration inside an ambient module body, at any nesting. */
  const visitAmbient = (m: ts.ModuleDeclaration): void => {
    add(m.name, m.name.text, false);
    let body = m.body;
    // `declare module 'x' { namespace A.B {} }` nests bodies as ModuleDeclarations.
    while (body !== undefined && ts.isModuleDeclaration(body)) {
      add(body.name, body.name.text, false);
      body = body.body;
    }
    if (body === undefined || !ts.isModuleBlock(body)) return;
    for (const s of body.statements) {
      if (ts.isModuleDeclaration(s)) {
        visitAmbient(s);
        continue;
      }
      for (const [node, name] of declared(s)) add(node, name, false);
    }
  };
  const dts = sf.isDeclarationFile;
  for (const s of sf.statements) {
    if (isAmbientModule(s)) {
      visitAmbient(s);
    } else if (dts && !hasExportModifier(s)) {
      // An exported declaration of a module `.d.ts` is imported by reference like any other.
      for (const [node, name] of declared(s)) add(node, name, true);
    }
  }
  return out;
}

function hasExportModifier(s: ts.Statement): boolean {
  return ts.canHaveModifiers(s) && (ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
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

/**
 * `decls` with every import/export alias declaration replaced by the
 * declarations it resolves to. A symbol merged from an import and a local
 * value (`import type { T } from './types'; const { T } = f(); export { T }`)
 * keeps the import specifier among its declarations, and SCIP has only a
 * reference there; the definition is the imported declaration.
 */
function expandAliasDeclarations(decls: readonly ts.Declaration[], checker: ts.TypeChecker): ts.Declaration[] {
  const out: ts.Declaration[] = [];
  const seen = new Set<ts.Node>();
  const visit = (d: ts.Declaration, depth: number): void => {
    if (seen.has(d)) return;
    seen.add(d);
    const isAlias =
      ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d) || ts.isExportSpecifier(d) || ts.isImportEqualsDeclaration(d);
    if (!isAlias) {
      out.push(d);
      return;
    }
    const name = ts.getNameOfDeclaration(d);
    const sym = name !== undefined ? checker.getSymbolAtLocation(name) : undefined;
    if (sym === undefined || depth > 10) return;
    const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    for (const t of target.declarations ?? []) if (!ts.isSourceFile(t)) visit(t, depth + 1);
  };
  for (const d of decls) visit(d, 0);
  return out;
}

/**
 * A declaration added by an expando assignment (`fn.prop = x`,
 * `Object.defineProperty(fn, ...)`), not a declaration statement.
 */
function isExpandoDeclaration(decl: ts.Node): boolean {
  return (
    ts.isIdentifier(decl) ||
    ts.isPropertyAccessExpression(decl) ||
    ts.isElementAccessExpression(decl) ||
    ts.isBinaryExpression(decl) ||
    ts.isCallExpression(decl)
  );
}

/** True when an org module specifier reaches into the package's `dist/` (`hono/dist/types/router`). */
function isDeepDistImport(spec: string): boolean {
  const name = barePackageName(spec);
  return name !== undefined && /^\/(?:.*\/)?dist(?:\/|$)/.test(spec.slice(name.length));
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
