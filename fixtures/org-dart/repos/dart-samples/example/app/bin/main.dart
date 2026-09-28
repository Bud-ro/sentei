// An example app of ANOTHER repo than acme_x: a promoted consumer package
// (pub:acme/dart-samples:acme_sample_app), indexed; its use of usedBySample counts.
import 'package:acme_x/acme_x.dart';

// Expected: no finding (the runtime calls main; the package has no export surface).
void main() {
  print(usedBySample());
}
