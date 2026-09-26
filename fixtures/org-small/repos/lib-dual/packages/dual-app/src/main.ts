// Entry point of @acme/dual-app, consumer of @acme/dual in the same repo (as
// supabase-js consumes auth-js).
import { dualReport, dualUsed } from '@acme/dual';
// A deep build-output import (supabase auth-helpers imports
// '@supabase/supabase-js/dist/module/lib/types'): linked to src/lib/types.ts.
import type { GenericSchema } from '@acme/dual/dist/module/lib/types';
// A deep build-output import with no source: unresolved, flags @acme/dual-legacy.
import type { Gone } from '@acme/dual-legacy/dist/esm/internal/gone';

// Expected: alive, no finding (not exported; called from the entry file top level).
function main(schema: GenericSchema, gone?: Gone): void {
  console.log(dualUsed(), dualReport(), Object.keys(schema.Tables), gone);
}

main({ Tables: {} });
