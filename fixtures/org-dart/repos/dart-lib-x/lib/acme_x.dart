// Package entry point for acme_x (lib/*.dart, not lib/src/): defines the export surface.
library;

// Re-export of a whole src/ library: implUsed and implUnused join the surface.
export 'src/impl.dart';
// `show` combinator: only Shown joins the surface; Hidden does not.
export 'src/shown.dart' show Shown;

// A part file: its declarations belong to this library, so they are surface too.
part 'src/part_a.dart';

// Expected: alive, no finding (external ref from acme_app bin/main.dart, unqualified call).
int usedFn() => _privateFn() + 1;

// Expected: deletion_candidate, reasons ["no_refs"] (public in the entry file, referenced nowhere).
int unusedFn() => 0;

// Expected: alive, no finding (private, never exported; reachable via usedFn).
int _privateFn() => 1;

// Expected: private_dead, reasons ["already_unreachable"] (island with _islandB, reached by nothing).
// ignore: unused_element
int _islandA(int n) => n <= 0 ? 0 : _islandB(n - 1);

// Expected: private_dead, reasons ["already_unreachable"] (island with _islandA, reached by nothing).
int _islandB(int n) => n <= 0 ? 1 : _islandA(n - 1);

// Expected: alive, no finding. Used only implicitly by acme_app (`3.doubled`):
// no identifier in the consumer names IntTimes, only its member.
extension IntTimes on int {
  // Expected: alive, no finding (member of a live extension; external ref `3.doubled`).
  /// Twice the value. See [docOnly].
  int get doubled => this * 2;
}

// Expected: deletion_candidate, reasons ["no_refs"]. Named only by the dartdoc
// link `[docOnly]` on `doubled` above: a doc link is not a reference (fork patch 4).
int docOnly() => 3;
