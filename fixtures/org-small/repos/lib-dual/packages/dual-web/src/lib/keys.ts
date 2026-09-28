// Used only by the route handler under `src/app/.well-known/`.

// Expected: alive, no finding (the dot-directory route calls it).
export function publicKeys(): string[] {
  return ['key'];
}

// Expected: private_dead (nothing calls it).
export function keysDead(): string[] {
  return [];
}
