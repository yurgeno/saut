// Lint rules — privilege semantics and correctness, per harness. Every rule cites the
// review finding it operationalizes (S1… / C1… / T1… = ~/lab/plans/TAUT_DATA_SECURITY_REVIEW.md,
// 2026-08-24) or the external source (Claude Code docs, Reversec/Datadog research).
//
// No score. A finding is a finding; the per-harness `enforcement` column says whether the
// declared allowlist is a restriction, a grant, prose, or dropped on that harness.
import type { AgentArtifact, Artifact, Diagnostic, HarnessCaps, ToolRef, ToolRegistry } from './types.mts';
import { bodyToolMentions } from './skill.mts';
import { classifyTool } from './tools.mts';

export interface LintOptions {
  harnesses: HarnessCaps[];
  registry: ToolRegistry;
  descriptionChars?: number;             // budget; default = Claude Code listing cap
  agentsByName?: Map<string, AgentArtifact>;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit', 'write', 'edit', 'apply_patch']);   // Bash/PowerShell: judged by the bash-unscoped rule
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'shell']);
const WRITE_MCP = /(write|create|update|delete|draft|push|commit|send|post|set_|put_)/i;
// A read-only CLAIM about the artifact itself — not "the tracker is read-only" in passing:
// the description says so, or a body line opens with it, or "this skill/agent never writes".
const READONLY_CLAIM_DESC = /(?<!\b(?:repos?|repositories|tracker|jira|git|scm|branch(?:es)?|store|member repos?)\s(?:(?:stay|stays|remain|remains|are|is)\s)?)\b(?:read[- ]only(?! (?:tool|token|PAT|mode|access|call|api|on code|analysis of))|never writes?|does not write|observation[- ]only|non-mutating)\b/i;
const READONLY_CLAIM_BODY = /^\s*(?:>|\*\*|[-*] )?\s*read[- ]only\b|\bthis (?:skill|agent) (?:is read[- ]only|never writes|does not write|must not write)|\bNEVER writes\b/im;
const EXTERNAL_INPUT = /\b(jira|ticket|tracker|attachment|webfetch|websearch|web page|url|http[s]?:\/\/|context7|mcp__atlassian|mcp__context7|scrap|fetch)\b/i;
const UNTRUSTED_RULE = /\b(untrusted|treat(?:ed)? as data|is data,? not|not (?:as )?instructions?|prompt[- ]injection|never follow instructions)\b/i;
const INJECTION = [
  { re: /ignore (?:all |any )?(?:previous|prior|above) instructions/i, what: '"ignore previous instructions" phrase' },
  { re: /[​-‏⁠﻿‪-‮]/, what: 'invisible/bidi Unicode control characters' },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|node|python)\b/i, what: 'download-and-execute pipeline' },
  { re: /\b(?:cat|echo|printf)\b[^\n]*(?:\.env|id_rsa|\.aws\/credentials|\.netrc)/i, what: 'reads credential files' },
];
const SECRET = [
  /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
];
const DYNAMIC_CONTEXT = /!`[^`]+`/;

function d(a: Artifact, code: string, severity: Diagnostic['severity'], message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity, message, path: a.path, ...extra };
}

function isWriteRef(t: ToolRef): boolean {
  if (t.mcp) return !!t.mcp.tool && WRITE_MCP.test(t.mcp.tool);
  return WRITE_TOOLS.has(t.base);
}

export function enforcementFor(a: Artifact, h: HarnessCaps): string {
  return a.kind === 'skill' ? h.toolAllowlist : h.agentAllowlist;
}

export function lintArtifact(a: Artifact, o: LintOptions): Diagnostic[] {
  const out: Diagnostic[] = [...a.fm.diagnostics];
  const primary = o.harnesses.find((h) => h.id === 'claude-code') ?? o.harnesses[0];
  // mention detection uses the PascalCase (Claude-Code-shaped) names every allowlist is written in;
  // lowercase OpenCode/Codex names collide with English words
  const builtinsAll = new Set([...(primary?.builtinTools ?? []), ...(primary?.legacyTools ?? [])]);
  const list = a.kind === 'skill' ? a.allowedTools : a.tools;
  const listKey = a.kind === 'skill' ? 'allowed-tools' : 'tools';
  const listLine = a.fm.lines[listKey];
  const mentions = bodyToolMentions(a.body, builtinsAll);
  const claimsReadOnly = READONLY_CLAIM_DESC.test(a.description) || READONLY_CLAIM_BODY.test(a.body.slice(0, 2500));

  if (!a.name) out.push(d(a, 'missing-name', 'high', 'frontmatter has no `name`'));
  if (!a.description) out.push(d(a, 'missing-description', 'high', 'frontmatter has no `description` — the harness cannot route to this artifact'));
  const cap = o.descriptionChars ?? primary?.listing.descCap ?? 1536;
  if (a.description.length > cap)
    out.push(d(a, 'description-too-long', a.description.length > cap * 1.5 ? 'medium' : 'low', `description is ${a.description.length} chars (budget ${cap}); it is paid in EVERY session — keep the routing sentence, move the method into the body`, { line: a.fm.lines.description, precedent: 'T1' }));

  // ---- allowlist presence / semantics -------------------------------------------------
  if (list === null) {
    out.push(d(a, 'no-allowlist', a.kind === 'skill' ? 'high' : 'medium',
      a.kind === 'skill'
        ? 'no `allowed-tools` — on Claude Code the skill runs with the session\'s full toolset (Write, Edit, Agent, web, every MCP tool)'
        : 'no `tools:` — the agent inherits every tool of the parent session',
      { precedent: 'S1' }));
  } else {
    for (const t of list) {
      for (const h of o.harnesses) {
        const v = classifyTool(t, o.registry, h.id);
        if (h.id !== primary?.id && (v === 'unknown' || v === 'legacy')) continue;   // builtin names are Claude-Code-shaped; judge once
        if (v === 'unknown') out.push(d(a, 'unknown-tool', 'high', `"${t.raw}" is not a known tool name on ${h.title} — a dead name grants nothing and masks the capability loss`, { line: listLine, harness: h.id }));
        else if (v === 'legacy') out.push(d(a, 'legacy-tool', 'info', `"${t.base}" is a legacy tool name on ${h.title}`, { line: listLine, harness: h.id }));
        else if (v === 'mcp-unknown-server') out.push(d(a, 'unknown-mcp-server', 'high', `"${t.raw}" names MCP server "${t.mcp!.server}", which the catalog does not list`, { line: listLine, precedent: 'C1' }));
        else if (v === 'mcp-unknown-tool') out.push(d(a, 'unknown-mcp-tool', 'high', `"${t.raw}" is not among the tools the catalog lists for server "${t.mcp!.server}"`, { line: listLine, precedent: 'C1' }));
      }
    }
    // dead privileges: granted, never referenced
    for (const t of list) {
      if (t.spec) continue;                                   // scoped rules are deliberate
      // MCP: the exact name, the server (`atlassian`), or the tool's first word (`jira`) in prose count as evidence
      const serverWord = t.mcp ? new RegExp(`\\b${t.mcp.server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
      const toolWord = t.mcp?.tool ? new RegExp(`\\b${t.mcp.tool.split(/[_-]/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
      const referenced = t.mcp
        ? [...mentions.mcp].some((m) => m === t.base || (t.mcp!.tool === null && m.startsWith(`mcp__${t.mcp!.server}__`)) || (t.mcp!.tool?.includes('*') && m.startsWith(t.base.replace('*', ''))))
          || (serverWord?.test(a.body) ?? false) || (toolWord && toolWord.source.length > 6 && toolWord.test(a.body))
        : mentions.builtin.has(t.base) || mentions.evidence.has(t.base);
      if (!referenced) out.push(d(a, 'dead-privilege', 'medium', `"${t.raw}" is granted but the body never mentions it — remove it, or say where it is used`, { line: listLine, precedent: 'S4' }));
    }
    // body cites a tool the allowlist does not carry (silent degradation)
    const declaredMcp = list.filter((t) => t.mcp);
    for (const m of mentions.mcp) {
      const server = m.match(/^mcp__([^_]+(?:_[^_]+)*?)(?:__|$)/)?.[1] ?? '';
      const wildcard = m.endsWith('*') || !m.includes('__', 5);
      const ok = declaredMcp.some((t) => t.base === m
        || (wildcard && t.mcp!.server === server)
        || (t.mcp!.tool === null && m.startsWith(`mcp__${t.mcp!.server}__`))
        || (t.mcp!.tool?.includes('*') && m.startsWith(t.base.replace(/\*.*$/, ''))));
      if (!ok) out.push(d(a, 'body-tool-not-allowed', 'high', `body cites ${m}, which is not in \`${listKey}\` — the harness will not have it (or will prompt); the feature is dead or degraded`, { precedent: 'C1' }));
    }
    for (const b of mentions.builtin) {
      if (!list.some((t) => t.base === b) && !(a.kind === 'skill' && a.disallowedTools?.some((t) => t.base === b)))
        out.push(d(a, 'body-tool-not-allowed', 'medium', `body uses \`${b}\` as a tool, which is not in \`${listKey}\``, { precedent: 'C1' }));
    }
    // unscoped Bash on a read-only role where the harness supports scoping
    if (claimsReadOnly && list.some((t) => (t.base === 'Bash' || t.base === 'PowerShell') && !t.spec) && primary?.toolScopedSyntax)
      out.push(d(a, 'bash-unscoped-readonly', 'medium', 'claims read-only but grants bare `Bash` — narrow it to the verbs it needs (`Bash(git status *)`, …) where the harness supports scoped rules', { line: listLine, precedent: 'S7' }));
    // agent writes through Bash because Write was not granted
    if (a.kind === 'agent' && /\b(writes?|records?|saves?)\b[^.\n]{0,60}\b(\.md|file|report)\b/i.test(a.description + ' ' + a.body.slice(0, 2000))
      && list.some((t) => t.base === 'Bash') && !list.some((t) => t.base === 'Write' || t.base === 'Edit'))
      out.push(d(a, 'agent-writes-via-bash', 'medium', 'the agent is described as writing a file but has `Bash` and no `Write`/`Edit` — Bash is a superset of Write; grant the narrow tool', { line: listLine, precedent: 'S3' }));
  }

  // ---- read-only claim vs privileges ---------------------------------------------------
  const writers = (list ?? []).filter(isWriteRef);
  const shells = (list ?? []).filter((t) => SHELL_TOOLS.has(t.base));
  if (claimsReadOnly && (list === null || writers.length)) {
    out.push(d(a, 'readonly-claim-vs-writes', 'medium',
      list === null
        ? 'description/body promise read-only, but with no allowlist every writing tool is available'
        : `description/body promise read-only, but the allowlist grants ${writers.map((t) => t.raw).join(', ')}`,
      { line: listLine ?? a.fm.lines.description, precedent: 'C3' }));
  }
  // read-only NOT enforced anywhere: grant ≠ restriction
  if (claimsReadOnly && a.kind === 'skill') {
    const hasDeny = !!a.disallowedTools?.length;
    const grant = o.harnesses.filter((h) => h.toolAllowlist === 'grant');
    const prose = o.harnesses.filter((h) => h.toolAllowlist === 'prose' || h.toolAllowlist === 'dropped');
    if (grant.length && !hasDeny)
      out.push(d(a, 'readonly-not-enforced', 'high', `on ${grant.map((h) => h.title).join('/')} \`allowed-tools\` only PRE-APPROVES; a read-only promise needs \`disallowed-tools\` (or a settings deny rule) — today it holds on prose alone`, { harness: grant.map((h) => h.id).join(','), precedent: 'grant≠restriction' }));
    if (prose.length)
      out.push(d(a, 'readonly-not-enforced', 'medium', `on ${prose.map((h) => h.id).join('/')} the tool allowlist is informational — the read-only promise is prose only`, { harness: prose.map((h) => h.id).join(','), precedent: 'S7' }));
  }

  // ---- model invocation ------------------------------------------------------------
  if (a.kind === 'skill') {
    const expensiveRole = /(stack-engine|spa-mock|run-stack|docker|bring(?:s)? up the stack)/i.test(JSON.stringify(a.metadata ?? {}) + ' ' + a.description);
    const mutators = [...writers, ...shells.filter((t) => !t.spec)];
    if (a.modelInvocable && (list === null || mutators.length || expensiveRole))
      out.push(d(a, 'model-invocable-writer', 'high',
        `model may invoke this skill on its own (no \`disable-model-invocation: true\`) and it ${list === null ? 'has the full toolset' : mutators.length ? `can mutate (${mutators.map((t) => t.raw).join(', ')})` : 'drives an expensive runtime'}`,
        { line: a.fm.lines['disable-model-invocation'] ?? a.fm.lines.name, precedent: 'S2' }));
    const supervised = /\b(supervised|owner (?:must|has to) (?:approve|confirm)|never (?:run )?unattended)\b/i.test(a.body);
    if (a.modelInvocable && supervised)
      out.push(d(a, 'supervised-but-auto', 'high', 'body demands supervision but the model may invoke the skill autonomously', { precedent: 'S2' }));
    if (!a.userInvocable && !a.modelInvocable)
      out.push(d(a, 'unreachable', 'high', '`user-invocable: false` AND `disable-model-invocation: true` — nobody can invoke this skill'));
  }

  // ---- dynamic context + Bash ----------------------------------------------------------
  if (DYNAMIC_CONTEXT.test(a.body)) {
    const bare = list === null || list.some((t) => (t.base === 'Bash' || t.base === 'PowerShell') && !t.spec);
    out.push(d(a, 'dynamic-context', bare ? 'high' : 'medium', 'body contains dynamic context (!`cmd`) — it EXECUTES before the model sees anything; with bare Bash granted this is the malicious-skill pattern (Reversec/Datadog 2026)', { precedent: 'Reversec' }));
  }

  // ---- untrusted external content ----------------------------------------------------
  if (EXTERNAL_INPUT.test(a.body) && !UNTRUSTED_RULE.test(a.body))
    out.push(d(a, 'untrusted-content-rule', 'medium', 'the artifact pulls external content (tracker/web/attachments/MCP docs) but states no rule that such content is DATA, not instructions', { precedent: 'S5' }));

  // ---- injection heuristics / secrets --------------------------------------------------
  for (const p of INJECTION) if (p.re.test(a.body)) out.push(d(a, 'injection-heuristic', 'medium', `body contains ${p.what}`, { precedent: 'ToxicSkills' }));
  for (const p of SECRET) if (p.test(a.body) || p.test(a.fm.data ? JSON.stringify(a.fm.data) : '')) out.push(d(a, 'secret-pattern', 'high', 'a secret-shaped value appears in the artifact', { precedent: 'scan-secrets' }));

  // ---- TAUT wiring (generic checks: shape only; the adapter validates against the pack) --
  if (a.kind === 'skill' && a.metadata?.taut && typeof a.metadata.taut === 'object') {
    const w = a.metadata.taut as Record<string, unknown>;
    const mcpRoles = Array.isArray(w.mcp) ? w.mcp.map(String) : [];
    for (const role of mcpRoles) {
      const server = o.registry.servers.find((s) => s.role === role);
      if (o.registry.servers.length && !server) out.push(d(a, 'taut-mcp-role-unknown', 'medium', `metadata.taut.mcp names role "${role}", which no catalog server carries`, { precedent: 'C2' }));
      else if (server && !server.tools.some((t) => mentions.mcp.has(t)) && ![...mentions.mcp].some((m) => m.startsWith(`mcp__${server.serverKey}__`)))
        out.push(d(a, 'taut-mcp-role-unused', 'low', `metadata.taut.mcp declares role "${role}" (server ${server.serverKey}) but the body never calls its tools (delegated to agents?) — the key is documentary in the engine anyway`, { precedent: 'C2' }));
    }
    if (Array.isArray(w.agents) && o.agentsByName?.size)   // only when agents were in scope at all
      for (const ag of w.agents) if (!o.agentsByName.has(String(ag))) out.push(d(a, 'taut-agent-missing', 'high', `metadata.taut.agents names "${ag}" but no such agent was found`));
  }

  return dedupe(out);
}

