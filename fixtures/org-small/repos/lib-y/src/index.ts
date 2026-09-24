// Package entry point for @acme/y: defines the export surface.

// Expected: alive, no finding (re-exported as widgetY by @acme/widgets; imported directly by @acme/consumer).
export function yThing(): string {
  return 'y';
}

// Expected: blocked, reasons ["no_refs"], blocked_by ["npm:@acme/broken:index_failed", "npm:@acme/tool-py:unindexed_consumer"] (used by @acme/broken, whose index fails, and by @acme/tool-py, which has Python code we cannot index).
export function yUnused(): string {
  return 'unused';
}
