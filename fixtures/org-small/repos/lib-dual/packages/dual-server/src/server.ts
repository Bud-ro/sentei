// Started by `npm start` (`node dist/server.js`), the supabase postgres-meta layout: no
// main / exports, the runtime entry is build output that tsconfig outDir dist maps back here.
import { routeFor } from './routes';

// Expected: alive, no finding (not exported; called from the entry file top level).
function start(): void {
  console.log(routeFor('/'));
  // A bundler / worker input named relative to this file (bundled-worker.ts).
  console.log(new URL('./bundled-worker.ts', import.meta.url).href);
}

// Expected: private_dead already_unreachable (the package has runtime entries, so it is eligible).
function neverCalled(): number {
  return 2;
}

start();
