// Export-surface sidecar for TypeScript/JavaScript packages.
//
// SCIP carries no export information (non-exported top-level functions get
// global symbols too), so this reads the package's export surface with the
// TypeScript compiler API: the same typescript major/minor scip-typescript
// bundles (5.9.3), so symbol resolution agrees with the `.scip` file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import {
  barePackageName,
  checkConsumerFiles,
  collectRequireAliasRefs,
  importedNames,
  isExcludedConsumerFile,
  isGeneratedFile,
  scanOwnModuleLoads,
  scanUnindexedImports,
  unindexedScope,
  walkPackageFiles,
  type AliasConfig,
  type ConsumerCheckResult,
  type OrgPackageDir,
  type OwnLoadGap,
  type OwnModuleLoad,
} from './consumer-checks.ts';
import type { ConsumerPolicy, DeepImportExport, EntrySymbol, ExportRecord, ExportsSidecar, ShorthandRef, SourcePosition, UnindexedImport } from './types.ts';

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
  /**
   * discover.json `runtimeEntryPoints` (repo-relative POSIX): files the runtime or a
   * tool loads (`node scripts/x.mjs` scripts, Dockerfile CMD, Next.js
   * `next.config.*`, `bin`, `imports` arms, client entries). They seed reachability
   * but are never export surface: one outside the TypeScript program is not a
   * missing surface (never `partial`), and an unresolved re-export in one is a
   * diagnostic only. The entries of `entryPoints` that are not in this list are the
   * package's surface.
   */
  runtimeEntryPoints?: string[];
  /**
   * Absolute path of the sentei-written runtime tsconfig (scip-typescript.ts
   * RUNTIME_TSCONFIG): runtime
   * entries outside the package's own programs, indexed by scip-typescript as an
   * extra project. Read as one more program; absent when there is none.
   */
  runtimeTsconfig?: string;
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

/**
 * Why the loaded `typescript` cannot compute the surface, or null: any major but 5 (the
 * one scip-typescript 0.4.0 bundles). The root node_modules holds TypeScript 7, whose
 * package has no compiler API; without the CLI's nested
 * packages/cli/node_modules/typescript (a checkout without `npm ci`) the import found
 * it and failed later with "ts.getParsedCommandLineOfConfigFile is not a function".
 */
export function typescriptVersionProblem(version: string | undefined, resolvedPath: string): string | null {
  if (version !== undefined && /^5\./.test(version)) return null;
  return `the export surface needs TypeScript 5 (the major scip-typescript 0.4.0 bundles), but "typescript" resolved to `
    + `${resolvedPath} (version ${version ?? 'unknown'}); run \`npm ci\` so that packages/cli/node_modules/typescript (5.9.3) is installed`;
}

function assertTypescript5(): void {
  const version = (ts as { version?: unknown }).version;
  let resolved = '(unresolvable)';
  try {
    resolved = createRequire(import.meta.url).resolve('typescript');
  } catch {
    /* keep the placeholder */
  }
  const problem = typescriptVersionProblem(typeof version === 'string' ? version : undefined, resolved);
  if (problem !== null) throw new Error(`sentei: ${problem}`);
}

