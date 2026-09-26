// dart:io variant of lib/platform.dart's conditional export.

// Expected: alive, no finding (the same export surface as the stub's; the
// consumer's use of platformName counts for it too). Without the ingest rule
// for conditional exports (DESIGN, Phase 2 fix round 4): private_dead already_unreachable.
String platformName() => _ioDetail();

// Expected: alive, no finding (reached from platformName).
String _ioDetail() => 'io';
