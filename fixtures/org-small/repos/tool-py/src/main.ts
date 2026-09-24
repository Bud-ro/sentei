// Entry point of @acme/tool-py: a TS consumer of @acme/y that also ships a Python
// build script (scripts/build.py). Python has no indexer, so discover flags this
// package unindexed_consumer and every @acme/y verdict it could affect is blocked.
import { yThing } from '@acme/y';

console.log(yThing());
