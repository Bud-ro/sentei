// Test-support dir (`lib/src/test*/`), re-exported by the main library.

// Expected: alive, no finding (used by acme_app's test).
bool isFake(String url) => url.startsWith('fake:');
