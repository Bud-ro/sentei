// scip-dart adapter (PLAN.md §6.2, §6.6). Both Dart tools run as subprocesses
// from their own dirs under packages/indexers/, never from a global activation:
//   - packages/indexers/scip-dart: vendored scip-dart 1.7.0 (Workiva/scip-dart
//     @ 8d017a25874efb8513617e85e508a573692cbb63) with the patches listed in its
//     PATCHES.md (SDK floor 3.11; `--private-symbols`, which we always pass;
//     valid symbols for operators, nameless elements and import prefixes;
//     no occurrences for dartdoc `[Name]` links);
//   - packages/indexers/dart-surface: the export-surface sidecar (SCIP carries
//     no export information), same JSON shape as the TypeScript sidecar.
// Org dependencies are source-linked with a `pubspec_overrides.yaml`
// (`dependency_overrides: {<dep>: {path: ...}}`), the pub equivalent of the npm
// node_modules symlinks: consumer references then carry the lib's own symbols.
// Flutter packages (see [flutterReason]) are resolved with `flutter pub get`,
// whose package_config.json points `flutter` and `sky_engine` (dart:ui, via its
// _embedder.yaml) into the Flutter SDK; both tools then analyze against the
// Flutter SDK's own Dart SDK (`--sdk-path <flutterRoot>/bin/cache/dart-sdk`),
// which is a no-op when the `dart` on PATH is Flutter's.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_GLOBS, matchGlob } from '@sentei/core';
import { isExcludedConsumerFile } from './consumer-checks.ts';
import { packageDir, packageSlug } from './scip-typescript.ts';
import type { DiscoveredPackage, DiscoveredRepo, EntrySymbol, ExportsSidecar, Indexer, IndexerInput, IndexStatus, IndexerResult, SourcePosition } from './types.ts';
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
  version: '1.7.0+sentei.8',

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
    // 1. Source-link org dependencies (before `pub get`, which reads the overrides).
    const links = writeOverrides(input, dir, diagnostics);
    // 2. Resolve. Offline when installs are disabled: path deps and anything
    //    already in the pub cache still resolve. A Flutter package needs `flutter pub get`.
    const args = ['pub', 'get', ...(options.install ? [] : ['--offline'])];
    const flutter = flutterReason(input);
    let cmd = 'dart';
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
      diagnostics.push(`info: Flutter package (${flutter}); Flutter SDK ${sdk.version ?? '?'} at ${sdk.root}`);
    }
    const proc = await pubGet(input, dir, args, links, diagnostics, log, exec, cmd);
    if (proc.code !== 0) {
      status = 'partial';
      const why = firstLine(proc.stderr) ?? firstLine(proc.stdout) ?? '';
      diagnostics.push(`error: ${cmd} ${args.join(' ')} exited with ${proc.code ?? proc.signal}${why ? `: ${why}` : ''}`);
    } else {
      diagnostics.push(`info: ran ${cmd} ${args.join(' ')}`);
    }
    return { status, diagnostics, log };
  },

  async run(input, outDir) {
    const { repo, pkg, options } = input;
    const prepared = input.prepared ?? (await this.prepare!(input));
    const diagnostics: string[] = [...prepared.diagnostics];
    let status: IndexStatus = prepared.status;
    const slug = packageSlug(pkg);
    const scipFile = path.join(outDir, `${slug}.scip`);
    const exportsFile = path.join(outDir, `${slug}.exports.json`);
    const logFile = path.join(outDir, `${slug}.log`);
    const log: string[] = [...prepared.log];
    const finish = (): IndexerResult => {
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
      status = 'failed';
      diagnostics.push(`error: ${tools.error}`);
      return finish();
    }

    const repoRoot = realpathSync(repo.localPath);
    const dir = realpathSync(packageDir(repo, pkg));

    // Flutter packages: analyze against the Flutter SDK's Dart SDK.
    const sdk = flutterReason(input) !== undefined ? await flutterSdk() : undefined;
    const sdkArgs = sdk?.dartSdk !== undefined ? ['--sdk-path', sdk.dartSdk] : [];

    // 3. Index. scip-dart exits 0 on type errors and on unresolved imports; it
    //    fails only without .dart_tool/package_config.json (i.e. pub get failed).
    rmSync(scipFile, { force: true });
    const scipArgs = ['run', 'scip_dart', '--private-symbols', ...sdkArgs, '--output', scipFile, dir];
    const proc = await exec('dart', scipArgs, SCIP_DART_DIR);
    log.push(`$ dart ${scipArgs.join(' ')}  (cwd ${SCIP_DART_DIR})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
    if (proc.code !== 0) {
      status = 'failed';
      const why = firstLine(proc.stderr);
      diagnostics.push(`error: scip-dart exited with ${proc.code ?? proc.signal}${why ? `: ${why}` : ''}`);
    }
    if (!existsSync(scipFile) || statSync(scipFile).size === 0) {
      status = 'failed';
      diagnostics.push(`error: ${path.basename(scipFile)} missing or empty`);
    }

    // 4. Export-surface sidecar.
    const nested = repo.packages
      .map((p) => packageDir(repo, p))
      .filter((d) => d !== packageDir(repo, pkg) && existsSync(d))
      .map((d) => realpathSync(d))
      .filter((d) => d.startsWith(dir + path.sep));
    // Ignored manifests (examples, templates, fixtures) strictly inside this
    // package are separate packages too: scip-dart does not index them, so an
    // entry symbol or export found there could never match a definition.
    const ignored = (repo.ignoredManifests ?? [])
      .map((m) => path.resolve(repo.localPath, ...m.path.split('/')))
      .filter((d) => existsSync(d))
      .map((d) => realpathSync(d))
      .filter((d) => d.startsWith(dir + path.sep) && !nested.includes(d));
    const orgNames = [
      ...new Set(input.orgPackages.flatMap(({ pkg: p }) => (p.manager === 'pub' && p.name !== null ? [p.name] : []))),
    ].sort();
    const surfaceArgs = [
      'run', 'dart_surface',
      '--repo-root', repoRoot,
      '--package-root', dir,
      '--package-id', pkg.packageId,
      ...(pkg.name !== null && pkg.name !== undefined ? ['--package-name', pkg.name] : []),
      ...sdkArgs,
      '--org-packages', orgNames.join(','),
      ...pkg.entryPoints.flatMap((e) => ['--entry', e]),
      ...[...nested, ...ignored].flatMap((d) => ['--nested', d]),
      // Without a package config mapping the package itself (pub get failed;
      // any config found is an enclosing package's), none of its own
      // `package:` URIs resolve: one error says so, not one per directive.
      ...(prepared.diagnostics.some((d) => PUB_GET_FAILED.test(d)) ? ['--pub-get-failed'] : []),
    ];
    const sp = await exec('dart', surfaceArgs, DART_SURFACE_DIR);
    log.push(`$ dart ${surfaceArgs.join(' ')}  (cwd ${DART_SURFACE_DIR})`, '--- stderr', sp.stderr);
    let out: SurfaceOutput | undefined;
    if (sp.code === 0) {
      try {
        out = JSON.parse(sp.stdout) as SurfaceOutput;
      } catch (err) {
        diagnostics.push(`error: dart-surface printed invalid JSON: ${(err as Error).message}`);
      }
    } else {
      diagnostics.push(`error: dart-surface exited with ${sp.code ?? sp.signal}: ${firstLine(sp.stderr) ?? ''}`);
    }
    if (out === undefined) {
      status = 'failed';
      diagnostics.push('error: export surface failed');
      return finish();
    }
    const { unresolvedOrgModules, missingParts = [], diagnostics: surfaceDiagnostics, unresolvedOwnUris = 0, ...rest } = out;
    const sidecar: ExportsSidecar = {
      ...rest,
      shorthandRefs: rest.shorthandRefs ?? [],
      namespaceSpreadRefs: [],
      // A test's `main` is run by the test runner; test files never get verdicts.
      // dart-surface emits no kind: every Dart entry symbol is invoked by the runtime or a tool.
      entrySymbols: rest.entrySymbols
        .filter((e) => !TEST_GLOBS.some((g) => matchGlob(g, e.file)))
        .map((e) => ({ ...e, kind: e.kind ?? 'runtime' })),
    };
    writeFileSync(exportsFile, `${JSON.stringify(sidecar satisfies ExportsSidecar, null, 2)}\n`);
    if (unresolvedOwnUris > 0) {
      status = worstStatus(status, 'partial');
      diagnostics.push(`error: package unresolvable (pub get failed): ${unresolvedOwnUris} own package: import/export URI(s) do not resolve`);
    }
    for (const m of unresolvedOrgModules) {
      diagnostics.push(`error: unresolved org module '${m.module}' at ${m.file}:${m.line + 1}:${m.col + 1}`);
    }
    for (const u of sidecar.unresolvedImports) {
      diagnostics.push(`warn: '${u.name}' is not exported by org module '${u.module}' at ${u.file}:${u.line + 1}:${u.col + 1}`);
    }
    // A missing part (typically an ungenerated `*.g.dart`: build_runner was not
    // run) leaves its library incomplete: references inside it are unknown.
    // That matters for the package's library code (lib/, bin/): its surface and
    // its uses of other packages. Missing parts elsewhere (web/ demos, example/,
    // test/, tool/) and in test/docs files the policy does not count only warn.
    let incomplete = 0;
    for (const m of missingParts) {
      const at = `${m.file}:${m.line + 1}:${m.col + 1}`;
      if (isExcludedConsumerFile(m.file, input.policy)) {
        diagnostics.push(`warn: missing part '${m.uri}' at ${at} (not generated?); ignored: a test/docs file that does not count as a consumer`);
        continue;
      }
      const top = path.posix.relative(pkg.path === '.' ? '' : pkg.path, m.file).split('/')[0];
      if (top !== 'lib' && top !== 'bin') {
        diagnostics.push(`warn: missing part '${m.uri}' at ${at} (not generated?); outside lib/ and bin/, references inside it are unknown`);
        continue;
      }
      incomplete++;
      diagnostics.push(`error: missing generated part '${m.uri}' at ${at}: the library is incomplete, references inside the part are unknown (run build_runner before indexing)`);
    }
    diagnostics.push(...surfaceDiagnostics);
    if (unresolvedOrgModules.length > 0 || incomplete > 0 || sidecar.unresolved.length > 0 || sidecar.missingEntryPoints.length > 0) {
      status = worstStatus(status, 'partial');
    }
    return finish();
  },
};

// ---- pubspec_overrides.yaml ------------------------------------------------

/**
 * Points every org dependency at its checkout with a `dependency_overrides`
 * path entry in `<pkgDir>/pubspec_overrides.yaml`, merged into the user's
 * file (other keys and overrides kept). An existing file we did not write is
 * copied to `.sentei-backup/pubspec_overrides.yaml` first (once, never
 * overwritten); when the file is already ours, the merge base is that backup
 * (or nothing), so a link dropped with `exclude` gets the user's original
 * entry (if any) back. `pubspec.yaml` is never touched. Returns the links
 * written (pub name -> relative path).
 */
export function writeOverrides(
  input: IndexerInput,
  pkgDir: string,
  diagnostics: string[],
  exclude: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const links = new Map<string, string>();
  for (const dep of input.pkg.deps) {
    if (dep.resolvedPackageId === null || dep.resolvedPackageId === undefined) continue;
    if (dep.resolvedPackageId === input.pkg.packageId) continue;
    const target = input.lookup(dep.resolvedPackageId);
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
    if (exclude.has(name)) continue;
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
  let overrides = doc['dependency_overrides'];
  if (typeof overrides !== 'object') {
    overrides = {};
    doc['dependency_overrides'] = overrides;
  }
  for (const [name, rel] of links) {
    const prev = overrides[name];
    const next: YamlMap = { path: yamlScalar(rel) };
    if (!ours && prev !== undefined && !(typeof prev === 'object' && prev['path'] === next['path'])) {
      diagnostics.push(`info: replaced existing dependency_overrides entry for ${name}`);
    }
    overrides[name] = next;
  }
  const text = `${OVERRIDES_HEADER}\n${serializeYaml(doc, '')}`;
  if (text !== existingText) writeFileSync(file, text);
  diagnostics.push(`info: ${OVERRIDES}: ${[...links].map(([n, r]) => `${n} -> ${r}`).join(', ')}`);
  return links;
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

/** At most this many `pub get` retries, each dropping the source links pub rejected. */
export const MAX_CONFLICT_RETRIES = 3;

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
): Promise<ExecResult> {
  const { pkg } = input;
  let proc = await run(cmd, args, dir);
  log.push(`$ ${cmd} ${args.join(' ')}  (cwd ${dir})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
  const excluded = new Set<string>();
  let current = new Set(links.keys());
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES && proc.code !== 0 && current.size > 0; attempt++) {
    const conflicts = parseOverrideConflicts(`${proc.stdout}\n${proc.stderr}`, current).filter((c) => !excluded.has(c.dep));
    if (conflicts.length === 0) break;
    for (const c of conflicts) {
      excluded.add(c.dep);
      diagnostics.push(`warn: ${c.dep} not source-linked: HEAD conflicts with ${c.pkg ?? pkg.name ?? pkg.packageId}'s constraint (${c.detail})`);
    }
    current = new Set(writeOverrides(input, dir, diagnostics, excluded).keys());
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
    const detail = sentence
      .replace(/^(So, )?because /i, '')
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
}

function exec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Windows: the SDK's `dart` is an .exe, but Flutter's is a .bat shim that needs a shell.
    const child = spawn(cmd, args, { cwd, env: process.env, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', (err) => resolve({ code: -1, signal: null, stdout, stderr: `${stderr}${err.message}\n` }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
