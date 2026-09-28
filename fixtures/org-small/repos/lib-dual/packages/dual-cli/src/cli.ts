// Export surface of @acme/dual-cli (`exports` → dist/cli.mjs → src/cli.ts), also the
// module its bin imports as ../dist/cli.mjs.

// Expected: alive, no finding (the bin calls it: a runtime entry, not an unused export).
export function runCli(args: string[]): number {
  return cliHelper(args);
}

// Expected: alive (runCli uses it).
function cliHelper(args: string[]): number {
  return args.length;
}

// Expected: deletion_candidate, reasons ["no_refs"] (the bin does not take it).
export function cliUnused(): void {}
