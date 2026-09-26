// A private typedef used only in the type annotation of a top-level variable
// (flame-engine jenny `operators/_common.dart`: `final Map<…, BinaryOperatorBuilder>
// _builders = …`). Phase 2 fix round 3 (fork patch 12).

// Expected: alive, no finding (the type of _builders; the reference used to be
// credited to this file, not to _builders, and this came out private_dead).
typedef _Doubler = int Function(int value);

// Expected: alive, no finding (read by buildDouble).
final Map<String, _Doubler> _builders = {'double': (value) => value * 2};

// Expected: alive, no finding (called by extrasUsed in lib/extras/extras.dart).
int buildDouble(int value) => _builders['double']!(value);
