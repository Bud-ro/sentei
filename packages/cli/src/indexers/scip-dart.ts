// scip-dart adapter (PLAN.md §6.2, §6.6). Both Dart tools run as subprocesses
// from their own dirs under packages/indexers/, never from a global activation:
//   - packages/indexers/scip-dart: vendored scip-dart 1.7.0 (Workiva/scip-dart
//     @ 8d017a25874efb8513617e85e508a573692cbb63) with the patches listed in its
//     PATCHES.md (SDK floor 3.11; `--private-symbols`, which we always pass;
//     valid symbols for operators, nameless elements and import prefixes;
//     no occurrences for dartdoc `[Name]` links; `--package`, one run for the
//     packages of a pub workspace; every analysis context's files; files
//     resolved library by library; operator expressions are references;
//     files the analyzer excludes are indexed too; a file outside the
//     package config gets its enclosing pubspec's package; a variable's
//     enclosing range covers its type annotation; the parts of every indexed
//     library are indexed, build_runner's .dart_tool/build/generated/ output
//     included; an extension type's representation field and primary
//     constructor are definitions);
//   - packages/indexers/dart-surface: the export-surface sidecar (SCIP carries
//     no export information), same JSON shape as the TypeScript sidecar
//     (`--batch`: every package of a pub workspace in one run).
// Org dependencies are source-linked with a `pubspec_overrides.yaml`
// (`dependency_overrides: {<dep>: {path: ...}}`), the pub equivalent of the npm
// node_modules symlinks: consumer references then carry the lib's own symbols.
// Flutter packages (see [flutterReason]) are resolved with `flutter pub get`,
// whose package_config.json points `flutter` and `sky_engine` (dart:ui, via its
// _embedder.yaml) into the Flutter SDK; both tools then analyze against the
// Flutter SDK's own Dart SDK (`--sdk-path <flutterRoot>/bin/cache/dart-sdk`),
// which is a no-op when the `dart` on PATH is Flutter's.
// A pub workspace (root pubspec `workspace:`, members `resolution: workspace`)
// is resolved once at its root (source links only there, only for org deps
// outside the workspace: pub refuses to override a workspace package) and
// indexed by one scip-dart run over all its packages (see [PubWorkspace]).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_GLOBS, inSurfaceDir, matchGlob } from '@sentei/core';
import { readScipIndex } from '@sentei/core/scip';
import { isExcludedConsumerFile, isGeneratedFile } from './consumer-checks.ts';
import { packageDir, packageSlug } from './scip-typescript.ts';
import type { DiscoveredDep, DiscoveredPackage, DiscoveredRepo, EntrySymbol, ExportsSidecar, Indexer, IndexerInput, IndexerOptions, IndexStatus, IndexerResult, PrepareResult, SourcePosition } from './types.ts';
import { worstStatus } from './types.ts';

const INDEXERS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../indexers');
/** Vendored scip-dart (see its PATCHES.md). */
export const SCIP_DART_DIR = path.join(INDEXERS_DIR, 'scip-dart');
/** Export-surface sidecar tool. */
export const DART_SURFACE_DIR = path.join(INDEXERS_DIR, 'dart-surface');

const OVERRIDES = 'pubspec_overrides.yaml';
const BACKUP_DIR = '.sentei-backup';
/** First line of every pubspec_overrides.yaml we write (a file carrying it is ours, never backed up). */
export const OVERRIDES_HEADER = '# Written by sentei: source links for org dependencies. Original (if any) in .sentei-backup/.';

/** Output of dart-surface: the sidecar plus three adapter-only keys (stripped before writing). */
interface SurfaceOutput extends Omit<ExportsSidecar, 'namespaceSpreadRefs' | 'entrySymbols'> {
  /** dart-surface emits no `kind`; the adapter sets `runtime`. */
  entrySymbols: Array<Omit<EntrySymbol, 'kind'> & { kind?: EntrySymbol['kind'] }>;
  unresolvedOrgModules: Array<SourcePosition & { module: string }>;
  /** `part` directives whose file does not exist (an ungenerated `*.g.dart`): the library is incomplete. */
  missingParts?: Array<SourcePosition & { uri: string }>;
  diagnostics: string[];
  /** With `--pub-get-failed`: own `package:<self>/…` URIs that did not resolve (left out of the lists above). */
  unresolvedOwnUris?: number;
}

/** The `prepare` diagnostic for a failed `dart pub get` / `flutter pub get` (see [pubGetFailed]). */
const PUB_GET_FAILED = /^error: (?:dart|flutter) pub get(?: --offline)? exited with /;

/** The `prepare` diagnostic for a Flutter package when `flutter` is not on PATH. */
const NO_FLUTTER = /^error: Flutter package .* `flutter` is not on PATH/;

/** Dependencies that only the Flutter SDK provides. */
const FLUTTER_SDK_DEPS = new Set(['flutter', 'flutter_test', 'flutter_web_plugins', 'flutter_driver', 'flutter_localizations', 'integration_test']);

