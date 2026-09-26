// Export surface of @acme/dual-script (`exports`). The package also has runtime
// entries outside its tsconfig program (`include: ["src"]`, no allowJs): the
// `node scripts/serve.mjs` start script and Next.js `next.config.mjs`. They seed
// reachability but are no surface, so the package is not opaque.

// Expected: deletion_candidate, reasons ["no_refs"] (not blocked, and the package is not opaque).
export function scriptLibUnused(): number {
  return 1;
}
