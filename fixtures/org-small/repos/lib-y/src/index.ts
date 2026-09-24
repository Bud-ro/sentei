// Package entry point for @acme/y: defines the export surface.

// Expected: alive, no finding (re-exported as widgetY by @acme/widgets; imported directly by @acme/consumer).
export function yThing(): string {
  return 'y';
}

// Expected: blocked, reasons ["no_refs"], blocked_by ["npm:@acme/broken:index_failed"] (the only use is in @acme/broken, whose index fails).
export function yUnused(): string {
  return 'unused';
}
