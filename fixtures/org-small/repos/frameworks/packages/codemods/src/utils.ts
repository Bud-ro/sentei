// Used by the transform: alive.
export function renameIdentifier(source: string, _api: unknown): string {
  return source;
}

// Nothing uses it: private_dead.
export function codemodDead(): string {
  return '';
}
