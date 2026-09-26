// acme_pub's test: acme_kit is a dev dependency (package:test's role), which
// re-exports acme_match's closeish (matcher's closeTo).
import 'package:acme_kit/acme_kit.dart';
import 'package:acme_match/acme_match.dart' show hiddenMatcher;

void main() {
  print(closeish(1, 1.001));
  print(hiddenMatcher(null));
}
