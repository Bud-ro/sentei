// Expected: alive, no finding (used by pre_gen.dart's `run`).
Map<String, dynamic> projectVars(String name) => {'project': name};

// Expected: private_dead, reasons ["already_unreachable"] (the hooks' own dead code
// still gets a verdict).
String staleVar() => 'stale';
