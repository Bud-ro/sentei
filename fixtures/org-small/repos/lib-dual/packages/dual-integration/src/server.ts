// The server entrypoint the framework loads by the string in src/index.ts. An entry
// point (the `./server.js` export), but no org code imports it: its exports are
// runtime entries, never unused surface.

// Expected: alive, no finding (was a deletion_candidate before round 8d).
export function renderToStaticMarkup(): string {
  return render();
}

// Expected: alive, no finding (the framework reads the module's exports).
export function check(): boolean {
  return true;
}

// Expected: alive (renderToStaticMarkup uses it).
function render(): string {
  return '<div></div>';
}

// Expected: private_dead, reasons ["already_unreachable"].
function serverDead(): string {
  return '';
}
