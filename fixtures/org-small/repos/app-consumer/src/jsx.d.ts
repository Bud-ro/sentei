// Minimal self-contained JSX typing (no React), mirroring @acme/widgets.

// Expected: alive, no finding (ambient; referenced by the type annotation of view in view.tsx).
declare namespace JSX {
  // Expected: alive, no finding (ambient; referenced by the type annotation of view in view.tsx).
  interface Element {}
}
