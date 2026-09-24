// `discover` stage core (PLAN.md §6.1), M1 scope: a local org directory.
//
//   <orgDir>/org.json            { "org": "acme", "repos": [{ "name", "default_branch" }] }
//   <orgDir>/sentei.json         optional org policy + keep (config.ts)
//   <orgDir>/repos/<name>/       one checkout per repo; optional <repo>/sentei.json overlays
//
// discoverLocal builds the org model (the exact shape of work/discover.json);
// writeDiscoverToDb replaces the whole org in the DB from that model.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseKeepEntry, readOrgConfig, readRepoConfig, type Policy, type RepoConfig } from './config.ts';
import { matchGlob } from './glob.ts';
import { listFiles, readRepoManifests, type Manager, type ManifestPackage, type Visibility } from './manifests.ts';

export interface DiscoverDep {
  name: string;
  manager: Manager;
  constraint: string | null;
  /** Org package this dep points at, or null for third-party deps. */
  resolvedPackageId: string | null;
}

export interface DiscoverPackage {
  packageId: string;
  /** Package dir relative to the repo root, POSIX; '.' for the root. */
  path: string;
  manager: Manager;
  name: string;
  version: string | null;
  visibility: Visibility;
  /** Relative to the REPO root, POSIX, sorted. */
  entryPoints: string[];
  deps: DiscoverDep[];
}

export interface DiscoverRepo {
  repo: string;
  localPath: string;
  defaultBranch: string | null;
  headSha: string | null;
  config: RepoConfig;
  packages: DiscoverPackage[];
}

export interface DiscoverModel {
  org: string;
  source: { kind: 'local'; dir: string };
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
  const log = opts.log ?? (() => {});
  const orgDir = resolve(opts.orgDir);
  const listing = readOrgListing(orgDir);
  const orgConfig = readOrgConfig(orgDir);

  const repos: Array<DiscoverRepo & { manifests: ManifestPackage[] }> = [];
  for (const r of [...listing.repos].sort((a, b) => cmp(a.name, b.name))) {
    const repo = `${listing.org}/${r.name}`;
    const localPath = join(orgDir, 'repos', r.name);
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
    const manifests = readRepoManifests(localPath, warn, files);

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
      headSha: null,
      config,
      packages: [],
      manifests,
    });
  }

  // (manager, name) must be unique across the org (PLAN §5.1): report every clash at once.
  const owners = new Map<string, string[]>();
  for (const r of repos) {
    for (const m of r.manifests) {
      const id = `${m.manager}:${m.name}`;
      const loc = `${r.repo}:${m.manifest}`;
      owners.set(id, [...(owners.get(id) ?? []), loc]);
    }
  }
  const dups = [...owners].filter(([, locs]) => locs.length > 1);
  if (dups.length > 0) {
    throw new Error(`sentei: duplicate org package names (must be unique per manager):\n${
      dups.map(([id, locs]) => `  ${id}: ${locs.join(', ')}`).join('\n')}`);
  }

  // Resolve deps by (manager, name). Path/workspace/file/link deps carry the target's
  // package name as the dep key, so name matching covers them too.
  for (const r of repos) {
    r.packages = r.manifests.map((m): DiscoverPackage => ({
      packageId: `${m.manager}:${m.name}`,
      path: m.path,
      manager: m.manager,
      name: m.name,
      version: m.version,
      visibility: m.visibility,
      entryPoints: m.entryPoints,
      deps: m.deps.map((d) => {
        const target = d.manager === 'npm' ? npmTargetName(d.name, d.constraint) : d.name;
        const id = `${d.manager}:${target}`;
        return { name: d.name, manager: d.manager, constraint: d.constraint, resolvedPackageId: owners.has(id) ? id : null };
      }),
    }));
  }

  return {
    org: listing.org,
    source: { kind: 'local', dir: orgDir },
    generatedAt: opts.now ?? Math.floor(Date.now() / 1000),
    policy: orgConfig.policy,
    keep: orgConfig.keep,
    repos: repos.map(({ manifests: _m, ...r }) => r),
  };
}

/**
 * Replace the whole org in the DB from `model`, in one transaction:
 * repos (cascade root, so every derived row goes), packages, package_deps,
 * policy, keep_rules. Throws if PRAGMA foreign_key_check reports anything.
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
      'INSERT INTO packages (package_id, repo, path, manager, name, version, visibility, entry_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insDep = db.prepare(
      'INSERT INTO package_deps (consumer_package_id, dep_name, dep_manager, dep_constraint, resolved_package_id) VALUES (?, ?, ?, ?, ?)');

    for (const r of model.repos) {
      insRepo.run(r.repo, r.defaultBranch, r.headSha);
      for (const p of r.packages) {
        insPkg.run(p.packageId, r.repo, p.path, p.manager, p.name, p.version, p.visibility, JSON.stringify(p.entryPoints));
      }
    }
    // Deps after all packages so resolved_package_id FKs point at existing rows.
    for (const r of model.repos) {
      for (const p of r.packages) {
        for (const d of p.deps) insDep.run(p.packageId, d.name, d.manager, d.constraint, d.resolvedPackageId);
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
