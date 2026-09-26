// Package entry point for acme_x (lib/*.dart, not lib/src/): defines the export surface.
library;

// Re-export of a whole src/ library: implUsed and implUnused join the surface.
export 'src/impl.dart';
// `show` combinator: only Shown joins the surface; Hidden does not.
export 'src/shown.dart' show Shown;
// An extension type (fork patch 14: its representation field and primary constructor).
export 'src/handle.dart';

// A part file: its declarations belong to this library, so they are surface too.
part 'src/part_a.dart';

// Expected: alive, no finding (external ref from acme_app bin/main.dart, unqualified call).
int usedFn() => _privateFn() + 1;

// Expected: deletion_candidate, reasons ["no_refs"] (public in the entry file, referenced nowhere).
int unusedFn() => 0;

// Expected: alive, no finding (private, never exported; reachable via usedFn).
int _privateFn() => inExample();

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

// Expected: needs_review, reasons ["no_refs", "witness_mismatch:ignored:acme/dart-lib-x/example/pubspec.yaml:example/bin/demo.dart:8 (member loadAcme)"].
// Used only through its member, `'logo'.loadAcme()`, by the example app (an ignored
// manifest): the witness searches an extension's member names too.
extension AcmeLoader on String {
  // Expected: no finding (a member of an extension; not exported on its own).
  String loadAcme() => 'acme:$this';
}

// Expected: deletion_candidate, reasons ["no_refs"]. Its only member `sq` is shorter
// than 3 characters, so the witness does not search it: the example's local `sq` is
// not a hit.
extension AcmeTiny on int {
  // Expected: no finding (member of an extension).
  int get sq => this * this;
}

// Expected: needs_review, reasons ["internal_refs_only", "witness_mismatch:ignored:acme/dart-lib-x/example/pubspec.yaml:example/bin/demo.dart:9 (used by ignored manifest acme/dart-lib-x:example/pubspec.yaml)"].
// Used inside acme_x only (by _privateFn), so an unexport by the index; the example
// app (an ignored manifest, never indexed) names it, which the witness reports.
int inExample() => 1;
