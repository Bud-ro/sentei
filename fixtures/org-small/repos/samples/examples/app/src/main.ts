// An example app in a samples repo: its manifest is under examples/ (an ignored dir),
// but it depends on @acme/core from ANOTHER repo, so discover indexes it as the consumer
// package npm:acme/samples:@acme/sample-app (Phase 3 decision 3). Its files are not docs
// files (the docs globs apply below its own root), so this use of usedFn is a counted
// external reference.
import { usedFn } from '@acme/core';

// Expected: alive, no finding (the package has no export surface; called below).
function main(): void {
  console.log(usedFn(1));
}

main();
