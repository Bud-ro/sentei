// Re-exported by acme_kit's test-support entry lib/testing.dart.

// Expected: alive, no finding. Used only by acme_app's test through a regular
// dependency on acme_kit: re-exported by a test-support entry, so test-support surface.
bool supportMatcher(Object? o) => o != null;
