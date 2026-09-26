// A public library in a subdirectory of lib/ (not lib/src/): importable as
// `package:acme_x/extras/extras.dart`, so a discover entry point of its own
// (dart-lang/sse has only lib/client/ and lib/server/). Phase 2 fix round 3.

// Expected: alive, no finding (external ref from acme_app bin/clock.dart).
int extrasUsed() => 7;

// Expected: deletion_candidate ["no_refs"] (exported by the entry; before round 3
// the file was no entry and this was private_dead already_unreachable).
int extrasUnused() => 8;
