// Non-entry module: part of the @acme/widgets export surface only via `export *` in index.ts.

// Expected: alive, no finding (exported via `export *`; imported by @acme/consumer and @acme/app-skew).
export function internalUsed(): number {
  return 1;
}

// Expected: deprecation_candidate, reasons ["no_refs"] (exported via `export *`, referenced nowhere; published package).
export function internalUnused(): number {
  return unusedHelper() + 1;
}

// Expected: private_dead, reasons ["unlocked_by:internalUnused"] (reachable only through internalUnused).
function unusedHelper(): number {
  return 2;
}
