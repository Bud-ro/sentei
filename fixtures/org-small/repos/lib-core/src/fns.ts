import { helperFn } from './helper';

// Expected: alive (external ref from @acme/app).
export function usedFn(x: number): number {
  return privateHelper(x) + helperFn(x);
}

// Expected: deletion_candidate, reasons ["no_refs"] (exported, referenced nowhere).
export function unusedFn(x: number): number {
  return x * 3;
}

// Expected: unexport_candidate, reasons ["internal_refs_only"] (only helper.ts uses it).
export function internalOnlyFn(x: number): number {
  return x - 1;
}

// Expected: alive, no finding (not exported; reachable via usedFn).
function privateHelper(x: number): number {
  return x + 1;
}

// Expected: private_dead, reasons ["already_unreachable"] (island with islandB, reached by nothing).
function islandA(n: number): number {
  return n <= 0 ? 0 : islandB(n - 1);
}

// Expected: private_dead, reasons ["already_unreachable"] (island with islandA, reached by nothing).
function islandB(n: number): number {
  return n <= 0 ? 1 : islandA(n - 1);
}
