// `discover` stage core (PLAN.md §6.1).
//
// discoverRepos builds the org model (the exact shape of work/discover.json) from
// a list of checked-out repos; it is shared by both sources:
//   - local (discoverLocal, below): a directory laid out as
//   <orgDir>/org.json            { "org": "acme", "repos": [{ "name", "default_branch" }] }
//   <orgDir>/sentei.json         optional org policy + keep (config.ts)
//   <orgDir>/repos/<name>/       one checkout per repo; optional <repo>/sentei.json overlays
//
//   - github (github.ts discoverGithub): API listing + shallow clones.
// writeDiscoverToDb replaces the whole org in the DB from that model.
import { readFileSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  defaultOrgConfig, packageIdOf, packageRefMatches, parseKeepEntry, readOrgConfig, readRepoConfig, type Policy, type RepoConfig,
} from './config.ts';
import { matchGlob } from './glob.ts';
import {
  DEFAULT_IGNORE_MANIFEST_DIRS, inIgnoredDir, listFiles, readRepoManifestsWithIgnored,
  type IgnoredManifest, type Manager, type ManifestPackage, type Visibility,
} from './manifests.ts';
import type { ExcludedRepoInfo } from './repo-select.ts';

export interface DiscoverDep {
  name: string;
  manager: Manager;
  constraint: string | null;
  /** Org package this dep points at, or null for third-party deps and ambiguous ones. */
  resolvedPackageId: string | null;
  /**
   * How the org package was picked (DepResolution); present iff resolvedPackageId is.
   * Optional: absent in older discover.json files.
   */
  resolution?: DepResolution;
  /**
   * Present (true) when several org packages have the dep's name and none could be
   * preferred: resolvedPackageId is null, `candidates` lists them, and the consumer is
   * flagged `ambiguous_dep` at each (fail closed).
   */
  ambiguous?: true;
  /** Every org package of the dep's name (sorted), when there is more than one. */
  candidates?: string[];
  /** Present (true) when declared only as a dev dependency (ManifestDep.dev). */
  dev?: true;
}

/**
 * Dependency resolution by name (package ids are `<manager>:<repo>:<name>`, so a name
 * can belong to several org packages). `name`: the only org package of that name;
 * `same-repo`: several, the consumer's own repo has one; `published`: several, exactly
 * one of them is not private (npm `private: true` / pub `publish_to: none` packages
 * cannot be installed from a registry, so a consumer elsewhere cannot mean them).
 */
export type DepResolution = 'name' | 'same-repo' | 'published';

export interface DiscoverPackage {
  packageId: string;
  /** Package dir relative to the repo root, POSIX; '.' for the root. */
  path: string;
  manager: Manager;
  name: string;
  version: string | null;
  visibility: Visibility;
  /** Library manifest shape (ManifestPackage.isLibrary). Absent in older discover.json: app. */
  isLibrary?: boolean;
  /** Relative to the REPO root, POSIX, sorted. */
  entryPoints: string[];
  /**
   * Code-looking `main`/`module`/`types`/`typings`/`exports` leaves that resolve to no
   * file (ManifestPackage.unresolvedEntryPoints), as written; each also gives an
   * `opaque_consumer` flag. Optional: absent in older discover.json files (= []).
   */
  unresolvedEntryPoints?: string[];
  /**
   * Files loaded by the runtime / a bundler rather than imported
   * (ManifestPackage.runtimeEntryPoints: `imports` map arms, Vite / HTML client
   * entries, convention entries, `bin` targets; all but the bins are also entryPoints).
   * Optional: absent in older discover.json files (= []).
   */
  runtimeEntryPoints?: string[];
  /**
   * Exported class names the runtime instantiates by name (ManifestPackage.
   * runtimeEntrySymbols: wrangler Durable Object / Workflow `class_name`, migration
   * `new_classes`). Optional: absent when none.
   */
  runtimeEntrySymbols?: string[];
  deps: DiscoverDep[];
  /** package_flags discover owns (`unindexed_consumer`, `opaque_consumer`, `ambiguous_dep`); [] when none. */
  flags: DiscoverFlag[];
}

/**
 * Every `opaque_consumer` reason discover writes starts with this, so ingest (which
 * owns and rebuilds the other `opaque_consumer` rows) can keep discover's.
 */
export const DISCOVER_REASON_PREFIX = 'discover: ';

