// Preloaded (`node --require`) into the scip-typescript retry after a heap
// exhaustion. Workaround at the indexer boundary (PLAN.md §6.6) for a
// TypeScript 5.9.3 checker blow-up in scip-typescript 0.4.0: the hover
// documentation of every definition is built with `checker.signatureToString` /
// `typeToString`, and printing some recursive template-literal conditional types
// never finishes (unjs/scule: the overload `splitByCase<T>(str: T):
// SplitByCase<T>` exhausts 8 GB while type-checking the same program takes
// 35 ms and ~100 MB). sentei never reads SCIP documentation, so the retry
// replaces the signature text with a fixed marker; symbols, occurrences and
// relationships are unchanged.
'use strict';
const path = require('node:path');
const pkgJson = require.resolve('@sourcegraph/scip-typescript/package.json');
const { FileIndexer } = require(path.join(path.dirname(pkgJson), 'dist', 'src', 'FileIndexer.js'));
FileIndexer.prototype.signatureForDocumentation = function signatureForDocumentation() {
  return '(signature omitted by sentei: printing it exhausted the heap)';
};