function dedupe(ds: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return ds.filter((x) => { const k = `${x.code}|${x.harness ?? ''}|${x.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function sortDiags(ds: Diagnostic[]): Diagnostic[] {
  return [...ds].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0));
}

// Per-harness enforcement matrix for one artifact.
export function matrix(a: Artifact, harnesses: HarnessCaps[]): { harness: string; allowlist: string; degradations: string[] }[] {
  return harnesses.map((h) => ({ harness: h.id, allowlist: enforcementFor(a, h), degradations: h.degradations.map((x) => x.id) }));
}

// SARIF 2.1.0 — the interchange format CI/IDE tooling reads (same as Cisco skill-scanner).
export function toSarif(ds: Diagnostic[], version: string): unknown {
  const rules = [...new Set(ds.map((x) => x.code))].map((id) => ({ id, shortDescription: { text: id } }));
  const level = (s: string) => (s === 'high' ? 'error' : s === 'medium' ? 'warning' : 'note');
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'saut', version, informationUri: 'https://github.com/yurgeno/saut', rules } },
      results: ds.map((x) => ({
        ruleId: x.code, level: level(x.severity), message: { text: x.message + (x.harness ? ` [${x.harness}]` : '') },
        locations: [{ physicalLocation: { artifactLocation: { uri: x.path }, region: { startLine: x.line ?? 1 } } }],
      })),
    }],
  };
}
