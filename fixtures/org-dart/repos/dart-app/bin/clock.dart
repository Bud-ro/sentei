// Entry point of acme_app (bin/): uses acme_x's test-support API from lib/mocks/,
// a public library in a subdirectory of lib/ (lib/extras/), and bindings the
// analyzer excludes in acme_x (lib/bindings.dart -> lib/src/excluded/).
import 'package:acme_x/bindings.dart';
import 'package:acme_x/extras/extras.dart';
import 'package:acme_x/testing.dart';

// Expected: alive, no finding (bin/ entry point).
void main() {
  print(FakeClock().now() + extrasUsed() + bindingsCall());
}
