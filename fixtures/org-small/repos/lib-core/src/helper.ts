// Non-entry module: not part of the @acme/core export surface.
import { internalOnlyFn } from './fns';

// Expected: alive, no finding (module-exported but not package-exported; reachable via usedFn).
export function helperFn(x: number): number {
  return internalOnlyFn(x) * 2;
}
