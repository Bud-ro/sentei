// build_runner builder library, named by build.yaml (`import:`). A real
// builder returns a `Builder` from package:build; the fixture has no deps.

// Expected: alive, no finding. build.yaml `builder_factories: ["acmeBuilder"]`:
// build_runner calls it by name, nothing in code references it (entry symbol).
Object acmeBuilder(Map<String, Object?> options) => 'acme builder';
