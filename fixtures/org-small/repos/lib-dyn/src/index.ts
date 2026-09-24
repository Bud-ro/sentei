// Package entry point for @acme/dyn. Its only consumer (@acme/app-dynamic) accesses it dynamically.

// Expected: blocked, reasons ["no_refs"], blocked_by ["npm:@acme/app-dynamic:dynamic_access", "npm:@acme/app-dynamic:namespace_dynamic"].
export function dynA(): string {
  return 'a';
}

// Expected: blocked, reasons ["no_refs"], blocked_by ["npm:@acme/app-dynamic:dynamic_access", "npm:@acme/app-dynamic:namespace_dynamic"].
export function dynB(): string {
  return 'b';
}