export const scipDart: Indexer = {
  name: 'scip-dart',
  // Upstream version + our patch level. Bump the patch level whenever the
  // vendored fork or dart-surface changes output (it is the index cache key).
  // sentei.4: fork patch 3 (valid symbols), manager-prefixed output names,
  // Dart entry conventions (non-lib `main`, build.yaml factories, dart_dev config).
  // sentei.5: ignored nested manifests are not ours (no entry symbols/exports
  // there); missing parts outside lib/ and bin/ only warn.
  // sentei.6: entrySymbols[].kind (`runtime`, set by the adapter).
  // sentei.7: fork patch 4 (dartdoc `[Name]` links are not references); after
  // a failed pub get, unresolved own `package:` URIs collapse into one error.
  // sentei.8: Flutter packages (`flutter pub get`, fork patch 5 `--sdk-path`
  // and dart-surface `--sdk-path` pointing at the Flutter SDK's Dart SDK).
  // sentei.9: pub workspaces (resolved once at the root, indexed by one run,
  // fork patch 6), fork patch 7 (the lib/ of a member listed by path), fork
  // patch 8 (parts resolved in their library), fork patch 9 (operator
  // references), a package with lib/ code but no lib/ document fails;
  // dart-surface: a `main` re-exported by a script is an entry symbol, and
  // `conditionalImports`; build_runner for missing generated parts;
  // dart-surface once per pub workspace (`--batch`).
  // sentei.10: every public library (lib/**, not lib/src/) is a discover entry
  // point, so dart-surface computes its export surface; dart-surface: the main
  // of every library is an entry symbol; fork patch 10 (files the analyzer
  // excludes are indexed; an unresolvable file makes the package partial),
  // fork patch 11 (no crash on a file outside the package config), fork
  // patch 12 (a variable's enclosing range covers its type annotation);
  // dart-surface: Flutter plugin classes named in pubspec.yaml are entry symbols.
  // sentei.11: fork patch 13 (the parts of every indexed library are
  // documents, build_runner output under .dart_tool/build/generated/ included;
  // a part outside the package makes it partial).
  // sentei.12: fork patch 14 (an extension type's representation field and
  // primary constructor are definitions: 397 false skew rows on jni); the
  // sidecar's generatedFiles (header sniff over the index's documents);
  // dart-surface: grinder tasks (`@Task` / `@DefaultTask`) are entry symbols.
  // sentei.13: part files are no longer passed as `--entry` (dartLibraryEntries),
  // so the sidecar's entryPoints lists libraries only.
  // sentei.14: dart-surface records re-exports of same-repo org packages in
  // `exports` and the `main` / `hybridMain` of libraries named by `package:`
  // URI literals in `entrySymbols`; the generated-header sniff reads every
  // leading comment block (Web IDL, protoc "Do not modify").
  version: '1.7.0+sentei.14',

  detect({ repo, pkg }) {
    return pkg.manager === 'pub' && existsSync(path.join(packageDir(repo, pkg), 'pubspec.yaml'));
  },

  async prepare(input) {
    const { repo, pkg, options } = input;
    const diagnostics: string[] = [];
    const log: string[] = [];
    let status: IndexStatus = 'ok';
    const pkgDirPath = packageDir(repo, pkg);
    if (!existsSync(path.join(pkgDirPath, 'pubspec.yaml'))) {
      return { status: 'failed', diagnostics: [`error: ${path.join(pkg.path, 'pubspec.yaml')} not found`], log };
    }
    const dir = realpathSync(pkgDirPath);
    // A pub workspace resolves once, at its root, for every member.
    const ws = pubWorkspaceOf(repo, pkg);
    if (ws !== undefined) {
      const { shared, perPackage } = await once(workspacePrepares, options, ws.root, () => prepareWorkspace(input, ws));
      const own = perPackage.get(dir);
      return {
        status: shared.status,
        diagnostics: [
          `info: ${workspaceRole(ws, dir)}: resolved once at the workspace root for ${ws.packages.length} package(s)`,
          ...shared.diagnostics,
          ...(own?.diagnostics ?? []),
        ],
        log: [...shared.log, ...(own?.log ?? [])],
      };
    }
    // 1. Source-link org dependencies (before `pub get`, which reads the overrides).
    const links = writeOverrides(input, dir, diagnostics);
    // 2. Resolve. Offline when installs are disabled: path deps and anything
    //    already in the pub cache still resolve. A Flutter package needs `flutter pub get`.
    const args = ['pub', 'get', ...(options.install ? [] : ['--offline'])];
    const flutter = flutterReason(input);
    let cmd = 'dart';
    let dart = 'dart';
    if (flutter !== undefined) {
      const sdk = await flutterSdk();
      log.push(...sdk.log);
      if (sdk.root === undefined) {
        diagnostics.push(
          `error: Flutter package (${flutter}) but \`flutter\` is not on PATH: not resolved; install the Flutter SDK to index it` +
            (sdk.error ? ` (${sdk.error})` : ''),
        );
        return { status: 'partial', diagnostics, log };
      }
      cmd = 'flutter';
      dart = flutterDart(sdk.root);
      diagnostics.push(`info: Flutter package (${flutter}); Flutter SDK ${sdk.version ?? '?'} at ${sdk.root}`);
    }
    const proc = await pubGet(input, dir, args, links, diagnostics, log, exec, cmd);
    if (proc.code !== 0) {
      status = 'partial';
      const why = firstLine(proc.stderr) ?? firstLine(proc.stdout) ?? '';
      diagnostics.push(`error: ${cmd} ${args.join(' ')} exited with ${proc.code ?? proc.signal}${why ? `: ${why}` : ''}`);
    } else {
      diagnostics.push(`info: ran ${cmd} ${args.join(' ')}`);
      // 3. Missing generated parts (`*.g.dart` never committed): build_runner, if the package uses it.
      await buildRunner(dir, diagnostics, log, dart);
    }
    return { status, diagnostics, log };
  },

  async run(input, outDir) {
    const { repo, pkg, options } = input;
    const prepared = input.prepared ?? (await this.prepare!(input));
    const diagnostics: string[] = [...prepared.diagnostics];
    let status: IndexStatus = prepared.status;
    /**
     * The diagnostic that last made the status worse, repeated as a `cause:`
     * line for ingest's flag reason and the index progress line (both read the
     * last one), as the TypeScript adapter does. Without it the progress line of
     * a partial package led with its first `warn:` (`test not source-linked…`)
     * instead of the unresolved import that made it partial. A status inherited
     * from prepare (pub get failed) starts with prepare's first error.
     */
    let cause: string | undefined = prepared.status !== 'ok' ? prepared.diagnostics.find((d) => d.startsWith('error:')) : undefined;
    const worsen = (to: IndexStatus, why: string): void => {
      if (worstStatus(status, to) !== status) cause = why;
      status = worstStatus(status, to);
    };
    const slug = packageSlug(pkg);
    const scipFile = path.join(outDir, `${slug}.scip`);
    const exportsFile = path.join(outDir, `${slug}.exports.json`);
    const logFile = path.join(outDir, `${slug}.log`);
    const log: string[] = [...prepared.log];
    const finish = (): IndexerResult => {
      if (cause !== undefined && status !== 'ok') diagnostics.push(`cause: ${cause}`);
      log.push('--- diagnostics', ...diagnostics);
      writeFileSync(logFile, `${log.join('\n')}\n`);
      return { status, diagnostics, scipFile, exportsFile };
    };
    if (status === 'failed') return finish();
    // A Flutter package without `flutter`: nothing resolves `package:flutter`
    // or dart:ui, so there is no index to build (ingest flags it index_failed too).
    if (prepared.diagnostics.some((d) => NO_FLUTTER.test(d))) {
      rmSync(scipFile, { force: true });
      rmSync(exportsFile, { force: true });
      return finish();
    }

    const tools = await ensureTools(options.install);
    log.push(...tools.log);
    if (tools.error !== undefined) {
      worsen('failed', `error: ${tools.error}`);
      diagnostics.push(`error: ${tools.error}`);
      return finish();
    }

    const repoRoot = realpathSync(repo.localPath);
    const dir = realpathSync(packageDir(repo, pkg));
    const ws = pubWorkspaceOf(repo, pkg);

    // Flutter packages (in a workspace: when any package of it is one): analyze
    // against the Flutter SDK's Dart SDK.
    const needsFlutter = ws !== undefined ? workspaceFlutterReason(input, ws) !== undefined : flutterReason(input) !== undefined;
    const sdk = needsFlutter ? await flutterSdk() : undefined;
    const sdkArgs = sdk?.dartSdk !== undefined ? ['--sdk-path', sdk.dartSdk] : [];

    // 3. Index. scip-dart exits 0 on type errors and on unresolved imports; it
    //    fails only without .dart_tool/package_config.json (i.e. pub get failed).
    //    A pub workspace is indexed by one scip-dart run over all its packages
    //    (fork patch 6), each still getting its own index as if indexed alone.
    let proc: ExecResult;
    if (ws !== undefined) {
      const shared = await once(workspaceRuns, options, `${ws.root}\0${outDir}`, () => indexWorkspace(repo, ws, outDir, sdkArgs));
      proc = shared.proc;
      log.push(...shared.log);
      diagnostics.push(`info: indexed in one scip-dart run with the ${ws.packages.length} package(s) of the pub workspace at ${ws.rootPath}`);
    } else {
      rmSync(scipFile, { force: true });
      const scipArgs = ['run', 'scip_dart', '--private-symbols', ...sdkArgs, '--output', scipFile, dir];
      proc = await exec('dart', scipArgs, SCIP_DART_DIR);
      log.push(`$ dart ${scipArgs.join(' ')}  (cwd ${SCIP_DART_DIR})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
    }
    if (proc.code !== 0) {
      const why = firstLine(proc.stderr);
      const diag = `error: scip-dart exited with ${proc.code ?? proc.signal}${why ? `: ${why}` : ''}`;
      worsen('failed', diag);
      diagnostics.push(diag);
    } else {
      // Fork patch 10: files the analyzer excludes are indexed anyway; one
      // that does not resolve leaves its references unknown (fail closed).
      const files = scipDartFileReport(proc.stderr, dir);
      if (files.excludedIndexed.length > 0) {
        diagnostics.push(
          `info: scip-dart indexed ${files.excludedIndexed.length} file(s) beyond the analyzer's analyzedFiles() (analysis_options.yaml analyzer: exclude:): ${listSome(files.excludedIndexed)}`,
        );
      }
      if (files.unresolved.length > 0) {
        const why = `error: scip-dart could not resolve ${files.unresolved.length} file(s); references in them are unknown: ${listSome(files.unresolved)}`;
        worsen('partial', why);
        diagnostics.push(why);
      }
      // Fork patch 13: parts the analyzer resolved from build_runner's
      // `.dart_tool/build/generated/` are documents of the package, at their
      // real path (GENERATED_GLOBS mark them generated). A part outside the
      // package could not be one: its references are unknown (fail closed).
      if (files.generatedParts.length > 0) {
        diagnostics.push(
          `info: scip-dart indexed ${files.generatedParts.length} part(s) from build_runner's .dart_tool/build/generated/: ${listSome(files.generatedParts)}`,
        );
      }
      if (files.unindexedParts.length > 0) {
        const why = `error: ${files.unindexedParts.length} part(s) of the package's libraries lie outside the package and were not indexed; references in them are unknown: ${listSome(files.unindexedParts)}`;
        worsen('partial', why);
        diagnostics.push(why);
      }
      // Fork patch 11: a file reached by a relative import that no package of
      // the package config contains (dart-lang/native: jnigen's test/ from its
      // android_test_runner) gets its enclosing pubspec's package, not a crash.
      const outside = outsidePackageConfig(proc.stderr).map((f) => repoRelative(repoRoot, f));
      if (outside.length > 0) {
        diagnostics.push(
          `info: scip-dart${ws !== undefined ? ' (workspace run)' : ''}: ${outside.length} referenced file(s) outside the package config, symbols from the enclosing pubspec's package: ${listSome(outside)}`,
        );
      }
    }
    /** Package-relative POSIX paths of the index's documents. */
    let documents: string[] = [];
    if (!existsSync(scipFile) || statSync(scipFile).size === 0) {
      worsen('failed', `error: ${path.basename(scipFile)} missing or empty`);
      diagnostics.push(`error: ${path.basename(scipFile)} missing or empty`);
    } else {
      try {
        documents = readScipIndex(scipFile).documents.map((d) => d.relativePath.replaceAll('\\', '/'));
      } catch (err) {
        diagnostics.push(`error: ${path.basename(scipFile)} unreadable: ${(err as Error).message.split('\n')[0]}`);
      }
      // A package with library code whose index has none of it: the analyzer
      // context missed lib/ (fork patch 7 fixed one such case). Every export
      // would look unused and every consumer reference unknown: never `ok`.
      const libFiles = ownLibDartFiles(repo, pkg);
      if (libFiles > 0) {
        const libDocs = documents.filter((d) => d.startsWith('lib/')).length;
        if (libDocs === 0) {
          const why = `error: scip-dart indexed none of the ${libFiles} Dart file(s) under lib/ (the analyzer did not cover lib/); the index is incomplete`;
          worsen('failed', why);
          diagnostics.push(why);
        }
      }
    }

    // 4. Export-surface sidecar. A pub workspace: one dart-surface run for all
    //    its packages (`--batch`), each output as for the package alone.
    // Without a package config mapping the package itself (pub get failed;
    // any config found is an enclosing package's), none of its own
    // `package:` URIs resolve: one error says so, not one per directive.
    const pubGetFailed = prepared.diagnostics.some((d) => PUB_GET_FAILED.test(d));
    let out: SurfaceOutput | undefined;
    if (ws !== undefined) {
      const shared = await once(workspaceSurfaces, options, `${ws.root}\0${outDir}`, () => surfaceWorkspace(input, ws, sdkArgs, pubGetFailed));
      log.push(...shared.log);
      out = shared.outputs.get(pkg.packageId);
      if (out === undefined) diagnostics.push(`error: ${shared.error ?? 'dart-surface printed no output for this package'}`);
      else diagnostics.push(`info: export surface from one dart-surface run with the ${ws.packages.length} package(s) of the pub workspace at ${ws.rootPath}`);
    } else {
      const spec = surfaceSpec(input, pkg);
      const surfaceArgs = [
        'run', 'dart_surface',
        '--repo-root', repoRoot,
        '--package-root', spec.packageRoot,
        '--package-id', spec.packageId,
        ...(spec.packageName !== undefined ? ['--package-name', spec.packageName] : []),
        ...sdkArgs,
        '--org-packages', orgPubNames(input).join(','),
        ...spec.entries.flatMap((e) => ['--entry', e]),
        ...spec.nested.flatMap((d) => ['--nested', d]),
        ...(pubGetFailed ? ['--pub-get-failed'] : []),
      ];
      const sp = await exec('dart', surfaceArgs, DART_SURFACE_DIR);
      log.push(`$ dart ${surfaceArgs.join(' ')}  (cwd ${DART_SURFACE_DIR})`, '--- stderr', sp.stderr);
      if (sp.code === 0) {
        try {
          out = JSON.parse(sp.stdout) as SurfaceOutput;
        } catch (err) {
          diagnostics.push(`error: dart-surface printed invalid JSON: ${(err as Error).message}`);
        }
      } else {
        diagnostics.push(`error: dart-surface exited with ${sp.code ?? sp.signal}: ${firstLine(sp.stderr) ?? ''}`);
      }
    }
    if (out === undefined) {
      worsen('failed', diagnostics.findLast((d) => d.startsWith('error:')) ?? 'error: export surface failed');
      diagnostics.push('error: export surface failed');
      return finish();
    }
    const { unresolvedOrgModules, missingParts = [], diagnostics: surfaceDiagnostics, unresolvedOwnUris = 0, ...rest } = out;
    // Generated documents: the header sniff and path rules of the TypeScript
    // sidecar (consumer-checks.ts isGeneratedFile, one list of patterns), over
    // every document of the index. ffigen / jnigen bindings (`// AUTO
    // GENERATED FILE, DO NOT EDIT.`) are named like hand-written code. Only
    // the file's leading comments count, doc comments excluded, however many
    // lines they take (see [dartFileHeader]).
    const generatedFiles = documents
      .map((rel) => [path.join(dir, ...rel.split('/')), path.posix.join(pkg.path === '.' ? '' : pkg.path, rel)] as const)
      .filter(([abs, repoRel]) => isGeneratedDartFile(abs, repoRel, pkg.path))
      .map(([, repoRel]) => repoRel)
      .sort();
    if (generatedFiles.length > 0) {
      diagnostics.push(`info: ${generatedFiles.length} generated file(s) (header or path): ${listSome(generatedFiles)}`);
    }
    const sidecar: ExportsSidecar = {
      ...rest,
      generatedFiles,
      shorthandRefs: rest.shorthandRefs ?? [],
      namespaceSpreadRefs: [],
      conditionalImports: rest.conditionalImports ?? [],
      // A test's `main` is run by the test runner; test files never get verdicts.
      // Nothing under a pub package's lib/ is a test file (core SURFACE_DIRS, as in the SQL views).
      // dart-surface emits no kind: every Dart entry symbol is invoked by the runtime or a tool.
      entrySymbols: rest.entrySymbols
        .filter((e) => inSurfaceDir(e.file, 'pub', pkg.path) || !TEST_GLOBS.some((g) => matchGlob(g, e.file)))
        .map((e) => ({ ...e, kind: e.kind ?? 'runtime' })),
    };
    writeFileSync(exportsFile, `${JSON.stringify(sidecar satisfies ExportsSidecar, null, 2)}\n`);
    if (unresolvedOwnUris > 0) {
      const why = `error: package unresolvable (pub get failed): ${unresolvedOwnUris} own package: import/export URI(s) do not resolve`;
      worsen('partial', why);
      diagnostics.push(why);
    }
    for (const m of unresolvedOrgModules) {
      const why = `error: unresolved org module '${m.module}' at ${m.file}:${m.line + 1}:${m.col + 1}`;
      worsen('partial', why);
      diagnostics.push(why);
    }
    for (const u of sidecar.unresolvedImports) {
      diagnostics.push(`warn: '${u.name}' is not exported by org module '${u.module}' at ${u.file}:${u.line + 1}:${u.col + 1}`);
    }
    // A missing part (typically an ungenerated `*.g.dart`: build_runner was not
    // run) leaves its library incomplete: references inside it are unknown.
    // That matters for the package's library code (lib/, bin/): its surface and
    // its uses of other packages. Missing parts elsewhere (web/ demos, example/,
    // test/, tool/) and in test/docs files the policy does not count only warn.
    for (const m of missingParts) {
      const at = `${m.file}:${m.line + 1}:${m.col + 1}`;
      if (isExcludedConsumerFile(m.file, input.policy, { manager: 'pub', path: pkg.path })) {
        diagnostics.push(`warn: missing part '${m.uri}' at ${at} (not generated?); ignored: a test/docs file that does not count as a consumer`);
        continue;
      }
      const top = path.posix.relative(pkg.path === '.' ? '' : pkg.path, m.file).split('/')[0];
      if (top !== 'lib' && top !== 'bin') {
        diagnostics.push(`warn: missing part '${m.uri}' at ${at} (not generated?); outside lib/ and bin/, references inside it are unknown`);
        continue;
      }
      const why = `error: missing generated part '${m.uri}' at ${at}: the library is incomplete, references inside the part are unknown (run build_runner before indexing)`;
      worsen('partial', why);
      diagnostics.push(why);
    }
    diagnostics.push(...surfaceDiagnostics);
    // dart-surface's own lines for these (`warn: unresolved export directives: …`,
    // `warn: entry point(s) not found …`) are the cause.
    if (sidecar.unresolved.length > 0) {
      worsen('partial', surfaceDiagnostics.find((d) => d.startsWith('warn: unresolved export directives')) ?? `error: ${sidecar.unresolved.length} unresolved export directive(s)`);
    }
    if (sidecar.missingEntryPoints.length > 0) {
      worsen('partial', surfaceDiagnostics.find((d) => d.startsWith('warn: entry point(s) not found')) ?? `error: entry point(s) not found: ${sidecar.missingEntryPoints.join(', ')}`);
    }
    return finish();
  },
};

