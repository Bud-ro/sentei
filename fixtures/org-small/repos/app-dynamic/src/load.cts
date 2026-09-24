// CommonJS entry point (exports "./load").
// §8: require() of a computed org package name -> this package is flagged dynamic_access.

// Expected: alive, no finding (not exported; read at the top level of an entry file).
const pkgName = process.argv[3];
module.exports = require('@acme/' + pkgName);
