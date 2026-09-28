// Used by both variants: alive.
export function buttonLabel(p: string): string {
  return p;
}

// Nothing uses it: private_dead.
export function rnDead(): string {
  return '';
}
