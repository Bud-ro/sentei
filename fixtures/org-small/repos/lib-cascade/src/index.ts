// Package entry point for @acme/cascade (exports "." → import: src/index.ts; the
// require condition points at unbuilt dist/cjs, which is fine: one condition resolves).
import { digest } from '#impl';

// Expected: needs_review, reasons ["no_refs", "witness_mismatch:self:bin/viewer.mjs:3", "witness_mismatch:self:bin/viewer.mjs:4"]
// (no indexed use; bin/viewer.mjs, outside the tsconfig program, imports it by name).
export function viewer(): string {
  return initParams() + helperC() + digest('v');
}

// Expected: unexport_candidate, reasons ["internal_refs_only"]. Its only user is viewer,
// so analyze calls it a dead island; the witness keeps viewer, so it reverts.
export function initParams(): string {
  return helperA();
}

// Expected: alive, no finding (reached from initParams / viewer, which stay).
function helperA(): string {
  return 'a';
}

// Expected: alive, no finding (reached from viewer; not unlocked once viewer is downgraded).
function helperC(): string {
  return 'c';
}

// Expected: deletion_candidate, reasons ["no_refs"].
export function dropped(): string {
  return helperB();
}

// Expected: private_dead, reasons ["unlocked_by:dropped"].
function helperB(): string {
  return 'b';
}
