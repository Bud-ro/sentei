// Not exported: used only by the analyzer-excluded lib/src/excluded/bindings_gen.dart.

// Expected: alive, no finding (reached from bindingsCall; without the excluded
// file in the index: private_dead already_unreachable).
int bindingsBackend() => 3;
