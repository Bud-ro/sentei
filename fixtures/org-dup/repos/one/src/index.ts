// @acme/dup as published from repo `one` (not private): the package consumers get.

// alive: used by three (only `one` defines it, so the use proves resolution picked `one`)
export function onlyInOne(): string {
  return 'one';
}

// alive: used by three
export function shared(): string {
  return 'shared from one';
}

// deletion_candidate: no consumer
export function unusedInOne(): number {
  return 1;
}
