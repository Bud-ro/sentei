// Test-support code under lib/ (`lib/mocks/`): library surface of acme_x, which
// consumers' tests import. Not a test file (SURFACE_DIRS), so its uses count.
import '../src/wire_test.dart';

// Expected: alive, no finding (external ref from acme_app bin/clock.dart).
class FakeClock {
  // Expected: alive, no finding (member of a live class).
  int now() => wireTick();
}
