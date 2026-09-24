// Re-exported whole by lib/acme_x.dart (`export 'src/impl.dart';`).

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
int implUsed() => 2;

// Expected: deletion_candidate, reasons ["no_refs"] (surface via export, referenced nowhere).
int implUnused() => 3;

// Expected: alive, no finding. acme_app names it in an import `show` list but never
// calls it; a shown name counts as a reference (fail closed, like a TS import binding).
int shownOnly() => 6;
