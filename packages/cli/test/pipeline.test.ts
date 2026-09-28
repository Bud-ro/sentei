// M1 acceptance test (PLAN.md §10): the whole pipeline on a temp copy of
// fixtures/org-small must reproduce expected-findings.json EXACTLY. The expected file
// holds the base verdicts; the report views (delete / deprecate / legacy org_dead / …)
// are filters over them, checked here on the same run (no second analysis). Policy
// closedOrg is checked on the same index too (discover again, no re-index).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@sentei/core/db';
import { CLOSED_ORG_ASSERTION, ORG_DEAD_ASSERTION, type Report, type SarifLog } from '@sentei/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { StageContext } from '../src/context.ts';
import { analyze } from '../src/stages/analyze.ts';
import { discover } from '../src/stages/discover.ts';
import { index } from '../src/stages/index.ts';
import { ingest } from '../src/stages/ingest.ts';
import { report, sarifDirFor } from '../src/stages/report.ts';
import { witness } from '../src/stages/witness.ts';
import { sarifSchemaErrors } from '../../core/test/helpers/sarif.ts';
import { dropFlutterRepos, FLUTTER_REPOS, hasFlutter } from '../../../scripts/update-snapshots.ts';

const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures');
const NO_NODE_MODULES = { recursive: true, filter: (src: string) => path.basename(src) !== 'node_modules' };

interface ExpectedRow {
  package_id: string;
  symbol: string;
  file: string;
  verdict: string;
  reasons: string[];
  blocked_by?: string[];
}

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

/** Copy fixtures/<name> (minus node_modules) into a fresh temp dir; returns the copy's path. */
function copyFixture(name: string): string {
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'sentei-pipeline-')));
  tmps.push(tmp);
  const org = path.join(tmp, name);
  cpSync(path.join(FIXTURES, name), org, NO_NODE_MODULES);
  return org;
}

async function withCtx<T>(orgDir: string, fn: (ctx: StageContext, lines: string[]) => Promise<T>): Promise<T> {
  const work = path.join(path.dirname(orgDir), 'work');
  mkdirSync(work, { recursive: true });
  const dbPath = path.join(work, 'sentei.db');
  const db = openDb(dbPath);
  const lines: string[] = [];
  try {
    return await fn({ work, dbPath, db, orgDir, log: (l) => lines.push(l) }, lines);
  } finally {
    db.close();
  }
}

/** Run every stage and return report.json mapped to the expected-findings row shape. */
async function runPipeline(orgDir: string): Promise<{ rows: ExpectedRow[]; report: Report; lines: string[]; work: string }> {
  return withCtx(orgDir, async (ctx, lines) => {
    await discover(ctx);
    await index(ctx, { install: false });
    await ingest(ctx);
    await analyze(ctx);
    await witness(ctx);
    await report(ctx);
    const r = JSON.parse(readFileSync(path.join(ctx.work, 'report.json'), 'utf8')) as Report;
    const rows: ExpectedRow[] = [
      ...r.findings.map((f) => ({
        package_id: f.package_id,
        symbol: f.symbol,
        file: f.file,
        verdict: f.verdict,
        reasons: f.reasons,
        ...(f.blocked_by.length > 0 ? { blocked_by: f.blocked_by } : {}),
      })),
      ...r.versionSkew.map((v) => ({
        package_id: v.package_id,
        symbol: v.symbol,
        file: v.file,
        verdict: 'version_skew',
        reasons: [`target:${v.target_package_id}`],
      })),
    ];
    return { rows: sortRows(rows), report: r, lines, work: ctx.work };
  });
}

function sortRows(rows: ExpectedRow[]): ExpectedRow[] {
  const key = (r: ExpectedRow): string[] => [r.package_id, r.symbol, r.verdict, r.file];
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  });
}

function expected(file: string): ExpectedRow[] {
  return sortRows(JSON.parse(readFileSync(path.join(FIXTURES, 'org-small', file), 'utf8')) as ExpectedRow[]);
}

/** Every SARIF result of every repo log in <work>/<sub> (default: the default set in sarif/). */
function allSarifResults(work: string, sub = 'sarif'): Array<{ ruleId: string; symbol: unknown; message: string; log: SarifLog }> {
  const dir = path.join(work, sub);
  return readdirSync(dir).sort().flatMap((f) => {
    const log = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as SarifLog;
    return log.runs[0]!.results.map((x) => ({ ruleId: x.ruleId, symbol: x.properties.symbol, message: x.message.text, log }));
  });
}

