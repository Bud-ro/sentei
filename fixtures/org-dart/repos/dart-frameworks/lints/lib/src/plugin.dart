import 'package:analysis_server_plugin/plugin.dart';

// Expected: alive, no finding (reached from `plugin`).
class AcmePlugin extends Plugin {
  @override
  String get name => 'acme';
}
