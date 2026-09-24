// Entry point of acme_app (bin/), consumer of acme_x and acme_pub.
// `show`: only these names come from the first import (shownOnly is shown, never called).
// ignore: unused_shown_name
import 'package:acme_x/acme_x.dart' show usedFn, Shown, implUsed, shownOnly;
// `hide`: every other acme_x name (the extension, partUsed, ...) comes from here.
import 'package:acme_x/acme_x.dart' hide usedFn;
import 'package:acme_pub/acme_pub.dart';

// Expected: alive, no finding (bin/ entry point).
void main() {
  print(usedFn()); // unqualified imported top-level function
  print(3.doubled); // extension getter; the extension itself is never named here
  print(Shown().label); // class via `export ... show Shown`, implicit default constructor
  print(implUsed()); // declared in src/impl.dart, reached through `export 'src/impl.dart'`
  print(partUsed()); // declared in a part file
  print(pubUsed());
}
