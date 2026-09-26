// A library file whose name ends in `_test.dart`. Under lib/ it is library code
// (SURFACE_DIRS: nothing in a pub package's lib/ is a test), not a test.
// Re-exported whole by lib/testing.dart.

// Expected: unexport_candidate, reasons ["internal_refs_only"]. Only FakeClock
// (lib/mocks/) uses it; were lib/mocks/ a test dir, it would be only_test_refs.
int wireTick() => 7;

// Expected: deletion_candidate, reasons ["no_refs"] (surface via export, referenced nowhere).
int wireUnused() => 8;

// Expected: private_dead, reasons ["already_unreachable"]. A test file's symbols are
// never private_dead; this file is not a test file.
// ignore: unused_element
int _wireIsland() => 9;