describe('M1 acceptance: full pipeline on fixtures/org-small', () => {
  it('matches expected-findings.json exactly; views filter the same findings; --view limits stdout and SARIF', async () => {
    const org = copyFixture('org-small');
    const { rows, report: r, lines, work } = await runPipeline(org);
    expect(r.policy).not.toHaveProperty('assumeClosedWorld');
    expect(r.warnings.some((w) => w.includes('assumeClosedWorld'))).toBe(false);
    expect(rows).toEqual(expected('expected-findings.json'));
    // Fix round 4: dual-server's bundled-worker.ts is named only by `new URL('./bundled-worker.ts',
    // import.meta.url)` in server.ts; a runtime entry, so its top-level call keeps handleJob alive.
    expect(rows.filter((x) => x.symbol === 'handleJob')).toEqual([]);
    // Fix round 6: webpack entries. dual-webpack's `entry: './src/app.js'` and dual-electron's
    // default ./src/index.js (loaded as dist/main.js by an inline require in the index.html
    // that main.js opens with loadFile) keep their helpers alive; only the unused ones are dead.
    expect(rows.filter((x) => ['renderPage', 'formatTitle', 'rendererBanner'].includes(x.symbol))).toEqual([]);
    // Fix round 8c. app-vite: an `@/` alias from a .vue file (fetchUser), a <script src>
    // (legacyInit), an import.meta.glob match (homePage, pageTitle) and a module-level
    // statement of a loaded module (refreshToken) keep their code alive; authDead and
    // viteDead stay private_dead (expected-findings). app-astro: since fix round 8e its
    // astro.config.mjs makes src/pages/rss.ts (and the config) runtime entries, so its entry
    // set is credible: src/lib/orphan.ts, which nothing loads, is private_dead (before, a
    // skipped note); what its pages load stays alive.
    expect(rows.filter((x) => ['fetchUser', 'legacyInit', 'homePage', 'pageTitle', 'refreshToken', 'mountApp'].includes(x.symbol))).toEqual([]);
    expect(rows.filter((x) => x.package_id === 'npm:acme/app-astro:@acme/app-astro').map((x) => [x.symbol, x.verdict]))
      .toEqual([['orphanHelper', 'private_dead']]);
    expect(r.packages.find((p) => p.package_id === 'npm:acme/app-astro:@acme/app-astro')?.private_dead_skipped).toBeUndefined();
    expect(r.packages.find((p) => p.package_id === 'npm:acme/app-vite:@acme/app-vite')?.private_dead_skipped).toBeUndefined();
    // Fix round 8e (repo frameworks): what a framework, a bundler, jscodeshift, Firebase /
    // terraform, Metro or an Electron window loads by path or by name has no row; only the
    // one dead helper per package is private_dead (bundled / rn-lib / cloudfn's unused
    // exports are deletion candidates: their surface now resolves, nothing blocks them).
    // Fix round 8f: the dist-layout @acme/distlayout resolves too (its unused `.` and `./pg`
    // exports are deletion candidates, `pgTable` is used through `@acme/distlayout/pg`).
    expect(rows.filter((x) => [
      'footerText', 'slugify', 'remarkPlugin', 'Footer', 'Home', 'sidebars', 'themeClass', 'useCounter', 'clamp', 'handler',
      'transform', 'parser', 'renameIdentifier', 'ping', 'onSignup', 'translateText', 'Button', 'buttonLabel', 'drawSheet', 'sheetSize',
    ].includes(x.symbol) && x.package_id.startsWith('npm:acme/frameworks:'))).toEqual([]);
    expect(rows.filter((x) => x.package_id.startsWith('npm:acme/frameworks:')).map((x) => `${x.symbol} ${x.verdict}`)).toEqual([
      'bundledMain deletion_candidate', 'internalApi deletion_candidate', 'serverEntry deletion_candidate', 'cloudfnUnused deletion_candidate',
      'codemodDead private_dead',
      'distRootUnused deletion_candidate', 'pgUnused deletion_candidate', 'tableHelperDead private_dead',
      'docsDead private_dead', 'rendererDead private_dead', 'functionsDead private_dead', 'nuxtDead private_dead',
      'renderButton deletion_candidate', 'rnDead private_dead', 'themeDead private_dead',
    ]);
    // rn-lib's android/ and ios/ native code does not make it an unindexed consumer of @acme/core,
    // and the Nx generator template (`"name": "<%= name %>"`) is no package.
    expect(r.blockers.some((b) => b.blocker_package_id.startsWith('npm:acme/frameworks:'))).toBe(false);
    expect(r.packages.some((p) => p.name.includes('<%'))).toBe(false);
    // Fix round 9a: @acme/expo-plugin's app.plugin.js (`module.exports = require('./plugin/build')`,
    // an exports leaf outside the tsconfig program) is an Expo config plugin loaded by path,
    // whose source is plugin/src/index.ts: the package is not opaque and blocks nothing
    // (before, its `default` export was unresolved surface and it blocked @acme/core).
    const expo = r.packages.find((p) => p.name === '@acme/expo-plugin');
    expect(expo?.opaque).toBe(false);
    expect(expo?.flags).toEqual([]);
    // Consumer-only packages without entry points (the nameless demos, the promoted example
    // app) never had private_dead rows either; the note now says so.
    expect(r.packages.filter((p) => p.private_dead_skipped !== undefined).map((p) => p.name)).toEqual([
      '_unnamed/unnamed-demo', '_unnamed/unnamed-demo-2', '@acme/sample-app',
    ]);
    expect(lines.find((l) => l.includes('private_dead skipped'))).toMatch(
      /^ {2}\(private_dead skipped for 3 package\(s\) whose entry points sentei cannot see; \d+ unreachable private symbol\(s\) not reported: _unnamed\/unnamed-demo \(no known entry points\), /);
    await withCtx(org, async (ctx) => {
      expect(ctx.db.prepare(`SELECT package_id, file, module, resolved FROM unindexed_loads
        WHERE package_id LIKE 'npm:acme/app-%' ORDER BY package_id, file, module`).all()).toEqual([
        { package_id: 'npm:acme/app-astro:@acme/app-astro', file: 'astro.config.mjs', module: 'src/pages/rss.ts', resolved: 1 },
        { package_id: 'npm:acme/app-astro:@acme/app-astro', file: 'src/pages/index.astro', module: 'src/content/first.ts', resolved: 1 },
        { package_id: 'npm:acme/app-astro:@acme/app-astro', file: 'src/pages/index.astro', module: 'src/lib/feed.ts', resolved: 1 },
        { package_id: 'npm:acme/app-astro:@acme/app-astro', file: 'src/pages/index.astro', module: 'src/lib/posts.ts', resolved: 1 },
        { package_id: 'npm:acme/app-vite:@acme/app-vite', file: 'src/components/Legacy.vue', module: 'src/components/legacy.ts', resolved: 1 },
        { package_id: 'npm:acme/app-vite:@acme/app-vite', file: 'src/components/Profile.vue', module: 'src/api/client.ts', resolved: 1 },
        { package_id: 'npm:acme/app-vite:@acme/app-vite', file: 'src/main.ts', module: 'src/pages/home.ts', resolved: 1 },
      ]);
    });

    // Fix round 3. @acme/dual-script's runtime entries outside its tsconfig program
    // (a `node scripts/serve.mjs` start script, next.config.mjs, a CommonJS bin) are
    // indexed through the runtime tsconfig and never make it opaque; the nameless
    // unnamed-demo manifest is a consumer-only package (a bare nameless marker is
    // not: manifests.test.ts).
    await withCtx(org, async (ctx) => {
      // Phase 3 decision 3: samples' examples/app (another repo than @acme/core) is a
      // promoted consumer package, indexed; its files under examples/ are not docs files,
      // so its use of usedFn is a counted external reference.
      expect(ctx.db.prepare("SELECT package_id, reason FROM promoted_packages").all()).toEqual([
        { package_id: 'npm:acme/samples:@acme/sample-app', reason: 'example app depends on npm:acme/lib-core:@acme/core (repo acme/lib-core)' },
      ]);
      expect(r.repos.find((x) => x.repo === 'acme/samples')?.index_status).toBe('ok');
      expect(ctx.db.prepare("SELECT file FROM doc_files WHERE package_id = 'npm:acme/samples:@acme/sample-app'").all()).toEqual([]);
      expect(ctx.db.prepare(`SELECT s.name, e.n FROM external_refs e JOIN symbols s USING (symbol_id)
        WHERE e.consumer_package_id = 'npm:acme/samples:@acme/sample-app' AND s.name = 'usedFn'`).all())
        .toEqual([{ name: 'usedFn', n: 2 }]);
      const flags = ctx.db.prepare(`SELECT flag, reason FROM package_flags WHERE package_id = 'npm:acme/lib-dual:@acme/dual-script'`).all();
      expect(flags).toEqual([]);
      const docs = ctx.db.prepare(`SELECT file, is_entry FROM documents WHERE package_id = 'npm:acme/lib-dual:@acme/dual-script' ORDER BY file`).all();
      expect(docs).toEqual(expect.arrayContaining([
        { file: 'packages/dual-script/scripts/serve.mjs', is_entry: 1 },
        { file: 'packages/dual-script/next.config.mjs', is_entry: 1 },
        { file: 'packages/dual-script/bin/cli.cjs', is_entry: 1 },
      ]));
      const entries = (id: string): unknown => JSON.parse((ctx.db.prepare('SELECT entry_points FROM packages WHERE package_id = ?').get(id) as { entry_points: string }).entry_points);
      expect(entries('npm:acme/lib-dual:@acme/dual-webpack')).toEqual(['packages/dual-webpack/src/app.js']);
      expect(entries('npm:acme/lib-dual:@acme/dual-electron')).toEqual([
        'packages/dual-electron/main.js', 'packages/dual-electron/renderer.js', 'packages/dual-electron/src/index.js',
      ]);
      expect(ctx.db.prepare(`SELECT package_id, name, visibility, is_library FROM packages WHERE repo = 'acme/lib-dual' AND name LIKE '\\_unnamed/%' ESCAPE '\\'`).all())
        .toEqual([
          { package_id: 'npm:acme/lib-dual:_unnamed/unnamed-demo', name: '_unnamed/unnamed-demo', visibility: 'private', is_library: 0 },
          { package_id: 'npm:acme/lib-dual:_unnamed/unnamed-demo-2', name: '_unnamed/unnamed-demo-2', visibility: 'private', is_library: 0 },
        ]);
      // Fix round 4: both nameless packages' `npm . . src/\`main.ts\`/localHelper().` are
      // their own symbols (anonymousSymbolKey), each used only by its own package.
      const unnamed = ctx.db.prepare(`SELECT s.package_id, s.symbol_str,
          (SELECT group_concat(DISTINCT o.package_id) FROM occurrences o WHERE o.symbol_id = s.symbol_id) AS users
        FROM symbols s WHERE s.package_id LIKE 'npm:acme/lib-dual:\\_unnamed/%' ESCAPE '\\' AND s.name = 'localHelper' ORDER BY s.package_id`).all();
      expect(unnamed).toEqual([
        { package_id: 'npm:acme/lib-dual:_unnamed/unnamed-demo', users: 'npm:acme/lib-dual:_unnamed/unnamed-demo',
          symbol_str: 'scip-typescript npm _unnamed/unnamed-demo npm:acme/lib-dual:_unnamed/unnamed-demo src/`main.ts`/localHelper().' },
        { package_id: 'npm:acme/lib-dual:_unnamed/unnamed-demo-2', users: 'npm:acme/lib-dual:_unnamed/unnamed-demo-2',
          symbol_str: 'scip-typescript npm _unnamed/unnamed-demo-2 npm:acme/lib-dual:_unnamed/unnamed-demo-2 src/`main.ts`/localHelper().' },
      ]);
      expect(ctx.db.prepare(`SELECT count(*) AS n FROM edges e JOIN packages a ON a.package_id = e.from_package_id
        JOIN packages b ON b.package_id = e.to_package_id
        WHERE e.from_package_id <> e.to_package_id AND a.name LIKE '\\_unnamed/%' ESCAPE '\\' AND b.name LIKE '\\_unnamed/%' ESCAPE '\\'`).get())
        .toEqual({ n: 0 });
    });
    expect(lines.some((l) => l.includes('claimed as their own by two packages'))).toBe(false);
    expect(existsSync(path.join(org, 'repos/lib-dual/packages/dual-script/tsconfig.sentei-runtime.json'))).toBe(false);

    // Fix round 8d. dual-cli's bin imports its own unbuilt `../dist/cli.mjs` and
    // `import('../dist/tasks.js')`: mapped to src/, the names it takes are runtime entry
    // symbols it references (runCli: no DEPRECATE / deletion; runTasks and its helper:
    // not private_dead). dual-integration's `serverEntrypoint: '@acme/dual-integration/server.js'`
    // makes src/server.ts's exports runtime entries. Neither package is opaque.
    expect(rows.filter((x) => ['runCli', 'cliHelper', 'runTasks', 'taskHelper', 'renderToStaticMarkup', 'check', 'render'].includes(x.symbol))).toEqual([]);
    await withCtx(org, async (ctx) => {
      expect(ctx.db.prepare(`SELECT package_id, flag FROM package_flags WHERE package_id IN
        ('npm:acme/lib-dual:@acme/dual-cli', 'npm:acme/lib-dual:@acme/dual-integration')`).all()).toEqual([]);
      expect(ctx.db.prepare(`SELECT s.name, e.kind FROM entry_symbols e JOIN symbols s USING (symbol_id)
        WHERE s.package_id IN ('npm:acme/lib-dual:@acme/dual-cli', 'npm:acme/lib-dual:@acme/dual-integration') ORDER BY s.name`).all()).toEqual([
        { name: 'check', kind: 'runtime' }, { name: 'renderToStaticMarkup', kind: 'runtime' }, { name: 'runCli', kind: 'runtime' }, { name: 'runTasks', kind: 'runtime' },
      ]);
      // The bin's references (shorthandRefs) landed from its document.
      expect(ctx.db.prepare(`SELECT s.name, o.file FROM occurrences o JOIN symbols s USING (symbol_id)
        WHERE s.name IN ('runCli', 'runTasks') AND (o.role & 1) = 0 AND o.file LIKE '%/bin/cli.mjs' ORDER BY s.name`).all()).toEqual([
        { name: 'runCli', file: 'packages/dual-cli/bin/cli.mjs' }, { name: 'runTasks', file: 'packages/dual-cli/bin/cli.mjs' },
      ]);
    });

    // Views: filters over the base findings.
    const names = (xs: Array<{ package_id: string; symbol: string }>): string[] => xs.map((f) => `${f.package_id}#${f.symbol}`);
    const widgets = 'npm:acme/lib-widgets:@acme/widgets';
    expect(r.views.delete.rows.every((f) => f.verdict === 'deletion_candidate')).toBe(true);
    expect(names(r.views.delete.rows)).toContain('npm:acme/lib-core:@acme/core#unusedFn');
    expect(names(r.views.deprecate.rows)).toEqual([
      `${widgets}#default`, `${widgets}#internalUnused`, `${widgets}#namespaceUnused`, `${widgets}#testOnlyFn`,
    ]);
    // Fix round 9a: the legacy org_dead is not in the default report.json (view nor counts).
    expect(r.views.org_dead).toBeUndefined();
    expect(r.packages.every((p) => !('org_dead' in p.counts))).toBe(true);
    expect(r.views.deprecate.assertion).toBeUndefined();
    expect(names(r.views.private_dead.rows)).not.toContain(`${widgets}#unusedHelper`);
    expect(names(r.views.unexport.rows)).toContain('npm:acme/lib-core:@acme/core#internalOnlyFn');
    expect(r.packages.find((p) => p.package_id === widgets)).toMatchObject({ private: false, counts: { delete: 0, deprecate: 4 } });

    // Default stdout: every view but the legacy org_dead (no column, line or footnote).
    expect(lines.some((l) => /^ {2}DEPRECATE +4\b/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('ORG-DEAD'))).toBe(false);
    expect(lines.some((l) => l.includes(ORG_DEAD_ASSERTION))).toBe(false);
    expect(lines).toContain('policy: minAgeDays=0 trustPrivateRegistry=true countTestsAsConsumers=false countDocsAsConsumers=false closedOrg=false');
    expect(r.assertions).toEqual([]);

    // M5: one SARIF log per repo, schema-valid; default views: all but org_dead.
    for (const { repo } of r.repos) {
      expect(existsSync(path.join(work, 'sarif', `${repo.replaceAll('/', '__')}.sarif`)), repo).toBe(true);
    }
    const sarif = JSON.parse(readFileSync(path.join(work, 'sarif', 'acme__lib-core.sarif'), 'utf8')) as SarifLog;
    expect(sarifSchemaErrors(sarif)).toEqual([]);
    expect(sarif.runs[0]!.properties.assertions).toEqual([]);
    expect(sarif.runs[0]!.results.some((x) => x.ruleId === 'sentei/delete' && x.properties.symbol === 'unusedFn'
      && x.locations[0]!.physicalLocation.artifactLocation.uri === 'src/fns.ts')).toBe(true);
    const byDefault = allSarifResults(work);
    expect(byDefault.some((x) => x.ruleId === 'sentei/org-dead')).toBe(false);
    expect(byDefault.filter((x) => x.ruleId === 'sentei/deprecate').map((x) => x.symbol).sort())
      .toEqual(['default', 'internalUnused', 'namespaceUnused', 'testOnlyFn']);

    // report --view org_dead: the same DB, no re-analysis; only org-dead results, in
    // <work>/sarif-org_dead/. The default set keeps its content; report.json gains the
    // org_dead view (and its counts), nothing else changes.
    const readDir = (dir: string): Record<string, string> =>
      Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));
    const defaultFiles = readDir(path.join(work, 'sarif'));
    const fullReport = JSON.parse(readFileSync(path.join(work, 'report.json'), 'utf8')) as Report;
    const filtered = await withCtx(org, async (ctx, out) => {
      await report(ctx, { views: ['org_dead'] });
      return out;
    });
    expect(sarifDirFor(work, ['org_dead'])).toBe(path.join(work, 'sarif-org_dead'));
    expect(sarifDirFor(work, ['delete', 'org_dead'])).toBe(path.join(work, 'sarif-delete,org_dead'));
    expect(readDir(path.join(work, 'sarif'))).toEqual(defaultFiles);
    const after = JSON.parse(readFileSync(path.join(work, 'report.json'), 'utf8')) as Report;
    expect(after.views.org_dead.rows).toEqual(r.views.deprecate.rows);
    expect(after.views.org_dead.assertion).toBe(ORG_DEAD_ASSERTION);
    // widgets' unusedHelper is dead only once internalUnused is deleted: org_dead only.
    expect(names(after.views.org_dead.private_dead)).toEqual([`${widgets}#unusedHelper`]);
    expect(after.packages.find((p) => p.package_id === widgets)!.counts['org_dead']).toBe(5);
    const withoutOrgDead = (x: Report): unknown => ({
      ...x, generatedAt: 0, generatedAtIso: '', views: { ...x.views, org_dead: undefined },
      packages: x.packages.map((p) => ({ ...p, counts: { ...p.counts, org_dead: undefined } })),
    });
    expect(withoutOrgDead(after)).toEqual(withoutOrgDead(fullReport));
    expect(filtered).toContain(`[report] wrote ${path.join(work, 'report.json')} (full report: every view, the legacy org_dead included)`);
    expect(filtered).toContain(`[report] wrote ${r.repos.length} SARIF log(s) (5 result(s), views: org_dead) to ${path.join(work, 'sarif-org_dead')}`);
    expect(filtered).toContain(`[report] --view: the default SARIF set in ${path.join(work, 'sarif')} was left as it was`);
    const orgDead = allSarifResults(work, 'sarif-org_dead');
    expect(orgDead.map((x) => x.ruleId).every((id) => id === 'sentei/org-dead')).toBe(true);
    expect(orgDead.map((x) => x.symbol).sort()).toEqual(['default', 'internalUnused', 'namespaceUnused', 'testOnlyFn', 'unusedHelper']);
    expect(orgDead.every((x) => x.message.endsWith(`Assertion: ${ORG_DEAD_ASSERTION}`))).toBe(true);
    const widgetsLog = orgDead[0]!.log;
    expect(sarifSchemaErrors(widgetsLog)).toEqual([]);
    expect(widgetsLog.runs[0]!.properties.views).toEqual(['org_dead']);
    expect(widgetsLog.runs[0]!.properties.assertions).toEqual([{ view: 'org_dead', text: ORG_DEAD_ASSERTION }]);
    expect(filtered).toContain('views: org_dead');
    expect(filtered.some((l) => l.startsWith('PACKAGE ') && !l.includes('DELETE'))).toBe(true);
    expect(filtered.some((l) => /^ {2}ORG-DEAD/.test(l))).toBe(true);
    expect(filtered.some((l) => /^ {2}(DELETE|DEPRECATE|UNEXPORT)\b/.test(l))).toBe(false);
    expect(filtered.some((l) => l.startsWith('Top blockers') || l.startsWith('Version skew'))).toBe(false);

    // Policy closedOrg on the same index: discover (with --policy closedOrg=true), index
    // (all cached: no re-index), ingest, analyze, witness, report. The published
    // package's would-be deletions become deletion_candidate (through the witness), its
    // unexport a plain unexport, the helper they unlock private_dead; nothing else moves.
    const closed = await withCtx(org, async (ctx, out) => {
      ctx.policyOverrides = { closedOrg: true };
      await discover(ctx);
      await index(ctx, { install: false });
      await ingest(ctx);
      await analyze(ctx);
      await witness(ctx);
      await report(ctx);
      return { out, r: JSON.parse(readFileSync(path.join(ctx.work, 'report.json'), 'utf8')) as Report };
    });
    // (The fixture repos are not checkouts, so the index cache cannot apply here and index
    // runs again; that closedOrg never invalidates a cached index is index.test.ts's
    // failureInputHash test.)
    expect(closed.r.policy.closedOrg).toBe(true);
    expect(closed.r.assertions).toEqual([{ policy: 'closedOrg', text: CLOSED_ORG_ASSERTION }]);
    const published = new Set(r.packages.filter((p) => !p.private).map((p) => p.package_id));
    const flipped = r.findings.map((f) => ({
      ...f,
      verdict: f.verdict === 'deprecation_candidate' && published.has(f.package_id)
        ? (f.reasons.includes('internal_refs_only') && !f.reasons.includes('dead_island') ? 'unexport_candidate' : 'deletion_candidate')
        : f.verdict,
    }));
    expect(closed.r.findings).toEqual(flipped);
    expect(closed.r.views.deprecate.rows).toEqual([]);
    expect(closed.r.views.org_dead).toBeUndefined();
    expect(closed.r.views.delete.assertion).toBe(CLOSED_ORG_ASSERTION);
    expect(names(closed.r.views.delete.rows)).toEqual(expect.arrayContaining([
      `${widgets}#default`, `${widgets}#internalUnused`, `${widgets}#namespaceUnused`, `${widgets}#testOnlyFn`,
    ]));
    expect(names(closed.r.views.private_dead.rows)).toContain(`${widgets}#unusedHelper`);
    expect(closed.r.packages.find((p) => p.package_id === widgets))
      .toMatchObject({ private: true, private_by_assertion: true, counts: { delete: 4, deprecate: 0 } });
    expect(closed.out).toContain('policy: minAgeDays=0 trustPrivateRegistry=true countTestsAsConsumers=false countDocsAsConsumers=false '
      + `closedOrg=true (asserted: ${CLOSED_ORG_ASSERTION})`);
    const closedSarif = allSarifResults(work);
    expect(closedSarif.some((x) => x.ruleId === 'sentei/deprecate' || x.ruleId === 'sentei/org-dead')).toBe(false);
    const widgetsDeletes = closedSarif.filter((x) => x.ruleId === 'sentei/delete' && ['default', 'internalUnused', 'namespaceUnused', 'testOnlyFn'].includes(String(x.symbol)));
    expect(widgetsDeletes).toHaveLength(4);
    expect(widgetsDeletes.every((x) => x.message.endsWith(`assertion (policy closedOrg): ${CLOSED_ORG_ASSERTION}.`))).toBe(true);
    expect(sarifSchemaErrors(widgetsDeletes[0]!.log)).toEqual([]);
    expect(widgetsDeletes[0]!.log.runs[0]!.properties.assertions).toEqual([{ view: 'delete', text: CLOSED_ORG_ASSERTION }]);
  }, 300_000);
});

