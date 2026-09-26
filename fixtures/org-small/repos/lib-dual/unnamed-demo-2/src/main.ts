// A second nameless app (supabase hack-the-base `dec-24` next to multiplayer.dev): the
// same path and the same local function as unnamed-demo's, a different package
// (`_unnamed/unnamed-demo-2`).
import { dualUsedByUnnamed } from '@acme/dual';

function localHelper(): string {
  return `2: ${dualUsedByUnnamed()}`;
}

console.log(localHelper());
