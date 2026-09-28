// Re-exported whole by lib/acme_x.dart (`export 'src/impl.dart';`).

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
int implUsed() => 2;

// Expected: deletion_candidate, reasons ["no_refs"] (surface via export, referenced nowhere).
int implUnused() => 3;

// Expected: alive, no finding. acme_app names it in an import `show` list but never
// calls it; a shown name counts as a reference (fail closed, like a TS import binding).
int shownOnly() => 6;

// Unnamed extensions (`extension on T { ... }`), usable only inside this library.
// The fork made them and their members `local` symbols, so nothing they used had a
// global user: VeryGoodOpenSource very_good_cli `_ignoredDirectories` (used only by
// `extension on Set<String> { excludes }`) and fluttercommunity `_colorToJson` came
// out private_dead. Fork patch 15 names an unnamed extension
// `<extension on T, line N>`, so its members are global symbols with their uses.

// Expected: alive, no finding (external ref from acme_app bin/main.dart).
String shoutAll(List<String> words) => words.map((w) => w.loud).join(' ');

extension on String {
  // Expected: no finding (member of a live unnamed extension).
  String get loud {
    // A local function stays local (fork patch 15): uses inside it are uses by `loud`.
    String bang(String s) => '$s!';
    return bang(_upper(this));
  }
}

// Expected: alive, no finding (used only by the unnamed extension's `loud`).
String _upper(String s) => s.toUpperCase();

// Expected: private_dead, reasons ["already_unreachable"], named
// `<extension on bool, line 38>`: none of its members is used.
// ignore: unused_element
extension on bool {
  // Expected: no finding (member of an unused extension: the extension's row covers it).
  // ignore: unused_element
  bool get flipped => !this;
}
