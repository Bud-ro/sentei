// Entry point for acme_x's test-support API (lib/*.dart). The files it exports have
// test-like paths (`lib/src/wire_test.dart`, `lib/mocks/`) but live under lib/, so
// they are library code, never test files (SURFACE_DIRS).
library;

export 'mocks/fake_clock.dart';
export 'src/wire_test.dart';
