// Entry of the JS bundle; its default export becomes the global `acmeBridge`, which
// acme_js_app (bin/main.dart, same repo) reads through @JS('acmeBridge.start').

// Expected: alive, no finding. Only this file uses it (the assignment below), and
// acme-js-src is a private package nothing in the org depends on, so its internal-only
// exports get no unexport row (fix round 6, unexport_exempt_packages); before that it was
// an unexport the cross-manager witness moved to needs_review (Dart names it via @JS).
let acmeBridge: { start(): string };
// (Workiva's bundle picks one of two builds here, by React version.)
acmeBridge = { start: (): string => 'started' };
export default acmeBridge;

// Expected: needs_review, reasons ["no_refs", "witness_mismatch:pub:acme/dart-js:acme_js_app:bin/main.dart:13",
// "witness_mismatch:pub:acme/dart-js:acme_js_app:bin/main.dart:18"] (the @JS-annotated
// Dart declaration of the same name, and its call).
export function acmeLegacyStart(): string {
  return 'legacy';
}

// Expected: deletion_candidate, reasons ["no_refs"]: no Dart file names it.
export function jsOnlyUnused(): string {
  return 'unused';
}
