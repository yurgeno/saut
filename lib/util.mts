// Small shared helpers: failure type, fs probes, ANSI styling. Node builtins only.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export class SautError extends Error {}
export function fail(msg: string): never { throw new SautError(msg); }

export const exists = (p: string) => fs.access(p).then(() => true, () => false);

export async function readText(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, 'utf8')) as T;
}

export async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

// Recursive walk yielding files; skips the directories nobody wants scanned.
const SKIP_DIRS = new Set(['node_modules', '.git', 'results', '.test-tmp', 'dist', '.saut-scratch']);
export async function* walk(dir: string, depth = 12): AsyncGenerator<string> {
  if (depth < 0) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.test-tmp')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(p, depth - 1);
    } else if (e.isFile()) yield p;
  }
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = {
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
};

export function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r : p;
}

export function count(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
