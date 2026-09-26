// Re-exported by acme_kit's main library lib/acme_kit.dart (not a test-support entry).

// Expected: alive, no finding. Used only by acme_pub's test, whose dev dependency is
// acme_kit, which re-exports it (package:test re-exporting matcher's closeTo).
bool closeish(num a, num b) => (a - b).abs() < 0.01;

// Expected: deletion_candidate, reasons ["only_test_refs"]. Used only by acme_app's
// test, through its REGULAR dependency on acme_kit (whose main library is no
// test-support entry): the same rule as for a regular dependency on acme_match itself.
bool regularOnlyMatcher(num a) => a > 0;
