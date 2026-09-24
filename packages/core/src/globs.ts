// Test / docs / generated / script file globs (PLAN.md §6.5), shared by the text witness
// (witness.ts, matched with glob.ts) and analyze (the `test_files` / `doc_files` /
// `generated_files` / `script_files` views in sql/analyze.sql). analyze.sql is loaded verbatim, so it spells the same patterns
// as SQLite GLOB conditions; test/globs.test.ts parses them back out of analyze.sql
// and asserts they equal these lists, so the two cannot drift.
//
// Two shapes only (so the SQL rendering stays mechanical):
//   `**/<file pattern>`  matched against the base name (no `/` in the pattern)
//   `**/<dir>/**`        a directory segment anywhere in the path
// Patterns are matched against repo-relative POSIX paths.

/** Files that are tests or test support (mocks, fixtures, e2e, stories…). */
export const TEST_GLOBS: readonly string[] = Object.freeze([
  '**/*.test.*',
  '**/*_test.dart',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*.stories.*',
  '**/test/**',
  '**/__tests__/**',
  '**/mocks/**',
  '**/__mocks__/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/e2e/**',
  '**/test-integration/**',
  '**/__schemas__/**',
]);

/** Files that are documentation or examples. */
export const DOCS_GLOBS: readonly string[] = Object.freeze([
  '**/docs/**',
  '**/examples/**',
  '**/example/**',
  '**/demo/**',
]);

/**
 * Generated files (build_runner / protoc / freezed / mockito / over_react output, and
 * the conventional generated dirs). Nothing DEFINED in them is ever reported: their
 * declarations regenerate from a source we do not model. References FROM them still
 * count (a generated file using a symbol keeps it alive). Same shapes as above; the
 * `generated_files` view in analyze.sql spells the same list.
 */
export const GENERATED_GLOBS: readonly string[] = Object.freeze([
  '**/*.g.dart',
  '**/*.pb.dart',
  '**/*.pbenum.dart',
  '**/*.pbjson.dart',
  '**/*.pbserver.dart',
  '**/*.freezed.dart',
  '**/*.mocks.dart',
  '**/*.over_react.g.dart',
  '**/*.generated.*',
  '**/generated/**',
  '**/__generated__/**',
]);

/**
 * Runnable code that is neither library surface nor a test: playgrounds, benchmarks,
 * sandboxes, scripts and tools. Their references count like any other file's, their
 * documents are reachability seeds (they are run directly), and nothing DEFINED in them
 * gets a verdict or a private_dead row. Same shapes as above; the `script_files` view in
 * analyze.sql spells the same list.
 */
export const SCRIPT_GLOBS: readonly string[] = Object.freeze([
  '**/playground/**',
  '**/playgrounds/**',
  '**/bench/**',
  '**/benchmark/**',
  '**/benchmarks/**',
  '**/sandbox/**',
  '**/scripts/**',
  '**/tool/**',
  '**/tools/**',
]);
