// Re-exported by lib/acme_x.dart with `show Shown`: Hidden is NOT on the surface.

// Expected: alive, no finding (external ref: acme_app constructs Shown() and reads label).
class Shown {
  // Expected: alive, no finding (member of a live class).
  final String label = 'shown';
}

// Expected: private_dead, reasons ["already_unreachable"]. Public name in lib/src/, but
// the only export of this file is `show Shown`, so Hidden is not on the surface and
// nothing reaches it. It must never be a deletion_candidate (it is not an export).
class Hidden {
  // Expected: no finding (member of Hidden; only the outermost dead declaration is reported).
  final String label = 'hidden';
}
