// Entry point via exports "./unused-anon".

// Expected: deprecation_candidate, reasons ["no_refs"] (anonymous default export, symbol name `default`; imported by nobody; published package).
export default function () {
  return 1;
}
