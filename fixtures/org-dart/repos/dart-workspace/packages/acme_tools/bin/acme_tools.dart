// The executable only re-exports its main (over_react_codemod's bin/*.dart):
// nothing references `main`, dart-surface finds it in this library's export
// namespace and records it, at its declaration, as a runtime entry symbol.
export 'package:acme_tools/src/cli.dart';
