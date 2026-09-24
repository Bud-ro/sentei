// Cloudflare Pages Function (functions/ next to a wrangler config): loaded by path.

// Expected: alive, no finding (called by onRequest).
function greet(): string {
  return 'hello';
}

// Expected: alive, no finding (exported by a runtime entry file: an entry symbol).
export const onRequest = (): string => greet();
