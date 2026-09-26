// Test infrastructure in `tests/` (a TEST_GLOBS directory), used only by the test
// next to it: nothing here is ever private_dead. (It uses nothing from src/, so no
// export of @acme/core gains a test-only reference.)

// Expected: no finding (test file; module-exported only, used by tests/core.test.ts).
export function setupCore(): number {
  return seedValue() + 1;
}

// Expected: no finding (test file; reached only from setupCore).
function seedValue(): number {
  return 1;
}
