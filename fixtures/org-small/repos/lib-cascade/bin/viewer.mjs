#!/usr/bin/env node
// Outside the tsconfig program (unindexed): uses the package by name.
import { viewer } from '@acme/cascade';
console.log(viewer());
