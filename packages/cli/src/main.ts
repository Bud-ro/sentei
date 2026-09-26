#!/usr/bin/env node
// sentei CLI: parses arguments and dispatches to a stage. No logic lives here.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { DEFAULT_POLICY, isPolicyKey, parseViews, setPolicyValue, type Policy, type ReportViewName } from '@sentei/core';
import { openDb } from '@sentei/core/db';
import type { GithubDiscoverOptions, Stage, StageContext } from './context.ts';
import { analyze } from './stages/analyze.ts';
import { blame } from './stages/blame.ts';
import { discover } from './stages/discover.ts';
import { index, type IndexSummary } from './stages/index.ts';
import { ingest } from './stages/ingest.ts';
import { report } from './stages/report.ts';
import { repos } from './stages/repos.ts';
import { witness } from './stages/witness.ts';

/** Pipeline order; `run` executes these in sequence. */
const STAGES: ReadonlyArray<readonly [string, Stage]> = [
  ['discover', discover],
  ['index', async (ctx) => void (await index(ctx))],
  ['ingest', ingest],
  ['blame', blame],
  ['analyze', analyze],
  ['witness', witness],
  ['report', report],
];

const USAGE = `Usage: sentei <command> [options]

Commands:
  repos      List an org's GitHub repos and whether discover would clone
             each one, with reasons (no cloning; --json for machine output)
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
  --lockfile <file>     discover/repos --org: listing, selection and pinned head
                        shas; read if it exists (no API calls), else written
                        after listing (default: <work>/<org>.lock.json)
  --update-lockfile     discover/repos --org: relist and rewrite the lockfile
  --include <glob>      discover/repos --org: always clone repos whose name
                        matches, past every other rule (repeatable)
  --exclude <glob>      discover/repos --org: never clone repos whose name
                        matches (repeatable; --include wins)
  --include-forks       discover/repos --org: keep forks (skipped by default:
                        usually other people's code, duplicate package names)
  --include-archived    discover/repos --org: keep archived repos
                        (org sentei.json "repos" holds the other selection
                        rules: languages, maxSizeMb, minPushed, probe)
  --clone-concurrency <n>  discover --org: parallel clones; blame: repos unshallowed
                           and blamed at once (default 8)
  --allow-clone-failures   discover --org: skip repos that fail to clone
                        (their packages are unknown) instead of failing
  --clones-dir <dir>    discover --org: where clones live (default: <work>/repos)
  --config-dir <dir>    discover/repos --org: dir with the org sentei.json
                        (default: cwd if it has one, else defaults)
  --json         repos: print JSON instead of a table; index: print the
                 end-of-run summary as JSON ({"summary": …}; progress on stderr)
  --force        index: re-index repos even when cached for the same headSha
  --retry-failed index/run: retry packages whose partial/failed result is
                 cached (a failure is reused while its inputs are unchanged:
                 head shas of the package and its org deps, toolchain, flags)
  --no-install   index: do not run npm ci / pnpm / yarn install
  --strict       index/run: exit 2 when any package failed to index (its
                 consumers' findings are blocked; run still writes the report)
  --max-old-space-mb <n>  index: heap limit in MB of each indexer and export-surface
                          child process, doubled once on heap exhaustion (default: 8192)
  --policy <key>=<json>   discover/run: override one org sentei.json policy key
                          (repeatable), e.g. --policy countTestsAsConsumers=true
                          --policy minAgeDays=0
  --view <name>[,name]    report/run: views printed and emitted in SARIF (repeatable):
                          delete, deprecate, org_dead, unexport, private_dead,
                          needs_review, blocked, version_skew (default: all on
                          stdout, all but org_dead in <work>/sarif/). With --view,
                          SARIF goes to <work>/sarif-<view>[,<view>]/ and the
                          default <work>/sarif/ is left alone; report.json always
                          has every view
  -q, --quiet    Print only warnings, errors and the report summary
  -v, --verbose  On error, print the full stack trace
  -h, --help     Show this help

Exit codes: 0 success, 1 a stage failed, 2 usage error or (--strict) a package
failed to index.
`;

/** Where main() writes; injectable for tests. */
export interface MainIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Tests only: GitHub fetch/token injection for discover and repos. */
  github?: Pick<GithubDiscoverOptions, 'fetchImpl' | 'token'>;
}

