// sentei.json readers (PLAN.md §6.5 policy, §7 overlays). Pure: file reads + validation.
//
// Unknown keys are an error, not a warning: a typo such as "extraEntryPoint"
// would otherwise silently drop entry points and make live code look dead
// (fail open). Missing files are fine and yield defaults.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Policy {
  minAgeDays: number;
  trustPrivateRegistry: boolean;
  assumeClosedWorld: boolean;
  countTestsAsConsumers: boolean;
  countDocsAsConsumers: boolean;
}

/** PLAN §6.5 defaults; identical to the seeds in schema.sql. */
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  minAgeDays: 180,
  trustPrivateRegistry: true,
  assumeClosedWorld: false,
  countTestsAsConsumers: false,
  countDocsAsConsumers: false,
});

export interface OrgConfig {
  policy: Policy;
  /**
   * Org-wide keep entries, e.g. "npm:@acme/foo#sym" (every package named @acme/foo),
   * "npm:acme/lib:@acme/foo#sym" (only the one in repo acme/lib), "pub:bar#*".
   */
  keep: string[];
  /**
   * `ignoreManifestDirs`: dir names (one path segment each) under which a manifest is
   * not an org package. null = manifests.ts DEFAULT_IGNORE_MANIFEST_DIRS; a list
   * (even an empty one) replaces the default.
   */
  ignoreManifestDirs: string[] | null;
  /**
   * `ignoreManifests`: glob.ts globs matched against "<repo name>/<manifest path>"
   * (repo name without the org), e.g. "vscode/package.json"; matches are not org packages.
   */
  ignoreManifests: string[];
}

/** An org config with every default (no sentei.json). */
export function defaultOrgConfig(): OrgConfig {
  return { policy: { ...DEFAULT_POLICY }, keep: [], ignoreManifestDirs: null, ignoreManifests: [] };
}

export interface ExtraEdge {
  /** e.g. "file:src/registry.ts" */
  from: string;
  /** e.g. "npm:@acme/plugins#*" or "npm:acme/plugins:@acme/plugins#*" (PackageRef + "#<symbol|*>"). */
  to: string;
}

export interface RepoConfig {
  /** Repo-relative globs (glob.ts syntax). */
  extraEntryPoints: string[];
  /** Recorded in discover.json only; inserted as overlay edges once symbols exist. */
  extraEdges: ExtraEdge[];
  keep: string[];
}

export const EMPTY_REPO_CONFIG: Readonly<RepoConfig> = Object.freeze({ extraEntryPoints: [], extraEdges: [], keep: [] });

/**
 * A reference to org packages in sentei.json (`keep`, `extraEdges[].to`):
 * `<manager>:<name>` names every org package of that name (several repos may publish
 * one name), `<manager>:<repo>:<name>` exactly one (repo = `<org>/<repo name>`, the
 * package_id form).
 */
export interface PackageRef {
  manager: 'npm' | 'pub';
  /** `<org>/<repo name>`, or null for "every package with this name". */
  repo: string | null;
  name: string;
}

