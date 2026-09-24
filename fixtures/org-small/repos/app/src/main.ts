// Entry point of @acme/app, consumer of @acme/core.
import { usedFn } from '@acme/core';

// Expected: alive, no finding (not exported; called from the entry file top level).
function main(): void {
  console.log(usedFn(41));
}

main();
