// acme_kit's test spawning hybrid libraries by URI (no package:test: the fixture
// resolves offline; spawnHybridUri stands in for package:test's).
void spawnHybridUri(String uri) => print(uri);

void main() {
  spawnHybridUri('package:acme_kit/src/hybrid/echo_server.dart');
  spawnHybridUri('package:acme_match/src/remote_server.dart');
  // Not a Dart library of the repo: nothing.
  spawnHybridUri('package:acme_kit/src/hybrid/missing_server.dart');
}
