// Headless runners — one per harness, thin: spawn the CLI, parse its event stream into the
// neutral Trace. No orchestration logic lives here. Availability is probed (binary on PATH,
// and for opencode a reachable provider) so a missing harness is a reported row, never a crash.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, HarnessCaps } from '../types.mts';
import type { BenchCase, ToolCall, Trace, Usage } from './types.mts';

export interface RunSpec {
  harness: HarnessCaps;
  artifact: Artifact;
  cwd: string;
  case: BenchCase;
  run: number;
  model?: string;                 // harness model id; undefined = the runner's cheap default
  allowedTools: string[];         // Claude: --allowedTools (the skill's own grant still applies on top)
  timeoutMs: number;
  rawDir: string;
}

const DEFAULT_MODEL: Record<string, string | undefined> = { 'claude-code': 'haiku', codex: 'gpt-5.4-mini', opencode: undefined };

export async function which(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) { try { await fs.access(path.join(d, bin)); return true; } catch { /* next */ } }
  return false;
}

export async function available(h: HarnessCaps): Promise<{ ok: boolean; reason?: string }> {
  if (!h.runner) return { ok: false, reason: 'registry-only harness (no headless runner)' };
  const bin = h.runner.cmd[0];
  if (!(await which(bin))) return { ok: false, reason: `${bin} not on PATH` };
  return { ok: true };
}

// The prompt as the harness wants it: explicit invocation syntax differs per harness.
export function renderPrompt(h: HarnessCaps, a: Artifact, c: BenchCase): string {
  if (c.invocation !== 'explicit') return c.prompt;
  const args = c.prompt ? ` ${c.prompt}` : '';
  if (h.id === 'claude-code') return `/${a.name}${args}`;
  if (h.id === 'codex') return `$${a.name}${args}`;
  return `Use the ${a.name} skill${args ? ` with: ${c.prompt}` : ''}.`;
}

function spawnCollect(cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(t); resolve({ stdout, stderr: stderr + e.message, code: null, timedOut }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ stdout, stderr, code, timedOut }); });
  });
}

const digestOf = (name: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.skill ?? i.name ?? i.pattern ?? i.url ?? i.query ?? '';
  return String(pick).replace(/\s+/g, ' ').slice(0, 120);
};

// Claude-shaped vocabulary for allowlist comparison.
const NEUTRAL: Record<string, string> = {
  shell: 'Bash', bash: 'Bash', command_execution: 'Bash', apply_patch: 'Edit', file_change: 'Edit', edit: 'Edit', write: 'Write', read: 'Read',
  grep: 'Grep', glob: 'Glob', list: 'Glob', webfetch: 'WebFetch', websearch: 'WebSearch', web_search: 'WebSearch', skill: 'Skill', task: 'Agent', question: 'AskUserQuestion', todowrite: 'TodoWrite',
};
export const neutralName = (name: string): string => NEUTRAL[name] ?? NEUTRAL[name.toLowerCase()] ?? name;

function baseTrace(spec: RunSpec): Trace {
  return { harness: spec.harness.id, case: spec.case, run: spec.run, status: 'ok', listed: null, competing: null, fired: 'unknown', firedOther: [], tools: [], usage: null, costUsd: null, durationMs: 0, turns: null, finalText: '' };
}

async function saveRaw(spec: RunSpec, text: string): Promise<string> {
  const f = path.join(spec.rawDir, `${spec.harness.id}--${spec.case.name}--${spec.run}.jsonl`);
  await fs.mkdir(spec.rawDir, { recursive: true });
  await fs.writeFile(f, text);
  return f;
}

