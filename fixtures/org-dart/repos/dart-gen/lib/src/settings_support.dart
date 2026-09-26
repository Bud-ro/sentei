// Not exported: used only by the generated part of lib/acme_gen.dart.

// Expected: alive, no finding. Its only reference is in the generated part under
// .dart_tool/build/generated/ (fork patch 13 indexes it; without, private_dead).
Map<String, String> splitSettingPairs(String text) => {
      for (final pair in text.split(';'))
        if (pair.contains('=')) pair.split('=').first: pair.split('=').last,
    };
