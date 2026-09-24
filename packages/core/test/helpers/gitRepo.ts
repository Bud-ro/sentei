// Local bare git repos for clone tests (file:// URLs, no network).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const run = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Bare repo with two commits on `main`; returns [first, second] shas. */
export function makeBareRepo(root: string, name: string): { url: string; shas: [string, string] } {
  const bare = join(root, `${name}.git`);
  const work = join(root, `${name}-work`);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { env: ENV, stdio: 'ignore' });
  mkdirSync(work);
  run(work, 'init', '--initial-branch=main');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: `@t/${name}`, version: '1.0.0' }));
  run(work, 'add', '.');
  run(work, 'commit', '-m', 'one');
  const a = run(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'index.ts'), 'export const x = 1;\n');
  run(work, 'add', '.');
  run(work, 'commit', '-m', 'two');
  const b = run(work, 'rev-parse', 'HEAD');
  run(work, 'push', bare, 'main');
  return { url: pathToFileURL(bare).href, shas: [a, b] };
}
