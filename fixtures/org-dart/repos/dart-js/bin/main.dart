// Dart half of a mixed repo (the Workiva react_testing_library shape): the JS bundle
// built from js_src/ (npm acme-js-src) sets the global `acmeBridge`, which Dart reads
// through JS interop. No import can express this use; the witness pairs the two
// managers' packages of one repo instead.
import 'dart:js_interop';

// Expected: alive, no finding (local to the bin/ entry point).
@JS('acmeBridge.start')
external JSString _start();

// Expected: alive, no finding (the declaration name is the JS name: `acmeLegacyStart`).
@JS()
external JSString acmeLegacyStart();

// Expected: alive, no finding (bin/ entry point).
void main() {
  print(_start().toDart);
  print(acmeLegacyStart().toDart);
}
