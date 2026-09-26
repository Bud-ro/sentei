// Reached only through the webpack entry src/app.js (kept alive).
export function renderPage(el) {
  el.textContent = 'hello';
}

// Nothing uses this: private_dead once the entry is known.
export function webpackUnused() {
  return 1;
}
