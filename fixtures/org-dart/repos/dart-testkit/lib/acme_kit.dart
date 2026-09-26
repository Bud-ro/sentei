// Main library of acme_kit: a normal entry (not test-support by its name).
library;

export 'src/test_utils/matchers.dart';
// Re-export of a same-repo org package (package:test's `export 'package:matcher/…'`).
export 'package:acme_match/src/close.dart';

// Expected: deletion_candidate, reasons ["only_test_refs"]. A normal library symbol
// used only by another package's tests (acme_app test/kit_test.dart) stays test-only.
int kitRealOnlyInTests() => 1;
