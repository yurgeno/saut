// Shared test helpers. Run the suites with bare `node --test` from the repo root (npm test
// runs tsc first). The generic fixture pack (test/fixtures/pack) carries one artifact per
// rule; the suites never touch real content.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const run = promisify(execFile);
export const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CLI = path.join(REPO, 'saut.mjs');
export const PACK = path.join(REPO, 'test', 'fixtures', 'pack');
export const CATALOG = path.join(PACK, 'catalog', 'mcp.json');

export async function saut(args, opts = {}) {
  try {
    const r = await run('node', [CLI, ...args], { env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 16 * 1024 * 1024, ...opts });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

export const codes = (diags, file) => diags.filter((x) => !file || x.path.endsWith(file)).map((x) => x.code);
