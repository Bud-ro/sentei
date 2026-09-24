// Second entry library of acme_x (lib/*.dart): declarations whose SCIP symbols
// needed scip-dart fork patch 3 (packages/indexers/scip-dart/PATCHES.md):
// operator methods, nameless elements, an import prefix.
library;

// An import prefix is not a declaration: `p` gets a local symbol.
import 'src/shown.dart' as p;

// Expected: alive, no finding (acme_app bin/shapes.dart constructs Vec and uses == and []).
class Vec {
  // Expected: alive, no finding (member of a live class).
  final int x;

  const Vec(this.x);

  // Expected: alive, no finding (member of a live class). Symbol `Vec#`==`().`
  @override
  bool operator ==(Object other) => other is Vec && other.x == x;

  // Expected: alive, no finding (member of a live class).
  @override
  int get hashCode => x.hashCode;

  // Expected: alive, no finding (member of a live class). Symbol `Vec#`[]`().`
  int operator [](int i) => i == 0 ? x : 0;
}

// No finding: an unnamed extension has no name, so it and its members get
// local symbols (never verdict subjects). Used by labelOf below.
extension on String {
  String get shout => toUpperCase();
}

// Expected: alive, no finding (acme_app bin/shapes.dart names it). A generic
// function type: its type parameter T and named parameter `times` get no
// global symbol.
typedef Mapper = T Function<T>(T value, {int? times});

// Expected: alive, no finding (external ref from acme_app bin/shapes.dart).
String labelOf(Mapper m) => m<String>(p.Shown().label.shout);
