// Test / docs / generated / script file globs (PLAN.md §6.5), shared by the text witness
// (witness.ts, matched with glob.ts) and analyze (the `test_files` / `doc_files` /
// `generated_files` / `script_files` views in sql/analyze.sql). analyze.sql is loaded verbatim, so it spells the same patterns
// as SQLite GLOB conditions; test/globs.test.ts parses them back out of analyze.sql
// and asserts they equal these lists, so the two cannot drift.
//
// Two shapes only (so the SQL rendering stays mechanical):
//   `**/<file pattern>`  matched against the base name (no `/` in the pattern)
//   `**/<dir>/**`        a directory segment anywhere in the path
// Patterns are matched against repo-relative POSIX paths, except inside a package's
// SURFACE_DIRS (pub `lib/`), where TEST / DOCS / SCRIPT globs never apply.

/**
 * Files that are tests or test support (mocks, fixtures, e2e, stories, vitest type
 * tests `*.test-d.ts`, test-utils / testing helpers…).
 */
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
  '**/mocks.*',
  '**/*.test-d.*',
  '**/test-utils.*',
  '**/test-utils/**',
  '**/testing/**',
  '**/*.mock.*',
  // Phase 2 fix round 1 (supabase: 235 private_dead rows were test infrastructure in
  // `tests/` and `type-tests/`), plus the other conventional JS/TS and Flutter names.
  '**/tests/**',
  '**/type-tests/**',
  '**/testdata/**',
  '**/spec/**',
  '**/cypress/**',
  '**/playwright/**',
  '**/test_driver/**',
  '**/integration_test/**',
  '**/*.fixture.*',
  '**/*.e2e.*',
  '**/vitest.setup.*',
  '**/jest.setup.*',
  '**/setupTests.*',
]);

/**
 * Package-relative directories that hold a package's library surface by the package
 * manager's own definition: no TEST / DOCS / SCRIPT glob applies to a file under one
 * (GENERATED_GLOBS still do). pub: everything under `lib/` is importable as
 * `package:<name>/…` and tests never live there, so `lib/src/wire_test.dart`,
 * `lib/src/mocks/`, `lib/testing/` or `lib/src/example/` are library code (a
 * test-support package's whole API sits in such files; Workiva's were mis-scored as
 * tests). npm has no such directory: tests legitimately live in `src/` (`*.test.ts`,
 * `src/__tests__/`, `src/test/`), and the manifest's entry points, the closest npm
 * analogue, can deliberately be test support or stories (`extraEntryPoints`).
 * The `surface_files` view in analyze.sql spells the same rule (test/globs.test.ts checks).
 */
export const SURFACE_DIRS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pub: Object.freeze(['lib']),
  npm: Object.freeze([]),
});

/**
 * True when repo-relative `file` lies in a SURFACE_DIRS directory of its package
 * (`manager`, `pkgPath` repo-relative, '.' for the repo root): TEST / DOCS / SCRIPT
 * globs never apply to it.
 */
export function inSurfaceDir(file: string, manager: string, pkgPath: string): boolean {
  const base = pkgPath === '.' || pkgPath === '' ? '' : `${pkgPath}/`;
  return (SURFACE_DIRS[manager] ?? []).some((d) => file.startsWith(`${base}${d}/`));
}

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
 * sandboxes, scripts and tools, and tool configs (`vitest.config.ts`, `vite.config.ts`,
 * `eslint.config.mjs`, `tsup.config.ts`, `rollup.config.js`, `vitest.workspace.ts`: run
 * by the tool, not imported). Their references count like any other file's, their
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
  '**/script/**',
  '**/*.config.*',
  '**/*.workspace.*',
]);
