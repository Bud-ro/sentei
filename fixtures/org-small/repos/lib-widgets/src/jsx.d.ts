// Minimal self-contained JSX typing (no React). Kept to the one member the code names,
// so that no ambient declaration is left unreferenced.

// Expected: alive, no finding (ambient; referenced by Widget's return type).
declare namespace JSX {
  // Expected: alive, no finding (ambient; referenced by Widget's return type).
  interface Element {}
}
