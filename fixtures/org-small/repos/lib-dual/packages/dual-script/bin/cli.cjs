// A CommonJS bin (supabase edge-runtime `say/index.js` shape): no exports, only a
// value assigned to module.exports. scip-typescript resolves `banner.text` through
// the require alias to the module, never to the `banner` binding.

// Expected: alive, no finding (used at top level through the require alias).
const banner = require('./banner.cjs');

module.exports = require('node:http').createServer((_req, res) => {
  res.end(banner.text);
});