// Package identity is <manager>:<repo>:<name>: repos `one` and `two` both have
// `@acme/dup` (two's is private), consumer `three` depends on `@acme/dup` and uses a
// symbol only `one` defines. Resolution must pick `one` (the only published candidate),
// the report must say so, and `two` is a package of its own with no consumer.
describe('full pipeline on fixtures/org-dup (same package name in two repos)', () => {
  it('resolves the consumer to the published package and matches expected-findings.json exactly', async () => {
    const org = copyFixture('org-dup');
    const { rows, report: r, lines } = await runPipeline(org);
    const want = sortRows(JSON.parse(readFileSync(path.join(FIXTURES, 'org-dup', 'expected-findings.json'), 'utf8')) as ExpectedRow[]);
    expect(rows).toEqual(want);
    expect(r.packages.map((p) => [p.package_id, p.name, p.repo, p.consumers])).toEqual([
      ['npm:acme/one:@acme/dup', '@acme/dup', 'acme/one', ['npm:acme/three:@acme/three']],
      ['npm:acme/three:@acme/three', '@acme/three', 'acme/three', []],
      ['npm:acme/two:@acme/dup', '@acme/dup', 'acme/two', []],
    ]);
    expect(r.warnings).toContain(
      'npm:acme/three:@acme/three depends on @acme/dup, which names several org packages; resolved to npm:acme/one:@acme/dup (published)');
    expect(lines).toContain('[discover] note: 2 org packages are named npm:@acme/dup: npm:acme/one:@acme/dup, npm:acme/two:@acme/dup');
    expect(lines).toContain(
      '[discover] acme/three: npm:acme/three:@acme/three dep @acme/dup matches 2 org packages; resolved to npm:acme/one:@acme/dup (published)');
    expect(r.versionSkew).toEqual([]);
  }, 180_000);
});

