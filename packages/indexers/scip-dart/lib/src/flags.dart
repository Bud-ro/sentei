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

  void init(ArgResults results) {
    _verbose = results['verbose'] as bool? ?? false;
    _performance = results['performance'] as bool? ?? false;
    _privateSymbols = results['private-symbols'] as bool? ?? false;
  }

  static Flags get instance => _instance;
  static final Flags _instance = Flags._();
  Flags._();
}