const PROCESS_IO: MainIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** Replace anything that looks like a GitHub credential with "***". */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const secret of [env['GITHUB_TOKEN'], env['GH_TOKEN']]) {
    if (secret !== undefined && secret.length >= 8) out = out.split(secret).join('***');
  }
  return out
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '***')
    .replace(/(x-access-token:)[^@\s'"]+/gi, '$1***')
    .replace(/(authorization:\s*(?:bearer|token|basic)\s+)[^\s'"]+/gi, '$1***');
}

/**
 * `sentei <stage>: <first line of the message>`, plus the stack with `verbose`.
 * A leading `sentei:` / `sentei <stage>:` in the message is dropped (core errors
 * carry one already). Secrets are redacted in both.
 */
export function formatError(stage: string, err: unknown, verbose: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const message = err instanceof Error ? err.message : String(err);
  const first = (message.split('\n')[0] ?? '').replace(/^sentei(?: [\w-]+)?: /, '');
  let out = `sentei ${stage}: ${first}\n`;
  if (verbose && err instanceof Error && err.stack !== undefined) out += `${err.stack}\n`;
  return redactSecrets(out, env);
}

/** Parse repeated `--policy key=value` (value is JSON); throws a usage message. */
export function parsePolicyOverrides(specs: readonly string[]): Partial<Policy> {
  const scratch: Policy = { ...DEFAULT_POLICY };
  const out: Partial<Policy> = {};
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq <= 0) throw new Error(`--policy ${JSON.stringify(spec)}: expected <key>=<json value>`);
    const key = spec.slice(0, eq);
    const raw = spec.slice(eq + 1);
    if (!isPolicyKey(key)) {
      throw new Error(`--policy: unknown key "${key}" (known: ${Object.keys(DEFAULT_POLICY).join(', ')})`);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`--policy ${key}: value ${JSON.stringify(raw)} is not JSON`);
    }
    try {
      setPolicyValue(scratch, key, value, '--policy');
    } catch (err) {
      throw new Error((err as Error).message.replace(/^sentei: /, ''));
    }
    (out as Record<string, unknown>)[key] = scratch[key];
  }
  return out;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** --quiet keeps warnings/errors and the report summary (report lines without a [report] prefix). */
function keepWhenQuiet(stage: string, line: string): boolean {
  if (/\bwarning\b|\berror\b|\bfail/i.test(line)) return true;
  return stage === 'report' && !line.startsWith('[');
}

export async function main(argv: readonly string[], io: MainIo = PROCESS_IO): Promise<number> {
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
        'include-forks': { type: 'boolean' },
        'include-archived': { type: 'boolean' },
        'clone-concurrency': { type: 'string' },
        'allow-clone-failures': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'clones-dir': { type: 'string' },
        'config-dir': { type: 'string' },
        force: { type: 'boolean', default: false },
        'retry-failed': { type: 'boolean', default: false },
        install: { type: 'boolean', default: true },
        strict: { type: 'boolean', default: false },
        'max-old-space-mb': { type: 'string', default: '8192' },
        policy: { type: 'string', multiple: true, default: [] },
        view: { type: 'string', multiple: true, default: [] },
        quiet: { type: 'boolean', short: 'q', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowNegative: true,
    });
  } catch (err) {
    return usageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  const command = positionals[0];

  function usageError(message: string): number {
    io.stderr(`${message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help || command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  if (command === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  if (positionals.length > 1) return usageError(`unexpected arguments: ${positionals.slice(1).join(' ')}`);

  const selected = command === 'run' ? STAGES : STAGES.filter(([name]) => name === command);
  if (selected.length === 0 && command !== 'repos') return usageError(`unknown command: ${command}`);

  let cloneConcurrency: number | undefined;
  if (values['clone-concurrency'] !== undefined) {
    cloneConcurrency = Number(values['clone-concurrency']);
    if (!Number.isInteger(cloneConcurrency) || cloneConcurrency < 1 || cloneConcurrency > 32) {
      return usageError('--clone-concurrency must be an integer from 1 to 32');
    }
  }
  if (values.json && command !== 'repos' && command !== 'index') return usageError('--json only applies to repos and index');
  if (values.strict && command !== 'index' && command !== 'run') return usageError('--strict only applies to index (and run)');
  if (values['retry-failed'] && command !== 'index' && command !== 'run') return usageError('--retry-failed only applies to index (and run)');
  const github: GithubDiscoverOptions = {
    updateLockfile: values['update-lockfile'],
    include: values.include,
    exclude: values.exclude,
    ...(values['include-forks'] !== undefined ? { includeForks: values['include-forks'] } : {}),
    ...(values['include-archived'] !== undefined ? { includeArchived: values['include-archived'] } : {}),
    ...(cloneConcurrency !== undefined ? { cloneConcurrency } : {}),
    ...(values['allow-clone-failures'] ? { allowCloneFailures: true } : {}),
    ...(values.lockfile !== undefined ? { lockfile: values.lockfile } : {}),
    ...(values['clones-dir'] !== undefined ? { clonesDir: values['clones-dir'] } : {}),
    ...(values['config-dir'] !== undefined ? { configDir: values['config-dir'] } : {}),
    ...io.github,
  };

  if (command === 'repos') {
    // No database: listing and selection only.
    if (values.policy.length > 0) return usageError('--policy only applies to discover (and run): policy is recorded in the DB at discover');
    try {
      await repos({
        work: values.work,
        json: values.json,
        github,
        ...(values.org !== undefined ? { org: values.org } : {}),
        ...(values['org-dir'] !== undefined ? { orgDir: values['org-dir'] } : {}),
        out: io.stdout,
        log: (line) => {
          if (!values.quiet || keepWhenQuiet('repos', line)) io.stderr(`${line}\n`);
        },
      });
    } catch (err) {
      io.stderr(formatError('repos', err, values.verbose));
      return 1;
    }
    return 0;
  }

  const maxOldSpaceMb = Number(values['max-old-space-mb']);
  if (!Number.isInteger(maxOldSpaceMb) || maxOldSpaceMb <= 0) {
    return usageError('--max-old-space-mb must be a positive integer');
  }
  const indexOptions = { force: values.force, retryFailed: values['retry-failed'], install: values.install, maxOldSpaceMb };
  let views: ReportViewName[] | undefined;
  try {
    views = values.view.length > 0 ? parseViews(values.view) : undefined;
  } catch (err) {
    return usageError((err as Error).message);
  }
  if (views !== undefined && views.length === 0) return usageError('--view: no view named');
  if (views !== undefined && !selected.some(([name]) => name === 'report')) {
    return usageError('--view only applies to report (and run): views filter the report, never the analysis');
  }

  let policyOverrides: Partial<Policy>;
  try {
    policyOverrides = parsePolicyOverrides(values.policy);
  } catch (err) {
    return usageError((err as Error).message);
  }
  if (values.policy.length > 0 && !selected.some(([name]) => name === 'discover')) {
    return usageError('--policy only applies to discover (and run): policy is recorded in the DB at discover');
  }

  const { quiet, verbose } = values;
  // index --json: stdout carries only the JSON summary; progress goes to stderr.
  const json = values.json && command === 'index';
  let current = command;
  const fail = (err: unknown): number => {
    io.stderr(formatError(current, err, verbose));
    return 1;
  };

  const work = values.work;
  const dbPath = values.db ?? join(work, 'sentei.db');
  let db;
  try {
    mkdirSync(work, { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    db = openDb(dbPath);
  } catch (err) {
    return fail(err);
  }
  try {
    const log = (line: string): void => {
      if (!quiet || keepWhenQuiet(current, line)) (json ? io.stderr : io.stdout)(`${line}\n`);
    };
    const ctx: StageContext = { work, dbPath, db, log };
    if (values['org-dir'] !== undefined) ctx.orgDir = values['org-dir'];
    if (values.org !== undefined) ctx.org = values.org;
    if (values.policy.length > 0) ctx.policyOverrides = policyOverrides;
    ctx.github = github;
    const t0 = performance.now();
    const took: string[] = [];
    let indexSummary: IndexSummary | undefined;
    for (const [name, stage] of selected) {
      current = name;
      const start = performance.now();
      if (name === 'index') indexSummary = await index(ctx, indexOptions);
      else await (name === 'report' ? report(ctx, views !== undefined ? { views } : {}) : stage(ctx));
      const ms = performance.now() - start;
      took.push(`${name} ${seconds(ms)}`);
      if (!quiet) (json ? io.stderr : io.stdout)(`[${name}] done in ${seconds(ms)}\n`);
    }
    if (command === 'run' && !quiet) {
      io.stdout(`[run] done in ${seconds(performance.now() - t0)} (${took.join(', ')})\n`);
    }
    if (json && indexSummary !== undefined) io.stdout(`${JSON.stringify({ summary: indexSummary }, null, 2)}\n`);
    if (values.strict && indexSummary !== undefined && indexSummary.failed > 0) {
      io.stderr(`sentei ${command}: --strict: ${indexSummary.failed} package(s) failed to index: ${
        indexSummary.failures.map((f) => f.packageId).join(', ')}\n`);
      return 2;
    }
  } catch (err) {
    return fail(err);
  } finally {
    try {
      db.close();
    } catch {
      // Closing cannot make a failed run worse; the stage error (if any) is what matters.
    }
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
