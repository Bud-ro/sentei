// The report's blocker hints name the index log by path; core cannot import the cli's
// slug functions, so it spells them itself (report.ts indexLogPath). They must agree.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexLogPath } from '@sentei/core';
import { packageSlug } from '../src/indexers/scip-typescript.ts';
import { repoSlug } from '../src/stages/index.ts';

describe('report indexLogPath', () => {
  it('matches the index stage\'s <work>/index/<repoSlug>/<packageSlug>.log', () => {
    const cases = [
      { repo: 'acme/lib-core', manager: 'npm', name: '@acme/core', path: '.' },
      { repo: 'Workiva/over_react', manager: 'pub', name: 'todo_client', path: 'app/over_react_redux/todo_client' },
      { repo: 'acme/weird', manager: 'npm', name: '@scope/a+b', path: 'x' },
    ];
    for (const c of cases) {
      const want = path.posix.join('/w', 'index', repoSlug(c.repo),
        `${packageSlug({ packageId: `${c.manager}:${c.repo}:${c.name}`, path: c.path, manager: c.manager, name: c.name, entryPoints: [], deps: [] })}.log`);
      expect(indexLogPath('/w', c)).toBe(want);
    }
  });
});
