// Entry point of acme_core, a pub workspace member listed by path in the root
// pubspec: scip-dart used to index none of its lib/ files (fork patch 7).
// A named library whose parts say `part of acme_core;` (by name, not URI):
// scip-dart used to resolve such parts without their library, so every
// reference between the parts was lost (flame-engine/oxygen, fork patch 8).
library acme_core;

export 'src/storage.dart';
export 'src/vec.dart';

part '_parts/engine.dart';
part '_parts/helper.dart';
