# Stand-in framework packages

Minimal stand-ins for `mason`, `dart_frog`, `pigeon` and `analysis_server_plugin`,
used by `repos/dart-frameworks` as `path:` dependencies so the fixture resolves
offline (CI has no pub cache). They are outside `repos/`, so discover never sees
them; only the declarations the fixture uses exist.
