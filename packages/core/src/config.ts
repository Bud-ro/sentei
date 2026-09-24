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
  /** Org-wide keep entries, e.g. "npm:@acme/foo#sym", "pub:bar#*". */
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
  /** e.g. "npm:@acme/plugins#*" */
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

/** Keep entry: "<manager>:<name>#<symbol|*>". */
const KEEP_RE = /^(npm|pub):([^#]+)#([^#]+)$/;

export interface KeepRule {
  packageId: string;
  symbolName: string;
}

export function parseKeepEntry(entry: string): KeepRule | null {
  const m = KEEP_RE.exec(entry);
  if (!m) return null;
  return { packageId: `${m[1]}:${m[2]}`, symbolName: m[3]! };
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
      throw new Error(`sentei: ${file}: keep entry ${JSON.stringify(k)} must look like "npm:<name>#<symbol>" or "pub:<name>#*"`);
    }
  }
  return keep;
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
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          throw new Error(`sentei: ${file}: "minAgeDays" must be a non-negative integer`);
        }
        policy.minAgeDays = value;
        break;
      case 'trustPrivateRegistry':
      case 'assumeClosedWorld':
      case 'countTestsAsConsumers':
      case 'countDocsAsConsumers':
        if (typeof value !== 'boolean') throw new Error(`sentei: ${file}: "${key}" must be a boolean`);
        policy[key] = value;
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
