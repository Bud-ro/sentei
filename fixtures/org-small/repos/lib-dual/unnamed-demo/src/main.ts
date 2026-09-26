// A demo app whose package.json has no "name" (supabase multiplayer.dev,
// realtime/assets): nothing imports it, but it uses @acme/dual. sentei indexes it as
// the consumer-only package `_unnamed/unnamed-demo`.
import { dualUsedByUnnamed } from '@acme/dual';

console.log(dualUsedByUnnamed());
