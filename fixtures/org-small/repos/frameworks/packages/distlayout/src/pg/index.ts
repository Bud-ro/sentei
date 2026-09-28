// The subpath `@acme/distlayout/pg` (a directory index of a dist-layout manifest without
// `exports`: surface).
export { pgTable } from './table';

// Nothing imports it: deletion_candidate.
export function pgUnused(): string {
  return '';
}
