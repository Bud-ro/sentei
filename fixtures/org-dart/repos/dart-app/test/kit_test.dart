// A test of acme_app using acme_kit, declared as a regular dependency (Workiva's
// codemod lib/test.dart case). No package:test: the fixture resolves offline.
import 'package:acme_kit/acme_kit.dart';
import 'package:acme_kit/testing.dart';

void main() {
  final server = FakeServer();
  print(isFake(server.url));
  print(kitRealOnlyInTests());
  print(supportMatcher(server));
  print(regularOnlyMatcher(1));
}
