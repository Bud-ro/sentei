// Part of the entry library: lives under lib/src/ but its public names are on the
// acme_x surface because the library is lib/acme_x.dart.
part of '../acme_x.dart';

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
int partUsed() => 4;

// Expected: deletion_candidate, reasons ["no_refs"] (surface via the part, referenced nowhere).
int partUnused() => 5;