// ---- pub workspaces ----------------------------------------------------------

/**
 * A pub workspace (Dart 3.6+): a root pubspec with `workspace: [paths/globs]`
 * and members with `resolution: workspace`. Pub resolves every member once, at
 * the root (one package config, one lockfile), and refuses any
 * `dependency_overrides` of a workspace package ("Cannot override workspace
 * packages."), so source links go into the root's pubspec_overrides.yaml, and
 * only for org dependencies outside the workspace.
 */
export interface PubWorkspace {
  /** Real absolute path of the root (the outermost `workspace:` pubspec the package resolves through). */
  root: string;
  /** The root dir relative to the repo root, POSIX (`.` for the repo root). */
  rootPath: string;
  /** The repo's discovered pub packages the root resolves (members at any depth, and the root itself when discovered), by path. */
  packages: DiscoveredPackage[];
}

/** The two top-level pubspec keys that make a workspace: `workspace:` (a root) and `resolution: workspace` (a member). */
export function pubspecWorkspaceKeys(text: string): { root: boolean; member: boolean } {
  return {
    root: /^workspace[ \t]*:/m.test(text),
    member: /^resolution[ \t]*:[ \t]*["']?workspace["']?[ \t]*(?:#.*)?$/m.test(text),
  };
}

type WorkspaceKeysReader = (dir: string) => { root: boolean; member: boolean } | undefined;

/**
 * The workspace root resolving the package in `dir` (real absolute paths), or
 * undefined when it is not in a workspace: `dir` itself when its pubspec has
 * `workspace:` and no `resolution: workspace`; for a member, the nearest
 * enclosing `workspace:` pubspec inside the repo, followed outwards while that
 * one is itself a member (nested workspaces resolve at the outermost root). A
 * member with no root above it is left alone (pub reports that itself).
 */
export function workspaceRootOf(repoRoot: string, dir: string, read: WorkspaceKeysReader): string | undefined {
  const own = read(dir);
  if (own === undefined) return undefined;
  if (!own.member) return own.root ? dir : undefined;
  let cur = dir;
  while (cur !== repoRoot && cur.startsWith(repoRoot + path.sep)) {
    cur = path.dirname(cur);
    const k = read(cur);
    if (k?.root && !k.member) return cur;
  }
  return undefined;
}

/** The pub workspace `pkg` belongs to (as root or member), or undefined. */
export function pubWorkspaceOf(repo: DiscoveredRepo, pkg: DiscoveredPackage): PubWorkspace | undefined {
  const cache = new Map<string, { root: boolean; member: boolean } | undefined>();
  const read: WorkspaceKeysReader = (d) => {
    if (!cache.has(d)) {
      let keys: { root: boolean; member: boolean } | undefined;
      try {
        keys = pubspecWorkspaceKeys(readFileSync(path.join(d, 'pubspec.yaml'), 'utf8'));
      } catch {
        keys = undefined;
      }
      cache.set(d, keys);
    }
    return cache.get(d);
  };
  if (!existsSync(repo.localPath)) return undefined;
  const repoRoot = realpathSync(repo.localPath);
  const dirOf = (p: DiscoveredPackage): string | undefined => {
    const d = packageDir(repo, p);
    return existsSync(path.join(d, 'pubspec.yaml')) ? realpathSync(d) : undefined;
  };
  const own = dirOf(pkg);
  if (own === undefined) return undefined;
  const root = workspaceRootOf(repoRoot, own, read);
  if (root === undefined) return undefined;
  const packages = repo.packages
    .filter((p) => p.manager === 'pub')
    .filter((p) => {
      const d = dirOf(p);
      return d !== undefined && workspaceRootOf(repoRoot, d, read) === root;
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, rootPath: path.relative(repoRoot, root).split(path.sep).join('/') || '.', packages };
}

function workspaceRole(ws: PubWorkspace, dir: string): string {
  return dir === ws.root ? `pub workspace root (${ws.rootPath})` : `pub workspace member (root ${ws.rootPath})`;
}

/**
 * Work shared by every package of a workspace, once per index-stage run: the
 * stage passes one `options` object to every prepare/run call of a run, so it
 * keys the memo (a direct adapter call with its own options object redoes it).
 */
const workspacePrepares = new WeakMap<IndexerOptions, Map<string, Promise<WorkspacePrepared>>>();

/** [prepareWorkspace]'s result: shared by every package, plus each package's own lines (build_runner), by real dir. */
interface WorkspacePrepared {
  shared: PrepareResult;
  perPackage: Map<string, { diagnostics: string[]; log: string[] }>;
}
const workspaceRuns = new WeakMap<IndexerOptions, Map<string, Promise<{ proc: ExecResult; log: string[] }>>>();

function once<T>(store: WeakMap<IndexerOptions, Map<string, Promise<T>>>, options: IndexerOptions, key: string, fn: () => Promise<T>): Promise<T> {
  let byKey = store.get(options);
  if (byKey === undefined) store.set(options, (byKey = new Map()));
  let p = byKey.get(key);
  if (p === undefined) byKey.set(key, (p = fn()));
  return p;
}

/**
 * Why the workspace needs the Flutter SDK (pub resolves all members together,
 * so one Flutter member makes `dart pub get` fail for all), or undefined:
 * [flutterReason] of any discovered package in it, or a `sdk: flutter` /
 * `environment.flutter` in the pubspec of a workspace member discover
 * ignored (example apps).
 */
export function workspaceFlutterReason(input: Pick<IndexerInput, 'repo' | 'lookup'>, ws: PubWorkspace): string | undefined {
  const { repo } = input;
  for (const p of ws.packages) {
    const r = flutterReason({ repo, pkg: p, lookup: input.lookup });
    if (r !== undefined) return `${p.name ?? p.path}: ${r}`;
  }
  for (const m of repo.ignoredManifests ?? []) {
    const d = path.resolve(repo.localPath, ...m.path.split('/'));
    if (!existsSync(path.join(d, 'pubspec.yaml'))) continue;
    const real = realpathSync(d);
    if (real !== ws.root && !real.startsWith(ws.root + path.sep)) continue;
    let text: string;
    try {
      text = readFileSync(path.join(d, 'pubspec.yaml'), 'utf8');
    } catch {
      continue;
    }
    if (!pubspecWorkspaceKeys(text).member) continue;
    const fake: DiscoveredPackage = { packageId: `pub:${m.path}`, path: m.path, manager: 'pub', name: null, entryPoints: [], deps: [] };
    const r = pubspecFlutterReason(repo, fake);
    if (r !== undefined) return `${m.path}: ${r}`;
  }
  return undefined;
}

/**
 * `prepare` for a workspace, once: drops sentei overrides an older version
 * left in members (pub refuses them), writes the source links of every
 * package's org dependencies outside the workspace into the root's
 * pubspec_overrides.yaml, and runs `dart pub get` (`flutter pub get` when
 * [workspaceFlutterReason]) at the root, with the usual conflict retries.
 */
async function prepareWorkspace(input: IndexerInput, ws: PubWorkspace): Promise<WorkspacePrepared> {
  const { repo, options } = input;
  const diagnostics: string[] = [];
  const log: string[] = [];
  const perPackage: WorkspacePrepared['perPackage'] = new Map();
  for (const p of ws.packages) {
    const d = realpathSync(packageDir(repo, p));
    if (d !== ws.root) removeOurOverrides(d, diagnostics);
  }
  const ids = new Set(ws.packages.map((p) => p.packageId));
  const names = new Set(ws.packages.flatMap((p) => (p.name !== null && p.name !== undefined ? [p.name] : [])));
  const deps = ws.packages.flatMap((p) => p.deps);
  // Pub combines the overrides of every workspace package and refuses a name
  // overridden in two of them: a member's own override keeps its dep unlinked.
  const memberOverrides = new Map<string, string>();
  for (const p of ws.packages) {
    const d = realpathSync(packageDir(repo, p));
    if (d === ws.root) continue;
    const own = effectiveOverrideNames(d);
    if (own === undefined) diagnostics.push(`warn: workspace member ${p.path}: dependency_overrides unreadable; a source link of the same name may make pub refuse the workspace`);
    for (const n of own ?? []) if (!memberOverrides.has(n)) memberOverrides.set(n, p.path);
  }
  const write = (excluded: ReadonlySet<string>): Map<string, string> =>
    writeOverridesFor(deps, ids, names, input.lookup, ws.root, diagnostics, excluded, memberOverrides);
  const links = write(new Set());
  const args = ['pub', 'get', ...(options.install ? [] : ['--offline'])];
  const flutter = workspaceFlutterReason(input, ws);
  let cmd = 'dart';
  let dart = 'dart';
  if (flutter !== undefined) {
    const sdk = await flutterSdk();
    log.push(...sdk.log);
    if (sdk.root === undefined) {
      diagnostics.push(
        `error: Flutter package (${flutter}) but \`flutter\` is not on PATH: not resolved; install the Flutter SDK to index it` +
          (sdk.error ? ` (${sdk.error})` : ''),
      );
      return { shared: { status: 'partial', diagnostics, log }, perPackage };
    }
    cmd = 'flutter';
    dart = flutterDart(sdk.root);
    diagnostics.push(`info: Flutter workspace (${flutter}); Flutter SDK ${sdk.version ?? '?'} at ${sdk.root}`);
  }
  const proc = await pubGet(input, ws.root, args, links, diagnostics, log, exec, cmd, write);
  if (proc.code !== 0) {
    const why = firstLine(proc.stderr) ?? firstLine(proc.stdout) ?? '';
    diagnostics.push(`error: ${cmd} ${args.join(' ')} exited with ${proc.code ?? proc.signal}${why ? `: ${why}` : ''}`);
    return { shared: { status: 'partial', diagnostics, log }, perPackage };
  }
  diagnostics.push(`info: ran ${cmd} ${args.join(' ')} at the workspace root ${ws.rootPath}`);
  // Missing generated parts, per package (build_runner runs in a member's dir).
  for (const p of ws.packages) {
    const d = realpathSync(packageDir(repo, p));
    const own = { diagnostics: [] as string[], log: [] as string[] };
    await buildRunner(d, own.diagnostics, own.log, dart, exec, BUILD_RUNNER_TIMEOUT_MS, ws.root);
    perPackage.set(d, own);
  }
  return { shared: { status: 'ok', diagnostics, log }, perPackage };
}

/** The `dart` of a Flutter SDK (runs build_runner against the Flutter packages). */
function flutterDart(flutterRoot: string): string {
  return path.join(flutterRoot, 'bin', process.platform === 'win32' ? 'dart.bat' : 'dart');
}

/** Puts back (or removes) a pubspec_overrides.yaml sentei wrote in `dir`. */
function removeOurOverrides(dir: string, diagnostics: string[]): void {
  const file = path.join(dir, OVERRIDES);
  if (!existsSync(file) || !readFileSync(file, 'utf8').startsWith(OVERRIDES_HEADER)) return;
  const backup = path.join(dir, BACKUP_DIR, OVERRIDES);
  if (existsSync(backup)) copyFileSync(backup, file);
  else rmSync(file);
  diagnostics.push(`info: removed the ${OVERRIDES} an earlier sentei run wrote in workspace member ${dir} (links belong at the workspace root)`);
}

/**
 * One scip-dart run over every package of the workspace (fork patch 6,
 * `--package <dir>=<out>`), from the root's package config: each package's
 * `.scip` is written to its usual `<slug>.scip` in `outDir`, with the same
 * documents and symbols as a run on that package alone.
 */
async function indexWorkspace(repo: DiscoveredRepo, ws: PubWorkspace, outDir: string, sdkArgs: string[]): Promise<{ proc: ExecResult; log: string[] }> {
  const targets = ws.packages.map((p) => [realpathSync(packageDir(repo, p)), path.join(outDir, `${packageSlug(p)}.scip`)] as const);
  for (const [, out] of targets) rmSync(out, { force: true });
  const args = ['run', 'scip_dart', '--private-symbols', ...sdkArgs, ...targets.flatMap(([d, out]) => ['--package', `${d}=${out}`]), ws.root];
  const started = Date.now();
  const proc = await exec('dart', args, SCIP_DART_DIR);
  const log = [
    `$ dart ${args.join(' ')}  (cwd ${SCIP_DART_DIR}; one run for the ${targets.length} package(s) of the workspace, ${((Date.now() - started) / 1000).toFixed(1)} s)`,
    '--- stdout',
    proc.stdout,
    '--- stderr',
    proc.stderr,
  ];
  return { proc, log };
}

/** The per-package arguments of dart-surface (one `--batch` entry). */
interface SurfaceSpec {
  packageRoot: string;
  packageId: string;
  packageName?: string;
  /** Discover entry points, repo-relative POSIX. */
  entries: string[];
  /** Real paths of packages and ignored manifests strictly inside this one (their files are not ours). */
  nested: string[];
}

function surfaceSpec(input: Pick<IndexerInput, 'repo'>, pkg: DiscoveredPackage): SurfaceSpec {
  const { repo } = input;
  const dir = realpathSync(packageDir(repo, pkg));
  // Only pub packages own Dart files: scip-dart leaves out the dirs with a
  // pubspec.yaml, not an npm package.json. dart-lang/web's js_interop_gen has
  // an npm package in lib/src/ (its dart2js driver's node deps), and taking it
  // as nested dropped all of lib/src/ from dart-surface's scan (its `main`).
  const nested = repo.packages
    .filter((p) => p.manager === 'pub')
    .map((p) => packageDir(repo, p))
    .filter((d) => d !== packageDir(repo, pkg) && existsSync(d))
    .map((d) => realpathSync(d))
    .filter((d) => d.startsWith(dir + path.sep));
  // Ignored pub manifests (examples, templates, fixtures) strictly inside this
  // package are separate packages too: scip-dart does not index them, so an
  // entry symbol or export found there could never match a definition.
  const ignored = (repo.ignoredManifests ?? [])
    .map((m) => path.resolve(repo.localPath, ...m.path.split('/')))
    .filter((d) => existsSync(path.join(d, 'pubspec.yaml')))
    .map((d) => realpathSync(d))
    .filter((d) => d.startsWith(dir + path.sep) && !nested.includes(d));
  return {
    packageRoot: dir,
    packageId: pkg.packageId,
    ...(pkg.name !== null && pkg.name !== undefined ? { packageName: pkg.name } : {}),
    // Part files are not libraries (dart-surface would log "not a library").
    entries: dartLibraryEntries(repo.localPath, pkg.entryPoints),
    nested: [...nested, ...ignored],
  };
}

/** Pub names of every org package, sorted (dart-surface `--org-packages`). */
function orgPubNames(input: Pick<IndexerInput, 'orgPackages'>): string[] {
  return [...new Set(input.orgPackages.flatMap(({ pkg: p }) => (p.manager === 'pub' && p.name !== null && p.name !== undefined ? [p.name] : [])))].sort();
}

const workspaceSurfaces = new WeakMap<IndexerOptions, Map<string, Promise<{ outputs: Map<string, SurfaceOutput>; error?: string; log: string[] }>>>();

/**
 * One `dart_surface --batch` run for every package of the workspace (one
 * analysis context collection: the workspace's libraries are resolved once,
 * not once per package; ~13 s per flame package before). Outputs by package id.
 */
async function surfaceWorkspace(
  input: IndexerInput,
  ws: PubWorkspace,
  sdkArgs: string[],
  pubGetFailed: boolean,
): Promise<{ outputs: Map<string, SurfaceOutput>; error?: string; log: string[] }> {
  const { repo } = input;
  const spec = {
    repoRoot: realpathSync(repo.localPath),
    ...(sdkArgs[1] !== undefined ? { sdkPath: sdkArgs[1] } : {}),
    orgPackages: orgPubNames(input),
    pubGetFailed,
    packages: ws.packages.map((p) => surfaceSpec(input, p)),
  };
  const tmp = mkdtempSync(path.join(tmpdir(), 'sentei-surface-'));
  const outputs = new Map<string, SurfaceOutput>();
  try {
    const file = path.join(tmp, 'batch.json');
    writeFileSync(file, JSON.stringify(spec, null, 2));
    const args = ['run', 'dart_surface', '--batch', file];
    const started = Date.now();
    const sp = await exec('dart', args, DART_SURFACE_DIR);
    const log = [
      `$ dart ${args.join(' ')}  (cwd ${DART_SURFACE_DIR}; one run for the ${spec.packages.length} package(s) of the workspace, ${((Date.now() - started) / 1000).toFixed(1)} s)`,
      '--- batch', JSON.stringify(spec, null, 2),
      '--- stderr', sp.stderr,
    ];
    if (sp.code !== 0) return { outputs, error: `dart-surface exited with ${sp.code ?? sp.signal}: ${firstLine(sp.stderr) ?? ''}`, log };
    let parsed: unknown;
    try {
      parsed = JSON.parse(sp.stdout);
    } catch (err) {
      return { outputs, error: `dart-surface printed invalid JSON: ${(err as Error).message}`, log };
    }
    if (!Array.isArray(parsed) || parsed.length !== spec.packages.length) {
      return { outputs, error: `dart-surface --batch printed ${Array.isArray(parsed) ? parsed.length : 'no'} output(s) for ${spec.packages.length} package(s)`, log };
    }
    spec.packages.forEach((p, i) => outputs.set(p.packageId, parsed[i] as SurfaceOutput));
    return { outputs, log };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The leading comment header of a Dart file, for the generated-header sniff:
 * every `//` line and `/* … *\/` block before the first directive,
 * annotation or declaration, blank lines between them included, so a
 * generator line in a later block counts (package:web's `// Generated from Web
 * IDL definitions.` follows the license block). Doc comments (`///` lines,
 * `/** … *\/` blocks) are left out but do not end the header: they document
 * the library or the first declaration, and prose there ("The command line
 * argument parser generated by the `build_cli_annotations` package.",
 * dart-lang/samples; "will be automatically generated", swiftgen's config.dart)
 * is not a generator's header. The TypeScript sniff reads every comment of the
 * first 20 lines, which in Dart include the docs of the first declarations.
 * Returns '' when unreadable.
 */
export function dartFileHeader(abs: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    return dartLeadingComments(text.replace(/^\uFEFF/, ''));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * consumer-checks.ts isGeneratedFile for a Dart file: paths, then the header
 * sniff over its whole leading comment header ([dartFileHeader]).
 */
export function isGeneratedDartFile(abs: string, repoRel: string, pkgPath: string): boolean {
  const header = dartFileHeader(abs);
  return isGeneratedFile(abs, repoRel, pkgPath, header, header.split('\n').length);
}

/** See [dartFileHeader]: the non-doc comments of `text` before its first code token, one line per line. */
export function dartLeadingComments(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ws = /^\s+/.exec(text.slice(i, i + 4096));
    if (ws !== null) {
      i += ws[0].length;
      continue;
    }
    if (text.startsWith('//', i)) {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      if (!text.startsWith('///', i)) out.push(text.slice(i, end).replace(/\r$/, ''));
      i = end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      // Dart block comments nest.
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (text.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          j++;
        }
      }
      const isDoc = text.startsWith('/**', i) && !text.startsWith('/**/', i);
      if (!isDoc) out.push(...text.slice(i, j).split(/\r?\n/));
      i = j;
      continue;
    }
    break;
  }
  return out.join('\n');
}

/** What scip-dart (fork patches 10 and 13) reports about one package's files; package-relative POSIX paths. */
export interface ScipDartFileReport {
  /** Files indexed beyond the analyzer's analyzedFiles() (analysis_options.yaml `analyzer: exclude:`). */
  excludedIndexed: string[];
  /** Files that did not resolve: their references are unknown. */
  unresolved: string[];
  /** Parts of the package's libraries indexed from outside its walked dirs: build_runner output under `.dart_tool/build/generated/`. */
  generatedParts: string[];
  /** Parts of the package's libraries that are not in the package (`../…`), so not indexed: their references are unknown. */
  unindexedParts: string[];
}

/**
 * The per-package file report scip-dart writes to stderr as
 * `sentei-scip-dart: {"package": <abs dir>, "excludedIndexed": [...], "unresolved": [...], "generatedParts": [...], "unindexedParts": [...]}`
 * (package-relative POSIX paths), for the package in `dir` (real absolute path).
 * Absent (nothing to report), or a key missing (an older fork): empty.
 */
export function scipDartFileReport(stderr: string, dir: string): ScipDartFileReport {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('sentei-scip-dart: ')) continue;
    try {
      const r = JSON.parse(line.slice('sentei-scip-dart: '.length)) as Record<string, unknown>;
      if (typeof r['package'] !== 'string' || path.resolve(r['package']) !== path.resolve(dir)) continue;
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return {
        excludedIndexed: strings(r['excludedIndexed']),
        unresolved: strings(r['unresolved']),
        generatedParts: strings(r['generatedParts']),
        unindexedParts: strings(r['unindexedParts']),
      };
    } catch {
      continue;
    }
  }
  return { excludedIndexed: [], unresolved: [], generatedParts: [], unindexedParts: [] };
}

/** Files scip-dart (fork patch 11) warned are in no package of the package config, absolute, sorted. */
export function outsidePackageConfig(stderr: string): string[] {
  const out = new Set<string>();
  for (const line of stderr.split('\n')) {
    const m = /^WARN: (.+) is in no package of the package config; /.exec(line);
    if (m) out.add(m[1]!);
  }
  return [...out].sort();
}

function repoRelative(repoRoot: string, abs: string): string {
  const rel = path.relative(repoRoot, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel.split(path.sep).join('/');
}

/** The first few items of a list, comma-separated, with a count of the rest. */
function listSome(items: readonly string[], max = 5): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

/** Number of `.dart` files under the package's `lib/` (nested packages and dot dirs excluded). */
export function ownLibDartFiles(repo: DiscoveredRepo, pkg: DiscoveredPackage): number {
  const lib = path.join(packageDir(repo, pkg), 'lib');
  let n = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== lib && entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) return;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.dart')) n++;
    }
  };
  walk(lib);
  return n;
}