// M3 acceptance (PLAN.md §10): the same pipeline on fixtures/org-dart (scip-dart).
const HAS_DART = spawnSync('dart', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!HAS_DART) console.warn('[pipeline.test] SKIPPING M3 acceptance: `dart` is not on PATH');
const HAS_FLUTTER = hasFlutter();
if (HAS_DART && !HAS_FLUTTER) console.warn('[pipeline.test] M3 acceptance WITHOUT the Flutter repos of fixtures/org-dart: `flutter` is not on PATH');
const DART_FLUTTER = FLUTTER_REPOS['org-dart']!;

/** Copy fixtures/org-dart; without `flutter`, minus its Flutter repos. */
function copyDartFixture(): string {
  const org = copyFixture('org-dart');
  if (!HAS_FLUTTER) dropFlutterRepos('org-dart', org);
  return org;
}

function expectedDart(file: string): ExpectedRow[] {
  const rows = JSON.parse(readFileSync(path.join(FIXTURES, 'org-dart', file), 'utf8')) as ExpectedRow[];
  const flutterPkgs = new Set(Object.values(DART_FLUTTER));
  // A package id ends in its pub name (`pub:<name>` or `pub:<repo>:<name>`).
  return sortRows(HAS_FLUTTER ? rows : rows.filter((r) => !flutterPkgs.has(r.package_id.slice(r.package_id.lastIndexOf(':') + 1))));
}

