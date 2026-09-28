// infra/main.tf deploys `translateText` (entry_point): an entry symbol, never a verdict.
export function translateText(): string {
  return 'hola';
}

// Nothing deploys or imports it: deletion_candidate.
export function cloudfnUnused(): string {
  return '';
}
