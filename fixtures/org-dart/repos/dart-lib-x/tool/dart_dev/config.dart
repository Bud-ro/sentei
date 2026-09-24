// dart_dev (Workiva's task runner) convention: `dart run dart_dev` generates a
// run script that imports this library and reads its top-level `config`. A real
// config maps task names to `DevTool`s from package:dart_dev.

// Expected: alive, no finding (entry symbol: dart_dev reads it by name).
final config = <String, Object>{'format': 'dart format .'};
