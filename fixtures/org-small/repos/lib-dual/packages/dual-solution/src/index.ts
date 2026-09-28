// The `.` entry, in the referenced tsconfig.build.json.

// Expected: deletion_candidate (private, nothing uses it).
export function solutionUnused(): number {
  return 1;
}
