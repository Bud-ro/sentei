// Package entry point for @acme/lazy-opaque. Its only consumer (@acme/app-lazy) takes
// the rest of its dynamic-import namespace (`...rest`) and hands the namespace to a
// function: which members are read is unknown, so every verdict is blocked.

// Expected: alive, no finding (destructured by name next to the rest element).
export function opaqueA(): string {
  return 'a';
}

// Expected: blocked, reasons ["no_refs"], blocked_by ["npm:acme/app-lazy:@acme/app-lazy:namespace_dynamic"].
export function opaqueB(): string {
  return 'b';
}
