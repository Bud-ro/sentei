/// <reference path="./jsx.d.ts" />
// Non-entry module: re-exported by name from index.ts. The reference directive makes the
// JSX typing travel with this file into consumer programs (e.g. @acme/app-skew has none).

// Expected: alive, no finding (used as a JSX component `<Widget />` by @acme/consumer).
export function Widget(props: WidgetOptions): JSX.Element {
  return { tag: 'widget', text: props.label };
}

// Expected: alive, no finding (imported with `import type` by @acme/consumer).
export interface WidgetOptions {
  // Expected: alive, no finding (member; read by Widget, set by the JSX attribute in @acme/consumer).
  label: string;
}
