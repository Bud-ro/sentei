// Second program of acme_app: consumer of acme_x's lib/syntax.dart.
import 'package:acme_x/syntax.dart';

// Expected: alive, no finding (bin/ entry point).
void main() {
  const a = Vec(1);
  print(a == const Vec(1)); // operator ==
  print(a[0]); // operator []
  // A closure with a named parameter: local symbols.
  final Mapper id = <T>(T value, {int? times}) => value;
  print(labelOf(id));
}