export function computeExportSurface(input: ExportSurfaceInput): ExportSurfaceResult {
  assertTypescript5();
  const diagnostics: string[] = [];
  let partial = false;
  /**
   * The diagnostic that made the result partial (the first one), repeated at the end
   * as a `cause: <diagnostic>` line: ingest uses it as the `opaque_consumer` reason
   * instead of whatever diagnostic happens to come first.
   */
  let cause: string | undefined;
  const markPartial = (diag: string): void => {
    partial = true;
    cause ??= diag;
  };
  const unresolved = new Set<string>();
  /** Unresolved re-exports of runtime entries: not surface, so diagnostics only. */
  const runtimeUnresolved = new Set<string>();
  const runtimeEntries = new Set(input.runtimeEntryPoints ?? []);
  const toRepoRel = (abs: string): string =>
    path.relative(input.repoRoot, abs).split(path.sep).join(path.posix.sep);

  const aliasConfigs: AliasConfig[] = [];
  const specs = createPrograms(input, diagnostics, aliasConfigs);
  if (specs === undefined) {
    const why = diagnostics.find((d) => d.startsWith('error:')) ?? 'error: the tsconfig cannot be read';
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
        generatedFiles: [],
        entrySymbols: [],
      },
      diagnostics: [...diagnostics, `cause: ${why}`],
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
  /** `entry#exportedAs` of exports whose declaration lives outside the package. */
  const external = new Set<string>();

  const exports: ExportRecord[] = [];
  const readEntry = (entry: string, sf: ts.SourceFile, checker: ts.TypeChecker, unresolved: Set<string>): void => {
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
        // An alias that resolves to nothing (`unknown` symbol): unknown surface.
        // Any other declaration-less symbol is an intrinsic outside the package
        // (`export default globalThis`, `undefined`, `arguments`): like a
        // re-export of a lib or node_modules declaration, it is not a record,
        // and consumers resolve to that external symbol.
        if (checker.isUnknownSymbol(target)) unresolved.add(`${entry}#${exportedAs}`);
        else external.add(`${entry}#${exportedAs}`);
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
      const expanded = expandAliasDeclarations(decls, checker);
      if (expanded.length > 0 && expanded.every((d) => !isOwnFile(d.getSourceFile().fileName))) {
        // Declared outside the package (TypeScript lib, node_modules, another org
        // package): not this package's surface, and not unresolved either.
        external.add(`${entry}#${exportedAs}`);
        continue;
      }
      for (const decl of expanded) {
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
  const ambient: Array<SourcePosition & { name: string; dts?: string }> = [];
  const checked = new Set<string>();
  const pending = new Map(input.entryPoints.map((e) => [e, path.resolve(input.repoRoot, ...e.split('/'))] as const));
  const found = new Set<string>();
  /** Deep-import surface of other org packages, keyed by JSON (dedupes across programs). */
  const deepImportExports = new Map<string, DeepImportExport>();

  // Own code and SFC files outside UNINDEXED_SKIP_DIRS, nested packages and ignored manifests.
  const walked = walkPackageFiles({
    repoRoot: input.repoRoot,
    pkgDir: input.pkgDir,
    nestedPackageDirs: input.nestedPackageDirs,
    ...(input.ignoredDirs !== undefined ? { ignoredDirs: input.ignoredDirs } : {}),
  });
  // Loads of the package's own modules that no index links (round 8d): its unbuilt build
  // output named by a bin or script (`import('./dist/index.js')`), and string entries a
  // framework resolves (`serverEntrypoint: '<self>/server.js'`). Resolved per program below.
  const ownLoads = collectOwnLoads(input, walked, isOwnFile);
  const pendingLoads = new Map<string, OwnModuleLoad[]>();
  for (const l of ownLoads.loads) {
    for (const t of l.targets) pendingLoads.set(t, [...(pendingLoads.get(t) ?? []), l]);
  }
  // Next.js app-router files under a dot directory (round 9b; nextDotDirEntries): Next
  // serves them, so every export is a runtime entry symbol, as for the router files
  // discover lists (those need nothing here).
  for (const abs of nextDotDirEntries(input.pkgDir, input.nestedPackageDirs)) {
    const file = toRepoRel(abs);
    if (runtimeEntries.has(file)) continue;
    const t = path.resolve(abs);
    pendingLoads.set(t, [...(pendingLoads.get(t) ?? []), { file, line: 0, col: 0, spec: 'Next.js app router', targets: [t], kind: 'string' }]);
  }
  /** Runtime entry symbols and references from own-module loads (merged into the sidecar). */
  const loadEntrySymbols: Array<SourcePosition & { name: string }> = [];
  const loadRefs: ShorthandRef[] = [];
  const entryFiles = new Set([...input.entryPoints, ...runtimeEntries]);
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
    const r = checkConsumerFiles(files, checker, input.orgPackageNames, toRepoRel, input.orgPackageDirs, input.packageName ?? null);
    consumer.unresolvedOrgModules.push(...r.unresolvedOrgModules);
    consumer.unresolvedImports.push(...r.unresolvedImports);
    consumer.flags.push(...r.flags);
    consumer.namespaceMemberRefs.push(...r.namespaceMemberRefs);
    consumer.shorthandRefs.push(...r.shorthandRefs);
    consumer.namespaceSpreadRefs.push(...r.namespaceSpreadRefs);
    if (input.packageName !== undefined && input.packageName !== null) {
      // Only files SCIP indexes have the variable's definition (see indexedFiles above).
      const indexed = rootsKnown ? files.filter((sf) => indexedFiles.has(path.resolve(sf.fileName))) : files;
      consumer.shorthandRefs.push(...collectRequireAliasRefs(indexed, checker, input.pkgDir, input.packageName, toRepoRel));
    }
    collectDeepImportExports(files, checker, input.orgPackageDirs, input.packageName ?? null, deepImportExports);
    // Dynamic imports of own modules TypeScript resolves (round 9b): SCIP links the module,
    // not the names the import's result is used by (`dynamic(() => import('./dialog'))`
    // renders its default export).
    if (input.packageName !== undefined && input.packageName !== null) {
      const indexed = rootsKnown ? files.filter((sf) => indexedFiles.has(path.resolve(sf.fileName))) : files;
      collectDynamicImportRefs(indexed, checker, {
        isOwnFile, toRepoRel, pkgDir: input.pkgDir, selfName: input.packageName, diagnostics,
        refsFrom: () => true, isEntryLoad: () => false, entrySymbols: loadEntrySymbols, refs: loadRefs,
      });
    }
    for (const [target, loads] of pendingLoads) {
      const sf = program.getSourceFile(target);
      if (sf === undefined) continue;
      pendingLoads.delete(target);
      if (rootsKnown && !indexedFiles.has(path.resolve(sf.fileName))) {
        diagnostics.push(`info: ${loads.map((l) => `${l.file}:${l.line + 1}:${l.col + 1}`).join(', ')} load ${toRepoRel(target)}, which no tsconfig lists (scip-typescript did not index it)`);
        continue;
      }
      resolveOwnLoads(sf, loads, checker, {
        isOwnFile, toRepoRel, pkgDir: input.pkgDir, selfName: input.packageName ?? null, diagnostics,
        // References only from files SCIP indexes (they must be documents); entry symbols
        // for runtime or tool loads and for loads from files no index has.
        refsFrom: (file) => rootsKnown && indexedFiles.has(path.resolve(input.repoRoot, ...file.split('/'))),
        isEntryLoad: (l) => l.scope !== 'test' && l.scope !== 'docs'
          && (l.kind === 'string' || entryFiles.has(l.file) || !(rootsKnown && indexedFiles.has(path.resolve(input.repoRoot, ...l.file.split('/'))))),
        entrySymbols: loadEntrySymbols,
        refs: loadRefs,
      });
    }
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
      readEntry(entry, sf, checker, runtimeEntries.has(entry) ? runtimeUnresolved : unresolved);
    }
  }
  if (specs.length > 1) {
    diagnostics.push(`info: export surface read from ${specs.length} tsconfig projects (tsconfig + project references)`);
  }

  // Test/docs files that the policy does not count as consumers: analyze ignores
  // their references, so neither an unresolved org module nor a dynamic construct
  // there can hide a counted use.
  const pkgLocation = { manager: 'npm', path: toRepoRel(path.resolve(input.pkgDir)) || '.' };
  const excluded = (f: { file: string }): boolean => isExcludedConsumerFile(f.file, input.policy, pkgLocation);
  const selfName = input.packageName ?? null;
  /** Program files importing this package by its own name where that does not resolve. */
  const unresolvedSelf: UnindexedImport[] = [];
  for (const m of consumer.unresolvedOrgModules) {
    const where = `'${m.module}' at ${m.file}:${m.line + 1}:${m.col + 1}`;
    if (selfName !== null && barePackageName(m.module) === selfName) {
      // The package importing itself by name (`import('env-runner/runners/node')`,
      // an example's `vite.config.ts` importing the package): SCIP links nothing,
      // but no other package's use is hidden. Recorded like an unindexed file's
      // import of the package (core's self-witness reads the file), never partial.
      const scope = unindexedScope(m.file, pkgLocation);
      if (!unresolvedSelf.some((u) => u.file === m.file && u.module === m.module)) {
        unresolvedSelf.push({ file: m.file, module: m.module, targetPackage: selfName, ...(scope !== undefined ? { scope } : {}) });
      }
      diagnostics.push(`warn: unresolved self import ${where} (the package imports itself by name; recorded as an unindexed import of ${selfName}, status unaffected)`);
    } else if (excluded(m)) {
      diagnostics.push(`warn: unresolved org module ${where} (test/docs file, not a counted consumer; status unaffected)`);
    } else if (isDeepDistImport(m.module)) {
      // A deep dist import (`hono/dist/types/router`) is a private-path import
      // of build output. The shadow package links it to its source when
      // sourceForBuildOutput maps it (scip-typescript.ts `deepImportLinks`), so
      // this one has no source: we cannot see which members it uses. Blocking
      // every verdict of this consumer (partial) for it is disproportionate; it
      // is recorded in `unresolvedImports` (name `*`, a diagnostic) and as an
      // `opaque_consumer` flag targeted at the package, which blocks that
      // package's verdicts only (fail closed: its members may be used here).
      consumer.unresolvedImports.push({ module: m.module, name: '*', file: m.file, line: m.line, col: m.col });
      const target = barePackageName(m.module);
      if (target !== undefined) {
        consumer.flags.push({
          flag: 'opaque_consumer', reason: `deep import ${m.module} has no source`, targetPackage: target,
          file: m.file, line: m.line, col: m.col,
        });
      }
      diagnostics.push(`warn: unresolved deep dist import ${where} (private build-output path with no source; recorded as unresolved import '*' and a targeted opaque_consumer flag)`);
    } else {
      const diag = `error: unresolved org module ${where}`;
      markPartial(diag);
      diagnostics.push(diag);
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

  // Own-module loads: targets no program has, and build output that no source maps to.
  for (const [target, loads] of pendingLoads) {
    diagnostics.push(`info: ${loads.map((l) => `${l.file}:${l.line + 1}:${l.col + 1}`).join(', ')} load ${toRepoRel(target)}, which is in no TypeScript program (nothing to seed)`);
  }
  for (const g of ownLoads.gaps) {
    const where = `${g.file}:${g.line + 1}:${g.col + 1}`;
    if (g.scope === 'test' || g.scope === 'docs') {
      diagnostics.push(`warn: ${where} loads '${g.spec}', the package's own build output with no source (${g.scope} file, not a counted consumer; status unaffected)`);
      continue;
    }
    const diag = `error: ${where} loads '${g.spec}', the package's own unbuilt build output, which no source maps to (what it uses is unknown)`;
    markPartial(diag);
    diagnostics.push(diag);
  }
  for (const l of ownLoads.loads) {
    diagnostics.push(`info: ${l.file}:${l.line + 1}:${l.col + 1} loads own module ${l.targets.map(toRepoRel).join(', ')} ('${l.spec}'${l.kind === 'string' ? ', a string entry' : ''})`);
  }

  // Code files no program indexes (scip-typescript indexes exactly each config's
  // root files) and SFC files (never indexed).
  const scanned = scanUnindexedImports({
    repoRoot: input.repoRoot,
    pkgDir: input.pkgDir,
    nestedPackageDirs: input.nestedPackageDirs,
    indexedFiles,
    orgPackageNames: input.orgPackageNames,
    selfName,
    files: walked,
    // The package's own tsconfig `paths` (the first config that declares any: the root, then its references).
    ...(aliasConfigs[0] !== undefined ? { aliases: aliasConfigs[0] } : {}),
    orgPackageDirs: input.orgPackageDirs,
  });
  for (const u of scanned) {
    const scoped = u.scope !== undefined ? ` (${u.scope} file: witness only)` : '';
    diagnostics.push(
      u.unresolved === true
        ? `warn: ${u.file} loads ${u.module}, which names no file of the package (alias or glob sentei cannot resolve): `
          + `its entry set is incomplete, no private_dead for it${scoped}`
        : u.relative === true
        ? `info: ${u.file} loads own file ${u.module} (not indexed importer, alias, <script src> or import.meta.glob)${scoped}`
        : u.targetPackage === selfName
          ? `info: ${u.file} is in no tsconfig and imports this package by name ('${u.module}'; self-witness)${scoped}`
          : `warn: ${u.file} is in no tsconfig and imports org module '${u.module}' (unindexed consumer of ${u.targetPackage})${scoped}`,
    );
  }
  // A runtime / tool load from a file that is no entry point of the package (a string
  // entry in `astro.config.mjs` or an integration's source, a script outside every
  // program) is also recorded as an own-file load (`relative`): ingest's `unindexed_loads`
  // row keeps the entry symbols it adds from making the package's entry set credible for
  // private_dead (an app whose real roots sentei cannot see stays skipped, fail closed),
  // and the loaded module's private top-level declarations are kept as well.
  const loadRecords: UnindexedImport[] = [];
  if (selfName !== null) {
    for (const l of ownLoads.loads) {
      if (l.scope === 'test' || l.scope === 'docs' || entryFiles.has(l.file)) continue;
      const indexedFrom = rootsKnown && indexedFiles.has(path.resolve(input.repoRoot, ...l.file.split('/')));
      if (l.kind !== 'string' && indexedFrom) continue; // an import from indexed code: references only
      for (const t of l.targets) {
        loadRecords.push({ file: l.file, module: toRepoRel(t), targetPackage: selfName, relative: true, ...(l.scope !== undefined ? { scope: l.scope } : {}) });
      }
    }
  }
  const unindexedImports = [...new Map([...scanned, ...unresolvedSelf, ...loadRecords]
    .map((u) => [`${u.file}\0${u.module}\0${u.relative === true ? 'r' : ''}${u.unresolved === true ? 'u' : ''}`, u])).values()]
    .sort((a, b) => cmp(a.file, b.file) || cmp(a.module, b.module));

  // Generated own files: every walked file plus every own file of the programs
  // (a program may hold files the walk skips, e.g. Nuxt's `.nuxt/*.d.ts`).
  const generatedFiles = [...new Set([...walked, ...checked].map((abs) => path.resolve(abs)))]
    .map((abs) => [abs, toRepoRel(abs)] as const)
    .filter(([abs, rel]) => isGeneratedFile(abs, rel, pkgLocation.path))
    .map(([, rel]) => rel)
    .sort(cmp);
  if (generatedFiles.length > 0) {
    diagnostics.push(`info: ${generatedFiles.length} generated file(s) (header or path): ${generatedFiles.slice(0, 5).join(', ')}${generatedFiles.length > 5 ? ', ...' : ''}`);
  }

  if (skipped.bindings > 0) {
    diagnostics.push(`info: ${skipped.bindings} export(s) declared by destructuring (\`export const { a } = ...\`) not recorded: scip-typescript defines them as locals`);
  }
  if (skipped.typedefs > 0) diagnostics.push(`info: ${skipped.typedefs} JSDoc @typedef/@callback export(s) not recorded: scip-typescript does not index JSDoc`);
  if (skipped.expandos > 0) diagnostics.push(`info: ${skipped.expandos} expando assignment declaration(s) (\`fn.prop = ...\`) not recorded`);
  if (external.size > 0) {
    const list = [...external].sort();
    diagnostics.push(
      `info: ${list.length} export(s) resolve to declarations outside the package (lib, node_modules or another org package), not recorded: ` +
        `${list.slice(0, 5).join(', ')}${list.length > 5 ? ', ...' : ''}`,
    );
  }
  if (skipped.json.size > 0) diagnostics.push(`info: exports declared in JSON modules not recorded: ${[...skipped.json].sort().join(', ')}`);

  const entryPoints = input.entryPoints.filter((e) => found.has(e));
  const missingEntryPoints = input.entryPoints.filter((e) => !found.has(e));
  // A runtime entry (a `node scripts/x.mjs` script, `next.config.mjs`, a Dockerfile
  // CMD) is run, never imported: it seeds reachability but is no export surface. One
  // outside every program (the runtime tsconfig could not take it) is text-scanned for
  // org imports like any unindexed file (unindexedImports below); nothing about the
  // package's surface is unknown, so it never makes the result partial.
  const missingRuntime = missingEntryPoints.filter((e) => runtimeEntries.has(e));
  const missingSurface = missingEntryPoints.filter((e) => !runtimeEntries.has(e));
  if (missingRuntime.length > 0) {
    diagnostics.push(`info: runtime entry point(s) not in any TypeScript program (not export surface; their imports are text-scanned, status unaffected): ${missingRuntime.join(', ')}`);
  }
  if (runtimeUnresolved.size > 0) {
    diagnostics.push(`warn: unresolved re-exports of runtime entry points (not export surface; status unaffected): ${[...runtimeUnresolved].join(', ')}`);
  }

  if (missingSurface.length > 0) {
    // A plain JavaScript entry (`lib/mock.cjs`, a `.mjs` bin) the program excludes:
    // its exports are read by a text scan and recorded as unresolved surface (SCIP
    // has no symbol for them). Declaration entries (`.d.cts`) stay unknown.
    const other: string[] = [];
    for (const entry of missingSurface) {
      const abs = path.resolve(input.repoRoot, ...entry.split('/'));
      const names = PLAIN_JS_ENTRY.test(entry) && existsSync(abs) ? scanJsExportNames(abs) : undefined;
      if (names === undefined) {
        other.push(entry);
        continue;
      }
      const why = 'JavaScript entry outside the tsconfig program';
      if (names.length === 0) unresolved.add(`${entry} (${why}; no exports found by text scan)`);
      for (const name of names) unresolved.add(`${entry}#${name} (${why})`);
      const diag = `warn: entry ${entry} is JavaScript outside the tsconfig program; add it to include (exports: ${names.length > 0 ? names.join(', ') : 'none found'})`;
      markPartial(diag);
      diagnostics.push(diag);
    }
    if (other.length > 0) {
      const diag = `warn: entry point(s) not in the TypeScript program, export surface unknown: ${other.join(', ')}`;
      markPartial(diag);
      diagnostics.push(diag);
    }
  }
  if (unresolved.size > 0) {
    const diag = `warn: unresolved re-exports: ${[...unresolved].join(', ')}`;
    markPartial(diag);
    diagnostics.push(diag);
  }
  if (cause !== undefined) diagnostics.push(`cause: ${cause}`);

  exports.sort(
    (a, b) =>
      cmp(a.entry, b.entry) || cmp(a.exportedAs, b.exportedAs) || cmp(a.file, b.file) || a.line - b.line || a.col - b.col,
  );
  // Ambient contributions (see collectAmbientDeclarations): top-level `.d.ts`
  // declarations already on the export surface (and their namespace members)
  // stay ordinary exports.
  const exportedAt = new Set(exports.map((e) => `${e.file}:${e.line}:${e.col}`));
  const entryAt = new Map<string, EntrySymbol>();
  for (const { file, line, col, name } of ambient.filter((a) => !(a.dts !== undefined && exportedAt.has(a.dts)))) {
    entryAt.set(`${file}:${line}:${col}`, { file, line, col, name, kind: 'ambient' });
  }
  // Declarations an own-module load hands to a runtime or tool (runtime wins over ambient).
  for (const { file, line, col, name } of loadEntrySymbols) entryAt.set(`${file}:${line}:${col}`, { file, line, col, name, kind: 'runtime' });
  const entrySymbols = [...entryAt.values()].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || a.col - b.col);
  const refKey = (r: ShorthandRef): string => `${r.file}:${r.line}:${r.col}:${r.targetFile}:${r.targetLine}:${r.targetCol}`;
  const shorthandRefs = [...new Map([...consumer.shorthandRefs, ...loadRefs].map((r) => [refKey(r), r])).values()];
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
      shorthandRefs,
      namespaceSpreadRefs: consumer.namespaceSpreadRefs,
      unindexedImports,
      generatedFiles,
      entrySymbols,
      deepImportExports: [...deepImportExports.values()].sort(
        (a, b) =>
          cmp(a.targetPackage, b.targetPackage) || cmp(a.entry, b.entry) || cmp(a.exportedAs, b.exportedAs) || cmp(a.file, b.file) || cmp(a.name, b.name),
      ),
    },
    diagnostics,
    partial,
  };
}