describe('M3 acceptance: full pipeline on fixtures/org-dart', () => {
  it.skipIf(!HAS_DART)('matches expected-findings.json exactly', async () => {
    const org = copyDartFixture();
    const { rows, report: r, lines, work } = await runPipeline(org);
    expect(r.policy).not.toHaveProperty('assumeClosedWorld');
    expect(r.repos.map((x) => [x.repo, x.index_status]).sort()).toEqual([
      ['acme/dart-app', 'ok'],
      ['acme/dart-frameworks', 'ok'],
      ['acme/dart-gen', 'ok'],
      ['acme/dart-js', 'ok'],
      ['acme/dart-lib-pub', 'ok'],
      ['acme/dart-lib-x', 'ok'],
      ['acme/dart-samples', 'ok'],
      ['acme/dart-testkit', 'ok'],
      ['acme/dart-workspace', 'ok'],
      ...(HAS_FLUTTER ? Object.keys(DART_FLUTTER).sort().map((n) => [`acme/${n}`, 'ok']) : []),
    ]);
    expect(rows).toEqual(expectedDart('expected-findings.json'));
    // acme_pub is published-public: its unused export is a deprecation (the legacy
    // org_dead, which would read it as a deletion, is not in the default report.json).
    expect(r.views.deprecate.rows.map((f) => `${f.package_id}#${f.symbol}`)).toContain('pub:acme/dart-lib-pub:acme_pub#pubUnused');
    expect(r.views.org_dead).toBeUndefined();
    // acme_core's conditional import: the index resolves `storageName` to the default
    // storage_stub.dart only; the sidecar's conditionalImports keeps the io/web variants alive.
    expect(rows.filter((x) => x.symbol === 'storageName')).toEqual([]);
    // Fix round 4: acme_core's conditional EXPORT (lib/platform.dart): the io/web twins of
    // platformName take the stub's export surface, so they and _ioDetail are alive (they
    // were private_dead already_unreachable).
    expect(rows.filter((x) => x.symbol === 'platformName' || x.symbol === '_ioDetail')).toEqual([]);
    // Phase 3 decision 3: dart-samples' example/app (another repo than acme_x) is promoted
    // to a consumer package and indexed; the export only it uses has no finding.
    expect(lines).toContain('[discover] acme/dart-samples: promoted ignored-dir manifest example/app/pubspec.yaml to the consumer package '
      + 'pub:acme/dart-samples:acme_sample_app: example app depends on pub:acme/dart-lib-x:acme_x (repo acme/dart-lib-x)');
    expect(rows.filter((x) => x.symbol === 'usedBySample' || x.package_id === 'pub:acme/dart-samples:acme_sample_app')).toEqual([]);
    // Fix round 8b (evaluation batches C and D), dart-frameworks: mason hooks' `run`, dart_frog
    // routes' `onRequest` / `middleware`, the pigeon input's declarations and the analyzer
    // plugin's `plugin` are entry symbols (no finding; each was a false row before); only the
    // packages' own dead code remains. The mason template (__brick__/) and the two workshop
    // copies of one app name are no packages; apps without publish_to are private.
    expect(rows.filter((x) => x.package_id.startsWith('pub:acme/dart-frameworks:')).map((x) => x.symbol).sort())
      .toEqual(['pigeonApiVersion', 'staleVar', 'unusedInApp', 'unusedRouteHelper']);
    expect(r.packages.filter((p) => p.repo === 'acme/dart-frameworks').map((p) => [p.name, p.private])).toEqual([
      ['acme_backend', true], ['acme_brick_hooks', true], ['acme_cli_app', true], ['acme_lints', false], ['acme_pigeon_iface', true],
    ]);
    expect(lines).toContain('[discover] acme/dart-frameworks: brick/hooks/pubspec.yaml: an application (mason hooks: pre_gen.dart / post_gen.dart) without publish_to: treated as private');
    expect(lines).toContain('[discover] acme/dart-frameworks: ignored private duplicate manifest acme/dart-frameworks/workshop/start/pubspec.yaml (same name as acme/dart-frameworks/workshop/finish/pubspec.yaml)');
    // dart-lib-x's own example/ stays ignored: its use of inExample is a note in report.json and SARIF.
    const inExample = allSarifResults(work).find((x) => x.symbol === 'inExample')!;
    expect(inExample.ruleId).toBe('sentei/unexport');
    expect(inExample.message).toContain('note:used by example/pubspec.yaml (example/bin/demo.dart:9)');
  }, 600_000);
});
