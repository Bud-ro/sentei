// Package entry point for acme_pub (published-public: no publish_to).

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
int pubUsed() => 7;

// Expected: deprecation_candidate ["no_refs"] (published package; the org_dead view reads it as a deletion).
int pubUnused() => 8;
