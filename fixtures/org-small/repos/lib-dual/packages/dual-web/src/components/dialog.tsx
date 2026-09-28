// Loaded by the page through `dynamic(() => import('../components/dialog'))` only.

// Expected: alive, no finding (next/dynamic renders the default export).
export default function Dialog(): string {
  return dialogTitle();
}

// Expected: alive, no finding (the dialog calls it).
function dialogTitle(): string {
  return 'dialog';
}

// Expected: private_dead (a lazy loader takes the default export only).
export function dialogDead(): string {
  return 'dead';
}
