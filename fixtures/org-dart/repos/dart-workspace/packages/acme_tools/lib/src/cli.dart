import 'package:acme_core/acme_core.dart';
import 'package:acme_x/acme_x.dart' show usedFn;

// Expected: alive, no finding: run through bin/acme_tools.dart's
// `export 'package:acme_tools/src/cli.dart';` (sidecar entrySymbols).
void main() {
  final a = Vec2(1, 2) & Vec2(3, 4);
  print((a % 2)[0]);
  print(shifted(a, 1).x);
  print(Engine().run());
  print(_banner(usedFn()));
}

// Expected: alive, no finding (reached from main).
String _banner(int n) => 'acme_tools $n';
