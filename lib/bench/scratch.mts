// Scratch workspaces — the isolation the bench runs in. Never the user's workspace.
//
// generic: the artifact is placed exactly where each harness discovers it (registry
//   skillsDirs / agentsDir), a git repo is initialised (Codex walks up to the git root),
//   opencode.json carries a deny-by-default permission set.
// taut: the pack is COMPILED by the engine into <scratch>/ws against stub member repos —
//   the same recipe as tools/validate-pack.sh — so markers, allowlists, hooks and per-
//   harness paths are the real installed ones; `taut verify` seals it.
// --landscape <dir>: a COPY of a real landscape replaces the stubs (never the original).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TautContext } from '../adapters/taut.mts';
import type { Artifact, HarnessCaps } from '../types.mts';
import { exists } from '../util.mts';

const run = promisify(execFile);

export interface Scratch { root: string; ws: string; mode: 'generic' | 'taut'; compiled: { ok: boolean; detail: string; verify?: string } }

async function gitInit(dir: string): Promise<void> {
  const g = (args: string[]) => run('git', ['-C', dir, '-c', 'user.email=saut@bench', '-c', 'user.name=saut', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args]);
  await g(['init', '-q']);
  await g(['add', '-A']);
  await g(['commit', '-qm', 'saut scratch', '--allow-empty']);
}

export async function makeScratchRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'saut-bench-'));
}

// A harness may keep per-project state OUTSIDE the workspace it was pointed at: Claude Code
// derives an auto-memory directory from the cwd (~/.claude/projects/<cwd with / as ->). A
// bench must not leave that behind, so its own directories are removed with the scratch.
// Guarded twice: the name must be derived from THIS scratch path and contain `saut-bench-`.
export async function cleanHarnessState(scratchRoot: string): Promise<string[]> {
  const removed: string[] = [];
  if (!path.basename(scratchRoot).startsWith('saut-bench-')) return removed;
  const roots = [path.join(os.homedir(), '.claude', 'projects')];
  for (const dir of roots) {
    let entries: string[] = [];
    try { entries = await fs.readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (!e.includes('saut-bench-')) continue;
      const slug = e.replace(/-/g, '/');
      const mine = slug.includes(path.basename(scratchRoot).replace(/-/g, '/'));
      if (!mine) continue;
      try { await fs.rm(path.join(dir, e), { recursive: true, force: true }); removed.push(path.join(dir, e)); } catch { /* leave it */ }
    }
  }
  return removed;
}

export async function genericScratch(a: Artifact, harnesses: HarnessCaps[], root: string, siblings: Artifact[]): Promise<Scratch> {
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  const placed: string[] = [];
  for (const h of harnesses) {
    if (a.kind === 'skill') {
      for (const d of h.skillsDirs.slice(0, 1)) {                 // the harness's primary discovery dir
        const target = path.join(ws, d, a.name);
        if (await exists(target)) continue;
        await fs.cp(a.dir, target, { recursive: true, filter: (s) => !/\/evals(\/|$)/.test(s) });
        placed.push(path.join(d, a.name));
      }
    }
    if (h.agentsDir && h.agentFormat === 'md-frontmatter') {
      const agents = a.kind === 'agent' ? [a] : siblings.filter((s) => s.kind === 'agent');
      for (const ag of agents) {
        const target = path.join(ws, h.agentsDir, `${ag.name}.md`);
        if (await exists(target)) continue;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(ag.path, target);
        placed.push(path.join(h.agentsDir, `${ag.name}.md`));
      }
    }
  }
  await fs.writeFile(path.join(ws, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { skill: 'allow', bash: 'deny', edit: 'deny', webfetch: 'deny' } }, null, 2) + '\n');
  await fs.writeFile(path.join(ws, 'README.md'), `# saut scratch workspace\n\nBench target: ${a.kind} ${a.name}\n`);
  await gitInit(ws);
  return { root, ws, mode: 'generic', compiled: { ok: true, detail: `placed ${placed.join(', ')}` } };
}

export async function tautScratch(a: Artifact, ctx: TautContext, harnessIds: string[], root: string, landscape: string | null): Promise<Scratch> {
  const land = path.join(root, 'land');
  await fs.mkdir(land, { recursive: true });
  const ws = path.join(root, 'ws');
  let repos: string | string[] = 'scan';
  const known = ctx.project?.repos?.known ? Object.keys(ctx.project.repos.known) : [];
  if (landscape) {
    // a COPY of the real landscape — the bench never runs against the original
    await fs.cp(landscape, path.join(land, 'landscape'), { recursive: true, filter: (s) => !/\/node_modules(\/|$)|\/\.git\/objects(\/|$)/.test(s) });
    repos = 'scan';
  } else {
    for (const r of known.length ? known : ['stub-repo']) { await fs.mkdir(path.join(land, r), { recursive: true }); await gitInit(path.join(land, r)); }
  }
  await fs.mkdir(path.join(land, 'kaut-stub'), { recursive: true });
  await fs.writeFile(path.join(land, 'kaut-stub', 'kaut.mjs'), '// stub\n');
  const answers = {
    ...(ctx.project ? { deployment: ctx.project.name } : {}),
    workspace: ws,
    repos,
    harnesses: harnessIds.filter((h) => ctx.harnessIds.includes(h)),
    kaut: path.join(land, 'kaut-stub'),
    skills: 'all',
    mcp: 'all',
  };
  await fs.writeFile(path.join(land, 'answers.json'), JSON.stringify(answers, null, 2));
  const env = { ...process.env } as Record<string, string>;
  delete env.TAUT_DATA;
  const taut = path.join(ctx.engine, 'taut.mjs');
  try {
    await run('node', [taut, 'setup', '--answers', path.join(land, 'answers.json'), '--yes', '--data', ctx.packRoot], { cwd: landscape ? path.join(land, 'landscape') : land, env, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return { root, ws, mode: 'taut', compiled: { ok: false, detail: `taut setup failed: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim().slice(-800)}` } };
  }
  let verify = 'ok';
  try { await run('node', [taut, 'verify', '--workspace', ws], { env, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { verify = `verify failed: ${((e as { stdout?: string }).stdout ?? '').slice(-400)}`; }
  // the artifact must have landed
  const first = ctx.caps[harnessIds[0]];
  const landed = a.kind === 'skill' ? path.join(ws, first.skillsDir, a.name, 'SKILL.md') : path.join(ws, first.agentsDir, `${a.name}.${first.agentFormat === 'toml' ? 'toml' : 'md'}`);
  const ok = await exists(landed);
  return { root, ws, mode: 'taut', compiled: { ok: ok && verify === 'ok', detail: ok ? `compiled by ${path.basename(ctx.engine)} @${ctx.engineCommit ?? '?'} (${harnessIds.join('+')}, ${known.length || 1} stub repos)` : `compiled, but ${path.relative(ws, landed)} is not in the workspace (excluded by the repo-map lint or a gate?)`, verify } };
}