/** `<manager>:[<org>/<repo>:]<name>`; names contain no ':' or '#', repos exactly one '/'. */
const PACKAGE_REF_RE = /^(npm|pub):(?:([^#:/]+\/[^#:/]+):)?([^#:]+)$/;

export function parsePackageRef(ref: string): PackageRef | null {
  const m = PACKAGE_REF_RE.exec(ref);
  if (!m) return null;
  return { manager: m[1] as 'npm' | 'pub', repo: m[2] ?? null, name: m[3]! };
}

/** package_id of the package `name` in `repo` (`<org>/<repo name>`): `<manager>:<repo>:<name>`. */
export function packageIdOf(manager: string, repo: string, name: string): string {
  return `${manager}:${repo}:${name}`;
}

/**
 * Parts of a package_id (`<manager>:<repo>:<name>`; manager, repo and name contain no
 * ':'), or null for anything else (e.g. an old-format `<manager>:<name>`).
 */
export function splitPackageId(id: string): { manager: string; repo: string; name: string } | null {
  const a = id.indexOf(':');
  const b = a < 0 ? -1 : id.indexOf(':', a + 1);
  if (a <= 0 || b < 0 || id.indexOf(':', b + 1) >= 0) return null;
  const repo = id.slice(a + 1, b);
  if (!/^[^/]+\/[^/]+$/.test(repo) || b === id.length - 1) return null;
  return { manager: id.slice(0, a), repo, name: id.slice(b + 1) };
}

/** Whether `ref` names package `pkg`. */
export function packageRefMatches(ref: PackageRef, pkg: { manager: string; repo: string; name: string }): boolean {
  return ref.manager === pkg.manager && ref.name === pkg.name && (ref.repo === null || ref.repo === pkg.repo);
}

/** Keep entry: "<package ref>#<symbol|*>" (see PackageRef). */
export interface KeepRule {
  ref: PackageRef;
  symbolName: string;
}

export function parseKeepEntry(entry: string): KeepRule | null {
  const hash = entry.indexOf('#');
  if (hash < 0) return null;
  const ref = parsePackageRef(entry.slice(0, hash));
  const symbolName = entry.slice(hash + 1);
  if (!ref || symbolName === '' || symbolName.includes('#')) return null;
  return { ref, symbolName };
}

function readJson(file: string): unknown | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`sentei: cannot parse ${file}: ${(err as Error).message}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringArray(file: string, key: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`sentei: ${file}: "${key}" must be an array of strings`);
  }
  return [...v];
}

function keepArray(file: string, v: unknown): string[] {
  const keep = stringArray(file, 'keep', v);
  for (const k of keep) {
    if (!parseKeepEntry(k)) {
      throw new Error(`sentei: ${file}: keep entry ${JSON.stringify(k)} must look like "npm:<name>#<symbol>", "npm:<org>/<repo>:<name>#<symbol>" or "pub:<name>#*"`);
    }
  }
  return keep;
}

export function isPolicyKey(key: string): key is keyof Policy {
  return Object.hasOwn(DEFAULT_POLICY, key);
}

/**
 * Validate `value` for policy `key` and store it; throws `sentei: <where>: ...` on a
 * wrong type. Shared by the org sentei.json reader and the CLI's `--policy key=value`.
 */
export function setPolicyValue(policy: Policy, key: keyof Policy, value: unknown, where: string): void {
  if (key === 'minAgeDays') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`sentei: ${where}: "minAgeDays" must be a non-negative integer`);
    }
    policy.minAgeDays = value;
    return;
  }
  if (typeof value !== 'boolean') throw new Error(`sentei: ${where}: "${key}" must be a boolean`);
  policy[key] = value;
}

/**
 * Read `<orgDir>/sentei.json` (optional): policy, org-wide keep, and manifest
 * exclusions (`ignoreManifestDirs`, `ignoreManifests`; see OrgConfig).
 */
export function readOrgConfig(orgDir: string): OrgConfig {
  const file = join(orgDir, 'sentei.json');
  const json = readJson(file);
  const cfg = defaultOrgConfig();
  const policy = cfg.policy;
  if (json === undefined) return cfg;
  if (!isObject(json)) throw new Error(`sentei: ${file} must be a JSON object`);
  for (const [key, value] of Object.entries(json)) {
    switch (key) {
      case 'minAgeDays':
      case 'trustPrivateRegistry':
      case 'assumeClosedWorld':
      case 'countTestsAsConsumers':
      case 'countDocsAsConsumers':
        setPolicyValue(policy, key, value, file);
        break;
      case 'keep':
        cfg.keep = keepArray(file, value);
        break;
      case 'ignoreManifestDirs':
        cfg.ignoreManifestDirs = stringArray(file, key, value);
        for (const d of cfg.ignoreManifestDirs) {
          if (d === '' || d.includes('/') || d === '.' || d === '..') {
            throw new Error(`sentei: ${file}: ignoreManifestDirs entry ${JSON.stringify(d)} must be a single directory name`);
          }
        }
        break;
      case 'ignoreManifests':
        cfg.ignoreManifests = stringArray(file, key, value);
        for (const g of cfg.ignoreManifests) {
          if (!g.includes('/')) {
            throw new Error(`sentei: ${file}: ignoreManifests entry ${JSON.stringify(g)} must be "<repo name>/<manifest path>", e.g. "vscode/package.json"`);
          }
        }
        break;
      default:
        throw new Error(`sentei: ${file}: unknown key "${key}"`);
    }
  }
  return cfg;
}

/** Read `<repoDir>/sentei.json` (optional): overlays (PLAN §7). */
export function readRepoConfig(repoDir: string): RepoConfig {
  const file = join(repoDir, 'sentei.json');
  const json = readJson(file);
  const cfg: RepoConfig = { extraEntryPoints: [], extraEdges: [], keep: [] };
  if (json === undefined) return cfg;
  if (!isObject(json)) throw new Error(`sentei: ${file} must be a JSON object`);
  for (const [key, value] of Object.entries(json)) {
    switch (key) {
      case 'extraEntryPoints':
        cfg.extraEntryPoints = stringArray(file, key, value);
        break;
      case 'extraEdges':
        if (!Array.isArray(value)) throw new Error(`sentei: ${file}: "extraEdges" must be an array`);
        cfg.extraEdges = value.map((e, i) => {
          if (!isObject(e) || typeof e['from'] !== 'string' || typeof e['to'] !== 'string'
            || Object.keys(e).some((k) => k !== 'from' && k !== 'to')) {
            throw new Error(`sentei: ${file}: extraEdges[${i}] must be { "from": string, "to": string }`);
          }
          return { from: e['from'], to: e['to'] };
        });
        break;
      case 'keep':
        cfg.keep = keepArray(file, value);
        break;
      default:
        throw new Error(`sentei: ${file}: unknown key "${key}" (per-repo policy overrides are not supported)`);
    }
  }
  return cfg;
}
