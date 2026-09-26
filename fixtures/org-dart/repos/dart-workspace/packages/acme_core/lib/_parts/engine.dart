part of acme_core;

// Expected: alive, no finding (external ref from acme_tools bin/acme_tools.dart).
class Engine {
  // Expected: alive, no finding. `_Helper` is declared in the other part.
  int run() => _Helper().step() + 1;
}
