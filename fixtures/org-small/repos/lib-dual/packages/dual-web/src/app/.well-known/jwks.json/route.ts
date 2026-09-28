// A Next.js route handler under a dot directory (docs.page's `.well-known/jwks.json`):
// Next serves it, but TypeScript's `**/*` include skips dot directories.
import { publicKeys } from '../../../lib/keys';

// Expected: alive, no finding (Next calls the route handler).
export function GET(): string[] {
  return publicKeys();
}
