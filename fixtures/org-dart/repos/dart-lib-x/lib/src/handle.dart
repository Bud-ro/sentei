// An extension type (Dart 3.3, hence acme_x's `sdk: ^3.3.0`). Its
// representation `raw` is a field and `Handle.wrap` its primary constructor;
// neither is a Declaration node, so scip-dart defined neither while acme_app
// referenced both: false version skew (dart-lang: 397 rows on jni's
// `JConstructorId#pointer.` from ok_http and cronet_http). Fork patch 14.

// Expected: alive, no finding (acme_app calls `Handle.wrap(7)` and reads `.raw`).
extension type Handle.wrap(int raw) {
  // Expected: no finding (member of a live extension type).
  bool get isNull => raw == 0;
}
