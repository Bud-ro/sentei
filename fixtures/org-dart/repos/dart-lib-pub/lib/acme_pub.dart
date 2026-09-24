// Package entry point for acme_pub (published-public: no publish_to).

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
int pubUsed() => 7;

// Expected: deletion_candidate ["no_refs"] with assumeClosedWorld: true;
// deprecation_candidate ["no_refs", "open_world"] with assumeClosedWorld: false.
int pubUnused() => 8;
