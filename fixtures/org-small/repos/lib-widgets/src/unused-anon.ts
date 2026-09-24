// Entry point via exports "./unused-anon".

// Expected: deletion_candidate, reasons ["no_refs"] (anonymous default export, symbol name `default`; imported by nobody). Open world: deprecation_candidate.
export default function () {
  return 1;
}
