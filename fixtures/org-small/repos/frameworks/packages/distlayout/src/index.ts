// The package's `.` (main ./index.cjs, published from dist/: src/index.ts). Nothing
// imports the root: deletion_candidate.
export function distRootUnused(): string {
  return 'root';
}