/** A JavaScript entry file (not a declaration file) that a program could contain. */
const PLAIN_JS_ENTRY = /\.(?:[cm]?js|jsx)$/;

/**
 * Export names of a JavaScript file found by a text scan (ESM `export`
 * statements and CommonJS `exports.x =` / `module.exports =`), sorted and
 * deduplicated; `default` for a default export or `module.exports = ...`,
 * `* from '<m>'` for a star re-export. Undefined when the file cannot be read.
 */
export function scanJsExportNames(abs: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
  const names = new Set<string>();
  const each = (re: RegExp, f: (m: RegExpMatchArray) => void): void => {
    for (const m of text.matchAll(re)) f(m);
  };
  each(/\bexport\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g, (m) => names.add(m[1]!));
  each(/\bexport\s+(?:const|let|var|class)\s+([\w$]+)/g, (m) => names.add(m[1]!));
  each(/\bexport\s+default\b/g, () => names.add('default'));
  each(/\bexport\s*\{([^}]*)\}/g, (m) => {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && /^[\w$]+$/.test(name)) names.add(name);
    }
  });
  each(/\bexport\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*['"]([^'"\n]+)['"]/g, (m) => names.add(m[1] ?? `* from '${m[2]}'`));
  each(/\b(?:module\.)?exports\.([\w$]+)\s*=[^=]/g, (m) => names.add(m[1]!));
  each(/\b(?:module\.)?exports\[\s*['"]([^'"\n]+)['"]\s*\]\s*=[^=]/g, (m) => names.add(m[1]!));
  each(/Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*['"]([^'"\n]+)['"]/g, (m) => names.add(m[1]!));
  each(/\bmodule\.exports\s*=[^=]/g, () => names.add('default'));
  names.delete('__esModule');
  return [...names].sort(cmp);
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

