// Small shared helpers: failure type, fs probes, ANSI styling. Node builtins only.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export class SautError extends Error {}
export function fail(msg: string): never { throw new SautError(msg); }

export const exists = (p: string) => fs.access(p).then(() => true, () => false);

// Every read of a file SAUT did not write goes through here: a skill body, a referenced
// file, a grader source. 8 MB is far above any legitimate artifact and far below trouble.
export const MAX_READ_BYTES = 8 * 1024 * 1024;
export async function readText(p: string, max = MAX_READ_BYTES): Promise<string> {
  const h = await fs.open(p, 'r');
  try {
    const { size } = await h.stat();
    if (size > max) throw new SautError(`${p} is ${(size / 1048576).toFixed(1)} MB — refusing to read more than ${max / 1048576} MB`);
    return (await h.readFile({ encoding: 'utf8' })) as string;
  } finally { await h.close(); }
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, 'utf8')) as T;
}

export async function isDir(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

// Recursive walk yielding files; skips the directories nobody wants scanned.
const SKIP_DIRS = new Set(['node_modules', '.git', 'results', '.test-tmp', 'dist', '.saut-scratch']);

// Symlinks are followed: marketplace and plugin layouts symlink skills heavily, and
// `withFileTypes` reports a symlink as neither file nor directory — a linked skill used to
// be silently invisible, which reads as a clean bill for a tree that was never scanned.
// `visited` holds device+inode so a loop cannot spin forever.
export async function* walk(dir: string, depth = 12, visited = new Set<string>()): AsyncGenerator<string> {
  if (depth < 0) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.test-tmp')) continue;
    const p = path.join(dir, e.name);
    let isDirectory = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = await fs.stat(p);                     // follows the link
        const key = `${st.dev}:${st.ino}`;
        if (visited.has(key)) continue;
        visited.add(key);
        isDirectory = st.isDirectory();
        isFile = st.isFile();
      } catch { continue; }                              // dangling link
    }
    if (isDirectory) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(p, depth - 1, visited);
    } else if (isFile) yield p;
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

// An EMPTY PATH entry means "the current directory" to both path.join and execFile, so a
// file named `claude` or `snyk` in a scanned repository would look installed and then be
// executed. Existence is not enough either — the entry must be executable.
export async function onPath(bin: string): Promise<boolean> {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    for (const ext of exts) {
      try { await fs.access(path.join(d, bin + ext), fsConstants.X_OK); return true; } catch { /* next */ }
    }
  }
  return false;
}

export function count(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
