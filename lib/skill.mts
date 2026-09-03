// Artifact loading: discover and parse SKILL.md skills and agent definitions.
//
// Discovery is format-driven, not layout-driven: any `SKILL.md` below a root is a skill
// (its directory name is the skill id — the Agent Skills spec), any markdown file with a
// `name:` + `description:` frontmatter under an `agents/` directory (or `.claude/agents`,
// `.opencode/agents`) is an agent. TAUT packs (`skills/`, `<project>/skills/`, `agents/`)
// fall out of the same walk without a special case.
import path from 'node:path';
import { parseFrontmatter, bodyOf } from './frontmatter.mts';
import type { AgentArtifact, Artifact, Diagnostic, SkillArtifact, ToolRef } from './types.mts';
import { exists, fail, isDir, readText, walk } from './util.mts';

const AGENT_DIRS = new Set(['agents', '.claude/agents', '.opencode/agents']);

export function parseToolRef(raw: string): ToolRef {
  const s = raw.trim();
  const m = s.match(/^([^()\s]+)\((.*)\)$/s);
  const base = m ? m[1] : s;
  const spec = m ? m[2] : null;
  let mcp: ToolRef['mcp'] = null;
  const mm = base.match(/^mcp__([^_]+(?:_[^_]+)*?)(?:__(.+))?$/);
  if (mm) mcp = { server: mm[1], tool: mm[2] ?? null };
  return { raw: s, base, spec, mcp };
}

// `allowed-tools` / `tools` come as a list OR a comma/space-separated string (Claude Code
// accepts both); normalize to ToolRef[]. `null` = the key is absent.
export function toolList(v: unknown): ToolRef[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map((x) => parseToolRef(String(x)));
  if (typeof v === 'string') {
    if (v.trim() === '') return [];
    // split on commas outside parentheses
    const parts: string[] = [];
    let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean).map(parseToolRef);
  }
  return [];
}

// A tool-list key duplicated across capability-marker branches: the UNION of all branches
// (every grant that can ship somewhere counts; the TAUT adapter judges each branch exactly).
function toolUnion(fm: { data: Record<string, unknown>; all: Record<string, unknown[]> }, key: string): ToolRef[] | null {
  const vals = fm.all[key] ?? (fm.data[key] === undefined ? [] : [fm.data[key]]);
  if (!vals.length) return null;
  const seen = new Map<string, ToolRef>();
  for (const v of vals) for (const t of toolList(v) ?? []) if (!seen.has(t.raw)) seen.set(t.raw, t);
  return [...seen.values()];
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v === undefined || v === null ? null : String(v);
}

export async function loadSkill(file: string): Promise<SkillArtifact> {
  const text = await readText(file);
  const fm = parseFrontmatter(text, file);
  const d = fm.data;
  const dir = path.dirname(file);
  const name = str(d.name) ?? path.basename(dir);
  return {
    kind: 'skill',
    name,
    path: file,
    dir,
    fm,
    description: str(d.description) ?? '',
    body: bodyOf(text, fm),
    allowedTools: toolUnion(fm, 'allowed-tools'),
    disallowedTools: toolUnion(fm, 'disallowed-tools'),
    modelInvocable: d['disable-model-invocation'] !== true,
    userInvocable: d['user-invocable'] !== false,
    model: str(d.model),
    effort: str(d.effort),
    metadata: d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, unknown>) : null,
  };
}

export async function loadAgent(file: string): Promise<AgentArtifact> {
  const text = await readText(file);
  const fm = parseFrontmatter(text, file);
  const d = fm.data;
  return {
    kind: 'agent',
    name: str(d.name) ?? path.basename(file, '.md'),
    path: file,
    fm,
    description: str(d.description) ?? '',
    body: bodyOf(text, fm),
    tools: toolUnion(fm, 'tools'),
    model: str(d.model),
  };
}

function looksLikeAgentPath(file: string): boolean {
  const parts = file.split(path.sep);
  const parent = parts[parts.length - 2] ?? '';
  const grand = parts[parts.length - 3] ?? '';
  return AGENT_DIRS.has(parent) || AGENT_DIRS.has(`${grand}/${parent}`);
}

// Resolve CLI targets (files or directories) to artifacts. A directory holding SKILL.md
// is one skill; any other directory is walked.
export interface Discovered { artifacts: Artifact[]; failures: Diagnostic[]; ignored: string[] }