function createPrograms(
  input: Pick<ExportSurfaceInput, 'tsconfig' | 'pkgDir' | 'repoRoot' | 'entryPoints' | 'runtimeTsconfig'>,
  diagnostics: string[],
  /** Receives the `paths` of each visited config that declares any (root first). */
  aliasOut?: AliasConfig[],
): ProgramSpec[] | undefined {
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
      const alias = aliasConfigOf(parsed.options, key);
      if (alias !== undefined) aliasOut?.push(alias);
      if (parsed.fileNames.length > 0) {
        const { fileNames, options } = parsed;
        programs.push({ rootNames: fileNames, create: () => ts.createProgram({ rootNames: fileNames, options: { ...options, noEmit: true } }) });
      }
      for (const ref of parsed.projectReferences ?? []) visit(ts.resolveProjectReferencePath(ref), false);
      return true;
    };
    if (!visit(input.tsconfig, true)) return undefined;
    // The runtime tsconfig (scip-typescript indexes it as one more project, after the
    // package's own): last, so an entry file in both is read from the package's program.
    if (input.runtimeTsconfig !== undefined && existsSync(input.runtimeTsconfig)) visit(input.runtimeTsconfig, false);
    return programs;
  }
  // No tsconfig: default options from the entry files (allowJs so JS entries load).
  const rootNames = input.entryPoints.map((e) => path.resolve(input.repoRoot, ...e.split('/')));
  diagnostics.push('info: export surface computed from entry files with default compiler options');
  const options = { ...ts.getDefaultCompilerOptions(), allowJs: true, noEmit: true };
  return [{ rootNames, create: () => ts.createProgram({ rootNames, options }) }];
}

