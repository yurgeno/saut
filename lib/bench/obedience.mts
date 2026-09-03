// Obedience: did the run stay inside the artifact's declared allowlist? Compared in the
// Claude-shaped vocabulary every allowlist is written in. Scoped rules (`Bash(git diff *)`)
// are matched on the command prefix the way Claude Code documents it (`*` = any text; a
// trailing ` *` also matches the bare command; `:*` = ` *`).
import type { Artifact, HarnessCaps, ToolRef } from '../types.mts';
import type { Obedience, Trace } from './types.mts';

function specMatches(spec: string, digest: string): boolean {
  const s = spec.replace(/:\*$/, ' *').trim();
  if (s === '*' || s === '') return true;
  const parts = s.split('*');
  if (parts.length === 1) return digest.trim() === s;
  const re = new RegExp('^' + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  if (re.test(digest.trim())) return true;
  // trailing " *" also matches the bare command
  if (s.endsWith(' *') && digest.trim() === s.slice(0, -2)) return true;
  return false;
}

export function allowed(call: { neutral: string; digest: string }, list: ToolRef[]): boolean {
  // A compound shell command is allowed only when EVERY part matches SOME rule (Claude Code:
  // "a rule must match each subcommand independently").
  if ((call.neutral === 'Bash' || call.neutral === 'PowerShell') && /(?:&&|\|\||;|\|&|\|)/.test(call.digest)) {
    const parts = call.digest.split(/\s*(?:&&|\|\||;|\|&|\|)\s*/).filter(Boolean);
    return parts.length > 0 && parts.every((p) => allowed({ neutral: call.neutral, digest: p }, list));
  }
  for (const t of list) {
    if (t.mcp) {
      if (call.neutral === t.base) return true;
      if (t.mcp.tool === null && call.neutral.startsWith(`mcp__${t.mcp.server}__`)) return true;
      if (t.mcp.tool?.includes('*') && new RegExp('^' + t.base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(call.neutral)) return true;
      continue;
    }
    if (t.base !== call.neutral) continue;
    if (!t.spec) return true;
    if (specMatches(t.spec, call.digest)) return true;
  }
  return false;
}

// Skill-invocation calls are how the skill entered the run — never a violation of its own allowlist.
const AMBIENT = new Set(['Skill', 'ToolSearch', 'TaskOutput', 'TaskStop', 'TodoWrite', 'AskUserQuestion']);

export function obedience(a: Artifact, h: HarnessCaps, traces: Trace[]): Obedience | null {
  const list = a.kind === 'skill' ? a.allowedTools : a.tools;
  if (list === null) return { declared: [], observed: [...new Set(traces.flatMap((t) => t.tools.map((c) => c.neutral)))], violations: [], denied: [], enforcement: 'no allowlist declared — nothing to obey' };
  const observed = new Set<string>(); const violations = new Set<string>(); const denied = new Set<string>();
  for (const t of traces) {
    if (t.case.expect === 'no-fire') continue;                 // the control run does not use the skill
    for (const c of t.tools) {
      observed.add(c.neutral === 'Bash' ? `Bash(${c.digest})` : c.neutral);
      if (c.denied) { denied.add(c.neutral === 'Bash' ? `Bash(${c.digest})` : c.neutral); continue; }
      if (AMBIENT.has(c.neutral)) continue;
      if (!allowed(c, list)) violations.add(c.neutral === 'Bash' ? `Bash(${c.digest})` : c.neutral);
    }
  }
  return { declared: list.map((t) => t.raw), observed: [...observed], violations: [...violations], denied: [...denied], enforcement: a.kind === 'skill' ? h.toolAllowlist : h.agentAllowlist };
}
