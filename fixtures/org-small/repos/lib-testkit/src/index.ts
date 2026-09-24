// Package entry point for @acme/testkit: a test-support library. Its only consumer,
// @acme/consumer, declares it in devDependencies and uses it only from a test file.

// Expected: alive, no finding (used from app-consumer/src/widgets.test.ts; test uses count because the dependency is dev-only).
export function renderHelper(name: string): string {
  return `<${name} />`;
}

// Expected: deletion_candidate, reasons ["no_refs"] (a dev dependency does not make every export alive).
export function unusedKitHelper(): string {
  return 'unused';
}
