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
import { defaultOrgConfig, parseKeepEntry, readOrgConfig, readRepoConfig, type Policy, type RepoConfig } from './config.ts';
import { matchGlob } from './glob.ts';
import {
  DEFAULT_IGNORE_MANIFEST_DIRS, inIgnoredDir, listFiles, readRepoManifestsWithIgnored,
  type IgnoredManifest, type Manager, type ManifestPackage, type Visibility,
} from './manifests.ts';

export interface DiscoverDep {
  name: string;
  manager: Manager;
  constraint: string | null;
  /** Org package this dep points at, or null for third-party deps. */
  resolvedPackageId: string | null;
  /** Present (true) when declared only as a dev dependency (ManifestDep.dev). */
  dev?: true;
}

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
  deps: DiscoverDep[];
  /** package_flags discover owns (`unindexed_consumer`, `opaque_consumer`); [] when none. */
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
   * `discover: unresolved entry point <leaf>`). Both untargeted.
   */
  flag: 'unindexed_consumer' | 'opaque_consumer';
  reason: string;
  /** Repo-relative POSIX path of the first offending file (the manifest for opaque_consumer). */
  file: string;
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
  };

export interface DiscoverModel {
  org: string;
  source: DiscoverSource;
  /** Epoch seconds. */
  generatedAt: number;
  policy: Policy;
  keep: string[];
  repos: DiscoverRepo[];
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

/** Build the org model from a local org directory. Throws on duplicate (manager, name). */
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
 * applies sentei.json overlays, resolves deps by (manager, name).
 * Throws on a missing checkout or a duplicate (manager, name).
 */
export function discoverRepos(opts: DiscoverReposOptions): DiscoverModel {
  const log = opts.log ?? (() => {});
  const orgConfig = opts.orgConfigDir === null ? defaultOrgConfig() : readOrgConfig(opts.orgConfigDir);
  const ignoreDirList = orgConfig.ignoreManifestDirs ?? DEFAULT_IGNORE_MANIFEST_DIRS;
  const ignoreDirs: ReadonlySet<string> = new Set(ignoreDirList);
  const usedIgnoreGlobs = new Set<string>();

  const repos: Array<DiscoverRepo & { manifests: ManifestPackage[]; ignored: IgnoredManifest[]; files: string[] }> = [];
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
    const { packages: manifests, ignored } = readRepoManifestsWithIgnored(localPath, warn, files, {
      ignoreDirs: ignoreDirList,
      ignoreManifest: (manifest) => {
        const hit = orgConfig.ignoreManifests.find((g) => matchGlob(g, `${r.name}/${manifest}`));
        if (hit !== undefined) usedIgnoreGlobs.add(hit);
        return hit !== undefined;
      },
      log: (m) => log(`${repo}: ${m}`),
    });

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
    });
  }
  for (const g of orgConfig.ignoreManifests) {
    if (!usedIgnoreGlobs.has(g)) log(`warning: org sentei.json ignoreManifests ${JSON.stringify(g)} matched no manifest`);
  }

  // (manager, name) must be unique across the org (PLAN §5.1). Private duplicates
  // (npm `private: true`, pub `publish_to: none`: docs sites, playgrounds, app shells
  // that reuse a name) are auto-ignored when at most one manifest of the name is not
  // private: the non-private one (if any) is the package; the private ones become
  // ignored manifests (not org packages, still witness-scanned). Only a clash between
  // two non-private manifests is a hard error; report every such clash at once.
  type Owner = { r: (typeof repos)[number]; m: ManifestPackage; loc: string; ignoreEntry: string };
  const byName = new Map<string, Owner[]>();
  for (const r of repos) {
    const repoName = r.repo.slice(opts.org.length + 1);
    for (const m of r.manifests) {
      const id = `${m.manager}:${m.name}`;
      byName.set(id, [...(byName.get(id) ?? []), { r, m, loc: `${r.repo}:${m.manifest}`, ignoreEntry: `${repoName}/${m.manifest}` }]);
    }
  }
  const dups: Array<[string, Owner[]]> = [];
  for (const [id, group] of byName) {
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
  const owners = new Set(repos.flatMap((r) => r.manifests.map((m) => `${m.manager}:${m.name}`)));

  // Resolve deps by (manager, name). Path/workspace/file/link deps carry the target's
  // package name as the dep key, so name matching covers them too.
  const resolveDep = (d: { name: string; manager: Manager; constraint: string | null; dev?: true }): DiscoverDep => {
    const target = d.manager === 'npm' ? npmTargetName(d.name, d.constraint) : d.name;
    const id = `${d.manager}:${target}`;
    const out: DiscoverDep = { name: d.name, manager: d.manager, constraint: d.constraint, resolvedPackageId: owners.has(id) ? id : null };
    if (d.dev === true) out.dev = true;
    return out;
  };
  for (const r of repos) {
    r.ignoredManifests = r.ignored.map((m): DiscoverIgnoredManifest => ({
      path: m.path,
      manifest: m.manifest,
      manager: m.manager,
      name: m.name,
      deps: m.deps.map(resolveDep),
      depsUnknown: m.depsUnknown,
    }));
    r.packages = r.manifests.map((m): DiscoverPackage => ({
      packageId: `${m.manager}:${m.name}`,
      path: m.path,
      manager: m.manager,
      name: m.name,
      version: m.version,
      visibility: m.visibility,
      isLibrary: m.isLibrary,
      entryPoints: m.entryPoints,
      unresolvedEntryPoints: m.unresolvedEntryPoints,
      runtimeEntryPoints: m.runtimeEntryPoints,
      deps: m.deps.map(resolveDep),
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
    // unindexed_consumer (PLAN §2, M4): an org-package consumer with code we cannot index.
    for (const p of r.packages) {
      if (!p.deps.some((d) => d.resolvedPackageId !== null)) continue;
      const flag = unindexedConsumerFlag(p, r.packages, r.files, ignoreDirs);
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
    repos: repos.map(({ manifests: _m, ignored: _i, files: _f, ...r }) => r),
  };
}

/** The §5.1 duplicate-name error: every location, plus copy-pasteable `ignoreManifests` entries. */
function duplicateNamesMessage(dups: Array<[string, Array<{ loc: string; ignoreEntry: string }>]>): string {
  const lines = ['sentei: duplicate org package names (must be unique per manager; private duplicates are ignored automatically, these are not private):'];
  for (const [id, locs] of dups) lines.push(`  ${id}: ${locs.map((l) => l.loc).join(', ')}`);
  const entries = dups.flatMap(([, locs]) => locs.map((l) => l.ignoreEntry));
  lines.push(
    'Exactly one manifest per name may remain. If the others are templates, fixtures or examples',
    '(not real org packages), exclude them in the org sentei.json. Candidates (keep the real',
    "package's entry OUT of the list):",
    `  "ignoreManifests": [${entries.map((e) => JSON.stringify(e)).join(', ')}]`,
  );
  return lines.join('\n');
}

/**
 * First-file summary of files in unindexed languages owned by `pkg`: files under its
 * dir, minus nested packages' dirs, skipped dirs (already absent from `files`, see listFiles) and
 * ignored manifest dirs. null if there are none.
 */
function unindexedConsumerFlag(
  pkg: DiscoverPackage, repoPkgs: readonly DiscoverPackage[], files: readonly string[], ignoreDirs: ReadonlySet<string>,
): DiscoverFlag | null {
  const hits: string[] = [];
  const byExt = new Map<string, number>();
  for (const f of files) {
    const ext = posix.extname(f).toLowerCase();
    if (!UNINDEXED_LANGUAGE_EXTS.has(ext)) continue;
    if (inIgnoredDir(f, ignoreDirs)) continue;
    if (owningPackage(repoPkgs, f) !== pkg) continue;
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
 * discover-owned package_flags (unindexed_consumer, discover: opaque_consumer), policy, keep_rules. Throws if PRAGMA foreign_key_check reports anything.
 */
export function writeDiscoverToDb(db: DatabaseSync, model: DiscoverModel, warn: (m: string) => void = () => {}): void {
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM repos');
    db.exec('DELETE FROM keep_rules');
    db.exec('DELETE FROM policy');

    const insPolicy = db.prepare('INSERT INTO policy (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(model.policy)) insPolicy.run(k, JSON.stringify(v));

    const insRepo = db.prepare(
      'INSERT INTO repos (repo, default_branch, head_sha, indexed_at, index_status) VALUES (?, ?, ?, NULL, NULL)');
    const insPkg = db.prepare(
      'INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, is_library, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insDep = db.prepare(
      'INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id, dev) VALUES (?, ?, ?, ?, ?, ?)');
    // Discover-owned flags; ingest deletes and rebuilds only its own flags (for
    // opaque_consumer: those whose reason lacks DISCOVER_REASON_PREFIX), so these survive it.
    const insFlag = db.prepare('INSERT INTO package_flags (package_id, flag, reason, file) VALUES (?, ?, ?, ?)');

    for (const r of model.repos) {
      insRepo.run(r.repo, r.defaultBranch, r.headSha);
      for (const p of r.packages) {
        insPkg.run(p.packageId, r.repo, p.path, p.manager, p.name, p.version, p.visibility, p.isLibrary === true ? 1 : 0, JSON.stringify(p.entryPoints));
        for (const f of p.flags) insFlag.run(p.packageId, f.flag, f.reason, f.file);
      }
    }
    // Deps after all packages so resolved_package_id FKs point at existing rows.
    for (const r of model.repos) {
      for (const p of r.packages) {
        for (const d of p.deps) insDep.run(p.packageId, d.name, d.manager, d.constraint, d.resolvedPackageId, d.dev === true ? 1 : 0);
      }
    }

    const packageIds = new Set(model.repos.flatMap((r) => r.packages.map((p) => p.packageId)));
    const rules = new Map<string, { packageId: string; symbolName: string }>();
    const sources: Array<[string, string[]]> = [
      ['org sentei.json', model.keep],
      ...model.repos.map((r): [string, string[]] => [`${r.repo} sentei.json`, r.config.keep]),
    ];
    for (const [source, entries] of sources) {
      for (const entry of entries) {
        const rule = parseKeepEntry(entry);
        if (!rule) throw new Error(`sentei: ${source}: malformed keep entry ${JSON.stringify(entry)}`);
        if (!packageIds.has(rule.packageId)) {
          warn(`${source}: keep entry ${JSON.stringify(entry)} names unknown package ${rule.packageId}, ignored`);
          continue;
        }
        rules.set(`${rule.packageId}#${rule.symbolName}`, rule);
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
