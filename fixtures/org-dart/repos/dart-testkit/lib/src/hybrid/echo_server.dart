// Spawned by URI from acme_kit's own test/hybrid_test.dart (dart-lang/test's
// spawn_hybrid: `spawnHybridUri('package:spawn_hybrid/emits_numbers.dart')`).

// Expected: alive, no finding (runtime entry symbol: named by a package: URI literal).
void hybridMain(Object? channel) => _echo(channel);

// Expected: alive, no finding (reached from hybridMain).
void _echo(Object? channel) => print(channel);