export interface DiscoverFlag {
  /**
   * `unindexed_consumer`: code in a language we cannot index. `opaque_consumer`: an
   * entry point we cannot resolve, so the package's own surface is unknown (reason
   * `discover: unresolved entry point <leaf>`). Both untargeted. `ambiguous_dep`: a
   * dependency whose name several org packages share with none preferred (reason
   * `dep <name> matches <k> org packages: <ids>`), targeted at one candidate (one row
   * per candidate).
   */
  flag: 'unindexed_consumer' | 'opaque_consumer' | 'ambiguous_dep';
  reason: string;
  /** Repo-relative POSIX path of the first offending file (the manifest for opaque_consumer / ambiguous_dep). */
  file: string;
  /** ambiguous_dep only: the candidate package this row blocks. */
  targetPackageId?: string;
}

/**
 * Extensions of programming languages we have no indexer for (PLAN §2: a consumer
 * containing such code is `unindexed_consumer`, opaque). Read strictly as
 * programming languages that can load an npm/pub package: shell scripts (.sh),
 * YAML, JSON, Markdown, Dockerfiles and other config/data files are deliberately
 * NOT listed. Compared case-insensitively.
 */
export const UNINDEXED_LANGUAGE_EXTS: ReadonlySet<string> = new Set([
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php', '.cs', '.swift', '.c', '.cc', '.cpp',
  '.h', '.hpp', '.m', '.mm', '.scala', '.ex', '.exs', '.clj', '.cljs', '.pl', '.pm', '.lua', '.erl',
  '.hs', '.ml', '.fs', '.r', '.jl',
]);

/**
 * For a pub package, the only unindexed files that could consume another pub package:
 * JS-family code and pages (Dart compiled to JS exposes exports to them, `@JSExport`;
 * gated by DART_TO_JS_EXPORT).
 * C, C++, Objective-C, Swift, Java, Kotlin, Go, Rust, Python, Ruby… cannot import a
 * Dart library; they reach Dart over FFI or method channels, so for pub packages they
 * are never consumers, wherever they sit (ffigen's vendored cJSON, cupertino_http's
 * `src/*.m`, jnigen's `java/`, a Go tool beside a Dart workspace). Dart itself is
 * indexed. The npm side keeps UNINDEXED_LANGUAGE_EXTS.
 */
export const PUB_CONSUMER_EXTS: ReadonlySet<string> = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.html',
]);

/**
 * Dart that makes its members callable from JS by name (dart:js_interop `@JSExport`,
 * `createJSInteropWrapper`; package:js `createDartExport`). Only through such code can
 * JS use a Dart member without an indexed Dart reference, so a pub package's JS-family
 * files flag it `unindexed_consumer` only when an org dependency has it (the same gate
 * as witness.ts's cross-manager pass; the same pattern as its DART_JS_EXPORT_RE).
 * Fail closed: an unreadable Dart file counts as exporting.
 */
export const DART_TO_JS_EXPORT = /@JSExport\b|\bcreateJSInteropWrapper\b|\bcreateDartExport\b/;

/**
 * A manifest skipped as "not an org package" (ignoreManifestDirs / ignoreManifests),
 * with its deps resolved against org packages. Recorded in discover.json only (never
 * in the DB): its code is not indexed, so it adds no edges; the witness scans its dir
 * as an extra consumer of every package it depends on (PLAN §12).
 */
export interface DiscoverIgnoredManifest {
  /** Manifest dir relative to the repo root, POSIX; '.' for the root. */
  path: string;
  /** Manifest file relative to the repo root, POSIX. */
  manifest: string;
  manager: Manager;
  name: string | null;
  deps: DiscoverDep[];
  /** Unparseable manifest: deps unknown, the witness scans it for every package. */
  depsUnknown: boolean;
  /**
   * The org sentei.json `ignoreManifests` glob that excluded it; absent when an ignored
   * dir, a VS Code extension or a private duplicate did (those are routine, not
   * reported). Written to the DB table ignored_manifests for the report's warning.
   */
  ignoredBy?: string;
}

export interface DiscoverRepo {
  repo: string;
  localPath: string;
  defaultBranch: string | null;
  headSha: string | null;
  config: RepoConfig;
  packages: DiscoverPackage[];
  /** Sorted by (path, manager); [] when none. */
  ignoredManifests: DiscoverIgnoredManifest[];
}

export type DiscoverSource =
  | { kind: 'local'; dir: string }
  | {
    kind: 'github';
    org: string;
    apiUrl: string;
    /** Lockfile read or written for this run, or null when none was given. */
    lockfile: string | null;
    clonesDir: string;
    /**
     * Selected repos that could not be cloned and were skipped (--allow-clone-failures);
     * absent when every clone succeeded. Their packages are unknown to this run.
     */
    cloneFailures?: Array<{ repo: string; error: string }>;
  };

