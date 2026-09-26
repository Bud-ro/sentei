// Expected: alive, no finding (external refs from acme_tools).
class Vec2 {
  // Expected: alive, no finding.
  final int x;
  // Expected: alive, no finding.
  final int y;
  const Vec2(this.x, this.y);
}

// Expected: alive, no finding (external ref from acme_tools).
Vec2 shifted(Vec2 v, int d) => Vec2(v.x + d, v.y + d);
