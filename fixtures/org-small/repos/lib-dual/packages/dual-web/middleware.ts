// A root middleware.ts in a src/app project: Next ignores it (middleware must sit
// beside the router dir, here src/), so it is not an entry point.

// Expected: private_dead already_unreachable (not an entry, nothing imports it).
export function middleware(): void {}
