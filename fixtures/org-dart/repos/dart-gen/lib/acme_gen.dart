// A library with a build_runner part that is not next to it: a `build_to: cache`
// builder (over_react's) wrote it to
// .dart_tool/build/generated/acme_gen/lib/acme_gen.g.dart, and the analyzer
// resolves the part from there (over_react_test on Workiva).
import 'src/settings_support.dart';

part 'acme_gen.g.dart';

// Expected: no finding (the main of a library is a runtime entry symbol).
void main() => print(_$parseSettings('mode=fast;level=2'));