export interface DiscoverModel {
  org: string;
  source: DiscoverSource;
  /** Epoch seconds. */
  generatedAt: number;
  policy: Policy;
  keep: string[];
  repos: DiscoverRepo[];
  /**
   * GitHub source: listed repos this run does not analyse (selection exclusions, and
   * clone failures skipped with --allow-clone-failures), sorted by repo. Their
   * references to org packages are invisible; the report warns about the ones with
   * manifests. Absent for a local org directory.
   */
  excludedRepos?: ExcludedRepoInfo[];
}

export interface DiscoverLocalOptions {
  orgDir: string;
  log?: (line: string) => void;
  /** Epoch seconds; defaults to now (injectable for tests). */
  now?: number;
}

/** One checked-out repo handed to discoverRepos. */
export interface DiscoverRepoInput {
  /** Repo name without the org prefix. */
  name: string;
  defaultBranch: string | null;
  /** Absolute path of the checkout. */
  localPath: string;
  headSha: string | null;
}

export interface DiscoverReposOptions {
  org: string;
  source: DiscoverSource;
  repos: readonly DiscoverRepoInput[];
  /** Directory holding the org-level sentei.json, or null for defaults. */
  orgConfigDir: string | null;
  log?: (line: string) => void;
  /** Epoch seconds; defaults to now (injectable for tests). */
  now?: number;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface OrgListing {
  org: string;
  repos: Array<{ name: string; defaultBranch: string | null }>;
}

function readOrgListing(orgDir: string): OrgListing {
  const file = join(orgDir, 'org.json');
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`sentei: cannot read ${file}: ${(err as Error).message}`);
  }
  const bad = (why: string): Error => new Error(`sentei: ${file}: ${why}`);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw bad('must be a JSON object');
  const o = json as Record<string, unknown>;
  if (typeof o['org'] !== 'string' || o['org'] === '' || o['org'].includes('/')) throw bad('"org" must be a non-empty name without "/"');
  if (!Array.isArray(o['repos'])) throw bad('"repos" must be an array');
  const seen = new Set<string>();
  const repos = o['repos'].map((r: unknown, i) => {
    if (typeof r !== 'object' || r === null) throw bad(`repos[${i}] must be an object`);
    const e = r as Record<string, unknown>;
    const name = e['name'];
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw bad(`repos[${i}].name must be a plain directory name`);
    }
    if (seen.has(name)) throw bad(`repo "${name}" listed twice`);
    seen.add(name);
    const branch = e['default_branch'];
    if (branch !== undefined && branch !== null && typeof branch !== 'string') throw bad(`repos[${i}].default_branch must be a string`);
    return { name, defaultBranch: typeof branch === 'string' ? branch : null };
  });
  return { org: o['org'], repos };
}

/** Longest-prefix package (by package dir) owning a repo-relative file, or undefined. */
function owningPackage<T extends { path: string }>(pkgs: readonly T[], file: string): T | undefined {
  let best: T | undefined;
  let bestLen = -1;
  for (const p of pkgs) {
    const len = p.path === '.' ? 0 : p.path.length + 1;
    if ((len === 0 || file.startsWith(`${p.path}/`)) && len > bestLen) {
      best = p;
      bestLen = len;
    }
  }
  return best;
}

