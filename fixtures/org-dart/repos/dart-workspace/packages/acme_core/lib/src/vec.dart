// Operators are used without naming anything: `a & b` never names `Vec2Ops`,
// `v + 1` never names `_Shift`. scip-dart emitted no reference for operator
// expressions (fork patch 9), so both looked unused.

// Expected: alive, no finding (external refs from acme_tools).
class Vec2 {
  // Expected: alive, no finding.
  final int x;
  // Expected: alive, no finding.
  final int y;
  const Vec2(this.x, this.y);
}

// Expected: alive, no finding. acme_tools uses its operators only (`&`, `%`, `[]`).
extension Vec2Ops on Vec2 {
  // Expected: alive, no finding (`a & b` in acme_tools).
  Vec2 operator &(Vec2 o) => Vec2(x & o.x, y & o.y);
  // Expected: alive, no finding (`a % 2` in acme_tools).
  Vec2 operator %(int n) => Vec2(x % n, y % n);
  // Expected: alive, no finding (`a[0]` in acme_tools).
  int operator [](int i) => i == 0 ? x : y;
}

// Expected: alive, no finding (private, reached from `shifted` through `v + d`).
extension _Shift on Vec2 {
  // Expected: alive, no finding.
  Vec2 operator +(int d) => Vec2(x + d, y + d);
}

// Expected: alive, no finding (external ref from acme_tools).
Vec2 shifted(Vec2 v, int d) => v + d;
