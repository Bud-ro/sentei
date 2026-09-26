// Package entry point for @acme/dual. package.json points at build output only
// (main dist/main/index.js, module/types under dist/module/), which exists in no
// checkout; the two tsconfig outDirs map both back to src/.

// Expected: alive, no finding (imported by @acme/dual-app).
export function dualUsed(): string {
  return 'used';
}

// Expected: deletion_candidate, reasons ["no_refs"] (not blocked: the entry points resolve, so the package is not opaque).
export function dualUnused(): string {
  return 'unused';
}
