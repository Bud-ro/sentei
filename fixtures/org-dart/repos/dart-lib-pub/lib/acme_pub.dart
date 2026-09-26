// Package entry point for acme_pub (published-public: no publish_to).

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
int pubUsed() => 7;

// Expected: deprecation_candidate ["no_refs"] (published package; the org_dead view reads it as a deletion).
int pubUnused() => 8;

// Expected: deprecation_candidate ["only_docs_refs"]: used only by this package's own
// example/example.dart, a docs file (not a consumer while countDocsAsConsumers is
// false); the reason says so instead of no_refs.
int pubExampleOnly() => 9;