// ---- build_runner ----------------------------------------------------------

/** Parts build_runner writes: `*.g.dart` (json_serializable, built_value, over_react's `*.over_react.g.dart`) and `*.freezed.dart`. */
const GENERATED_PART = /\.(?:g|freezed)\.dart$/;

/** At most this long for `dart run build_runner build` (a large over_react package takes minutes). */
export const BUILD_RUNNER_TIMEOUT_MS = 10 * 60_000;

/**
 * `part '<uri>';` directives of the package's own Dart files (nested packages,
 * dot dirs, build/ and node_modules/ skipped) whose relative URI names a
 * generated part (see [GENERATED_PART]) that exists neither next to the file
 * nor where build_runner's `build_to: cache` builders (over_react) write it,
 * `.dart_tool/build/generated/<package name>/<path in the package>`, under the
 * package or under `workspaceRoot` (a pub workspace's generated dir is at its
 * root): the analyzer resolves the part from there (analyzer
 * `PackageConfigWorkspace.findFile`). As `<file relative to dir>: '<uri>'`,
 * sorted. Directives come from [dartPartUris], so a `part '…';` line in a
 * comment or a string is not one.
 */
export function missingGeneratedParts(dir: string, workspaceRoot?: string): string[] {
  const name = pubspecName(dir);
  const generatedDirs = name === undefined
    ? []
    : [...new Set([dir, workspaceRoot ?? dir])].map((root) => path.join(root, '.dart_tool', 'build', 'generated', name));
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (d !== dir && entries.some((e) => e.isFile() && e.name === 'pubspec.yaml')) return;
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'build' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.dart')) {
        let text: string;
        try {
          text = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        for (const uri of dartPartUris(text)) {
          if (uri.includes(':') || !GENERATED_PART.test(uri)) continue;
          const target = path.resolve(path.dirname(p), ...uri.split('/'));
          if (existsSync(target)) continue;
          const rel = path.relative(dir, target);
          if (!rel.startsWith('..') && !path.isAbsolute(rel) && generatedDirs.some((g) => existsSync(path.join(g, rel)))) continue;
          out.push(`${path.relative(dir, p).split(path.sep).join('/')}: '${uri}'`);
        }
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** The `name:` of `<dir>/pubspec.yaml`, or undefined. */
function pubspecName(dir: string): string | undefined {
  try {
    return /^name[ \t]*:[ \t]*["']?([A-Za-z_][A-Za-z0-9_]*)/m.exec(readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
}

const isDartIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * The URIs of the top-level `part '<uri>';` directives of a Dart source, in
 * order. A small lexer skips comments (`//`, `///`, nested block comments) and
 * string literals (single, double, triple-quoted, raw, `${…}` interpolation
 * included), so a `part '…';` line inside a doc comment or a multi-line string
 * is not a directive: over_react_analyzer_plugin's rule docs (a raw
 * triple-quoted `_details` string with a `part 'create_ref_usage.over_react.g.dart';`
 * line: 34 false "missing" parts on Workiva), a codemod's test input
 * (`part '$name.g.dart';` inside a string). A URI with interpolation or escapes is not
 * a directive's; `part of` is not a part. Parsing with the analyzer would need
 * a Dart process before build_runner; this is exact for directives.
 */
export function dartPartUris(text: string): string[] {
  const toks = dartTokens(text);
  const out: string[] = [];
  for (let k = 0; k + 2 < toks.length; k++) {
    const [a, b, c] = [toks[k]!, toks[k + 1]!, toks[k + 2]!];
    if (a.kind === 'word' && a.value === 'part' && a.depth === 0 && b.kind === 'string' && b.simple && c.kind === 'semi') out.push(b.value);
  }
  return out;
}

/**
 * Whether a Dart source is a part file: a top-level `part of` directive at the start of
 * a statement (the first token, or right after a `;`), comments and strings skipped by
 * the same lexer as [dartPartUris], so a doc comment or a string that says "part of" is
 * not one. A cheap text check, no analyzer.
 */
export function isDartPartFile(text: string): boolean {
  if (!/\bpart\s+of\b/.test(text)) return false;
  const toks = dartTokens(text);
  for (let k = 0; k + 1 < toks.length; k++) {
    const [a, b] = [toks[k]!, toks[k + 1]!];
    if (a.kind === 'word' && a.value === 'part' && a.depth === 0 && b.kind === 'word' && b.value === 'of'
      && (k === 0 || toks[k - 1]!.kind === 'semi')) return true;
  }
  return false;
}

/**
 * The entries (repo-relative POSIX) of a pub package that are libraries: every one but
 * the part files ([isDartPartFile]). discover lists every `lib/**` file, and a part is
 * not a library, so dart-surface would only log "not a library" for it (flamedeck: 2
 * files). An unreadable file is kept (dart-surface decides).
 */
export function dartLibraryEntries(localPath: string, entries: readonly string[]): string[] {
  return entries.filter((e) => {
    if (!e.endsWith('.dart')) return true;
    let text: string;
    try {
      text = readFileSync(path.resolve(localPath, ...e.split('/')), 'utf8');
    } catch {
      return true;
    }
    return !isDartPartFile(text);
  });
}

type DartTok = { kind: 'word' | 'string' | 'semi'; value: string; simple: boolean; depth: number };

/** Top-level tokens of a Dart source: words, simple strings and `;`, with their brace depth. */
function dartTokens(text: string): DartTok[] {
  const toks: DartTok[] = [];
  const n = text.length;
  let i = 0;
  const readString = (): { value: string; simple: boolean } => {
    let raw = false;
    if (text[i] === 'r' || text[i] === 'R') {
      raw = true;
      i++;
    }
    const q = text[i]!;
    const close = text.startsWith(q.repeat(3), i) ? q.repeat(3) : q;
    i += close.length;
    let value = '';
    let simple = true;
    while (i < n) {
      if (text.startsWith(close, i)) {
        i += close.length;
        return { value, simple };
      }
      const c = text[i]!;
      if (close.length === 1 && c === '\n') return { value, simple: false }; // unterminated
      if (!raw && c === '\\') {
        simple = false;
        i += 2;
        continue;
      }
      if (!raw && c === '$') {
        simple = false;
        i++;
        if (text[i] === '{') {
          i++;
          lex(true);
        }
        continue;
      }
      value += c;
      i++;
    }
    return { value, simple: false };
  };
  // Code until the end (or, in an interpolation, until its closing brace).
  const lex = (interpolation: boolean): void => {
    let depth = 0;
    while (i < n) {
      const c = text[i]!;
      if (c === '/' && text[i + 1] === '/') {
        const eol = text.indexOf('\n', i);
        i = eol < 0 ? n : eol;
      } else if (c === '/' && text[i + 1] === '*') {
        let level = 0;
        while (i < n) {
          if (text.startsWith('/*', i)) {
            level++;
            i += 2;
          } else if (text.startsWith('*/', i)) {
            level--;
            i += 2;
            if (level === 0) break;
          } else {
            i++;
          }
        }
      } else if (c === '"' || c === "'" || ((c === 'r' || c === 'R') && (text[i + 1] === '"' || text[i + 1] === "'"))) {
        const str = readString();
        if (!interpolation) toks.push({ kind: 'string', value: str.value, simple: str.simple, depth });
      } else if (isDartIdentChar(c)) {
        let j = i + 1;
        while (j < n && isDartIdentChar(text[j])) j++;
        if (!interpolation) toks.push({ kind: 'word', value: text.slice(i, j), simple: true, depth });
        i = j;
      } else {
        if (c === '{') depth++;
        else if (c === '}') {
          if (interpolation && depth === 0) {
            i++;
            return;
          }
          depth--;
        } else if (c === ';' && !interpolation) toks.push({ kind: 'semi', value: ';', simple: true, depth });
        i++;
      }
    }
  };
  lex(false);
  return toks;
}

/**
 * Generates missing `*.g.dart` / `*.freezed.dart` parts before indexing: a
 * library whose generated part is missing is incomplete (references inside
 * the part are unknown; Workiva's over_react packages commit none of them).
 * When [missingGeneratedParts] finds any and the pubspec depends on
 * build_runner, runs `dart run build_runner build --delete-conflicting-outputs`
 * in `dir` (after pub get), time-boxed to [BUILD_RUNNER_TIMEOUT_MS], output to
 * the package log, then counts again what is still missing (next to the
 * source or under `.dart_tool/build/generated/`, see [missingGeneratedParts]).
 * Records one `build_runner:` diagnostic and returns the outcome:
 * - `ran`: exit 0 (`ran (N missing; M still missing; …)`);
 * - `ran-with-errors`: non-zero exit but every part now exists (over_react_test:
 *   exit 1 from a pre-2.12 test's DDC build, all 13 parts written);
 * - `failed`: non-zero exit or timeout with parts still missing;
 * - `skipped`: build_runner is not a dependency;
 * undefined (nothing recorded) when no generated part is missing. `dart` is
 * the Flutter SDK's for a Flutter package; `workspaceRoot` the pub workspace
 * root of a member.
 */
export async function buildRunner(
  dir: string,
  diagnostics: string[],
  log: string[],
  dart = 'dart',
  run: (cmd: string, args: string[], cwd: string, timeoutMs?: number) => Promise<ExecResult> = exec,
  timeoutMs = BUILD_RUNNER_TIMEOUT_MS,
  workspaceRoot?: string,
): Promise<'ran' | 'ran-with-errors' | 'skipped' | 'failed' | undefined> {
  const missing = missingGeneratedParts(dir, workspaceRoot);
  if (missing.length === 0) return undefined;
  const some = `${missing.length} generated part(s) missing, e.g. ${missing[0]}`;
  let pubspec = '';
  try {
    pubspec = readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
  } catch {
    // no pubspec: nothing to run
  }
  if (!/^[ \t]+build_runner[ \t]*:/m.test(pubspec)) {
    diagnostics.push(`info: build_runner: skipped (${some}; build_runner is not a dependency)`);
    return 'skipped';
  }
  const args = ['run', 'build_runner', 'build', '--delete-conflicting-outputs'];
  const started = Date.now();
  const proc = await run(dart, args, dir, timeoutMs);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log.push(`$ ${dart} ${args.join(' ')}  (cwd ${dir}; ${secs} s)`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
  const still = missingGeneratedParts(dir, workspaceRoot).length;
  if (proc.timedOut !== true && proc.code === 0) {
    diagnostics.push(`info: build_runner: ran (${some}; ${still} still missing; ${secs} s)`);
    return 'ran';
  }
  const first = firstLine(proc.stderr) ?? firstLine(proc.stdout);
  const why = proc.timedOut === true
    ? `timed out after ${Math.round(timeoutMs / 1000)} s`
    : `exited with ${proc.code ?? proc.signal}${first ? `: ${first}` : ''}`;
  if (still === 0) {
    diagnostics.push(`info: build_runner: ran with errors (${some}; 0 still missing; ${why}; ${secs} s)`);
    return 'ran-with-errors';
  }
  diagnostics.push(`warn: build_runner: failed (${some}; ${still} still missing; ${why})`);
  return 'failed';
}

// ---- pubspec_overrides.yaml ------------------------------------------------

/**
 * Points every org dependency at its checkout with a `dependency_overrides`
 * path entry in `<pkgDir>/pubspec_overrides.yaml`, merged into the user's
 * file (other keys and overrides kept). An existing file we did not write is
 * copied to `.sentei-backup/pubspec_overrides.yaml` first (once, never
 * overwritten); when the file is already ours, the merge base is that backup
 * (or nothing), so a link dropped with `exclude` gets the user's original
 * entry (if any) back. Pub reads `dependency_overrides` from ONE place: the
 * overrides file when it has the key, else `pubspec.yaml`. So when the user's
 * file has no such key (or there is none), the pubspec's own
 * `dependency_overrides` are carried into the merge base: without them
 * dart-lang/native lost its `ffigen: {path: pkgs/ffigen}` and version solving
 * failed for all 14 workspace packages. Our links win only for the org
 * packages we link. `pubspec.yaml` is never touched. Returns the links
 * written (pub name -> relative path).
 */
export function writeOverrides(
  input: IndexerInput,
  pkgDir: string,
  diagnostics: string[],
  exclude: ReadonlySet<string> = new Set(),
): Map<string, string> {
  return writeOverridesFor(input.pkg.deps, new Set([input.pkg.packageId]), new Set(), input.lookup, pkgDir, diagnostics, exclude);
}

/**
 * [writeOverrides] for any dependency list: links every dep resolved to an org
 * package outside `selfIds`, except pub names in `skipNames` (a pub workspace's
 * own members: pub refuses to override them), in `exclude`, and in
 * `memberOverrides` (name -> the workspace member whose own overrides name it:
 * pub refuses a package "overridden in both" the root and a member).
 */
export function writeOverridesFor(
  deps: readonly DiscoveredDep[],
  selfIds: ReadonlySet<string>,
  skipNames: ReadonlySet<string>,
  lookup: IndexerInput['lookup'],
  pkgDir: string,
  diagnostics: string[],
  exclude: ReadonlySet<string> = new Set(),
  memberOverrides: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const links = new Map<string, string>();
  for (const dep of deps) {
    if (dep.resolvedPackageId === null || dep.resolvedPackageId === undefined) continue;
    if (selfIds.has(dep.resolvedPackageId)) continue;
    const target = lookup(dep.resolvedPackageId);
    if (target === undefined) {
      diagnostics.push(`warn: ${dep.name} resolves to ${dep.resolvedPackageId}, which is not in discover.json`);
      continue;
    }
    const targetDir = packageDir(target.repo, target.pkg);
    if (!existsSync(targetDir)) {
      diagnostics.push(`warn: ${dep.name}: org checkout ${targetDir} does not exist; not linked`);
      continue;
    }
    // The override key must be the target's pub name (what pub resolves).
    const name = target.pkg.name ?? dep.name;
    if (exclude.has(name) || links.has(name)) continue;
    if (skipNames.has(name)) {
      diagnostics.push(`warn: ${dep.name} resolves to ${dep.resolvedPackageId}, but the pub workspace has a member of that name; not linked`);
      continue;
    }
    const member = memberOverrides.get(name);
    if (member !== undefined) {
      diagnostics.push(`warn: ${name} is overridden by workspace member ${member} (pub refuses an override in both it and the root); not linked`);
      continue;
    }
    links.set(name, path.relative(pkgDir, realpathSync(targetDir)).split(path.sep).join('/') || '.');
  }

  const file = path.join(pkgDir, OVERRIDES);
  const backup = path.join(pkgDir, BACKUP_DIR, OVERRIDES);
  const existingText = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const ours = existingText?.startsWith(OVERRIDES_HEADER) === true;
  if (links.size === 0) {
    // Nothing to link (any more): put the user's file back, or remove ours.
    if (ours) {
      if (existsSync(backup)) copyFileSync(backup, file);
      else rmSync(file);
    }
    return links;
  }

  let doc: YamlMap = {};
  if (existingText !== undefined && !ours) {
    if (!existsSync(backup)) {
      mkdirSync(path.dirname(backup), { recursive: true });
      copyFileSync(file, backup);
      diagnostics.push(`info: backed up existing ${OVERRIDES} to ${BACKUP_DIR}/${OVERRIDES}`);
    } else {
      diagnostics.push(`info: ${BACKUP_DIR}/${OVERRIDES} already exists; not overwritten`);
    }
  }
  // The merge base is the user's file: the existing one when it is not ours,
  // else its backup (absent: the user had none).
  const baseText = existingText !== undefined && !ours ? existingText : existsSync(backup) ? readFileSync(backup, 'utf8') : undefined;
  if (baseText !== undefined) {
    const parsed = parseYamlBlock(baseText);
    if (parsed === undefined) {
      if (!ours) diagnostics.push(`warn: existing ${OVERRIDES} is not a plain block map; replaced (original in ${BACKUP_DIR}/)`);
    } else {
      doc = parsed;
    }
  }
  // Pub takes dependency_overrides from the overrides file when it has the
  // key, else from pubspec.yaml; ours always has it, so without a user key the
  // pubspec's entries join the base (with a user key, pub already ignored them).
  let fromPubspec: ReadonlySet<string> = new Set();
  if (!Object.hasOwn(doc, 'dependency_overrides')) {
    const own = pubspecOverridesIn(pkgDir);
    if (own.error !== undefined) {
      diagnostics.push(`warn: pubspec.yaml dependency_overrides not carried into ${OVERRIDES} (${own.error}); pub no longer applies them`);
    } else if (own.overrides !== undefined && Object.keys(own.overrides).length > 0) {
      doc['dependency_overrides'] = { ...own.overrides };
      fromPubspec = new Set(Object.keys(own.overrides));
      const carried = `info: carried pubspec.yaml dependency_overrides into ${OVERRIDES} (pub reads only one of the two): ${Object.keys(own.overrides).join(', ')}`;
      if (!diagnostics.includes(carried)) diagnostics.push(carried); // once, not per conflict retry
    }
  }
  let overrides = doc['dependency_overrides'];
  if (typeof overrides !== 'object') {
    overrides = {};
    doc['dependency_overrides'] = overrides;
  }
  for (const [name, rel] of links) {
    const prev = overrides[name];
    const next: YamlMap = { path: yamlScalar(rel) };
    if ((!ours || fromPubspec.has(name)) && prev !== undefined && !(typeof prev === 'object' && prev['path'] === next['path'])) {
      diagnostics.push(`info: replaced existing dependency_overrides entry for ${name}`);
    }
    overrides[name] = next;
  }
  const text = `${OVERRIDES_HEADER}\n${serializeYaml(doc, '')}`;
  if (text !== existingText) writeFileSync(file, text);
  diagnostics.push(`info: ${OVERRIDES}: ${[...links].map(([n, r]) => `${n} -> ${r}`).join(', ')}`);
  return links;
}

/**
 * The `dependency_overrides` of `<dir>/pubspec.yaml` (a top-level block map;
 * `{}` / `null` read as none), or why they cannot be read (flow style, YAML
 * [parseYamlBlock] does not round-trip). No file or no key: neither.
 */
export function pubspecOverridesIn(dir: string): { overrides?: YamlMap; error?: string } {
  let text: string;
  try {
    text = readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
  } catch {
    return {};
  }
  return pubspecDependencyOverrides(text);
}

/** [pubspecOverridesIn] on the text of a pubspec.yaml. */
export function pubspecDependencyOverrides(text: string): { overrides?: YamlMap; error?: string } {
  const lines = text.split(/\r?\n/);
  const key = /^["']?dependency_overrides["']?[ \t]*:/;
  const at = lines.findIndex((l) => key.test(l));
  if (at < 0) return {};
  const rest = stripComment(lines[at]!).replace(key, '').trim();
  if (rest === '{}' || rest === 'null' || rest === '~') return { overrides: {} };
  if (rest !== '') return { error: `not a block map: ${rest.slice(0, 40)}` };
  const block = ['dependency_overrides:'];
  for (let i = at + 1; i < lines.length && (lines[i]!.trim() === '' || /^[ \t#]/.test(lines[i]!)); i++) block.push(lines[i]!);
  const parsed = parseYamlBlock(block.join('\n'));
  const overrides = parsed?.['dependency_overrides'];
  if (parsed === undefined || typeof overrides !== 'object') return { error: 'YAML sentei cannot round-trip' };
  return { overrides };
}

/**
 * The names a pub package overrides itself: its own pubspec_overrides.yaml's
 * `dependency_overrides` when that file (not one we wrote) has the key, else its
 * pubspec.yaml's. Undefined when they cannot be read.
 */
export function effectiveOverrideNames(dir: string): string[] | undefined {
  const file = path.join(dir, OVERRIDES);
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (!text.startsWith(OVERRIDES_HEADER)) {
      const parsed = parseYamlBlock(text);
      if (parsed === undefined) return undefined;
      const o = parsed['dependency_overrides'];
      if (o !== undefined) return typeof o === 'object' ? Object.keys(o) : [];
    }
  }
  const own = pubspecOverridesIn(dir);
  return own.error !== undefined ? undefined : Object.keys(own.overrides ?? {});
}

// ---- Flutter ---------------------------------------------------------------

/**
 * Why a package needs the Flutter SDK, or undefined: its pubspec has
 * `environment.flutter` or depends on a Flutter SDK package (`flutter`,
 * `flutter_test`, ... or any `sdk: flutter` dependency, dev deps included:
 * pub resolves those too), or an org dependency (source-linked, followed
 * transitively) is a Flutter package.
 */
export function flutterReason(input: Pick<IndexerInput, 'repo' | 'pkg' | 'lookup'>): string | undefined {
  const seen = new Set<string>();
  const visit = (repo: DiscoveredRepo, pkg: DiscoveredPackage, via: string | undefined): string | undefined => {
    if (seen.has(pkg.packageId)) return undefined;
    seen.add(pkg.packageId);
    const own = pubspecFlutterReason(repo, pkg);
    if (own !== undefined) return via === undefined ? own : `org dependency ${via}: ${own}`;
    for (const dep of pkg.deps) {
      if (dep.resolvedPackageId === null || dep.resolvedPackageId === undefined) continue;
      const target = input.lookup(dep.resolvedPackageId);
      if (target === undefined || target.pkg.manager !== 'pub') continue;
      const r = visit(target.repo, target.pkg, via ?? target.pkg.name ?? dep.name);
      if (r !== undefined) return r;
    }
    return undefined;
  };
  return visit(input.repo, input.pkg, undefined);
}

function pubspecFlutterReason(repo: DiscoveredRepo, pkg: DiscoveredPackage): string | undefined {
  const sdkDep = pkg.deps.find((d) => FLUTTER_SDK_DEPS.has(d.name) || d.constraint === 'sdk:flutter');
  if (sdkDep !== undefined) return `depends on ${sdkDep.name}`;
  let text: string;
  try {
    text = readFileSync(path.join(packageDir(repo, pkg), 'pubspec.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  // `environment:` block with a `flutter:` key.
  const env = /^environment:[ \t]*(?:#.*)?\r?\n((?:(?:[ \t]+.*|[ \t]*)(?:\r?\n|$))*)/m.exec(text);
  if (env !== null && /^[ \t]+["']?flutter["']?[ \t]*:/m.test(env[1]!)) return 'environment.flutter';
  // Discover may not list every dependency section (e.g. dependency_overrides): `sdk: flutter` anywhere.
  if (/^[ \t]+sdk:[ \t]*["']?flutter["']?[ \t]*(?:#.*)?$/m.test(text)) return 'an sdk: flutter dependency';
  return undefined;
}

export interface FlutterSdk {
  /** FLUTTER_ROOT; undefined when `flutter` is not on PATH (or does not answer). */
  root?: string;
  /** `<root>/bin/cache/dart-sdk` when it exists. */
  dartSdk?: string;
  version?: string;
  error?: string;
  log: string[];
}

let flutterSdkPromise: Promise<FlutterSdk> | undefined;

/** Tests: pretend `flutter` is (or is not) installed; undefined restores detection. */
export function setFlutterSdkForTests(sdk: Omit<FlutterSdk, 'log'> | undefined): void {
  flutterSdkPromise = sdk === undefined ? undefined : Promise.resolve({ ...sdk, log: [] });
}

/** Locates the Flutter SDK once per process with `flutter --version --machine`. */
export function flutterSdk(): Promise<FlutterSdk> {
  flutterSdkPromise ??= (async (): Promise<FlutterSdk> => {
    const proc = await exec('flutter', ['--version', '--machine'], process.cwd());
    const log = [`$ flutter --version --machine`, proc.stdout, proc.stderr];
    if (proc.code !== 0) {
      return { error: proc.code === -1 ? undefined : `flutter --version exited with ${proc.code ?? proc.signal}`, log };
    }
    try {
      // Older Flutter versions may print a banner before the JSON.
      const json = JSON.parse(proc.stdout.slice(proc.stdout.indexOf('{'))) as { flutterRoot?: string; frameworkVersion?: string; dartSdkVersion?: string };
      if (typeof json.flutterRoot !== 'string') return { error: 'flutter --version --machine printed no flutterRoot', log };
      const dartSdk = path.join(json.flutterRoot, 'bin', 'cache', 'dart-sdk');
      return {
        root: json.flutterRoot,
        ...(existsSync(dartSdk) ? { dartSdk } : {}),
        version: `${json.frameworkVersion ?? '?'} (Dart ${json.dartSdkVersion ?? '?'})`,
        log,
      };
    } catch (err) {
      return { error: `flutter --version --machine printed invalid JSON: ${(err as Error).message}`, log };
    }
  })();
  return flutterSdkPromise;
}

/**
 * At most this many `pub get` retries, each dropping the source links pub
 * rejected. Pub names one rejected link per failure: dart-lang/pub-dev needed
 * 4 drops (test, build_runner, source_gen, coverage) and flute 4 (the cap was
 * 3, so both failed). Each retry is one offline resolution, seconds.
 */
export const MAX_CONFLICT_RETRIES = 8;

/**
 * `dart pub get` (`flutter pub get` with `cmd` = flutter) in `dir`. An org dep's HEAD can require versions the
 * consumer's own constraints exclude (HEAD moved to analyzer 14, the consumer
 * pins analyzer 5). Each time pub names rejected source links, they are
 * dropped (accumulating, user overrides restored) and pub get is retried, up
 * to [MAX_CONFLICT_RETRIES] times: the consumer then resolves the released
 * versions (its references still carry the org package's symbols,
 * version-normalized at ingest). One `warn:` per dropped link. Returns the
 * last run.
 */
export async function pubGet(
  input: IndexerInput,
  dir: string,
  args: string[],
  links: ReadonlyMap<string, string>,
  diagnostics: string[],
  log: string[],
  run: (cmd: string, args: string[], cwd: string) => Promise<ExecResult> = exec,
  cmd = 'dart',
  /** Rewrites the overrides without the excluded links (default: [writeOverrides] for `input`). */
  rewrite: (excluded: ReadonlySet<string>) => Map<string, string> = (excluded) => writeOverrides(input, dir, diagnostics, excluded),
): Promise<ExecResult> {
  const { pkg } = input;
  let proc = await run(cmd, args, dir);
  log.push(`$ ${cmd} ${args.join(' ')}  (cwd ${dir})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
  const excluded = new Set<string>();
  let current = new Set(links.keys());
  for (let attempt = 0; proc.code !== 0 && current.size > 0; attempt++) {
    // Every link pub names in this failure is dropped at once.
    const conflicts = parseOverrideConflicts(`${proc.stdout}\n${proc.stderr}`, current).filter((c) => !excluded.has(c.dep));
    if (conflicts.length === 0) break; // no progress: the failure is not (or no longer) a source link
    if (attempt === MAX_CONFLICT_RETRIES) {
      diagnostics.push(`warn: pub get still rejects source link(s) ${conflicts.map((c) => c.dep).join(', ')} after ${MAX_CONFLICT_RETRIES} retries; giving up`);
      break;
    }
    for (const c of conflicts) {
      excluded.add(c.dep);
      diagnostics.push(`warn: ${c.dep} not source-linked: HEAD conflicts with ${c.pkg ?? pkg.name ?? pkg.packageId}'s constraint (${c.detail})`);
    }
    current = new Set(rewrite(excluded).keys());
    proc = await run(cmd, args, dir);
    log.push(`$ ${cmd} ${args.join(' ')}  (cwd ${dir}; retry without ${[...excluded].join(', ')})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
  }
  return proc;
}

/** One source link pub refused: `dep`'s checkout conflicts with a constraint of `pkg`. */
export interface OverrideConflict {
  /** The overridden (source-linked) dependency pub names. */
  dep: string;
  /** The package whose constraint excludes the checkout, when pub names it. */
  pkg?: string;
  /** Pub's sentence about it, without the leading `Because`. */
  detail: string;
}

/**
 * Reads a failed `dart pub get` for source links pub rejected. Pub names a
 * path override `<dep> from path`, e.g.
 *   Because every version of codemod from path depends on analyzer ^14.0.0 and
 *   w_flux_codemod depends on analyzer ^5.13.0, codemod from path is forbidden.
 *   So, because w_flux_codemod depends on codemod from path, version solving failed.
 * Returns one conflict per overridden name that appears so, in `overridden`
 * order; nothing unless version solving failed.
 */
export function parseOverrideConflicts(output: string, overridden: ReadonlySet<string>): OverrideConflict[] {
  if (!/version solving failed/.test(output)) return [];
  const text = output.replace(/\s+/g, ' ');
  const sentences = text.split(/(?<=\.) (?=[A-Z])/).map((x) => x.trim());
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out: OverrideConflict[] = [];
  for (const dep of overridden) {
    const fromPath = new RegExp(`(?<![\\w-])${esc(dep)} from path\\b`);
    const sentence = sentences.find((x) => fromPath.test(x));
    if (sentence === undefined) continue;
    // The consumer: "<pkg> depends on <dep> from path", else the other side of the "and".
    // (pub writes a package as `name`, `name <version>` or `name <range>`.)
    const ver = '(?: [<>=^0-9][^ ,]*(?: <[^ ,]+)?)?';
    const direct = new RegExp(`\\b([a-z0-9_]+)${ver} depends on ${esc(dep)} from path`).exec(text);
    const other = new RegExp(`\\band ([a-z0-9_]+)${ver} depends on`).exec(sentence);
    const pkg = direct?.[1] ?? other?.[1];
    // (pub chains derivations: `So, because …` / `And because …`.)
    const detail = sentence
      .replace(/^(?:So, |And )?because /i, '')
      .replace(new RegExp(`, ${esc(dep)} from path is forbidden\\.?$`), '')
      .replace(/[.,]$/, '');
    out.push({ dep, ...(pkg !== undefined ? { pkg } : {}), detail });
  }
  return out;
}

/** Scalars are kept as raw source text so re-serializing preserves their quoting. */
type YamlValue = string | YamlMap;
interface YamlMap {
  [key: string]: YamlValue;
}

function yamlScalar(s: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(s) ? s : JSON.stringify(s);
}

/**
 * Minimal reader for pubspec_overrides.yaml: nested block maps whose values
 * are single-line scalars (kept raw). Returns undefined on anything else
 * (sequences, multi-line scalars, anchors), so the caller never guesses.
 */
export function parseYamlBlock(text: string): YamlMap | undefined {
  const root: YamlMap = {};
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (line.trim() === '' || line.trim() === '---') continue;
    const indent = line.length - line.trimStart().length;
    if (line.includes('\t')) return undefined;
    const m = /^([^:#'"{}[\]]+?|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(line.trim());
    if (m === null) return undefined;
    const key = m[1]!.replace(/^(["'])(.*)\1$/, '$2');
    const value = (m[2] ?? '').trim();
    if (/^[|>&*!-]/.test(value)) return undefined;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!.map;
    if (value === '') {
      const child: YamlMap = {};
      parent[key] = child;
      stack.push({ indent, map: child }); // an empty one is `key:` (null) again when written
    } else {
      parent[key] = value;
    }
  }
  return root;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function serializeYaml(map: YamlMap, indent: string): string {
  let out = '';
  for (const [k, v] of Object.entries(map)) {
    const key = /^[A-Za-z0-9._/-]+$/.test(k) ? k : JSON.stringify(k);
    if (typeof v === 'string') out += `${indent}${key}: ${v}\n`;
    else out += `${indent}${key}:\n${serializeYaml(v, `${indent}  `)}`;
  }
  return out;
}

// ---- tool setup ------------------------------------------------------------

let toolsReady: Promise<{ error?: string; log: string[] }> | undefined;

/**
 * Runs `dart pub get` in both tool dirs once (lazily, per process), then warms
 * their `dart run` snapshots. Guarded by a lock dir (vitest workers and parallel
 * sentei runs share the checkout) and skipped when a marker records the
 * pubspec.yaml hash it was resolved for.
 */
function ensureTools(install: boolean): Promise<{ error?: string; log: string[] }> {
  toolsReady ??= (async () => {
    const log: string[] = [];
    for (const [dir, exe, warmArgs] of [
      [SCIP_DART_DIR, 'scip_dart', ['--version']],
      [DART_SURFACE_DIR, 'dart_surface', ['--help']],
    ] as const) {
      const error = await withLock(path.join(dir, '.dart_tool', 'sentei-setup.lock'), async () => {
        const marker = path.join(dir, '.dart_tool', 'sentei-ready');
        const hash = createHash('sha256').update(readFileSync(path.join(dir, 'pubspec.yaml'))).digest('hex');
        const ready = existsSync(marker) && readFileSync(marker, 'utf8') === hash
          && existsSync(path.join(dir, '.dart_tool', 'package_config.json'));
        if (!ready) {
          // Offline first (the pub cache usually has everything); online only if allowed.
          let proc = await exec('dart', ['pub', 'get', '--offline'], dir);
          log.push(`$ dart pub get --offline  (cwd ${dir})`, proc.stdout, proc.stderr);
          if (proc.code !== 0 && install) {
            proc = await exec('dart', ['pub', 'get'], dir);
            log.push(`$ dart pub get  (cwd ${dir})`, proc.stdout, proc.stderr);
          }
          if (proc.code !== 0) {
            return `dart pub get in ${path.relative(INDEXERS_DIR, dir)} exited with ${proc.code ?? proc.signal}: ${firstLine(proc.stderr) ?? ''}`;
          }
        }
        // Builds (or reuses) the cached snapshot under .dart_tool/pub/bin while we hold the lock.
        const warm = await exec('dart', ['run', exe, ...warmArgs], dir);
        if (warm.code !== 0) {
          log.push(`$ dart run ${exe} ${warmArgs.join(' ')}  (cwd ${dir})`, warm.stdout, warm.stderr);
          return `dart run ${exe} failed in ${path.relative(INDEXERS_DIR, dir)}: ${firstLine(warm.stderr) ?? ''}`;
        }
        if (!ready) writeFileSync(marker, hash);
        return undefined;
      });
      if (error !== undefined) return { error, log };
    }
    return { log };
  })();
  // A failed setup is retried by the next caller (e.g. after the network came back).
  void toolsReady.then((r) => {
    if (r.error !== undefined) toolsReady = undefined;
  });
  return toolsReady;
}

/** Runs `fn` holding an exclusive lock dir; a lock older than 15 minutes is considered stale. */
async function withLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 15 * 60_000) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // raced with the holder releasing it
      }
      if (Date.now() > deadline) throw new Error(`sentei: timed out waiting for ${lockDir}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// ---- subprocess ------------------------------------------------------------

function firstLine(s: string): string | undefined {
  return s.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
}

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Killed after its time box. */
  timedOut?: true;
}

function exec(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Windows: the SDK's `dart` is an .exe, but Flutter's is a .bat shim that needs a shell.
    const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${err.message}\n` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ...(timedOut ? { timedOut: true as const } : {}) });
    });
  });
}
