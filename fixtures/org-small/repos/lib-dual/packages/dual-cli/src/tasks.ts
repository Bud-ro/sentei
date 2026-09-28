// Not an entry point: only the bin's `import('../dist/tasks.js')` loads it.

// Expected: alive (runTasks uses it; without the dist → src load it was private_dead).
function taskHelper(): number {
  return 1;
}

// Expected: alive, no finding (destructured by the bin's dynamic import).
export function runTasks(): number {
  return taskHelper();
}

// Expected: private_dead, reasons ["already_unreachable"].
function taskDead(): number {
  return 2;
}
