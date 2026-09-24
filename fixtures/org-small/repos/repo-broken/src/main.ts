// Entry point of @acme/broken. tsconfig.json is deliberately invalid JSON, so the
// index fails, the package is flagged index_failed, and @acme/y verdicts are blocked.
// The real use below is exactly what the blocker protects.
import { yUnused } from '@acme/y';

// Expected: no finding (package is opaque; nothing is ingested for it).
function main(): void {
  console.log(yUnused());
}

main();
