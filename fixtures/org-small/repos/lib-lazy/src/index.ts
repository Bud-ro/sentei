// Package entry point for @acme/lazy. Its only consumer (@acme/app-lazy) loads it with
// dynamic import() and destructures the namespace, which scip-typescript 0.4.0 links
// to nothing (the bindings are `local` symbols); the adapter's checker-resolved
// namespaceMemberRefs carry the uses.

// Expected: alive, no finding (an alias re-export: destructured from `await import()`).
export { lazyDirect } from './direct';

// Expected: alive, no finding (destructured from the awaited result of a loader function).
export function lazyLoaded(): string {
  return 'loaded';
}

// Expected: alive, no finding (destructured from a namespace kept in a variable).
export function lazyKept(): string {
  return 'kept';
}

// Expected: deletion_candidate, reasons ["no_refs"] (never destructured or accessed).
export function lazyUnused(): string {
  return 'unused';
}
