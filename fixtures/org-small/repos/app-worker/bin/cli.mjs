#!/usr/bin/env node
// A package.json `bin`, outside the tsconfig program: a runtime entry point only, never
// surface, so its absence from the index does not make the package partial.
console.log('worker-cli');
