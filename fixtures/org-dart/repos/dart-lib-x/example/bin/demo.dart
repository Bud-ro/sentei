// Example app for acme_x. Its own pubspec makes it an ignored manifest (example/ is
// in ignoreManifestDirs): never indexed, read only by the text witness.
import 'package:acme_x/acme_x.dart';

void main() {
  // A local named like AcmeTiny's member `sq` (too short to be searched).
  final sq = 4;
  print('logo'.loadAcme());
  print(inExample() + sq);
}
