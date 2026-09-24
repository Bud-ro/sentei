// Entry point of @acme/consumer. Exports nothing; every import below is a reference case.
import { internalUsed, widgetY } from '@acme/widgets'; // named import; export-star surface; aliased cross-package re-export
import * as W from '@acme/widgets'; // namespace import, member access below
import type { WidgetOptions } from '@acme/widgets'; // type-only import
import { deepThing } from '@acme/widgets/deep/thing'; // subpath import through an exports "*" pattern
import anon from '@acme/widgets/anon'; // anonymous export, imported by local name
import { yThing } from '@acme/y'; // direct named import of the aliased symbol
import { view } from './view';

// Expected: alive, no finding (not exported; called at the top level of the entry file).
async function main(): Promise<void> {
  const opts: WidgetOptions = { label: 'main' };
  const m = await import('@acme/widgets/lazy'); // dynamic import with a static string
  console.log(internalUsed(), widgetY(), yThing(), W.namespaceUsed(), deepThing(), m.lazyWidget(), anon(), opts.label, view);
}

main();
