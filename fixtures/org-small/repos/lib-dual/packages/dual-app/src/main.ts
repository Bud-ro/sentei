// Entry point of @acme/dual-app, consumer of @acme/dual in the same repo (as
// supabase-js consumes auth-js).
import { dualUsed } from '@acme/dual';

// Expected: alive, no finding (not exported; called from the entry file top level).
function main(): void {
  console.log(dualUsed());
}

main();
