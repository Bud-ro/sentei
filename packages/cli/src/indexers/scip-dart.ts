// scip-dart adapter (PLAN.md §6.2, §6.6). Both Dart tools run as subprocesses
// from their own dirs under packages/indexers/, never from a global activation:
//   - packages/indexers/scip-dart: vendored scip-dart 1.7.0 (Workiva/scip-dart
//     @ 8d017a25874efb8513617e85e508a573692cbb63) with the patches listed in its
//     PATCHES.md (SDK floor 3.11; `--private-symbols`, which we always pass);
//   - packages/indexers/dart-surface: the export-surface sidecar (SCIP carries
//     no export information), same JSON shape as the TypeScript sidecar.
// Org dependencies are source-linked with a `pubspec_overrides.yaml`
// (`dependency_overrides: {<dep>: {path: ...}}`), the pub equivalent of the npm
// node_modules symlinks: consumer references then carry the lib's own symbols.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDir, packageSlug } from './scip-typescript.ts';
import type { ExportsSidecar, Indexer, IndexerInput, IndexStatus, IndexerResult, SourcePosition } from './types.ts';
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

/** Output of dart-surface: the sidecar plus two adapter-only keys (stripped before writing). */
interface SurfaceOutput extends ExportsSidecar {
  unresolvedOrgModules: Array<SourcePosition & { module: string }>;
  diagnostics: string[];
}

export const scipDart: Indexer = {
  name: 'scip-dart',
  // Upstream version + our patch level. Bump the patch level whenever the
  // vendored fork or dart-surface changes output (it is the index cache key).
  version: '1.7.0+sentei.3',

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
    writeOverrides(input, dir, diagnostics);
    // 2. Resolve. Offline when installs are disabled: path deps and anything
    //    already in the pub cache still resolve.
    const args = ['pub', 'get', ...(options.install ? [] : ['--offline'])];
    const proc = await exec('dart', args, dir);
    log.push(`$ dart ${args.join(' ')}  (cwd ${dir})`, '--- stdout', proc.stdout, '--- stderr', proc.stderr);
    if (proc.code !== 0) {
      status = 'partial';
      const why = firstLine(proc.stderr) ?? firstLine(proc.stdout) ?? '';
      diagnostics.push(`error: dart ${args.join(' ')} exited with ${proc.code ?? proc.signal}${why ? `: ${why}` : ''}`);
    } else {
      diagnostics.push(`info: ran dart ${args.join(' ')}`);
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

    const tools = await ensureTools(options.install);
    log.push(...tools.log);
    if (tools.error !== undefined) {
      status = 'failed';
      diagnostics.push(`error: ${tools.error}`);
      return finish();
    }

    const repoRoot = realpathSync(repo.localPath);
    const dir = realpathSync(packageDir(repo, pkg));

    // 3. Index. scip-dart exits 0 on type errors and on unresolved imports; it
    //    fails only without .dart_tool/package_config.json (i.e. pub get failed).
    rmSync(scipFile, { force: true });
    const scipArgs = ['run', 'scip_dart', '--private-symbols', '--output', scipFile, dir];
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
    const orgNames = [
      ...new Set(input.orgPackages.flatMap(({ pkg: p }) => (p.manager === 'pub' && p.name !== null ? [p.name] : []))),
    ].sort();
    const surfaceArgs = [
      'run', 'dart_surface',
      '--repo-root', repoRoot,
      '--package-root', dir,
      '--package-id', pkg.packageId,
      '--org-packages', orgNames.join(','),
      ...pkg.entryPoints.flatMap((e) => ['--entry', e]),
      ...nested.flatMap((d) => ['--nested', d]),
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
    const { unresolvedOrgModules, diagnostics: surfaceDiagnostics, ...rest } = out, sidecar = { ...rest, shorthandRefs: rest.shorthandRefs ?? [] };
    writeFileSync(exportsFile, `${JSON.stringify(sidecar satisfies ExportsSidecar, null, 2)}\n`);
    for (const m of unresolvedOrgModules) {
      diagnostics.push(`error: unresolved org module '${m.module}' at ${m.file}:${m.line + 1}:${m.col + 1}`);
    }
    for (const u of sidecar.unresolvedImports) {
      diagnostics.push(`warn: '${u.name}' is not exported by org module '${u.module}' at ${u.file}:${u.line + 1}:${u.col + 1}`);
    }
    diagnostics.push(...surfaceDiagnostics);
    if (unresolvedOrgModules.length > 0 || sidecar.unresolved.length > 0 || sidecar.missingEntryPoints.length > 0) {
      status = worstStatus(status, 'partial');
    }
    return finish();
  },
};

// ---- pubspec_overrides.yaml ------------------------------------------------

/**
 * Points every org dependency at its checkout with a `dependency_overrides`
 * path entry in `<pkgDir>/pubspec_overrides.yaml`, merged into an existing
 * file (other keys and overrides kept). An existing file we did not write is
 * copied to `.sentei-backup/pubspec_overrides.yaml` first (once, never
 * overwritten). `pubspec.yaml` is never touched.
 */
export function writeOverrides(input: IndexerInput, pkgDir: string, diagnostics: string[]): void {
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
    links.set(name, path.relative(pkgDir, realpathSync(targetDir)).split(path.sep).join('/') || '.');
  }
  if (links.size === 0) return;

  const file = path.join(pkgDir, OVERRIDES);
  let doc: YamlMap = {};
  let existingText: string | undefined;
  if (existsSync(file)) {
    existingText = readFileSync(file, 'utf8');
    const ours = existingText.startsWith(OVERRIDES_HEADER);
    if (!ours) {
      const backup = path.join(pkgDir, BACKUP_DIR, OVERRIDES);
      if (!existsSync(backup)) {
        mkdirSync(path.dirname(backup), { recursive: true });
        copyFileSync(file, backup);
        diagnostics.push(`info: backed up existing ${OVERRIDES} to ${BACKUP_DIR}/${OVERRIDES}`);
      } else {
        diagnostics.push(`info: ${BACKUP_DIR}/${OVERRIDES} already exists; not overwritten`);
      }
    }
    const parsed = parseYamlBlock(existingText);
    if (parsed === undefined) {
      diagnostics.push(`warn: existing ${OVERRIDES} is not a plain block map; replaced (original in ${BACKUP_DIR}/)`);
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
    if (prev !== undefined && !(typeof prev === 'object' && prev['path'] === next['path'])) {
      diagnostics.push(`info: replaced existing dependency_overrides entry for ${name}`);
    }
    overrides[name] = next;
  }
  const text = `${OVERRIDES_HEADER}\n${serializeYaml(doc, '')}`;
  if (text !== existingText) writeFileSync(file, text);
  diagnostics.push(`info: ${OVERRIDES}: ${[...links].map(([n, r]) => `${n} -> ${r}`).join(', ')}`);
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

interface ExecResult {
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
