// Export-surface worker: runs `computeExportSurface` (and the consumer checks
// that share its TypeScript programs) in a child process, one per package, so
// the programs of every package are freed with the process and the
// orchestrator's heap stays flat across an org (the first unjs run died at
// ~4 GB when they all ran in-process).
//
// Protocol: a `SurfaceJob` as JSON on stdin. The worker writes the sidecar to
// `job.sidecarFile` itself (it can be large; the parent never parses it) and
// prints a `SurfaceWorkerResult` as JSON on stdout. Any failure is an uncaught
// exception: non-zero exit, stack on stderr.
//
//   node --max-old-space-size=<mb> surface-worker.ts < job.json
import { readFileSync, writeFileSync } from 'node:fs';
import { computeExportSurface, type ExportSurfaceInput } from './export-surface.ts';

/** `ExportSurfaceInput` in JSON form (sets as arrays). */
export interface SurfaceJob {
  input: Omit<ExportSurfaceInput, 'orgPackageNames'> & { orgPackageNames: string[] };
  /** Absolute path the sidecar JSON is written to. */
  sidecarFile: string;
}

export interface SurfaceWorkerResult {
  diagnostics: string[];
  partial: boolean;
}

export function runJob(job: SurfaceJob): SurfaceWorkerResult {
  const surface = computeExportSurface({ ...job.input, orgPackageNames: new Set(job.input.orgPackageNames) });
  writeFileSync(job.sidecarFile, `${JSON.stringify(surface.sidecar, null, 2)}\n`);
  return { diagnostics: surface.diagnostics, partial: surface.partial };
}

if (import.meta.main) {
  const job = JSON.parse(readFileSync(0, 'utf8')) as SurfaceJob;
  process.stdout.write(`${JSON.stringify(runJob(job))}\n`);
}
