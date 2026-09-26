// Named only by `new URL('./bundled-worker.ts', import.meta.url)` in server.ts (the
// supabase CLI hands serve.main.ts to esbuild that way, and Deno runs it verbatim):
// nothing imports it, so it is a runtime entry point by that reference alone.

// Expected: alive, no finding (not exported; called from the entry file top level).
// Without the new URL convention: private_dead already_unreachable.
function handleJob(): string {
  return 'job';
}

console.log(handleJob());
