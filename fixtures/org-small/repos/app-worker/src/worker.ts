// The Worker entry (wrangler.jsonc `main`): a runtime entry point by convention.
import { lazyWidget } from '@acme/widgets/lazy';

// A declared namespace: its members are owned by it (parent), like class members.
// Expected: alive, no finding (Routes is used below; its members live with it).
namespace Routes {
  // Expected: alive, no finding (member of a live namespace).
  export const home = '/';
  // Expected: alive, no finding (member of a live namespace, kept through its owner).
  export function unusedRoute(): string {
    return '/old';
  }
}

// Expected: private_dead already_unreachable (only the namespace is reported, not its member).
namespace Legacy {
  // Expected: no finding (nested in the dead namespace Legacy, reported there).
  export function oldHandler(): number {
    return 1;
  }
}

// Expected: alive, no finding (called by the default export).
function handle(path: string): string {
  // Not a use of @acme/widgets' internalUnused: this file imports only the `./lazy` entry.
  const internalUnused = lazyWidget();
  return `${path}:${internalUnused}`;
}

// Expected: private_dead already_unreachable (the package has a runtime entry, so it is eligible).
function neverCalled(): number {
  return 2;
}

// Expected: alive, no finding (a Durable Object class named by wrangler.jsonc
// durable_objects.bindings[].class_name: instantiated by the runtime, never referenced).
export class Room {
  fetch(): string {
    return 'room';
  }
}

// Expected: alive, no finding (default export of a runtime entry: an entry symbol).
export default {
  fetch(): string {
    return handle(Routes.home);
  },
};
