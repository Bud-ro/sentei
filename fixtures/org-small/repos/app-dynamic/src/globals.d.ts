// Ambient stand-ins for the Node globals used below (no @types/node).

// Expected: alive, no finding (ambient; referenced from main.ts and load.cts).
declare const process: {
  // Expected: alive, no finding (member; read as process.argv).
  argv: string[];
};
// Expected: alive, no finding (ambient; referenced from load.cts, an entry point).
declare const require: (id: string) => unknown;
// Expected: alive, no finding (ambient; referenced from load.cts, an entry point).
declare const module: {
  // Expected: alive, no finding (member; assigned as module.exports).
  exports: unknown;
};
