// Entry point via exports "./lazy".

// Expected: alive, no finding (dynamic `import('@acme/widgets/lazy')` with a static string in @acme/consumer).
export function lazyWidget(): number {
  return 8;
}