// ---- claude-code -----------------------------------------------------------------------
export async function runClaude(spec: RunSpec): Promise<Trace> {
  const t = baseTrace(spec);
  const prompt = renderPrompt(spec.harness, spec.artifact, spec.case);
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
    '--max-turns', String(spec.case.maxTurns), '--model', spec.model ?? spec.case.model ?? DEFAULT_MODEL['claude-code']!,
    '--setting-sources', 'project'];
  if (spec.allowedTools.length) args.push('--allowedTools', spec.allowedTools.join(','));
  const started = Date.now();
  const r = await spawnCollect('claude', args, spec.cwd, spec.timeoutMs, { ...process.env, NO_COLOR: '1' });
  t.durationMs = Date.now() - started;
  t.rawFile = await saveRaw(spec, r.stdout + (r.stderr ? `\n#stderr\n${r.stderr}` : ''));
  if (r.timedOut) { t.status = 'timeout'; return t; }
  const denials = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'system' && j.subtype === 'init') {
      const skills: string[] = j.skills ?? [];
      t.listed = skills.includes(spec.artifact.name);
      t.competing = Math.max(0, skills.length - (t.listed ? 1 : 0));
    } else if (j.type === 'assistant') {
      for (const c of j.message?.content ?? []) {
        if (c.type !== 'tool_use') continue;
        const call: ToolCall = { name: c.name, neutral: neutralName(c.name), digest: digestOf(c.name, c.input), denied: false, error: false };
        if (c.name === 'Skill') {
          const invoked = String(c.input?.skill ?? c.input?.name ?? c.input?.command ?? '').replace(/^\//, '').split(/[\s:]/)[0];
          if (invoked === spec.artifact.name) t.fired = 'tool';
          else if (invoked && !t.firedOther.includes(invoked)) t.firedOther.push(invoked);   // another skill won this prompt
        }
        t.tools.push(call);
        if (c.id) (call as any)._id = c.id;
      }
    } else if (j.type === 'user') {
      for (const c of j.message?.content ?? []) {
        if (c?.type !== 'tool_result') continue;
        const call = t.tools.find((x) => (x as any)._id === c.tool_use_id);
        if (!call) continue;
        const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
        if (c.is_error) { call.error = true; if (/permission|not allowed|denied|requires approval/i.test(text)) call.denied = true; }
      }
    } else if (j.type === 'result') {
      t.turns = j.num_turns ?? null;
      t.costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
      const u = j.usage ?? {};
      t.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
      t.finalText = String(j.result ?? '').slice(0, 2000);
      for (const d of j.permission_denials ?? []) denials.add(`${d.tool_name}|${digestOf(d.tool_name, d.tool_input)}`);
      if (j.is_error) { t.status = 'error'; t.error = String(j.result ?? j.error ?? j.subtype ?? 'error').slice(0, 300); }
    }
  }
  for (const call of t.tools) { if (denials.has(`${call.name}|${call.digest}`)) call.denied = true; delete (call as any)._id; }
  // the invocation itself was refused (a gate, a permission rule): the skill never loaded
  if (t.fired === 'tool' && t.tools.some((c) => c.name === 'Skill' && c.digest === spec.artifact.name && c.denied)) t.fired = 'blocked';
  if (r.code !== 0 && t.status === 'ok') { t.status = 'error'; t.error = (r.stderr || `exit ${r.code}`).trim().slice(-300); }
  if (t.fired === 'unknown') t.fired = spec.case.invocation === 'explicit' && t.status === 'ok' ? 'expansion' : 'none';
  return t;
}

// ---- codex -------------------------------------------------------------------------
export async function runCodex(spec: RunSpec): Promise<Trace> {
  const t = baseTrace(spec);
  const prompt = renderPrompt(spec.harness, spec.artifact, spec.case);
  const args = ['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', spec.cwd,
    '-m', spec.model ?? spec.case.model ?? DEFAULT_MODEL.codex!, prompt];
  const started = Date.now();
  const r = await spawnCollect('codex', args, spec.cwd, spec.timeoutMs, { ...process.env, NO_COLOR: '1' });
  t.durationMs = Date.now() - started;
  t.rawFile = await saveRaw(spec, r.stdout + (r.stderr ? `\n#stderr\n${r.stderr}` : ''));
  if (r.timedOut) { t.status = 'timeout'; return t; }
  const skillPath = `skills/${spec.artifact.name}/SKILL.md`;
  const texts: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    if (j.type === 'error' || j.type === 'turn.failed') { t.status = 'error'; t.error = String(j.message ?? j.error?.message ?? 'error').slice(0, 300); }
    else if (j.type === 'item.completed') {
      const it = j.item ?? {};
      if (it.type === 'command_execution') {
        const cmd = String(it.command ?? '').replace(/^\/bin\/\w+ -l?c ['"]?/, '').replace(/['"]$/, '');
        const denied = /sandbox|read-only|not permitted|denied/i.test(String(it.aggregated_output ?? '')) && it.exit_code !== 0;
        t.tools.push({ name: 'shell', neutral: 'Bash', digest: cmd.slice(0, 120), denied, error: it.exit_code !== 0 && !denied });
        if (cmd.includes(skillPath)) t.fired = 'read';
      } else if (it.type === 'file_change') {
        t.tools.push({ name: 'apply_patch', neutral: 'Edit', digest: String((it.changes ?? []).map((c: any) => c.path).join(', ')).slice(0, 120), denied: it.status === 'failed', error: false });
      } else if (it.type === 'mcp_tool_call') {
        t.tools.push({ name: `mcp__${it.server}__${it.tool}`, neutral: `mcp__${it.server}__${it.tool}`, digest: String(it.tool), denied: false, error: it.status === 'failed' });
      } else if (it.type === 'web_search') {
        t.tools.push({ name: 'web_search', neutral: 'WebSearch', digest: String(it.query ?? ''), denied: false, error: false });
      } else if (it.type === 'agent_message') texts.push(String(it.text ?? ''));
    } else if (j.type === 'turn.completed') {
      const u = j.usage ?? {};
      t.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cached_input_tokens ?? 0, cacheWrite: u.cache_write_input_tokens ?? 0 };
    }
  }
  t.finalText = texts.at(-1)?.slice(0, 2000) ?? '';
  t.listed = null;                                     // Codex does not expose its listing headlessly
  if (t.fired === 'unknown') {
    const mentioned = texts.some((x) => x.includes(`\`${spec.artifact.name}\``) || x.includes(`$${spec.artifact.name}`));
    t.fired = spec.case.invocation === 'explicit' && t.status === 'ok' ? 'expansion' : mentioned ? 'read' : 'none';
  }
  if (r.code !== 0 && t.status === 'ok') { t.status = 'error'; t.error = (r.stderr || `exit ${r.code}`).trim().slice(-300); }
  return t;
}