/**
 * A config's `compilerOptions.paths` with absolute substitutions: relative to `baseUrl`
 * when set, else to the directory of the config that declared `paths` (TypeScript's
 * internal `pathsBasePath`, which follows `extends`), else to this config's directory.
 */
function aliasConfigOf(options: ts.CompilerOptions, configFile: string): AliasConfig | undefined {
  if (options.paths === undefined) return undefined;
  const base = options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? path.dirname(configFile);
  return {
    paths: Object.entries(options.paths).map(([pattern, targets]) => ({
      pattern,
      targets: targets.map((t) => path.resolve(base, t)),
    })),
  };
}

/** Next.js app-router files served from any segment directory (route handlers, pages, layouts). */
const NEXT_ROUTER_FILE = /^(?:route|page|layout)\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Next.js app-router files under a dot directory of the package's `app/` or `src/app/`
 * (`app/.well-known/jwks.json/route.ts`): Next serves them like any other segment, but
 * TypeScript's `**\/*` include skips dot directories, so they are outside the program,
 * and discover's convention globs skip dot directories as well. Only for a package that
 * depends on `next`; nested packages and node_modules are not walked. Absolute, sorted.
 * The adapter lists them in the runtime tsconfig's `files`, and the export surface makes
 * their exports runtime entry symbols (computeExportSurface), like the router files
 * discover already knows.
 */
