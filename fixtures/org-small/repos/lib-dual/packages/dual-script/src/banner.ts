// Not on the export surface: used only by the start script.

// Expected: alive, no finding (used only by scripts/serve.mjs, a runtime entry outside the tsconfig program).
export function serveBanner(port: number): string {
  return `listening on ${port}`;
}

// Expected: private_dead already_unreachable (the package is transparent, so eligible).
function scriptDeadHelper(): number {
  return 3;
}
