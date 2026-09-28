// Expected: no finding (main).
void main() => print('acme');

// Expected: deletion_candidate, reasons ["no_refs"]: the app is private, so an
// unused export is a deletion, not a deprecation.
String unusedInApp() => 'unused';
