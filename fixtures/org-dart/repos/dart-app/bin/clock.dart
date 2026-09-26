// Entry point of acme_app (bin/): uses acme_x's test-support API from lib/mocks/.
import 'package:acme_x/testing.dart';

// Expected: alive, no finding (bin/ entry point).
void main() {
  print(FakeClock().now());
}
