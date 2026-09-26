// dart.library.js_interop variant of src/storage.dart's conditional import.
// Expected: alive, no finding: the index sees only the default variant; the
// sidecar's conditionalImports lends it the uses of storage_stub.dart's twin.
String storageName() => 'web';
