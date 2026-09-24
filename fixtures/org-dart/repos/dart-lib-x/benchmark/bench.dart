// A runnable script outside lib/ (`dart run benchmark/bench.dart`): not a
// discover entry point, but its main is run directly.
import 'package:acme_x/acme_x.dart';

// Expected: alive, no finding (entry symbol: main of a script outside lib/).
void main() {
  print(work(1000));
}

// Expected: alive, no finding (reachable from main).
int work(int n) => List.generate(n, (i) => usedFn()).length;
