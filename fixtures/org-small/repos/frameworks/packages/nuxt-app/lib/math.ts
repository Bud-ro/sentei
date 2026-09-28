// Used by a composable: alive.
export function clamp(n: number): number {
  return Math.max(0, n);
}

// Nothing uses it: private_dead.
export function nuxtDead(): number {
  return 0;
}