// A linter pointed at a tree of third-party skills must survive one unreadable or malformed
// file: the failure becomes a diagnostic against that path, and the walk continues.
export async function discoverDetailed(targets: string[]): Promise<Discovered> {
  const artifacts: Artifact[] = [];
  const failures: Diagnostic[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  const add = async (file: string) => {
    const abs = path.resolve(file);
    if (seen.has(abs)) return;
    seen.add(abs);
    try {
      if (path.basename(abs) === 'SKILL.md') artifacts.push(await loadSkill(abs));
      else if (abs.endsWith('.md') && looksLikeAgentPath(abs)) {
        const a = await loadAgent(abs);
        if (a.fm.diagnostics.some((x) => x.code === 'no-frontmatter')) return;   // a README under agents/
        artifacts.push(a);
      }
    } catch (e) {
      failures.push({ code: 'load-failed', severity: 'high', message: `could not be read: ${(e as Error).message}`, path: abs });
    }
  };
  for (const t of targets) {
    const abs = path.resolve(t);
    if (!(await exists(abs))) fail(`no such path: ${t}`);
    if (await isDir(abs)) {
      if (await exists(path.join(abs, 'SKILL.md'))) { await add(path.join(abs, 'SKILL.md')); continue; }
      for await (const f of walk(abs)) await add(f);
    } else if (abs.endsWith('.md')) {
      if (path.basename(abs) === 'SKILL.md') await add(abs);
      else {
        try { artifacts.push(await loadAgent(abs)); }      // explicit file = trust the caller
        catch (e) { failures.push({ code: 'load-failed', severity: 'high', message: `could not be read: ${(e as Error).message}`, path: abs }); }
      }
    } else ignored.push(abs);                                // not a markdown target — say so, don't drop it silently
  }
  return { artifacts, failures, ignored };
}

export async function discover(targets: string[]): Promise<Artifact[]> {
  return (await discoverDetailed(targets)).artifacts;
}

// Prose EVIDENCE that a builtin tool is actually used by a body (for the dead-privilege
// rule): a shell fence or a command line is evidence of Bash, "spawn the subagent" of
// Agent, and so on. Read/Glob/Grep/Skill/AskUserQuestion/ToolSearch are ambient — never dead.
export const TOOL_EVIDENCE: Record<string, RegExp> = {
  Bash: /```(?:bash|sh|shell|zsh)|\B`(?:git|npm|npx|node|pnpm|yarn|docker|make|cargo|go|python3?|pip|mvn|gradle|glab|gh|curl|ls|cat|grep|find|rg|kill|pkill|lsof|cd|tools\/|\.\/|\$)[^`\n]*`|\b(?:shell|command[- ]line|run (?:the )?(?:command|script)|terminal)\b/i,
  PowerShell: /powershell|pwsh/i,
  Write: /\b(?:writes?|written|creates?|records?|saves?|scaffolds?|generates?|new)\b[^.\n]{0,80}\b(?:files?|\.md|\.json|report|draft|memory|stubs?|artifacts?|descriptors?|module|component|test)\b/i,
  Edit: /\b(?:edits?|modif(?:y|ies)|patch(?:es)?|updates?|appl(?:y|ies)|fix(?:es)?|refactor|rewrite|amend|implement(?:s|ation)?|changes?)\b[^.\n]{0,80}\b(?:file|code|repo|line|section|\.md|source|descriptor|artifact|change)\b|\bimplement(?:s|ation)?\b/i,
  NotebookEdit: /notebook|\.ipynb/i,
  Agent: /\b(?:sub-?agents?|spawn|delegat|launch(?:es|ed)?|dispatch|isolated context|separate context|parallel (?:agents|workers)|fan[- ]out)\b/i,
  WebFetch: /\b(?:fetch(?:es)?|web ?page|https?:\/\/|url)\b/i,
  WebSearch: /\b(?:web ?search|search the web|search online)\b/i,
  AskUserQuestion: /\b(?:ask(?:s|ed)? (?:the )?(?:user|owner)|question|confirm(?:ation)? (?:from|with) the owner|owner (?:decides|picks|chooses)|wait for the owner)\b/i,
  Skill: /\bskill/i,
  Monitor: /\bmonitor|watch(?:es)? (?:the )?(?:log|output)/i,
  TodoWrite: /\btodo|checklist|task list/i,
  Workflow: /\bworkflow/i,
  SendMessage: /\bmessage/i,
  LSP: /\bLSP\b|language server/i,
};
export const AMBIENT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill', 'AskUserQuestion', 'ToolSearch', 'TaskOutput', 'TaskStop', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode']);

// Tool mentions in a body: fully-qualified MCP names always; builtin names only when the
// text treats them as an identifier (backticks, `Tool(`, or "the Tool tool") — plain prose
// like "read the file" is not a Read reference. `evidence` = prose evidence per TOOL_EVIDENCE.
export function bodyToolMentions(body: string, builtins: Iterable<string>): { mcp: Set<string>; builtin: Set<string>; evidence: Set<string> } {
  const mcp = new Set<string>(body.match(/mcp__[A-Za-z0-9_-]+?(?:__[A-Za-z0-9_.*-]+)?(?=[^A-Za-z0-9_.*-]|$)/g) ?? []);
  const builtin = new Set<string>();
  const evidence = new Set<string>();
  for (const t of builtins) {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\`${esc}(?:\\([^)]*\\))?\`|\\b${esc}\\(|\\b${esc} tool\\b|\\btool ${esc}\\b`).test(body)) builtin.add(t);
    if (AMBIENT_TOOLS.has(t) || TOOL_EVIDENCE[t]?.test(body) || new RegExp(`\\b${esc}\\b`).test(body)) evidence.add(t);
  }
  return { mcp, builtin, evidence };
}
