// Next.js middleware beside the src/app router: loaded by Next by name.

// Expected: alive, no finding (Next calls it).
export function middleware(): void {}

// Expected: alive, no finding (Next reads it).
export const config = { matcher: '/' };
