// Entry point of @acme/app-lazy: org packages loaded with dynamic import() and
// destructured (supabase pg-delta's `const { analyzeAndSort } = await loadPgTopo()`).

// `const { a } = await import('<org package>')`.
const { lazyDirect } = await import('@acme/lazy');

// Expected: alive, no finding (not exported; called at the top level of the entry file).
const load = () => import('@acme/lazy');
// Expected: alive, no finding (not exported; called at the top level of the entry file).
async function loadLazy() {
  return await load();
}
// `const { a } = await loader()`.
const { lazyLoaded } = await loadLazy();

// `const m = await import(...); const { a } = m`.
const kept = await import('@acme/lazy');
const { lazyKept } = kept;

console.log(lazyDirect(), lazyLoaded(), lazyKept());

// A rest element hides which members are read: namespace_dynamic at @acme/lazy-opaque.
const { opaqueA, ...others } = await import('@acme/lazy-opaque');
console.log(opaqueA, others);

// Handing the namespace to a function that takes `object` hides them too.
// Expected: alive, no finding (not exported; called at the top level of the entry file).
function show(o: object): void {
  console.log(o);
}
show(await import('@acme/lazy-opaque'));
