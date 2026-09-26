// A small version-constraint matcher for dependency resolution (discover.ts
// resolveDep): does an org package's manifest version satisfy a consumer's declared
// constraint? npm ranges (`^`, `~`, exact, x-ranges, comparators, hyphen ranges, `||`)
// and pub constraints (`^` with pub's 0.x rule, comparators, exact, `any`). No
// dependency: only the shapes manifests actually use.
//
// Deliberately lenient where it can only make MORE versions match (prerelease
// versions are compared by precedence, npm's "prereleases only on the same tuple"
// exclusion is not applied, build metadata is ignored): a candidate is taken only when
// it is the ONLY one that matches, so matching more can only leave a name ambiguous.
// Anything not understood (dist-tags, `workspace:`, `file:`, git and path deps,
// malformed ranges) is `null`, which the caller treats as "unknown" (fail closed).

/** A parsed version: numeric core plus prerelease identifiers ([] = a release). */
interface Version {
  core: [number, number, number];
  pre: string[];
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  v: Version;
}

const NUM = /^(?:0|[1-9]\d*)$/;

/** A full version `1.2.3`, `v1.2.3-rc.1+build`; null when not one. */
export function parseVersion(text: string): Version | null {
  const m = /^[=v]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = NUM.test(x);
    const yn = NUM.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function test(v: Version, c: Comparator): boolean {
  const r = compare(v, c.v);
  switch (c.op) {
    case '<': return r < 0;
    case '<=': return r <= 0;
    case '>': return r > 0;
    case '>=': return r >= 0;
    case '=': return r === 0;
  }
}

/** A partial version `1`, `1.2`, `1.2.3-rc.1`, `1.x`, `*`: the given parts (undefined = wildcard). */
interface Partial {
  parts: Array<number | undefined>;
  pre: string[];
}

function parsePartial(text: string): Partial | null {
  const t = text.replace(/^[=v]+/, '');
  if (t === '' || t === '*' || t === 'x' || t === 'X') return { parts: [undefined, undefined, undefined], pre: [] };
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(t);
  if (!m) return null;
  const parts: Array<number | undefined> = [];
  let wild = false;
  for (const p of [m[1], m[2], m[3]]) {
    if (wild || p === undefined || /^[xX*]$/.test(p)) {
      wild = true;
      parts.push(undefined);
    } else {
      parts.push(Number(p));
    }
  }
  return { parts, pre: m[4] === undefined || parts[2] === undefined ? [] : m[4].split('.') };
}

const ver = (a: number, b: number, c: number, pre: string[] = []): Version => ({ core: [a, b, c], pre });

/** The comparators of one npm / pub primitive (`^1.2`, `~1`, `>=1.2`, `1.x`); null when malformed. */
function primitive(op: string, p: Partial, caret: 'npm' | 'pub'): Comparator[] | null {
  const [ma, mi, pa] = p.parts;
  if (ma === undefined) return op === '<' || op === '>' ? [{ op: '<', v: ver(0, 0, 0) }] : []; // `<*` matches nothing
  const lo = ver(ma, mi ?? 0, pa ?? 0, p.pre);
  switch (op) {
    case '^': {
      let hi: Version;
      if (caret === 'pub') {
        hi = ma > 0 ? ver(ma + 1, 0, 0) : ver(0, (mi ?? 0) + 1, 0);
        if (mi === undefined) hi = ver(ma + 1, 0, 0);
      } else if (ma > 0 || mi === undefined) {
        hi = ver(ma + 1, 0, 0);
      } else if (mi > 0 || pa === undefined) {
        hi = ver(0, mi + 1, 0);
      } else {
        hi = ver(0, 0, pa + 1);
      }
      return [{ op: '>=', v: lo }, { op: '<', v: hi }];
    }
    case '~':
    case '~>': {
      const hi = mi === undefined ? ver(ma + 1, 0, 0) : ver(ma, mi + 1, 0);
      return [{ op: '>=', v: lo }, { op: '<', v: hi }];
    }
    case '':
    case '=': {
      if (mi === undefined) return [{ op: '>=', v: lo }, { op: '<', v: ver(ma + 1, 0, 0) }];
      if (pa === undefined) return [{ op: '>=', v: lo }, { op: '<', v: ver(ma, mi + 1, 0) }];
      return [{ op: '=', v: lo }];
    }
    case '>=':
      return [{ op: '>=', v: lo }];
    case '<':
      return [{ op: '<', v: lo }];
    case '>':
      if (mi === undefined) return [{ op: '>=', v: ver(ma + 1, 0, 0) }];
      if (pa === undefined) return [{ op: '>=', v: ver(ma, mi + 1, 0) }];
      return [{ op: '>', v: lo }];
    case '<=':
      if (mi === undefined) return [{ op: '<', v: ver(ma + 1, 0, 0) }];
      if (pa === undefined) return [{ op: '<', v: ver(ma, mi + 1, 0) }];
      return [{ op: '<=', v: lo }];
    default:
      return null;
  }
}

/** One space-separated set of primitives (an AND); null when any is malformed. */
function comparatorSet(text: string, caret: 'npm' | 'pub'): Comparator[] | null {
  // `>= 1.2.3` → `>=1.2.3`
  const tokens = text.trim().replace(/(\^|~>|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter((t) => t !== '');
  const out: Comparator[] = [];
  for (const tok of tokens) {
    const m = /^(\^|~>|~|>=|<=|>|<|=)?(.*)$/.exec(tok)!;
    const p = parsePartial(m[2]!);
    if (p === null) return null;
    const cs = primitive(m[1] ?? '', p, caret);
    if (cs === null) return null;
    out.push(...cs);
  }
  return out;
}

/**
 * Whether `version` satisfies the npm range `range` (`^1.2.3`, `~1.2`, `1.x`, `>=1 <2`,
 * `1.0.0 - 2.0.0`, `a || b`, `*`, ``, an `npm:<name>@<range>` alias). null when either
 * side is not understood (a dist-tag, `workspace:`, `file:`, a URL, a malformed range).
 */
export function npmSatisfies(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (v === null) return null;
  let r = range.trim();
  if (r.startsWith('npm:')) {
    const at = r.lastIndexOf('@');
    if (at <= 4) return null;
    r = r.slice(at + 1);
  }
  if (/^[a-z][a-z+.-]*:/i.test(r) || r.includes('/')) return null; // workspace:, file:, link:, git urls, paths
  let any = false;
  for (const alt of r.split('||')) {
    const a = alt.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(a);
    let set: Comparator[] | null;
    if (hyphen) {
      const lo = parsePartial(hyphen[1]!);
      const hi = parsePartial(hyphen[2]!);
      if (lo === null || hi === null) return null;
      const los = primitive('>=', lo, 'npm');
      const his = primitive('<=', hi, 'npm');
      if (los === null || his === null) return null;
      set = [...los, ...his];
    } else {
      set = comparatorSet(a, 'npm');
    }
    if (set === null) return null;
    if (set.every((c) => test(v, c))) any = true;
  }
  return any;
}

/**
 * Whether `version` satisfies the pub constraint `constraint` (`^1.2.3` with pub's rule
 * that `^0.x.y` allows `<0.(x+1).0`, exact `1.2.3`, `>=1.0.0 <2.0.0`, `any`). null when
 * either side is not understood (sentei's `path:` / `git:` / `sdk:` markers, malformed).
 */
export function pubSatisfies(version: string, constraint: string): boolean | null {
  const v = parseVersion(version);
  if (v === null) return null;
  const c = constraint.trim();
  if (c === 'any') return true;
  if (/^[a-z]+:/i.test(c) || c.includes('||')) return null;
  const set = comparatorSet(c, 'pub');
  if (set === null) return null;
  return set.every((x) => test(v, x));
}
