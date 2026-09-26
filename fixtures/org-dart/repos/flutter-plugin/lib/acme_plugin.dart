// Entry library of acme_plugin (pubspec `fileName: acme_plugin.dart` for web).
// Phase 2 fix round 3: plugin classes named in pubspec.yaml are runtime entries.
export 'src/web_impl.dart';

// Expected: alive, no finding (pubspec `flutter.plugin.platforms.linux.dartPluginClass`).
class AcmePluginLinux {
  // Expected: alive, no finding (member of a live class).
  static void registerWith() {}
}

// Expected: deletion_candidate ["no_refs"] (exported, not a plugin class: negative).
class AcmePluginHelper {}
