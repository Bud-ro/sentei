// Entry point via the exports pattern "./deep/*" -> "./src/deep/*.ts".

// Expected: alive, no finding (subpath import `@acme/widgets/deep/thing` in @acme/consumer).
export function deepThing(): number {
  return 7;
}
