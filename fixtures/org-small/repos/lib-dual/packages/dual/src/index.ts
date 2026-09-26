// Package entry point for @acme/dual. package.json points at build output only
// (main dist/main/index.js, module/types under dist/module/), which exists in no
// checkout; the two tsconfig outDirs map both back to src/.

// Expected: alive, no finding (imported by @acme/dual-app).
export function dualUsed(): string {
  return 'used';
}

// Expected: alive, no finding (imported only by the nameless unnamed-demo app).
export function dualUsedByUnnamed(): string {
  return 'unnamed';
}

// Expected: deletion_candidate, reasons ["no_refs"] (not blocked: the entry points resolve, so the package is not opaque).
export function dualUnused(): string {
  return 'unused';
}

// Fix round 6 (signature types). Expected: alive, no finding. Used only inside this
// package, but it is the return type of the public dualReport (used by dual-app):
// unexporting it would leave a public API whose type consumers cannot name.
export interface DualReport {
  ok: boolean;
}

// Expected: unexport_candidate, reasons ["internal_refs_only"]: used only in the body of
// a private function, so it can lose its export.
export interface DualScratch {
  n: number;
}

function scratch(): number {
  const s: DualScratch = { n: 1 };
  return s.n;
}

// Expected: alive, no finding (imported by @acme/dual-app).
export function dualReport(): DualReport {
  return { ok: scratch() > 0 };
}
