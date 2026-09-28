import 'package:mason/mason.dart';

import 'lib/src/vars.dart';

// Expected: no finding. mason runs `run(HookContext)` of hooks/pre_gen.dart by
// convention (VeryGoodOpenSource: 7 false DELETE rows in very_good_cli's hooks).
Future<void> run(HookContext context) async {
  context.vars.addAll(projectVars(context.vars['name'] as String));
}
