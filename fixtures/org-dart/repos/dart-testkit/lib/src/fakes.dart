// Exported through lib/testing.dart: test-support surface.

// Expected: alive, no finding. Used only by acme_app's test (test/kit_test.dart),
// through a regular dependency: other packages' test uses of test-support count.
class FakeServer {
  // Expected: alive, no finding (member of a live class).
  String get url => 'fake://server';
}

// Expected: deletion_candidate, reasons ["no_refs"] (test-support, used nowhere).
FakeServer unusedFakeServer() => FakeServer();

// Expected: deletion_candidate, reasons ["only_test_refs"]. Used only by acme_kit's
// own test: a package's own tests are never its consumers, test-support or not.
int ownTestOnlyFake() => 3;