export function nextDotDirEntries(pkgDir: string, nestedPackageDirs: readonly string[] = []): string[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const deps = ['dependencies', 'devDependencies', 'peerDependencies']
    .some((k) => typeof manifest[k] === 'object' && manifest[k] !== null && 'next' in (manifest[k] as object));
  if (!deps) return [];
  const nested = nestedPackageDirs.map((d) => path.resolve(d));
  const out: string[] = [];
  const walk = (dir: string, underDot: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || nested.includes(abs)) continue;
        walk(abs, underDot || e.name.startsWith('.'));
      } else if (underDot && e.isFile() && NEXT_ROUTER_FILE.test(e.name)) {
        out.push(abs);
      }
    }
  };
  for (const app of ['app', 'src/app']) walk(path.join(path.resolve(pkgDir), ...app.split('/')), false);
  return out.sort(cmp);
}

/** A file extension TypeScript can take as a program root with allowJs (no declaration files). */
const PROGRAM_EXT = /(?<!\.d)\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * The absolute files of `candidates` (absolute) that the programs of `tsconfig` (and
 * its project references) do not have as root files, that exist, and that TypeScript
 * can load (`.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`, not `.d.ts`).
 * These are the runtime entries scip-typescript would otherwise not index. Sorted.
 */
export function filesOutsidePrograms(
  tsconfig: string, pkgDir: string, candidates: readonly string[], opts: { declarations?: boolean } = {},
): string[] {
  assertTypescript5();
  const specs = createPrograms({ tsconfig, pkgDir, repoRoot: pkgDir, entryPoints: [] }, []);
  if (specs === undefined) return []; // an unreadable tsconfig: scip-typescript reports it
  const roots = new Set(specs.flatMap((s) => s.rootNames.map((f) => path.resolve(f))));
  return [...new Set(candidates.map((f) => path.resolve(f)))]
    .filter((f) => (PROGRAM_EXT.test(f) || (opts.declarations === true && /\.d\.[cm]?ts$/.test(f))) && !roots.has(f) && existsSync(f))
    .sort(cmp);
}

/**
 * Whether a tsconfig has project `references` (read without `extends`, which does not
 * carry them): a solution-style config (`"files": []` + references, astro's packages) or
 * a mixed one. Its entries that no referenced project includes are indexed through the
 * runtime tsconfig (scip-typescript.ts writeRuntimeTsconfig, round 9b).
 */
export function hasProjectReferences(tsconfig: string): boolean {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const refs = (read.config as { references?: unknown } | undefined)?.references;
  return Array.isArray(refs) && refs.length > 0;
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
 *    `declare namespace JSX`): ambient script declarations. `dts` holds the
 *    position key of the top-level declaration so the caller drops those that
 *    are on the export surface. A declaration with `export` in a module `.d.ts`
 *    is imported like any other and is not included;
 *  - the members of such a top-level `.d.ts` namespace, at any nesting
 *    (`declare namespace WebAssembly { class CompileError }`): they merge into
 *    the global scope like the namespace itself. They carry the namespace's
 *    `dts` key and are dropped with it.
 * Members of ordinary (non-ambient) namespaces are not included.
 */
