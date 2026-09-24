// Package entry point for @acme/widgets (published-public: no "private" flag).
// §8: transitive export surface through `export *`.
export * from './internal';
// §8: re-export across org packages under an alias; keeps @acme/y#yThing alive.
export { yThing as widgetY } from '@acme/y';
export { Widget } from './widget';
export type { WidgetOptions } from './widget';
export { testOnlyFn, keptFn, namespaceUsed, namespaceUnused } from './misc';