/** npm alias `"foo": "npm:@acme/real@^1"` → "@acme/real"; otherwise the dep name itself. */
function npmTargetName(name: string, constraint: string | null): string {
  if (constraint === null || !constraint.startsWith('npm:')) return name;
  const spec = constraint.slice(4);
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Build the org model from a local org directory. Throws on duplicate (manager, name) within one repo. */
export function discoverLocal(opts: DiscoverLocalOptions): DiscoverModel {
  const orgDir = resolve(opts.orgDir);
  const listing = readOrgListing(orgDir);
  return discoverRepos({
    org: listing.org,
    source: { kind: 'local', dir: orgDir },
    repos: listing.repos.map((r) => ({
      name: r.name,
      defaultBranch: r.defaultBranch,
      localPath: join(orgDir, 'repos', r.name),
      headSha: null,
    })),
    orgConfigDir: orgDir,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

/**
 * Build the org model from checked-out repos (any source). Walks manifests,
 * applies sentei.json overlays, resolves deps by (manager, name) (DepResolution).
 * Throws on a missing checkout or two non-private manifests of one (manager, name)
 * in the same repo (their package ids would collide).
 */
export function discoverRepos(opts: DiscoverReposOptions): DiscoverModel {
  const log = opts.log ?? (() => {});
  const orgConfig = opts.orgConfigDir === null ? defaultOrgConfig() : readOrgConfig(opts.orgConfigDir);
  const ignoreDirList = orgConfig.ignoreManifestDirs ?? DEFAULT_IGNORE_MANIFEST_DIRS;
  const ignoreDirs: ReadonlySet<string> = new Set(ignoreDirList);
  const usedIgnoreGlobs = new Set<string>();

  const repos: Array<DiscoverRepo & {
    manifests: ManifestPackage[]; ignored: IgnoredManifest[]; files: string[]; ignoredBy: Map<string, string>;
  }> = [];
  for (const r of [...opts.repos].sort((a, b) => cmp(a.name, b.name))) {
    const repo = `${opts.org}/${r.name}`;
    const localPath = r.localPath;
    let isDir = false;
    try {
      isDir = statSync(localPath).isDirectory();
    } catch {
      /* reported below */
    }
    if (!isDir) throw new Error(`sentei: ${repo}: expected a checkout at ${localPath}`);
    const warn = (m: string): void => log(`warning: ${repo}: ${m}`);
    const config = readRepoConfig(localPath);
    const files = listFiles(localPath);
    const hasLibDir = (dir: string): boolean => {
      const prefix = dir === '.' ? 'lib/' : `${dir}/lib/`;
      return files.some((f) => f.startsWith(prefix));
    };
    // A pub package without lib/ (a workspace root, a bin-only tool) has nothing to
    // import: "no entry points" is expected there, not a warning (handled below).
    const manifestWarn = (m: string): void => {
      const hit = /^(?:(.*)\/)?pubspec\.yaml: no entry points/.exec(m);
      if (hit && !hasLibDir(hit[1] ?? '.')) return;
      warn(m);
    };
    /** manifest -> the ignoreManifests glob that matched it. */
    const ignoredBy = new Map<string, string>();
    const { packages: manifests, ignored } = readRepoManifestsWithIgnored(localPath, manifestWarn, files, {
      ignoreDirs: ignoreDirList,
      ignoreManifest: (manifest) => {
        const hit = orgConfig.ignoreManifests.find((g) => matchGlob(g, `${r.name}/${manifest}`));
        if (hit !== undefined) {
          usedIgnoreGlobs.add(hit);
          ignoredBy.set(manifest, hit);
        }
        return hit !== undefined;
      },
      log: (m) => log(`${repo}: ${m}`),
    });
    // No lib/ at all: nothing another package can import (package: URIs resolve under
    // lib/), so it is no library and nobody outside can depend on its code, whatever
    // publish_to says (pub workspace roots named `_` or `*_workspace`, bin-only tools).
    for (const m of manifests) {
      if (m.manager !== 'pub' || hasLibDir(m.path)) continue;
      if (m.visibility !== 'private') log(`${repo}: ${m.manifest}: no lib/ directory, treated as private (not importable)`);
      m.visibility = 'private';
      m.isLibrary = false;
    }

    // Overlay extraEntryPoints (PLAN §7): each matched file joins its owning package's entry points.
    for (const glob of config.extraEntryPoints) {
      const hits = files.filter((f) => matchGlob(glob, f));
      if (hits.length === 0) warn(`sentei.json extraEntryPoints ${JSON.stringify(glob)} matched no files`);
      for (const f of hits) {
        const owner = owningPackage(manifests, f);
        if (!owner) {
          warn(`sentei.json extraEntryPoints: ${f} is not inside any package, ignored`);
          continue;
        }
        if (!owner.entryPoints.includes(f)) owner.entryPoints.push(f);
      }
    }
    for (const m of manifests) m.entryPoints.sort(cmp);

    repos.push({
      repo,
      localPath,
      defaultBranch: r.defaultBranch,
      headSha: r.headSha,
      config,
      packages: [],
      ignoredManifests: [],
      manifests,
      ignored,
      files,
      ignoredBy,
    });
  }
  for (const g of orgConfig.ignoreManifests) {
    if (!usedIgnoreGlobs.has(g)) log(`warning: org sentei.json ignoreManifests ${JSON.stringify(g)} matched no manifest`);
  }

  // Package identity is (repo, manager, name): the same name in two repos is two
  // packages (resolveDep below picks one per consumer, or flags the ambiguity). Within
  // ONE repo the ids would collide, so there the old rule stays: private duplicates
  // (npm `private: true`, pub `publish_to: none`: docs sites, playgrounds, app shells
  // that reuse the name) are auto-ignored when at most one manifest of the name is not
  // private; they become ignored manifests (not org packages, still witness-scanned).
  // Two non-private manifests of one name in one repo are a hard error.
  type Owner = { r: (typeof repos)[number]; m: ManifestPackage; loc: string; ignoreEntry: string };
  const byRepoName = new Map<string, Owner[]>();
  for (const r of repos) {
    const repoName = r.repo.slice(opts.org.length + 1);
    for (const m of r.manifests) {
      const id = packageIdOf(m.manager, r.repo, m.name);
      byRepoName.set(id, [...(byRepoName.get(id) ?? []), { r, m, loc: `${r.repo}:${m.manifest}`, ignoreEntry: `${repoName}/${m.manifest}` }]);
    }
  }
  const dups: Array<[string, Owner[]]> = [];
  for (const [id, group] of byRepoName) {
    if (group.length < 2) continue;
    const open = group.filter((o) => o.m.visibility !== 'private');
    if (open.length > 1) {
      dups.push([id, open]); // the private ones would be ignored anyway
      continue;
    }
    for (const o of group) {
      if (o.m.visibility !== 'private') continue;
      const other = open[0] ?? group.find((x) => x !== o)!;
      log(`${o.r.repo}: ignored private duplicate manifest ${o.r.repo}/${o.m.manifest} (same name as ${other.r.repo}/${other.m.manifest})`);
      o.r.manifests = o.r.manifests.filter((x) => x !== o.m);
      o.r.ignored.push({ path: o.m.path, manifest: o.m.manifest, manager: o.m.manager, name: o.m.name, deps: o.m.deps, depsUnknown: false });
      o.r.ignored.sort((a, b) => cmp(a.path, b.path) || cmp(a.manager, b.manager));
    }
  }
  if (dups.length > 0) throw new Error(duplicateNamesMessage(dups));

  // Every org package by (manager, name): usually one, several when repos share a name.
  type Candidate = { id: string; repo: string; isPrivate: boolean; ignoreEntry: string };
  const byName = new Map<string, Candidate[]>();
  for (const r of repos) {
    const repoName = r.repo.slice(opts.org.length + 1);
    for (const m of r.manifests) {
      const key = `${m.manager}:${m.name}`;
      byName.set(key, [...(byName.get(key) ?? []), {
        id: packageIdOf(m.manager, r.repo, m.name), repo: r.repo, isPrivate: m.visibility === 'private', ignoreEntry: `${repoName}/${m.manifest}`,
      }]);
    }
  }
  for (const list of byName.values()) list.sort((a, b) => cmp(a.id, b.id));
  for (const [key, list] of byName) {
    if (list.length > 1) log(`note: ${list.length} org packages are named ${key}: ${list.map((c) => c.id).join(', ')}`);
  }

  // Resolve deps by (manager, name) (DepResolution). Path/workspace/file/link deps carry
  // the target's package name as the dep key, so name matching covers them too.
  const resolveDep = (
    d: { name: string; manager: Manager; constraint: string | null; dev?: true }, consumerRepo: string,
  ): DiscoverDep => {
    const target = d.manager === 'npm' ? npmTargetName(d.name, d.constraint) : d.name;
    const cands = byName.get(`${d.manager}:${target}`) ?? [];
    const out: DiscoverDep = { name: d.name, manager: d.manager, constraint: d.constraint, resolvedPackageId: null };
    let pick: Candidate | undefined;
    if (cands.length === 1) {
      pick = cands[0]!;
      out.resolution = 'name';
    } else if (cands.length > 1) {
      out.candidates = cands.map((c) => c.id);
      const sameRepo = cands.filter((c) => c.repo === consumerRepo);
      const published = cands.filter((c) => !c.isPrivate);
      if (sameRepo.length === 1) {
        pick = sameRepo[0]!;
        out.resolution = 'same-repo';
      } else if (published.length === 1) {
        pick = published[0]!;
        out.resolution = 'published';
      } else {
        out.ambiguous = true;
      }
    }
    if (pick) out.resolvedPackageId = pick.id;
    if (d.dev === true) out.dev = true;
    return out;
  };
  /** discover log line for a dep that names several org packages. */
  const logMultiple = (repo: string, who: string, d: DiscoverDep): void => {
    const target = d.manager === 'npm' ? npmTargetName(d.name, d.constraint) : d.name;
    const cands = byName.get(`${d.manager}:${target}`) ?? [];
    if (d.ambiguous === true) {
      log(`warning: ${repo}: ${who} dep ${d.name} matches ${cands.length} org packages (${cands.map((c) => c.id).join(', ')}); `
        + 'unresolved, their verdicts are blocked (ambiguous_dep). Keep the one it means and exclude the others in the org '
        + `sentei.json, e.g. "ignoreManifests": [${cands.map((c) => JSON.stringify(c.ignoreEntry)).join(', ')}] minus the real one`);
    } else if (d.candidates !== undefined) {
      log(`${repo}: ${who} dep ${d.name} matches ${cands.length} org packages; resolved to ${d.resolvedPackageId} (${d.resolution})`);
    }
  };
  // Pub package id -> the first of its lib/ Dart files that exports Dart to JS, or null
  // (the gate on JS-family unindexed consumers of pub packages, PUB_CONSUMER_EXTS).
  const homes = new Map<string, { r: (typeof repos)[number]; m: ManifestPackage }>();
  for (const r of repos) for (const m of r.manifests) homes.set(packageIdOf(m.manager, r.repo, m.name), { r, m });
  const jsExports = new Map<string, string | null>();
  const dartToJsExport = (id: string): string | null => {
    if (jsExports.has(id)) return jsExports.get(id)!;
    const home = homes.get(id);
    let hit: string | null = null;
    if (home && home.m.manager === 'pub') {
      const lib = home.m.path === '.' ? 'lib/' : `${home.m.path}/lib/`;
      for (const f of home.r.files) {
        if (!f.startsWith(lib) || !f.endsWith('.dart') || owningPackage(home.r.manifests, f) !== home.m) continue;
        let text: string | null = null;
        try {
          text = readFileSync(join(home.r.localPath, f), 'utf8');
        } catch {
          /* unreadable: assume it exports (fail closed) */
        }
        if (text === null || DART_TO_JS_EXPORT.test(text)) {
          hit = f;
          break;
        }
      }
    }
    jsExports.set(id, hit);
    return hit;
  };
  for (const r of repos) {
    r.ignoredManifests = r.ignored.map((m): DiscoverIgnoredManifest => ({
      path: m.path,
      manifest: m.manifest,
      manager: m.manager,
      name: m.name,
      deps: m.deps.map((d) => resolveDep(d, r.repo)),
      depsUnknown: m.depsUnknown,
      // (an ignored dir wins: readRepoManifestsWithIgnored does not ask the glob then)
      ...(r.ignoredBy.has(m.manifest) ? { ignoredBy: r.ignoredBy.get(m.manifest)! } : {}),
    }));
    r.packages = r.manifests.map((m): DiscoverPackage => ({
      packageId: packageIdOf(m.manager, r.repo, m.name),
      path: m.path,
      manager: m.manager,
      name: m.name,
      version: m.version,
      visibility: m.visibility,
      isLibrary: m.isLibrary,
      entryPoints: m.entryPoints,
      unresolvedEntryPoints: m.unresolvedEntryPoints,
      runtimeEntryPoints: m.runtimeEntryPoints,
      ...(m.runtimeEntrySymbols ? { runtimeEntrySymbols: m.runtimeEntrySymbols } : {}),
      deps: m.deps.map((d) => resolveDep(d, r.repo)),
      // An exports/main/types leaf that looks like code but resolves to nothing: an entry
      // point (and every symbol only it exports) is missing from the surface, which would
      // make live exports look dead. Untargeted: the package itself is opaque (fail closed).
      flags: m.unresolvedEntryPoints.map((leaf): DiscoverFlag => ({
        flag: 'opaque_consumer',
        reason: `${DISCOVER_REASON_PREFIX}unresolved entry point ${leaf}`,
        file: m.manifest,
      })),
    }));
    for (const p of r.packages) {
      for (const f of p.flags) log(`warning: ${r.repo}: ${p.packageId} flagged opaque_consumer (${f.reason.slice(DISCOVER_REASON_PREFIX.length)})`);
    }
    for (const m of r.ignoredManifests) {
      for (const d of m.deps) logMultiple(r.repo, `ignored manifest ${m.manifest}`, d);
    }
    // ambiguous_dep (fail closed): a dep naming several org packages with none preferred
    // may mean any of them, so each candidate is blocked for this consumer.
    for (const p of r.packages) {
      const manifest = r.manifests.find((m) => m.path === p.path && m.manager === p.manager)!.manifest;
      for (const d of p.deps) {
        logMultiple(r.repo, p.packageId, d);
        if (d.ambiguous !== true) continue;
        const cands = d.candidates ?? [];
        for (const c of cands) {
          if (c === p.packageId) continue;
          p.flags.push({
            flag: 'ambiguous_dep',
            reason: `dep ${d.name} matches ${cands.length} org packages: ${cands.join(', ')}`,
            file: manifest,
            targetPackageId: c,
          });
        }
      }
    }
    // unindexed_consumer (PLAN §2, M4): an org-package consumer with code we cannot index.
    for (const p of r.packages) {
      if (!p.deps.some((d) => d.resolvedPackageId !== null || d.ambiguous === true)) continue;
      const flag = unindexedConsumerFlag(p, r.packages, r.files, ignoreDirs);
      if (flag && p.manager === 'pub') {
        // JS reaches a dependency's Dart only through that dependency's JS exports.
        const exporter = p.deps
          .flatMap((d) => d.resolvedPackageId !== null ? [d.resolvedPackageId] : d.candidates ?? [])
          .filter((id) => id !== p.packageId)
          .map((id) => [id, dartToJsExport(id)] as const)
          .find(([, file]) => file !== null);
        if (!exporter) {
          log(`${r.repo}: ${p.packageId} not flagged unindexed_consumer: ${flag.reason}, but no org dependency exports Dart to JS`);
          continue;
        }
        flag.reason += `; ${exporter[0]} exports Dart to JS (${exporter[1]})`;
      }
      if (flag) {
        p.flags.push(flag);
        log(`${r.repo}: ${p.packageId} flagged unindexed_consumer (${flag.reason})`);
      }
    }
  }

  return {
    org: opts.org,
    source: opts.source,
    generatedAt: opts.now ?? Math.floor(Date.now() / 1000),
    policy: orgConfig.policy,
    keep: orgConfig.keep,
    repos: repos.map(({ manifests: _m, ignored: _i, files: _f, ignoredBy: _b, ...r }) => r),
  };
}

/** The same-repo duplicate-name error: every location, plus copy-pasteable `ignoreManifests` entries. */
function duplicateNamesMessage(dups: Array<[string, Array<{ loc: string; ignoreEntry: string }>]>): string {
  const lines = ['sentei: duplicate package names within one repo (package ids are <manager>:<repo>:<name>; private duplicates are ignored automatically, these are not private):'];
  for (const [id, locs] of dups) lines.push(`  ${id}: ${locs.map((l) => l.loc).join(', ')}`);
  const entries = dups.flatMap(([, locs]) => locs.map((l) => l.ignoreEntry));
  lines.push(
    'Exactly one manifest per name may remain in a repo. If the others are templates, fixtures or examples',
    '(not real org packages), exclude them in the org sentei.json. Candidates (keep the real',
    "package's entry OUT of the list):",
    `  "ignoreManifests": [${entries.map((e) => JSON.stringify(e)).join(', ')}]`,
  );
  return lines.join('\n');
}

/**
 * Top-level dirs of a pub package holding platform / native code: Flutter runners and
 * plugin implementations (android, ios, macos, linux, windows, web, darwin) and FFI
 * sources (native). That code talks to Dart over method channels or FFI and cannot
 * import a Dart library, so it is never a consumer of an org package.
 */
export const PUB_PLATFORM_DIRS: ReadonlySet<string> = new Set(['android', 'ios', 'macos', 'linux', 'windows', 'web', 'darwin', 'native']);
/** Flutter tool output inside platform dirs, wherever it sits. */
const PUB_GENERATED_DIRS: ReadonlySet<string> = new Set(['.plugin_symlinks', 'ephemeral']);

/** Is repo-relative `file` platform / native code of the pub package at `pkgPath`? */
function isPubPlatformFile(pkgPath: string, file: string): boolean {
  const rel = pkgPath === '.' ? file : file.slice(pkgPath.length + 1);
  const segs = rel.split('/');
  return PUB_PLATFORM_DIRS.has(segs[0]!) || segs.slice(0, -1).some((s) => PUB_GENERATED_DIRS.has(s));
}

/**
 * First-file summary of files in unindexed languages owned by `pkg` (npm:
 * UNINDEXED_LANGUAGE_EXTS; pub: PUB_CONSUMER_EXTS, the caller then applies the
 * DART_TO_JS_EXPORT gate): files under its dir, minus nested packages' dirs, skipped
 * dirs (already absent from `files`, see listFiles), ignored manifest dirs (package-
 * relative) and, for pub packages, platform code (PUB_PLATFORM_DIRS: `web/index.html`
 * of a Flutter app is its runner). null if there are none.
 */
function unindexedConsumerFlag(
  pkg: DiscoverPackage, repoPkgs: readonly DiscoverPackage[], files: readonly string[], ignoreDirs: ReadonlySet<string>,
): DiscoverFlag | null {
  const hits: string[] = [];
  const byExt = new Map<string, number>();
  for (const f of files) {
    const ext = posix.extname(f).toLowerCase();
    if (!(pkg.manager === 'pub' ? PUB_CONSUMER_EXTS : UNINDEXED_LANGUAGE_EXTS).has(ext)) continue;
    if (owningPackage(repoPkgs, f) !== pkg) continue;
    // Package-relative, so a kept package named like an ignored dir (`pkgs/test`,
    // isIgnoredManifestPath) still has its own code scanned.
    if (inIgnoredDir(pkg.path === '.' ? f : f.slice(pkg.path.length + 1), ignoreDirs)) continue;
    if (pkg.manager === 'pub' && isPubPlatformFile(pkg.path, f)) continue;
    hits.push(f);
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  if (hits.length === 0) return null;
  const counts = [...byExt].sort(([a], [b]) => cmp(a, b)).map(([ext, n]) => `${n} ${ext}`).join(', ');
  return { flag: 'unindexed_consumer', reason: `${counts} file(s), e.g. ${hits[0]}`, file: hits[0]! };
}

/**
 * Replace the whole org in the DB from `model`, in one transaction:
 * repos (cascade root, so every derived row goes), packages, package_deps,
 * discover-owned package_flags (unindexed_consumer, discover: opaque_consumer), policy, keep_rules,
 * excluded_repos. Throws if PRAGMA foreign_key_check reports anything.
 */
export function writeDiscoverToDb(db: DatabaseSync, model: DiscoverModel, warn: (m: string) => void = () => {}): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM repos');
    db.exec('DELETE FROM keep_rules');
    db.exec('DELETE FROM policy');

    const insPolicy = db.prepare('INSERT INTO policy (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(model.policy)) insPolicy.run(k, JSON.stringify(v));

    db.exec('DELETE FROM excluded_repos');
    const insExcluded = db.prepare('INSERT INTO excluded_repos (repo, reason, manifests) VALUES (?, ?, ?)');
    for (const x of model.excludedRepos ?? []) insExcluded.run(x.repo, x.reason, x.manifests === null ? null : JSON.stringify(x.manifests));

    const insRepo = db.prepare(
      'INSERT INTO repos (repo, default_branch, head_sha, indexed_at, index_status) VALUES (?, ?, ?, NULL, NULL)');
    const insPkg = db.prepare(
      'INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, is_library, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insDep = db.prepare(`INSERT INTO package_deps
      (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id, dev, resolution, ambiguous)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    // Discover-owned flags; ingest deletes and rebuilds only its own flags (for
    // opaque_consumer: those whose reason lacks DISCOVER_REASON_PREFIX), so these survive it.
    const insFlag = db.prepare('INSERT INTO package_flags (package_id, flag, reason, file, target_package_id) VALUES (?, ?, ?, ?, ?)');

    const insIgnored = db.prepare('INSERT INTO ignored_manifests (repo, manifest, glob) VALUES (?, ?, ?)');
    for (const r of model.repos) {
      insRepo.run(r.repo, r.defaultBranch, r.headSha);
      for (const m of r.ignoredManifests ?? []) if (m.ignoredBy !== undefined) insIgnored.run(r.repo, m.manifest, m.ignoredBy);
      for (const p of r.packages) {
        insPkg.run(p.packageId, r.repo, p.path, p.manager, p.name, p.version, p.visibility, p.isLibrary === true ? 1 : 0, JSON.stringify(p.entryPoints));
      }
    }
    // Flags and deps after all packages so target / resolved_package_id FKs point at existing rows.
    for (const r of model.repos) {
      for (const p of r.packages) {
        for (const f of p.flags) insFlag.run(p.packageId, f.flag, f.reason, f.file, f.targetPackageId ?? null);
      }
    }
    for (const r of model.repos) {
      for (const p of r.packages) {
        for (const d of p.deps) {
          insDep.run(p.packageId, d.name, d.manager, d.constraint, d.resolvedPackageId, d.dev === true ? 1 : 0,
            d.resolvedPackageId === null ? null : (d.resolution ?? 'name'), d.ambiguous === true ? 1 : 0);
        }
      }
    }

    // keep: a name-only entry (`npm:<name>#sym`) applies to every package of that name,
    // a `npm:<org>/<repo>:<name>#sym` entry to that one package.
    const allPkgs = model.repos.flatMap((r) => r.packages.map((p) => ({ id: p.packageId, repo: r.repo, manager: p.manager, name: p.name })));
    const rules = new Map<string, { packageId: string; symbolName: string }>();
    const sources: Array<[string, string[]]> = [
      ['org sentei.json', model.keep],
      ...model.repos.map((r): [string, string[]] => [`${r.repo} sentei.json`, r.config.keep]),
    ];
    for (const [source, entries] of sources) {
      for (const entry of entries) {
        const rule = parseKeepEntry(entry);
        if (!rule) throw new Error(`sentei: ${source}: malformed keep entry ${JSON.stringify(entry)}`);
        const hits = allPkgs.filter((p) => packageRefMatches(rule.ref, p));
        if (hits.length === 0) {
          warn(`${source}: keep entry ${JSON.stringify(entry)} names unknown package ${entry.slice(0, entry.indexOf('#'))}, ignored`);
          continue;
        }
        for (const p of hits) rules.set(`${p.id}#${rule.symbolName}`, { packageId: p.id, symbolName: rule.symbolName });
      }
    }
    const insKeep = db.prepare('INSERT INTO keep_rules (package_id, symbol_name) VALUES (?, ?)');
    for (const rule of rules.values()) insKeep.run(rule.packageId, rule.symbolName);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(`sentei: foreign_key_check failed after discover: ${JSON.stringify(violations)}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
