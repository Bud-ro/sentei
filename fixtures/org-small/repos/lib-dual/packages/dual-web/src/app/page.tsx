// A Next.js app-router page under src/app (a runtime entry by the existing router convention).
import dynamic from 'next/dynamic';

// A lazily loaded component (docs.page's search dialog): SCIP links only the module;
// next/dynamic renders its default export.
const Dialog = dynamic(() => import('../components/dialog'));

// Expected: alive, no finding (the page component, loaded by Next).
export default function Page(): unknown {
  return Dialog;
}
