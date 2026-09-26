// Non-entry module: re-exported by name from index.ts.

// Expected: deprecation_candidate, reasons ["only_test_refs"] (only reference is @acme/consumer src/widgets.test.ts; published package).
export function testOnlyFn(): number {
  return 3;
}

// Expected: no finding (unreferenced, but listed in sentei.json keep as npm:@acme/widgets#keptFn).
export function keptFn(): number {
  return 4;
}

// Expected: alive, no finding (member access `W.namespaceUsed()` on a namespace import in @acme/consumer).
export function namespaceUsed(): number {
  return 5;
}

// Expected: deprecation_candidate, reasons ["no_refs"] (namespace-imported package, but never accessed; published package).
export function namespaceUnused(): number {
  return 6;
}