function collectAmbientDeclarations(
  sf: ts.SourceFile,
  toRepoRel: (abs: string) => string,
): Array<SourcePosition & { name: string; dts?: string }> {
  const out: Array<SourcePosition & { name: string; dts?: string }> = [];
  const add = (nameNode: ts.Node, name: string, dts: string | undefined): SourcePosition => {
    const at = position(sf, nameNode.getStart(sf), toRepoRel);
    out.push({ ...at, name, ...(dts !== undefined ? { dts } : {}) });
    return at;
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
  /**
   * The declaration's name and every declaration inside its body, at any
   * nesting. `dts` is the top-level `.d.ts` namespace's key (undefined inside
   * `declare module` / `declare global`); `self` is false when the caller
   * already recorded the name.
   */
  const visitBody = (m: ts.ModuleDeclaration, dts: string | undefined, self: boolean): void => {
    if (self) add(m.name, m.name.text, dts);
    let body = m.body;
    // `namespace A.B {}` nests bodies as ModuleDeclarations.
    while (body !== undefined && ts.isModuleDeclaration(body)) {
      add(body.name, body.name.text, dts);
      body = body.body;
    }
    if (body === undefined || !ts.isModuleBlock(body)) return;
    for (const s of body.statements) {
      if (ts.isModuleDeclaration(s)) {
        visitBody(s, dts, true);
        continue;
      }
      for (const [node, name] of declared(s)) add(node, name, dts);
    }
  };
  const key = (p: SourcePosition): string => `${p.file}:${p.line}:${p.col}`;
  const dts = sf.isDeclarationFile;
  for (const s of sf.statements) {
    if (isAmbientModule(s)) {
      visitBody(s, undefined, true);
    } else if (dts && !hasExportModifier(s)) {
      // An exported declaration of a module `.d.ts` is imported by reference like any other.
      for (const [node, name] of declared(s)) {
        const at = position(sf, node.getStart(sf), toRepoRel);
        add(node, name, key(at));
        if (ts.isModuleDeclaration(s)) visitBody(s, key(at), false);
      }
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

/**
 * Adds to `out` the exports of every module that a deep import in `files`
 * (`@acme/x/dist/module/lib/types`: a specifier naming another org package plus a
 * subpath) resolves to inside that package's checkout (`orgDirs`, realpaths; the
 * shadow package's links resolve there). Import/export declarations, `import x =
 * require()`, `import()` / `require()` calls and `import('…')` types. Each
 * declaration of an export that lives in the target package is one record (alias
 * re-exports followed; `export * as ns` members and declarations outside the
 * package are skipped). A self import (`selfName`) is not recorded.
 */
function collectDeepImportExports(
  files: readonly ts.SourceFile[],
  checker: ts.TypeChecker,
  orgDirs: readonly OrgPackageDir[],
  selfName: string | null,
  out: Map<string, DeepImportExport>,
): void {
  const done = new Set<ts.Symbol>();
  const handle = (lit: ts.StringLiteralLike): void => {
    const name = barePackageName(lit.text);
    if (name === undefined || name === lit.text || name === selfName) return;
    const candidates = orgDirs.filter((d) => d.name === name);
    if (candidates.length === 0) return;
    const mod = checker.getSymbolAtLocation(lit);
    if (mod === undefined || done.has(mod)) return;
    done.add(mod);
    const modSf = mod.declarations?.find(ts.isSourceFile);
    if (modSf === undefined) return;
    const inTarget = (abs: string, dir: string): boolean =>
      isInside(abs, dir) && !path.relative(dir, abs).split(path.sep).includes('node_modules');
    const modAbs = path.resolve(modSf.fileName);
    const target = candidates.find((d) => inTarget(modAbs, d.dir));
    if (target === undefined) return;
    const rel = (abs: string): string => path.relative(target.dir, abs).split(path.sep).join(path.posix.sep);
    let members: ts.Symbol[];
    try {
      members = checker.getExportsOfModule(mod);
    } catch {
      return;
    }
    for (const exp of members) {
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      for (const decl of expandAliasDeclarations(sym.declarations ?? [], checker)) {
        if (ts.isSourceFile(decl)) continue;
        const declAbs = path.resolve(decl.getSourceFile().fileName);
        if (!inTarget(declAbs, target.dir)) continue;
        const rec: DeepImportExport = { targetPackage: name, entry: rel(modAbs), exportedAs: exp.name, name: nameOf(decl, sym).name, file: rel(declAbs) };
        out.set(JSON.stringify(rec), rec);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const p = node.parent;
      if (
        ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) ||
        ts.isExternalModuleReference(p) ||
        (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) ||
        (ts.isCallExpression(p) && p.arguments[0] === node &&
          (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require')))
      ) {
        handle(node);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of files) visit(sf);
}

/**
 * Own-module loads (consumer-checks scanOwnModuleLoads) of the package's walked code
 * files plus its runtime entries that the walk does not return (extension-less bins).
 */
function collectOwnLoads(
  input: ExportSurfaceInput, walked: readonly string[], isOwnFile: (f: string) => boolean,
): { loads: OwnModuleLoad[]; gaps: OwnLoadGap[] } {
  const files = new Set(walked.map((f) => path.resolve(f)));
  for (const e of input.runtimeEntryPoints ?? []) {
    const abs = path.resolve(input.repoRoot, ...e.split('/'));
    if (!files.has(abs) && isOwnFile(abs) && existsSync(abs)) files.add(abs);
  }
  return scanOwnModuleLoads({
    repoRoot: input.repoRoot,
    pkgDir: input.pkgDir,
    nestedPackageDirs: input.nestedPackageDirs,
    files: [...files].sort(cmp),
    selfName: input.packageName ?? null,
  });
}

interface OwnLoadContext {
  isOwnFile: (fileName: string) => boolean;
  toRepoRel: (abs: string) => string;
  pkgDir: string;
  selfName: string | null;
  diagnostics: string[];
  /** Whether a reference from this (repo-relative) file can land (the file is an indexed document). */
  refsFrom: (file: string) => boolean;
  /** Whether the load hands the module to a runtime or tool: its exports become runtime entry symbols. */
  isEntryLoad: (load: OwnModuleLoad) => boolean;
  entrySymbols: Array<SourcePosition & { name: string }>;
  refs: ShorthandRef[];
}

/**
 * The declarations the loads of one own module `sf` take: the named exports (`default`
 * for a default import), or every export when a load names none. Each becomes a
 * reference from the loading position (a `shorthandRefs` record, when the loading file is
 * an indexed document and the package has a name) and, for a runtime or tool load
 * (a string entry, a load by an entry / bin / runtime file or by a file no index has),
 * a runtime entry symbol: the runtime calls it, so it is no export surface and gets no
 * verdict, and its declaration keeps the module (its top-level code) reachable. A module
 * with no exports: its top-level declarations are the entry symbols, so its code still
 * counts as run.
 */
function resolveOwnLoads(sf: ts.SourceFile, loads: readonly OwnModuleLoad[], checker: ts.TypeChecker, ctx: OwnLoadContext): void {
  const mod = checker.getSymbolAtLocation(sf);
  let members: ts.Symbol[] = [];
  if (mod !== undefined) {
    try {
      members = checker.getExportsOfModule(mod);
    } catch {
      members = [];
    }
  }
  const pkgRel = (abs: string): string => path.relative(ctx.pkgDir, abs).split(path.sep).join(path.posix.sep);
  /** Own declarations of an export: [declared name, position]. */
  const declsOf = (exp: ts.Symbol): Array<{ name: string; at: SourcePosition; abs: string }> => {
    const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const out: Array<{ name: string; at: SourcePosition; abs: string }> = [];
    for (const decl of expandAliasDeclarations(target.declarations ?? [], checker)) {
      if (ts.isSourceFile(decl) || ts.isBindingElement(decl) || isExpandoDeclaration(decl)) continue;
      const declSf = decl.getSourceFile();
      if (!ctx.isOwnFile(declSf.fileName)) continue;
      const { node, name, note } = nameOf(decl, target);
      if (note !== undefined) continue; // an anonymous default: no SCIP definition to name
      out.push({ name, at: position(declSf, node.getStart(declSf), ctx.toRepoRel), abs: path.resolve(declSf.fileName) });
    }
    return out;
  };
  for (const load of loads) {
    const entry = ctx.isEntryLoad(load);
    const refs = load.kind === 'import' && ctx.selfName !== null && ctx.refsFrom(load.file);
    const wanted: Array<{ name: string; at: SourcePosition }> = load.names !== undefined
      ? load.names.map(({ name, file, line, col }) => ({ name, at: { file, line, col } }))
      : members.map((m) => ({ name: m.name, at: { file: load.file, line: load.line, col: load.col } }));
    let found = 0;
    for (const w of wanted) {
      const exp = members.find((m) => m.name === w.name);
      if (exp === undefined) continue;
      for (const d of declsOf(exp)) {
        found += 1;
        if (entry) ctx.entrySymbols.push({ ...d.at, name: d.name });
        if (refs) {
          ctx.refs.push({
            file: w.at.file, line: w.at.line, col: w.at.col, member: w.name, targetPackage: ctx.selfName!,
            targetFile: pkgRel(d.abs), targetLine: d.at.line, targetCol: d.at.col,
          });
        }
      }
    }
    if (members.length === 0 && entry) {
      for (const d of topLevelDeclarations(sf, ctx.toRepoRel)) {
        ctx.entrySymbols.push(d);
        found += 1;
      }
    }
    if (found === 0 && load.names !== undefined) {
      ctx.diagnostics.push(`warn: ${load.file}:${load.line + 1}:${load.col + 1} loads ${load.names.map((n) => n.name).join(', ')} from ${ctx.toRepoRel(path.resolve(sf.fileName))} ('${load.spec}'), which does not export them`);
    }
  }
}

/**
 * References for the names a dynamic `import('./x')` of an own module takes (consumer-checks
 * importedNames: destructured or accessed names, `default` for a lazy component loader
 * such as `next/dynamic` or `React.lazy`), from each of `files` (indexed documents) to
 * the module's declarations, as `shorthandRefs` through resolveOwnLoads. SCIP links such
 * an import to the module only, which keeps the module's top-level code reachable but
 * not the export the loader renders (docs.page's `export default function SearchDialog`).
 * A result used as a whole (unknown names) adds nothing: the module-level reference
 * stays the only one, as before.
 */
function collectDynamicImportRefs(files: readonly ts.SourceFile[], checker: ts.TypeChecker, ctx: OwnLoadContext): void {
  const byTarget = new Map<ts.SourceFile, OwnModuleLoad[]>();
  for (const sf of files) {
    const file = ctx.toRepoRel(path.resolve(sf.fileName));
    const pos = (node: ts.Node): SourcePosition => {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      return { file, line, col: character };
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const lit = node.arguments[0];
        if (lit !== undefined && ts.isStringLiteralLike(lit)) {
          const names = importedNames(lit, pos);
          const target = names !== undefined && names !== null && names.length > 0 ? moduleSourceFile(checker, lit) : undefined;
          if (target !== undefined && ctx.isOwnFile(target.fileName) && !target.isDeclarationFile) {
            const abs = path.resolve(target.fileName);
            byTarget.set(target, [...(byTarget.get(target) ?? []), { ...pos(lit), spec: lit.text, targets: [abs], names: names!, kind: 'import' }]);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const [target, loads] of byTarget) resolveOwnLoads(target, loads, checker, ctx);
}

/** The source file a module specifier resolves to, or undefined. */
function moduleSourceFile(checker: ts.TypeChecker, lit: ts.StringLiteralLike): ts.SourceFile | undefined {
  let mod: ts.Symbol | undefined;
  try {
    mod = checker.getSymbolAtLocation(lit);
  } catch {
    return undefined;
  }
  return mod?.declarations?.find(ts.isSourceFile);
}

/** Named top-level declarations of a file (functions, classes, variables, types, enums, namespaces). */
function topLevelDeclarations(sf: ts.SourceFile, toRepoRel: (abs: string) => string): Array<SourcePosition & { name: string }> {
  const out: Array<SourcePosition & { name: string }> = [];
  const add = (n: ts.Identifier): void => {
    out.push({ ...position(sf, n.getStart(sf), toRepoRel), name: n.text });
  };
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name);
    } else if (
      (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)
        || ts.isEnumDeclaration(s) || ts.isModuleDeclaration(s)) && s.name !== undefined && ts.isIdentifier(s.name)
    ) {
      add(s.name);
    }
  }
  return out;
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
