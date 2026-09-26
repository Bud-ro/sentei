// Package entry point for @acme/dual-legacy (dist/index.js maps to this file).
// @acme/dual-app imports '@acme/dual-legacy/dist/esm/internal/gone', a build
// output path with no source in this checkout: sentei cannot see what that import
// uses, so the consumer's sidecar flags this package (a targeted opaque_consumer).

// Expected: blocked, reasons ["no_refs"], blocked_by the dual-app opaque_consumer flag.
export function legacyUnused(): string {
  return 'unused';
}