// ---- opencode ----------------------------------------------------------------------
export async function runOpencode(spec: RunSpec): Promise<Trace> {
  const t = baseTrace(spec);
  const prompt = renderPrompt(spec.harness, spec.artifact, spec.case);
  const args = ['run', '--format', 'json', '--dir', spec.cwd, ...(spec.model ?? spec.case.model ? ['-m', (spec.model ?? spec.case.model)!] : []), prompt];
  const started = Date.now();
  const r = await spawnCollect('opencode', args, spec.cwd, spec.timeoutMs, { ...process.env, NO_COLOR: '1' });
  t.durationMs = Date.now() - started;
  t.rawFile = await saveRaw(spec, r.stdout + (r.stderr ? `\n#stderr\n${r.stderr}` : ''));
  if (r.timedOut) { t.status = 'timeout'; return t; }
  const texts: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j: any; try { j = JSON.parse(line); } catch { continue; }
    const type = String(j.type ?? '');
    if (type === 'error') {
      const msg = String(j.error?.data?.message ?? j.error?.message ?? j.message ?? 'error');
      t.status = /connect|ECONNREFUSED|provider|credential|api key/i.test(msg) ? 'unavailable' : 'error';
      t.error = msg.slice(0, 300);
    }
    // tool events: {type:"tool", part:{tool, state:{input,status,error}}} or {type:"tool_use"…} — accept both shapes
    const part = j.part ?? j;
    const toolName = part.tool ?? (type.startsWith('tool') ? part.name : undefined);
    if (toolName) {
      const state = part.state ?? {};
      const input = state.input ?? part.input ?? {};
      const status = String(state.status ?? part.status ?? '');
      const errText = String(state.error ?? part.error ?? '');
      const call: ToolCall = { name: String(toolName), neutral: neutralName(String(toolName)), digest: digestOf(String(toolName), input), denied: /denied|permission|not allowed/i.test(errText), error: status === 'error' && !/denied|permission|not allowed/i.test(errText) };
      if (!t.tools.some((x) => x.name === call.name && x.digest === call.digest && x.denied === call.denied)) t.tools.push(call);
      if (call.name === 'skill') {
        const invoked = String(input.name ?? input.skill ?? '');
        if (invoked === spec.artifact.name) t.fired = call.denied ? 'blocked' : 'tool';
        else if (invoked && !t.firedOther.includes(invoked)) t.firedOther.push(invoked);
      }
    }
    if (type === 'text' && part.text) texts.push(String(part.text));
    if (j.tokens || j.usage) { const u = j.tokens ?? j.usage; t.usage = { input: u.input ?? u.input_tokens ?? 0, output: u.output ?? u.output_tokens ?? 0, cacheRead: u.cache?.read ?? 0, cacheWrite: u.cache?.write ?? 0 }; }
  }
  t.finalText = texts.join('').slice(0, 2000);
  if (t.fired === 'unknown') t.fired = t.status !== 'ok' ? 'unknown' : 'none';
  if (r.code !== 0 && t.status === 'ok') { t.status = 'error'; t.error = (r.stderr || `exit ${r.code}`).trim().slice(-300); }
  return t;
}

export const RUNNERS: Record<string, (spec: RunSpec) => Promise<Trace>> = { 'claude-code': runClaude, codex: runCodex, opencode: runOpencode };
