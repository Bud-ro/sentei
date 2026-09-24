// `#impl` default arm (the one TypeScript resolves under moduleResolution bundler).

// Expected: alive, no finding (exported by a runtime entry: an `imports` map arm).
export function digest(s: string): string {
  return `d:${s}`;
}
