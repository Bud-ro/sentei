// Entry point of @acme/app-dynamic.
// §8: `X[key]` on a namespace import -> this package is flagged namespace_dynamic.
import * as D from '@acme/dyn';

// Expected: alive, no finding (not exported; read at the top level of the entry file).
const key = process.argv[2] as keyof typeof D;
console.log(D[key]);
