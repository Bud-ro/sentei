// A public library whose surface is a conditional EXPORT (dart-lang: a name
// moved behind `export 'stub.dart' if (dart.library.io) 'io.dart';`). The
// analyzer resolves the export to the default (the stub) only.
export 'src/platform_stub.dart'
    if (dart.library.io) 'src/platform_io.dart'
    if (dart.library.js_interop) 'src/platform_web.dart';
