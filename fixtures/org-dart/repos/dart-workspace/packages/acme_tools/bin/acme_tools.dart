import 'package:acme_core/acme_core.dart';
import 'package:acme_x/acme_x.dart' show usedFn;

// Expected: alive, no finding (bin/ entry point).
void main() {
  print(shifted(Vec2(1, 2), 1).x);
  print(usedFn());
}
