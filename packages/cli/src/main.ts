#!/usr/bin/env node
// sentei CLI: parses arguments and dispatches to a stage. No logic lives here.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '@sentei/core/db';
import type { Stage, StageContext } from './context.ts';
import { analyze } from './stages/analyze.ts';
import { blame } from './stages/blame.ts';
import { discover } from './stages/discover.ts';
import { index } from './stages/index.ts';
import { ingest } from './stages/ingest.ts';
import { report } from './stages/report.ts';
import { witness } from './stages/witness.ts';

/** Pipeline order; `run` executes these in sequence. */
const STAGES: ReadonlyArray<readonly [string, Stage]> = [
  ['discover', discover],
  ['index', index],
  ['ingest', ingest],
  ['blame', blame],
  ['analyze', analyze],
  ['witness', witness],
  ['report', report],
];

const USAGE = `Usage: sentei <command> [options]

Commands:
  discover   List org repos and record packages + manifest deps
  index      Run SCIP indexers per package
  ingest     Load .scip files into the database
  blame      Record first-seen dates for exported symbols
  analyze    Compute reachability and verdicts
  witness    Text-search check for deletion candidates
  report     Write report.json / SARIF and print a summary
  run        Run all stages in order

Options:
  --work <dir>   Work directory (default: ./work)
  --db <file>    Database file (default: <work>/sentei.db)
  --org <name>     discover: GitHub org or user to list and shallow-clone
                   (token: GITHUB_TOKEN, GH_TOKEN, or \`gh auth token\`)
                   behind a proxy set NODE_USE_ENV_PROXY=1 (Node's fetch
                   ignores HTTPS_PROXY by default)
  --org-dir <dir>  discover: local org directory (org.json + repos/<name>/)
                   (exactly one of --org / --org-dir)
  --lockfile <file>     discover --org: pin repo head shas; read if it exists
                        (no API calls), else written after listing
  --update-lockfile     discover --org: relist and rewrite the lockfile
  --include <glob>      discover --org: only repos whose name matches (repeatable)
  --exclude <glob>      discover --org: skip repos whose name matches (repeatable)
  --include-forks       discover --org: keep forks (skipped by default: they are
                        usually other people's code and duplicate package names)
  --clones-dir <dir>    discover --org: where clones live (default: <work>/repos)
  --config-dir <dir>    discover --org: dir with the org sentei.json
                        (default: cwd if it has one, else defaults)
  --force        index: re-index repos even when cached for the same headSha
  --no-install   index: do not run npm ci / pnpm / yarn install
  --max-old-space-mb <n>  index: indexer heap limit in MB (default: 8192)
  -h, --help     Show this help
`;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        work: { type: 'string', default: './work' },
        db: { type: 'string' },
        'org-dir': { type: 'string' },
        org: { type: 'string' },
        lockfile: { type: 'string' },
        'update-lockfile': { type: 'boolean', default: false },
        include: { type: 'string', multiple: true, default: [] },
        exclude: { type: 'string', multiple: true, default: [] },
        'include-forks': { type: 'boolean', default: false },
        'clones-dir': { type: 'string' },
        'config-dir': { type: 'string' },
        force: { type: 'boolean', default: false },
        install: { type: 'boolean', default: true },
        'max-old-space-mb': { type: 'string', default: '8192' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowNegative: true,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (positionals.length > 1) {
    process.stderr.write(`unexpected arguments: ${positionals.slice(1).join(' ')}\n\n${USAGE}`);
    return 2;
  }

  const selected = command === 'run' ? STAGES : STAGES.filter(([name]) => name === command);
  if (selected.length === 0) {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }

  const maxOldSpaceMb = Number(values['max-old-space-mb']);
  if (!Number.isInteger(maxOldSpaceMb) || maxOldSpaceMb <= 0) {
    process.stderr.write(`--max-old-space-mb must be a positive integer\n\n${USAGE}`);
    return 2;
  }
  const indexOptions = { force: values.force, install: values.install, maxOldSpaceMb };

  const work = values.work;
  const dbPath = values.db ?? join(work, 'sentei.db');
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    const ctx: StageContext = { work, dbPath, db, log: (line) => process.stdout.write(`${line}\n`) };
    if (values['org-dir'] !== undefined) ctx.orgDir = values['org-dir'];
    if (values.org !== undefined) ctx.org = values.org;
    ctx.github = {
      updateLockfile: values['update-lockfile'],
      include: values.include,
      exclude: values.exclude,
      includeForks: values['include-forks'],
      ...(values.lockfile !== undefined ? { lockfile: values.lockfile } : {}),
      ...(values['clones-dir'] !== undefined ? { clonesDir: values['clones-dir'] } : {}),
      ...(values['config-dir'] !== undefined ? { configDir: values['config-dir'] } : {}),
    };
    for (const [name, stage] of selected) {
      await (name === 'index' ? index(ctx, indexOptions) : stage(ctx));
    }
  } finally {
    db.close();
  }
  return 0;
}

if (import.meta.main) {
  // A closed pipe (e.g. `sentei run | head`) is not an error worth a stack trace.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  process.exitCode = await main(process.argv.slice(2));
}
