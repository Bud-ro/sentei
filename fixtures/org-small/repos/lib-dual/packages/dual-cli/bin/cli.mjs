#!/usr/bin/env node
// The bin loads the package's own build output, which is not built in the checkout
// (withastro create-astro, @nuxt/scripts-cli). dist/cli.mjs maps to src/cli.ts and
// dist/tasks.js to src/tasks.ts: what the bin takes from them is a runtime entry.
import { runCli } from '../dist/cli.mjs';

process.exitCode = runCli(process.argv.slice(2));
void import('../dist/tasks.js').then(({ runTasks }) => runTasks());
