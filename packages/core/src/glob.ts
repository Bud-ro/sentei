// Minimal POSIX-path glob matcher (no dependency). Supported syntax:
//   `**`  any number of whole path segments, including zero (`a/**/b` matches `a/b`)
//   `*`   any run of characters within one segment (never `/`)
//   `?`   exactly one character other than `/`
// Everything else matches literally. No braces, classes, or negation. Paths are
// POSIX and relative (no leading `./`); a leading `./` on the glob is ignored.

const REGEX_SPECIAL = /[\\^$.+()|{}[\]]/;

/** Compile a glob to an anchored RegExp over a POSIX relative path. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.startsWith('./') ? glob.slice(2) : glob;
  g = g.replace(/\/+$/, '');
  let re = '';
  let i = 0;
  while (i < g.length) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      const atSegStart = i === 0 || g[i - 1] === '/';
      const next = g[i + 2];
      if (atSegStart && next === '/') {
        re += '(?:.*/)?'; // `**/` : zero or more leading segments
        i += 3;
        continue;
      }
      if (atSegStart && next === undefined) {
        // trailing `**`: everything below (and, after `a/`, `a` itself is excluded
        // because the slash before it is literal); a bare `**` matches everything.
        re += '.*';
        i += 2;
        continue;
      }
      // `**` inside a segment (e.g. `a**b`) behaves like `*`.
      re += '[^/]*';
      i += 2;
      continue;
    }
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (REGEX_SPECIAL.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** True if the POSIX relative `path` matches `glob`. */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.startsWith('./') ? path.slice(2) : path);
}
