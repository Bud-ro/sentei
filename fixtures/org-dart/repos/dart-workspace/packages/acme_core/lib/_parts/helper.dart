part of acme_core;

// Expected: alive, no finding: used by `Engine.run` in the sibling part
// (resolved in its library, fork patch 8). The parts sort before their library
// (`lib/_parts/` < `lib/acme_core.dart`), which is when resolving a part
// alone lost it.
class _Helper {
  // Expected: alive, no finding.
  int step() => 41;
}
