// Remote targets: `saut lint|cost|passport <git url>` fetches the repository into a throwaway
// directory, runs the command there, and removes it. The content is UNTRUSTED — someone
// else's repository — so the fetch and everything after it are read-only by construction:
//   - one commit, no tags, no submodules; `ext::` transport refused, credentials never prompted
//   - symlinks are checked out as plain files, so a SKILL.md cannot point at ~/.ssh/id_rsa
//   - no repository hooks run (hooksPath pointed at an empty directory)
//   - commands that would execute or write repository content (--live spawns the MCP servers
//     of the repo's catalog; --fix rewrites files; test / studio run harnesses) refuse it
// Paths in the output name the repository and the commit, never the temporary directory.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SautError, setDisplayRoot } from './util.mts';

const run = promisify(execFile);

export interface RemoteSpec {
  url: string;          // what git fetches
  ref: string | null;   // branch, tag or full commit id; null = the remote HEAD
  subpath: string;      // inside the repository, '' = the root
  label: string;        // host/owner/repo — how the output names it
}

export interface Fetched { spec: RemoteSpec; dir: string; root: string; target: string; commit: string }

// https / ssh / file URLs and scp-like `git@host:owner/repo`. http:// and git:// carry no
// integrity — refused rather than scanned and trusted.
const SCP = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;
const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isRemoteTarget(t: string): boolean {
  return URLISH.test(t) || SCP.test(t);
}

// <url>[#<ref>][:<subpath>] — `#main`, `#v1.2:skills/review`, `#:skills/review`. Browse URLs
// that a person copies from GitHub / GitLab (…/tree/<ref>/<path>, …/-/tree/<ref>/<path>) are
// understood too; a ref with a slash needs the `#` form there.
export function parseRemote(raw: string): RemoteSpec {
  if (raw.startsWith('-')) throw new SautError(`not a repository URL: ${raw}`);
  let base = raw, ref: string | null = null, subpath = '';
  const hash = raw.indexOf('#');
  if (hash >= 0) {
    base = raw.slice(0, hash);
    const frag = raw.slice(hash + 1);
    const colon = frag.indexOf(':');
    ref = (colon >= 0 ? frag.slice(0, colon) : frag) || null;
    subpath = colon >= 0 ? frag.slice(colon + 1) : '';
  }
  if (SCP.test(base)) {
    const host = base.slice(base.indexOf('@') + 1, base.indexOf(':'));
    const repo = base.slice(base.indexOf(':') + 1).replace(/\.git$/, '').replace(/\/+$/, '');
    return finish({ url: base, ref, subpath, label: `${host}/${repo}` });
  }
  let u: URL;
  try { u = new URL(base); } catch { throw new SautError(`not a repository URL: ${raw}`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme === 'http' || scheme === 'git') throw new SautError(`${scheme}:// has no transport integrity — use https:// or ssh:// (${raw})`);
  if (!['https', 'ssh', 'file'].includes(scheme)) throw new SautError(`unsupported repository URL scheme "${scheme}" — https://, ssh://, git@host:… or file:// (${raw})`);
  if (u.search) throw new SautError(`a repository URL takes no query string: ${raw}`);
  let parts = u.pathname.split('/').filter(Boolean);
  if (scheme === 'https' && !ref && !subpath) {
    // github.com/o/r/tree/<ref>/<path…> · gitlab/o/(g/)r/-/tree/<ref>/<path…>
    const dash = parts.indexOf('-');
    const at = dash >= 0 && (parts[dash + 1] === 'tree' || parts[dash + 1] === 'blob') ? dash
      : parts.length > 3 && (parts[2] === 'tree' || parts[2] === 'blob') ? 2 : -1;
    if (at >= 0) {
      const skip = parts[at] === '-' ? 2 : 1;
      ref = parts[at + skip] ?? null;
      subpath = parts.slice(at + skip + 1).join('/');   // a blob path is a file: SKILL.md or an agent .md
      parts = parts.slice(0, at);
    }
  }
  // over https a user part is a token as often as a name (https://<PAT>@github.com/…); it would be
  // printed and written into JSON, SARIF and the report — refuse it like a password. ssh:// keeps
  // its user (ssh://git@host/…): that is the login name, not a secret.
  if (u.password || (scheme === 'https' && u.username)) throw new SautError('a repository URL must not carry a password or token — use a git credential helper');
  const repoPath = parts.join('/').replace(/\.git$/, '');
  if (scheme !== 'file' && !repoPath) throw new SautError(`no repository path in ${raw}`);
  const clean = new URL(base);
  if (scheme === 'https') clean.pathname = '/' + parts.join('/');
  clean.hash = '';
  return finish({ url: clean.href, ref, subpath, label: scheme === 'file' ? path.basename(u.pathname).replace(/\.git$/, '') : `${u.hostname}/${repoPath}` });
}

function finish(s: RemoteSpec): RemoteSpec {
  const sub = s.subpath.replace(/^\/+|\/+$/g, '');
  if (sub && (path.posix.isAbsolute(sub) || sub.split('/').includes('..'))) throw new SautError(`the path inside the repository must stay inside it: ${s.subpath}`);
  if (s.ref && (s.ref.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(s.ref))) throw new SautError(`not a git ref: ${s.ref}`);
  return { ...s, subpath: sub };
}

// Everything git reads from its environment that could make a fetch prompt, run a program or
// leave the throwaway directory is pinned here.
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:file', GCM_INTERACTIVE: 'never' };
}

