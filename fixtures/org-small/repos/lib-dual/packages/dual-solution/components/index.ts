// The `./components` entry: in no project of the solution-style tsconfig (astro's
// components/index.ts); indexed through the runtime tsconfig.

// Expected: deletion_candidate (private, nothing uses it).
export function componentUnused(): string {
  return 'component';
}
