import 'src/plugin.dart';

// Expected: no finding. The analysis server loads the top-level `plugin` of
// lib/main.dart (Baseflow a11y_linter: a false DEPRECATE row).
final plugin = AcmePlugin();
