// A program under lib/src/ that nothing imports: a tool compiles or spawns it by
// path (dart-lang/web js_interop_gen compiles lib/src/dart_main.dart with dart2js
// from a string in cli.dart; isolate / web-worker entry points). Phase 2 fix round 3.

// Expected: alive, no finding (a top-level main is a runtime entry symbol,
// wherever it is; before round 3: private_dead already_unreachable).
void main() => print(_workerHelper());

// Expected: alive, no finding (reached from main; was private_dead).
int _workerHelper() => 42;
