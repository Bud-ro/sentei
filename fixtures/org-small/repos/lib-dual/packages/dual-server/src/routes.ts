// Helpers of the server entry.

// Expected: alive, no finding (called by the server entry).
export function routeFor(path: string): string {
  return `route:${path}`;
}

// Expected: private_dead already_unreachable (exported, but no package entry point exports it and nothing calls it).
export function unusedRoute(): string {
  return 'old';
}
