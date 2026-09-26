// No string literal names this library.

// Expected: private_dead, reasons ["already_unreachable"]: nothing imports or spawns
// it, so its hybridMain is not an entry symbol (negative for URI entries).
void hybridMain(Object? channel) => print(channel);
