export function feedItems(): string[] {
  return ['a'];
}

// Unused, but a component imports this module and sentei cannot tell which names it
// uses: every top-level declaration of it is kept alive (fail closed).
export function astroDead(): number {
  return 0;
}
