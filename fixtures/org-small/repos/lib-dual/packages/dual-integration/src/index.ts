// An Astro-style integration: the framework imports the module the string names
// (`@astrojs/preact` registers `serverEntrypoint: '@astrojs/preact/server.js'`).
// The subpath maps through `exports` (./server.js → dist/server.js) to src/server.ts.

// Expected: deletion_candidate, reasons ["no_refs"] (no org package uses the integration).
export function integration(): { name: string; serverEntrypoint: string } {
  return { name: 'acme-integration', serverEntrypoint: '@acme/dual-integration/server.js' };
}
