# Pending fixture: conditional export (not asserted yet)

Not part of the org: nothing under `pending/` is in `org.json` or `repos/`, so
the tests never index it. It is ready for the ingest change described in
`docs/DESIGN.md` ("Phase 2 fix round 3", open item: conditional exports).

`repos/` here overlays `fixtures/org-dart/repos/`:

| File | Role |
| --- | --- |
| `dart-workspace/packages/acme_core/lib/platform.dart` (new) | public library: `export 'src/platform_stub.dart' if (dart.library.io) 'src/platform_io.dart' if (dart.library.js_interop) 'src/platform_web.dart';` |
| `dart-workspace/packages/acme_core/lib/src/platform_{stub,io,web}.dart` (new) | each declares `platformName()`; the io variant calls a private `_ioDetail()` |
| `dart-workspace/packages/acme_tools/lib/src/cli.dart` (replaces) | the existing file plus `import 'package:acme_core/platform.dart';` and `print(platformName());` |

Today (adapter `1.7.0+sentei.10`, checked with `sentei run` on org-dart plus
this overlay) the report has three extra rows, all wrong:

```
pub:acme/dart-workspace:acme_core platformName packages/acme_core/lib/src/platform_io.dart  private_dead ["already_unreachable"]
pub:acme/dart-workspace:acme_core _ioDetail    packages/acme_core/lib/src/platform_io.dart  private_dead ["already_unreachable"]
pub:acme/dart-workspace:acme_core platformName packages/acme_core/lib/src/platform_web.dart private_dead ["already_unreachable"]
```

Once ingest puts the alternatives of a conditional export on the export
surface, the expected findings of org-dart are unchanged (every symbol here is
alive). To enable: copy `repos/` over `fixtures/org-dart/repos/`, regenerate the
snapshots (`npm run snapshots:update`), and delete this directory.
