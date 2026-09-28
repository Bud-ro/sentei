// Own-code loads no index sees (fix round 8c): SFC aliases (`~/`, `@/`, tsconfig paths),
// `<script src>`, `import.meta.glob`, framework conventions; and the fail-closed gap
// (`unresolved`) when an alias or a glob cannot be resolved.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aliasTargets, importMetaGlobs, scanUnindexedImports } from '../src/indexers/consumer-checks.ts';
import type { UnindexedImport } from '../src/indexers/types.ts';

let root: string;

function write(files: Record<string, string>): void {
  for (const [f, body] of Object.entries(files)) {
    const abs = path.join(root, ...f.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'sentei-sfc-loads-')));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rel = (u: UnindexedImport): string =>
  `${u.file} -> ${u.module}${u.relative ? ' (own)' : ` (${u.targetPackage})`}${u.unresolved ? ' UNRESOLVED' : ''}`;

describe('aliasTargets', () => {
  it('tsconfig paths first (exact key, then the longest * prefix), then the conventions', () => {
    const pkg = path.join(root, 'alias');
    mkdirSync(path.join(pkg, 'src'), { recursive: true });
    const aliases = {
      paths: [
        { pattern: '@/*', targets: [path.join(pkg, 'app/*')] },
        { pattern: '@/lib/*', targets: [path.join(pkg, 'lib/*')] },
        { pattern: 'config', targets: [path.join(pkg, 'config/index.ts')] },
      ],
    };
    expect(aliasTargets('@/lib/x', pkg, aliases)).toEqual([path.join(pkg, 'lib/x')]);
    expect(aliasTargets('@/y?raw', pkg, aliases)).toEqual([path.join(pkg, 'app/y')]);
    expect(aliasTargets('config', pkg, aliases)).toEqual([path.join(pkg, 'config/index.ts')]);
    // No paths entry: the Vite / Nuxt / Astro conventions (src/ exists here).
    expect(aliasTargets('~/a/b', pkg, aliases)).toEqual([path.join(pkg, 'src/a/b')]);
    expect(aliasTargets('~~/a', pkg, undefined)).toEqual([path.join(pkg, 'a')]);
    expect(aliasTargets('@@/a', pkg, undefined)).toEqual([path.join(pkg, 'a')]);
    expect(aliasTargets('$lib/a', pkg, undefined)).toEqual([path.join(pkg, 'src/lib/a')]);
    expect(aliasTargets('vue', pkg, undefined)).toBeUndefined();
    expect(aliasTargets('@acme/x', pkg, undefined)).toBeUndefined();
    const noSrc = path.join(root, 'alias-nosrc');
    mkdirSync(noSrc, { recursive: true });
    expect(aliasTargets('@/a', noSrc, undefined)).toEqual([path.join(noSrc, 'a')]);
  });
});

describe('importMetaGlobs', () => {
  it('reads string and array patterns; an unreadable call is undefined; a call without arguments is skipped', () => {
    expect(importMetaGlobs(`
      const a = import.meta.glob('./pages/*.ts');
      const b = import.meta.glob<{ default: string }>(["./x/*.ts", '!./x/skip.ts'], { eager: true });
      const c = import.meta.globEager(\`/src/*.ts\`);
      const d = import.meta.glob(\`./\${dir}/*.ts\`);
      const e = import.meta.glob(patterns);
      // import.meta.glob() in a comment is prose
    `)).toEqual([['./pages/*.ts'], ['./x/*.ts', '!./x/skip.ts'], ['/src/*.ts'], undefined, undefined]);
  });
});

