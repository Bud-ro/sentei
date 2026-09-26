// Modified by sentei (see PATCHES.md); original: Workiva/scip-dart 1.7.0, Apache-2.0.

import 'package:args/args.dart';

class Flags {
  bool get verbose => _verbose;
  bool _verbose = false;

  bool get performance => _performance;
  bool _performance = false;

  /// Emit global symbols for private (`_name`) declarations instead of
  /// `local N` symbols, so private members are addressable across documents.
  bool get privateSymbols => _privateSymbols;
  bool _privateSymbols = false;

  /// Dart SDK for the analyzer (`--sdk-path`), e.g. the Flutter SDK's
  /// `bin/cache/dart-sdk`; null: the SDK running scip-dart.
  String? get sdkPath => _sdkPath;
  String? _sdkPath;

  void init(ArgResults results) {
    _verbose = results['verbose'] as bool? ?? false;
    _performance = results['performance'] as bool? ?? false;
    _privateSymbols = results['private-symbols'] as bool? ?? false;
    _sdkPath = results['sdk-path'] as String?;
  }

  static Flags get instance => _instance;
  static final Flags _instance = Flags._();
  Flags._();
}
