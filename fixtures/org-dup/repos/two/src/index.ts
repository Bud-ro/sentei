// A private copy of @acme/dup in repo `two` (e.g. a fork kept in the org): a real
// package with its own consumers (none here), never what a consumer elsewhere installs.

// deletion_candidate: three's `shared` resolves to one's, not this one
export function shared(): string {
  return 'shared from two';
}

// deletion_candidate: no consumer
export function onlyInTwo(): number {
  return 2;
}
