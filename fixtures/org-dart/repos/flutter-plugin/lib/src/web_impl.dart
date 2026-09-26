// The web implementation, re-exported by lib/acme_plugin.dart (the pubspec's
// `fileName`), like flame-engine gamepads_web's `GamepadsWeb`.

// Expected: alive, no finding (pubspec `flutter.plugin.platforms.web.pluginClass`;
// was DEPRECATE / ORG-DEAD in the flame-engine run).
class AcmePluginWeb {
  // Expected: alive, no finding (member of a live class).
  static void registerWith(Object registrar) => _log('web');
}

// Expected: alive, no finding (reached from registerWith).
void _log(String platform) => print('acme_plugin: $platform');
