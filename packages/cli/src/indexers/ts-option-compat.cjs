// tsconfig option values newer than the bundled TypeScript (PLAN.md §6.6:
// workaround at the indexer boundary). scip-typescript 0.4.0 and the export
// surface run TypeScript 5.9.3, which rejects `"lib": ["ES2025"]`,
// `"target": "es2025"` (TS6046, "Argument for '--lib' option must be: ...") and
// scip-typescript then exits 1 without indexing anything (supabase/
// orb-sync-engine, whose tsconfig is written for TypeScript 7). A value that is
// only *newer* than what TypeScript knows is read as the newest value it does
// know instead: the program is the same one the repo compiles, minus lib typings
// TypeScript 5.9 does not have (their uses become type errors, never a lost org
// reference). Anything else unknown stays an error. Loaded by
// ts-option-compat-preload.cjs; the functions are exported for tests.
'use strict';

/** Line prefix on stderr of every note (the adapter turns these into `info:` diagnostics). */
const NOTE_PREFIX = 'sentei-ts-compat: ';

/** Options whose values are looked up in a name → value Map (`lib` through its element type). */
const OPTIONS = ['lib', 'target', 'module', 'moduleResolution'];

/**
 * The known value to read an unknown `value` of `option` as, or undefined to
 * leave it unknown (TypeScript then reports TS6046 as before). `known` holds
 * the lowercase names TypeScript accepts.
 *   lib: `esYYYY[.part]` newer than every known `esYYYY`, or an unknown
 *     `esnext.part` → `esnext.part` when known, else `esnext` (the newest ES
 *     lib; `es2025` features sit in TypeScript 5.9's esnext libs);
 *   target, module: a newer `esYYYY` → `esnext`;
 *   module, moduleResolution: an unknown `nodeNN` → `nodenext`.
 */
function compatAlias(option, value, known) {
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase();
  if (known.has(v)) return undefined;
  let maxYear = 0;
  for (const k of known) {
    const m = /^es(\d{4})$/.exec(k);
    if (m !== null && Number(m[1]) > maxYear) maxYear = Number(m[1]);
  }
  const es = /^es(\d{4})(?:\.(.+))?$/.exec(v);
  const newerEs = es !== null && Number(es[1]) > maxYear;
  const pick = (name) => (known.has(name) ? name : undefined);
  switch (option) {
    case 'lib': {
      const part = newerEs ? es[2] : v.startsWith('esnext.') ? v.slice('esnext.'.length) : null;
      if (part === null) return undefined;
      return (part !== undefined && pick(`esnext.${part}`)) || pick('esnext');
    }
    case 'target':
      return newerEs && es[2] === undefined ? pick('esnext') : undefined;
    case 'module':
      if (newerEs && es[2] === undefined) return pick('esnext');
      return /^node\d+$/.test(v) ? pick('nodenext') : undefined;
    case 'moduleResolution':
      return /^node\d+$/.test(v) ? pick('nodenext') : undefined;
    default:
      return undefined;
  }
}

/**
 * Makes `ts` accept the values `compatAlias` maps: wraps `get` of the option
 * Maps (TypeScript 5.x converts a tsconfig value with `opt.type.get(value)`
 * and a `/// <reference lib>` with `libMap.get`; iteration, used for the
 * "must be one of" message, is unchanged). `note(text)` runs once per
 * option and value. Idempotent; a TypeScript without these internals is left alone.
 */
function patchTypeScript(ts, note) {
  if (ts === null || typeof ts !== 'object' || ts.__senteiOptionCompat === true) return;
  const decls = ts.optionDeclarations;
  if (!Array.isArray(decls)) return;
  Object.defineProperty(ts, '__senteiOptionCompat', { value: true });
  for (const name of OPTIONS) {
    const decl = decls.find((o) => o.name === name);
    const map = name === 'lib' ? decl?.element?.type : decl?.type;
    if (!(map instanceof Map)) continue;
    const known = new Set(map.keys());
    const get = map.get.bind(map);
    const seen = new Set();
    map.get = (key) => {
      const hit = get(key);
      if (hit !== undefined) return hit;
      const alias = compatAlias(name, key, known);
      if (alias === undefined) return undefined;
      if (!seen.has(key)) {
        seen.add(key);
        note(`tsconfig ${name} '${key}' is newer than TypeScript ${ts.version} knows; read as '${alias}'`);
      }
      return get(alias);
    };
  }
}

module.exports = { NOTE_PREFIX, compatAlias, patchTypeScript };
