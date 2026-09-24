// Vite client entry (index.html <script src="/src/client.ts">): imported by no code.

// Expected: alive, no finding (called at the top level of a client entry).
function boot(): void {
  document.title = 'cascade';
}

boot();
