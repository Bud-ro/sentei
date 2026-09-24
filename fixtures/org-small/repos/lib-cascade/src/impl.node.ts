// `#impl` node arm: loaded by Node's `node` condition, never picked by the type checker.

// Expected: alive, no finding (exported by a runtime entry: an `imports` map arm).
export function digest(s: string): string {
  return `node:${s}`;
}