describe('scanUnindexedImports: SFC aliases, <script src>, import.meta.glob, framework loads', () => {
  it('resolves own-code loads and records what it cannot resolve as a gap', () => {
    write({
      'app/package.json': '{"name":"@acme/app"}',
      'app/src/main.ts': [
        "const pages = import.meta.glob(['./pages/*.ts', '!./pages/skip.ts']);",
        "const widgets = import.meta.glob('/src/widgets/{a,b}.ts', { eager: true });",
        'const dyn = import.meta.glob(`./x/${name}.ts`);',
        "const aliased = import.meta.glob('@/feeds/*.ts');",
      ].join('\n'),
      'app/src/pages/home.ts': 'export const home = 1;\n',
      'app/src/pages/about.ts': 'export const about = 1;\n',
      'app/src/pages/skip.ts': 'export const skip = 1;\n',
      'app/src/widgets/a.ts': 'export const a = 1;\n',
      'app/src/widgets/b.ts': 'export const b = 1;\n',
      'app/src/widgets/c.ts': 'export const c = 1;\n',
      'app/src/feeds/rss.ts': 'export const rss = 1;\n',
      'app/src/api/client.ts': 'export const client = 1;\n',
      'app/src/lib/util.ts': 'export const util = 1;\n',
      'app/src/components/Widget.vue': [
        '<script setup lang="ts">',
        "import { client } from '@/api/client';",
        "import util from '~/lib/util';",
        "import Other from '~/components/Other.vue';",
        "import missing from '~/missing/thing';",
        "import { ref } from '#imports';",
        "import { core } from '@acme/core';",
        "import { shared } from '@shared/helpers';",
        '</script>',
        '<script src="./widget-logic.ts"></script>',
      ].join('\n'),
      'app/src/components/Other.vue': '<template><div/></template>\n',
      'app/src/components/widget-logic.ts': 'export default {};\n',
      'app/src/content/post.mdx': [
        "import { util } from '~/lib/util';",
        '',
        'Tutorial: `import.meta.glob()` loads files.',
        '```ts',
        "import { db } from '@/db';",
        "const all = import.meta.glob('./nothing/${x}');",
        '```',
      ].join('\n'),
      'shared/helpers.ts': 'export const shared = 1;\n',
    });
    const pkgDir = path.join(root, 'app');
    const out = scanUnindexedImports({
      repoRoot: root,
      pkgDir,
      nestedPackageDirs: [],
      indexedFiles: new Set([path.join(pkgDir, 'src/main.ts')]),
      orgPackageNames: new Set(['@acme/core', '@acme/shared']),
      selfName: '@acme/app',
      aliases: { paths: [{ pattern: '@shared/*', targets: [path.join(root, 'shared/*')] }] },
      orgPackageDirs: [{ name: '@acme/shared', dir: path.join(root, 'shared') }],
    });
    expect(out.map(rel)).toEqual([
      'app/src/components/Widget.vue -> @acme/core (@acme/core)',
      // An alias into another org package is an (unindexed) import of it.
      'app/src/components/Widget.vue -> @shared/helpers (@acme/shared)',
      'app/src/components/Widget.vue -> app/src/api/client.ts (own)',
      'app/src/components/Widget.vue -> app/src/components/widget-logic.ts (own)',
      'app/src/components/Widget.vue -> app/src/lib/util.ts (own)',
      // No file there: a gap (the package's entry set is incomplete). Other.vue is an SFC
      // (scanned itself), `#imports` a Nuxt virtual module: neither is recorded.
      'app/src/components/Widget.vue -> ~/missing/thing (own) UNRESOLVED',
      // Only the MDX file's real import: its fenced example and inline code are not code.
      'app/src/content/post.mdx -> app/src/lib/util.ts (own)',
      'app/src/main.ts -> app/src/feeds/rss.ts (own)',
      'app/src/main.ts -> app/src/pages/about.ts (own)',
      'app/src/main.ts -> app/src/pages/home.ts (own)',
      'app/src/main.ts -> app/src/widgets/a.ts (own)',
      'app/src/main.ts -> app/src/widgets/b.ts (own)',
      'app/src/main.ts -> import.meta.glob(…) (own) UNRESOLVED',
    ]);
    // The indexed main.ts itself is never scanned for imports (TypeScript resolved them).
    expect(out.every((u) => u.targetPackage === '@acme/app' || !u.relative)).toBe(true);
  });

  it('a package-like specifier matched only by a catch-all paths entry falls back to a bare import, not a gap', () => {
    write({
      'catchall/src/A.vue': "<script>import { core } from '@acme/core'; import { h } from 'vue';</script>\n",
    });
    const pkgDir = path.join(root, 'catchall');
    const out = scanUnindexedImports({
      repoRoot: pkgDir,
      pkgDir,
      nestedPackageDirs: [],
      indexedFiles: new Set(),
      orgPackageNames: new Set(['@acme/core']),
      selfName: 'catchall',
      aliases: { paths: [{ pattern: '*', targets: [path.join(pkgDir, 'types/*')] }] },
    });
    expect(out.map(rel)).toEqual(['src/A.vue -> @acme/core (@acme/core)']);
  });

  it('framework conventions: Astro endpoints / middleware and files astro.config names; Nuxt auto-imports and plugins', () => {
    write({
      'site/astro.config.mjs': "export default { integrations: [starlight({ routeMiddleware: './src/routeData.ts' })] };\n",
      'site/src/pages/index.astro': '---\n---\n<h1/>\n',
      'site/src/pages/api/feed.ts': 'export function GET() {}\n',
      'site/src/middleware.ts': 'export const onRequest = () => {};\n',
      'site/src/routeData.ts': 'export const onRequest = () => {};\n',
      'site/src/lib/unused.ts': 'export const unused = 1;\n',
      'nuxt/nuxt.config.ts': 'export default defineNuxtConfig({});\n',
      'nuxt/composables/useCounter.ts': 'export const useCounter = () => 1;\n',
      'nuxt/app/utils/double.ts': 'export const double = (n: number) => n * 2;\n',
      'nuxt/plugins/sentry.client.ts': 'export default {};\n',
      'nuxt/server/utils/db.ts': 'export const db = 1;\n',
      'nuxt/lib/plain.ts': 'export const plain = 1;\n',
    });
    const scan = (dir: string): string[] => scanUnindexedImports({
      repoRoot: path.join(root, dir), pkgDir: path.join(root, dir), nestedPackageDirs: [],
      indexedFiles: new Set(), orgPackageNames: new Set(), selfName: dir,
    }).map(rel);
    expect(scan('site')).toEqual([
      'astro.config.mjs -> src/middleware.ts (own)',
      'astro.config.mjs -> src/pages/api/feed.ts (own)',
      'astro.config.mjs -> src/routeData.ts (own)',
    ]);
    expect(scan('nuxt')).toEqual([
      'nuxt.config.ts -> app/utils/double.ts (own)',
      'nuxt.config.ts -> composables/useCounter.ts (own)',
      'nuxt.config.ts -> plugins/sentry.client.ts (own)',
      'nuxt.config.ts -> server/utils/db.ts (own)',
    ]);
  });
});
