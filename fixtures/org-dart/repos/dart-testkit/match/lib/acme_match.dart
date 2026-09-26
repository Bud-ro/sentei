// Main library of acme_match (package:matcher's role; acme_kit is package:test's).
library;

export 'src/close.dart';
export 'src/support.dart';

// Expected: deletion_candidate, reasons ["only_test_refs"]. acme_pub's test uses it
// through its dev dependency on acme_kit, but acme_kit does not re-export it and
// acme_pub has no dependency on acme_match.
bool hiddenMatcher(Object? o) => o == null;
