// A conditional import (fire_atlas storage, flame_3d backends): the analyzer
// resolves `storageName` to one variant only, so the index sees only the
// default's; the dart-surface sidecar lists every variant in
// `conditionalImports` and ingest lends the default's uses to the others.
import 'storage_stub.dart'
    if (dart.library.io) 'storage_io.dart'
    if (dart.library.js_interop) 'storage_web.dart';

// Expected: alive, no finding (external ref from acme_tools).
String storageLabel() => 'storage: ${storageName()}';
