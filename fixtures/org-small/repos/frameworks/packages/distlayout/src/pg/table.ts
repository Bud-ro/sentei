// Re-exported by pg/index.ts, used by @acme/distlayout-app: alive, no finding.
export function pgTable(name: string): string {
  return `table ${name}`;
}

// Not re-exported by the index, and nothing imports this module's other names:
// private_dead (a module file is not surface, only directory indices are).
export function tableHelperDead(): string {
  return '';
}
