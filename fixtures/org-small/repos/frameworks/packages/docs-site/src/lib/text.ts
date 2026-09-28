// Used by the theme and the remark plugin: alive.
export function footerText(): string {
  return 'footer';
}

// Used by the remark plugin: alive.
export function slugify(s: string): string {
  return s.toLowerCase();
}

// Nothing uses it: private_dead.
export function docsDead(): string {
  return 'dead';
}
