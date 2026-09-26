// Expected: alive, no finding (re-exported by the entry; destructured by @acme/app-lazy).
export function lazyDirect(): string {
  return 'direct';
}
