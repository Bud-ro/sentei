// A demo app whose package.json has no "name" (supabase multiplayer.dev,
// realtime/assets): nothing imports it, but it uses @acme/dual. sentei indexes it as
// the consumer-only package `_unnamed/unnamed-demo`.
import { dualUsedByUnnamed } from '@acme/dual';

// unnamed-demo-2 has the same file with the same local function: scip-typescript names
// both `npm . . src/\`main.ts\`/localHelper().`, and each must stay its own package's.
function localHelper(): string {
  return dualUsedByUnnamed();
}

console.log(localHelper());
