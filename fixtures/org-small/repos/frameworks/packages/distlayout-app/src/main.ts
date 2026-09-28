// Consumer of the dist-layout package @acme/distlayout through a subpath (as apps import
// `drizzle-orm/pg-core`): `pg` is dist/pg/index.js in the published package, and
// src/pg/index.ts in the checkout.
import { pgTable } from '@acme/distlayout/pg';

// Expected: alive, no finding (not exported; called from the entry file top level).
function main(): void {
  console.log(pgTable('users'));
}

main();
