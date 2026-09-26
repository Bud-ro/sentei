// Not re-exported by the entry point: reached only through the deep build-output
// import '@acme/dual/dist/module/lib/types' (supabase auth-helpers imports
// '@supabase/supabase-js/dist/module/lib/types'). tsconfig.module.json maps
// dist/module back to src/, so the consumer's reference resolves to this file.

// Expected: alive, no finding (imported by @acme/dual-app through the deep import).
export interface GenericSchema {
  Tables: Record<string, unknown>;
}

// Expected: deletion_candidate, reasons ["no_refs"]. The deep import makes this module
// part of @acme/dual's export surface, so its unused exports are unused surface (not
// private_dead: a consumer may import them the same way).
export interface UnusedSchema {
  Views: Record<string, unknown>;
}
