// Test / docs file globs (PLAN.md §6.5), shared by the text witness (witness.ts,
// matched with glob.ts) and analyze (the `test_files` / `doc_files` views in
// sql/analyze.sql). analyze.sql is loaded verbatim, so it spells the same patterns
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
