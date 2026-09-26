// Preloaded (`node --require`) into scip-typescript and the export-surface
// worker: patches the TypeScript that the main script resolves (scip-typescript's
// own copy, or @sentei/cli's for the worker; one module instance serves both
// `require` and `import`) so tsconfig values newer than it knows are read as the
// newest it does know, with a note on stderr. See ts-option-compat.cjs.
'use strict';
const { createRequire } = require('node:module');
const { NOTE_PREFIX, patchTypeScript } = require('./ts-option-compat.cjs');

const main = process.argv[1];
if (typeof main === 'string' && main !== '') {
  let ts;
  try {
    ts = createRequire(main)('typescript');
  } catch {
    ts = undefined; // no TypeScript next to the script: nothing to patch
  }
  if (ts !== undefined) patchTypeScript(ts, (text) => process.stderr.write(`${NOTE_PREFIX}${text}\n`));
}