async function git(args: string[], cwd: string, timeoutMs: number, hooks: string): Promise<string> {
  const safe = ['-c', 'protocol.ext.allow=never', '-c', 'core.symlinks=false', '-c', `core.hooksPath=${hooks}`,
    '-c', 'submodule.recurse=false', '-c', 'core.fsmonitor=false', '-c', 'advice.detachedHead=false'];
  try {
    const r = await run('git', [...safe, ...args], { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return String(r.stdout).trim();
  } catch (e) {
    const err = e as { killed?: boolean; stderr?: string; code?: string | number; message: string };
    if (err.code === 'ENOENT') throw new SautError('a remote target needs git on PATH');
    if (err.killed) throw new SautError(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`);
    const msg = String(err.stderr ?? err.message).trim().split('\n').filter((l) => l.trim() && !/^hint:/.test(l)).slice(-3).join(' · ');
    throw new SautError(`git ${args[0]} failed: ${msg}`);
  }
}

export async function fetchRemote(spec: RemoteSpec, opts: { timeoutSec?: number } = {}): Promise<Fetched> {
  const timeoutMs = (opts.timeoutSec ?? 180) * 1000;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-remote-'));
  const root = path.join(dir, 'repo');
  const hooks = path.join(dir, 'no-hooks');
  try {
    await fs.mkdir(hooks);
    await git(['init', '-q', root], dir, timeoutMs, hooks);
    // `fetch <url> <ref>` takes a branch, a tag or a full commit id alike, at depth 1
    await git(['fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', spec.url, spec.ref ?? 'HEAD'], root, timeoutMs, hooks);
    await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], root, timeoutMs, hooks);
    const commit = await git(['rev-parse', 'HEAD'], root, timeoutMs, hooks);
    const target = spec.subpath ? path.join(root, ...spec.subpath.split('/')) : root;
    try { await fs.stat(target); } catch { throw new SautError(`no "${spec.subpath}" in ${spec.label}@${commit.slice(0, 12)}`); }
    // the .git of the throwaway clone is not repository content — nothing should lint it
    await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
    setDisplayRoot(root, `${spec.label}@${commit.slice(0, 12)}`);
    return { spec, dir, root, target, commit };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

// Commands that only READ the content take a remote target; the rest refuse it with the reason.
const READ_ONLY = new Set(['lint', 'cost', 'passport', 'report', 'studio']);   // studio: served read-only

export async function materializeTargets(cmd: string, opts: { _: string[]; live?: boolean; fix?: boolean; timeout?: number; keep?: boolean }): Promise<{ fetched: Fetched[]; cleanup: () => Promise<void> }> {
  const remote = opts._.map((t, i) => [t, i] as const).filter(([t]) => isRemoteTarget(t));
  const none = { fetched: [], cleanup: async () => {} };
  if (!remote.length) return none;
  if (!READ_ONLY.has(cmd)) throw new SautError(`saut ${cmd} takes local paths only — a repository URL is scanned by lint, cost, passport, report and studio (untrusted content is never run)`);
  if (opts.live) throw new SautError('--live spawns the MCP servers a catalog names — never for a remote repository\'s catalog');
  if (opts.fix) throw new SautError('--fix edits files — for a remote repository, clone it yourself and run saut there');
  const fetched: Fetched[] = [];
  const cleanup = async () => {
    if (opts.keep) { for (const f of fetched) process.stderr.write(`saut: kept ${f.root}\n`); return; }
    await Promise.all(fetched.map((f) => fs.rm(f.dir, { recursive: true, force: true })));
  };
  // a signal exits; the exit hook removes the directories synchronously (an await may never resume)
  const onExit = () => { if (!opts.keep) for (const f of fetched) rmSync(f.dir, { recursive: true, force: true }); };
  process.once('exit', onExit);
  if (!process.listenerCount('SIGINT')) process.once('SIGINT', () => process.exit(130));
  if (!process.listenerCount('SIGTERM')) process.once('SIGTERM', () => process.exit(143));
  try {
    for (const [t, i] of remote) {
      const f = await fetchRemote(parseRemote(t), { timeoutSec: opts.timeout });
      fetched.push(f);
      opts._[i] = f.target;
    }
  } catch (e) { await cleanup(); throw e; }
  return { fetched, cleanup };
}
