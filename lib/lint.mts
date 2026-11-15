// Lint rules — privilege semantics and correctness, per harness. Every rule cites the
// review finding it operationalizes (S1… / C1… / T1… = ~/lab/plans/TAUT_DATA_SECURITY_REVIEW.md,
// 2026-08-24) or the external source (Claude Code docs, Reversec/Datadog research).
//
// No score. A finding is a finding; the per-harness `enforcement` column says whether the
// declared allowlist is a restriction, a grant, prose, or dropped on that harness.
import type { Evidence, AgentArtifact, Artifact, Autofix, Diagnostic, HarnessCaps, ToolRef, ToolRegistry } from './types.mts';
import { bodyToolMentions, evidenceIn } from './skill.mts';
import path from 'node:path';
import { classifyTool } from './tools.mts';
import { docFor, ruleInfo } from './rules.mts';

export const SPEC_DESCRIPTION_MAX = 1024;

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
// the description says so, or a body paragraph, heading-led line, quote or list item opens with
// it, or "this skill/agent never writes". Scoped uses are not claims: "tracker access is
// strictly read-only", a mid-sentence "(read-only)" after the object it qualifies (a closing
// "(read-only)." is a claim), "the read-only state of …", and a hard-wrapped line that merely
// starts with the word.
const READONLY_CLAIM_DESC = /(?<!\b(?:repos?|repositories|tracker|jira|git|scm|branch(?:es)?|store|member repos?|access)\s(?:(?:stay|stays|remain|remains|are|is)\s)?(?:(?:strictly|always|fully|absolutely)\s)?)(?<!\bthe\s)(?:(?<!\()|(?=read[- ]only\)\s*(?:[.;]|$)))\b(?:read[- ]only(?! (?:tool|token|PAT|mode|access|call|api|on code|analysis of))|never writes?|does not write|observation[- ]only|non-mutating)\b/i;
const READONLY_CLAIM_BODY = /(?:^|\n[ \t]*\n|(?:^|\n)#[^\n]*\n)[ \t]*read[- ]only\b|(?:^|\n)[ \t]*(?:>[ \t]*|\*\*|(?:>[ \t]*)?(?:[-*]|\d+\.)[ \t]+(?:\*\*)?)read[- ]only\b|\bthis (?:skill|agent) (?:is read[- ]only|never writes|does not write|must not write)|\bNEVER writes\b/i;
// Content the artifact PULLS IN from outside — not a link it shows the reader: a bare URL in
// "Full docs: https://…" fetches nothing.
// A ticket or issue counts when the text READS it ("fetch it from the issue tracker", "read the
// jira ticket"), not when it writes one or names the tracker: "split it into tickets", "/to-tickets".
const EXTERNAL_INPUT = /\b((?:read|pull|load|open|get|download|triage|go through|look up)(?:s|es|ed|ing)?\s+(?:(?:the|a|an|each|every|its|their|all|open|new|incoming|linked)\s+)?(?:[\w-]+\s+){0,2}?(?:jira|tickets?|issues?|attachments?)|from (?:the |a |its )?(?:issue )?tracker|webfetch|websearch|web ?search|web pages?|context7|mcp__atlassian|mcp__context7|scrap\w*|fetch(?:es|ed|ing)?|(?:issue|pull request|PR|review) comments?|(?:open|read|load|download)s? (?:the |a |each )?(?:url|link|page)s?)\b|\bhttps?:\/\/\S*\{|\$\{?url\b/i;
// What raises a missing allowlist from hygiene to risk: the text tells the agent to change
// files (an edit verb aimed at code or files) or to run a command that changes something.
// Stricter than the per-tool evidence the dead-privilege rule uses — a false positive here
// inflates severity, which is the noise this exists to cut.
const EDIT_INTENT = /(?<!\b(?:the|these|those|scattered|small|many|multiple|such|of|by|your|its|their)\s)\b(?:edit|modify|patch|rewrite|refactor|fix|implement|create|write|delete|remove|rename|apply|add|commit)(?:s|es|ed|ing|ted|ting)?\s+(?:(?:the|a|an|this|that|each|every|your|its|new|all|missing|any)\s+)?(?:[\w-]+\s+){0,2}?(?:files?|code|functions?|modules?|tests?|class(?:es)?|components?|patch(?:es)?|commits?|bugs?|root cause|lines?|imports?|work|changes|features?)\b/i;
const SHELL_MUTATION = /(?:```(?:bash|sh|shell|zsh)[^`]*?|\b(?:run|execute|call)s?\s+`)[^`]*\b(?:git\s+(?:commit|push|reset|checkout|rebase|merge|rm|clean)|rm\s+-|mv\s|sed\s+-i|npm\s+(?:install|publish)|pip\s+install|chmod|chown|curl\b[^`]*\|\s*(?:sh|bash))/i;
// "read-only" about the skill, not about a thing it uses ("a read-only token", "in read-only mode")
const NO_CHANGE_CLAIM = /\b(?:changes nothing|report[- ]only|(?<!\bin )read[- ]only(?![- ](?:[\w-]+ )?(?:tool|token|PAT|mode|access|call|api|credentials?|scope|key|connection|user|replica|database|db|mount|copy|view|branch|repo|clone)s?\b)|one[- ]shot (?:report|display)|does not (?:change|modify|edit|write)|never (?:changes|modifies|edits|writes)|do not (?:change|modify|edit|write) (?:any|the) (?:code|files?))\b/i;
// Index of the first match not negated within its clause ("do not edit the files"), or -1.
function intentAt(text: string, re: RegExp): number {
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
    const start = Math.max(text.lastIndexOf('.', m.index), text.lastIndexOf(';', m.index), text.lastIndexOf('\n', m.index), text.lastIndexOf('—', m.index)) + 1;
    if (!/\b(?:no|not|never|without|cannot|nothing|\w+n't)\b/i.test(text.slice(start, m.index + m[0].length))) return m.index;
  }
  return -1;
}
const clip = (t: string, n = 100) => { const s = t.trim().replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const UNTRUSTED_RULE = /\b(untrusted|treat(?:ed)? as data|is data,? not|not (?:as )?instructions?|never (?:an? )?instructions?|never instructs? you|prompt[- ]injection|never follow instructions)\b/i;
// Each probe returns the index of its first match in the body, or -1.
const byRe = (re: RegExp) => (s: string): number => re.exec(s)?.index ?? -1;
// curl|wget … | sh on one line. Linear: find each pipe into an interpreter, then look for the
// download before it on that line — one regex with `[^\n]*` between the two backtracks
// quadratically on a long line (an untrusted skill could stall a CI lint).
export function downloadExec(s: string): number {
  let off = 0;
  for (const l of s.split('\n')) {
    for (const m of l.matchAll(/\|\s*(?:sh|bash|zsh|node|python)\b/gi)) {
      const c = /\b(?:curl|wget)\b/i.exec(l.slice(0, m.index));
      if (c) return off + c.index;
    }
    off += l.length + 1;
  }
  return -1;
}
export const INJECTION: { find: (s: string) => number; what: string }[] = [
  { find: byRe(/ignore (?:all |any )?(?:previous|prior|above) instructions/i), what: 'contains an "ignore previous instructions" phrase' },
  { find: byRe(/[​-‏⁠﻿‪-‮]/), what: 'contains invisible/bidi Unicode control characters' },
  { find: downloadExec, what: 'contains a download-and-execute pipeline' },
  // the credential file must be the command's ARGUMENT — "never echo credentials; fill
  // `.taut/local.env`" is a prohibition in prose, not a read
  { find: byRe(/\b(?:cat|less|more|head|tail|echo|printf|base64)\s+(?:-\w+\s+)*["'`]?[\w$~./-]*(?:\.env\b|id_rsa|\.aws\/credentials|\.netrc)/i), what: 'reads a credential file' },
];
export const SECRET = [
  /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
];
const DYNAMIC_CONTEXT = /!`[^`]+`/;

function d(a: Artifact, code: string, severity: Diagnostic['severity'], message: string, extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity, message, path: a.path, ...extra };
}

// 1-based file line of the first body match — findings about the body point at it.
function bodyLine(a: Artifact, re: RegExp): number | undefined {
  const m = re.exec(a.body);
  return m ? lineAt(a, m.index) : undefined;
}
const lineAt = (a: Artifact, index: number): number => a.fm.bodyOffset + a.body.slice(0, index).split('\n').length - 1;

// Current names for tools older harness versions called otherwise.
const LEGACY_REPLACEMENT: Record<string, string> = { MultiEdit: 'Edit', LS: 'Glob', NotebookRead: 'Read', Task: 'Agent', SlashCommand: 'Skill' };

// Does the artifact promise read-only — in its description, or at the top of its body?
export function claimsReadOnlyOf(a: Artifact): boolean {
  return READONLY_CLAIM_DESC.test(a.description) || READONLY_CLAIM_BODY.test(a.body.slice(0, 2500));
}

function isWriteRef(t: ToolRef): boolean {
  if (t.mcp) return !!t.mcp.tool && WRITE_MCP.test(t.mcp.tool);
  return WRITE_TOOLS.has(t.base);
}

export function enforcementFor(a: Artifact, h: HarnessCaps): string {
  return a.kind === 'skill' ? h.toolAllowlist : h.agentAllowlist;
}

// The body without lines that describe OTHER skills ("- **`/handoff`** writes a markdown file"):
// a router listing them is not asking for that itself.
const ownBody = (a: Artifact) => a.body.replace(/^[ \t]*(?:[-*]|\d+\.)?[ \t]*(?:\*\*)?`\/[\w:-]+`.*$/gm, '');
// Does the artifact read outside content (a ticket, an issue, a web page)? The same test the
// privilege rules use as evidence; the report counts it as a capability.
export const readsOutsideContent = (a: Artifact) => ownBody(a).search(EXTERNAL_INPUT) >= 0;

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
  const claimsReadOnly = claimsReadOnlyOf(a);
  // Severity follows evidence, not the mere absence of a key: does the text ask for changes or
  // a shell, and does untrusted content come in? The two together are the injection-to-write
  // chain a missing allowlist leaves open; either alone is a weaker case; neither is hygiene.
  // A router that describes OTHER skills ("- **`/handoff`** writes a markdown file") is not
  // asking for that itself: lines led by a slash-command reference are someone else's job.
  const own = ownBody(a);
  const prose = `${a.description ?? ''}\n${own}`;
  // an explicit "changes nothing" / "report only" from the author outweighs a stray edit verb in a
  // proposal ("propose fixes that delete code"); a shell that mutates or dynamic context does not
  // Where a prose index lands: the description's frontmatter line, or the body line (`own` keeps
  // the body's line structure, so a line count maps straight back).
  const descLen = (a.description ?? '').length + 1;
  const bodyLines = a.body.split('\n');
  const at = (i: number, inProse: boolean): Pick<Evidence, 'line' | 'quote'> => {
    if (i < 0) return {};
    if (inProse && i < descLen) return { line: a.fm.lines.description, quote: clip(a.description ?? '') };
    const before = (inProse ? prose.slice(descLen, i) : a.body.slice(0, i)).split('\n');
    const n = before.length - 1, col = before[n].length, text = bodyLines[n] ?? '';
    // centre long lines on the match, so the quote shows the words that were read
    return { line: a.fm.bodyOffset + n, quote: col > 50 && text.length > 100 ? '…' + clip(text.slice(col - 30), 99) : clip(text) };
  };
  const noChangeAt = prose.search(NO_CHANGE_CLAIM);
  const saysNoChange = noChangeAt >= 0;
  const editAt = saysNoChange ? -1 : intentAt(prose.replace(/\bClaude Code\b/g, 'Claude'.padEnd(11)), EDIT_INTENT);
  const shellAt = a.body.search(SHELL_MUTATION), dynAt = a.body.search(DYNAMIC_CONTEXT);
  const asksToMutate = editAt >= 0 || shellAt >= 0 || dynAt >= 0;
  const untrustedAt = own.search(EXTERNAL_INPUT);   // an index into `own`: map it through prose (desc + \n + own), which keeps the body's lines
  const takesUntrusted = untrustedAt >= 0;
  const mutateEv: Evidence = editAt >= 0 ? { says: 'asks for changes', found: true, ...at(editAt, true) }
    : shellAt >= 0 ? { says: 'runs a shell command that changes things', found: true, ...at(shellAt, false) }
    : dynAt >= 0 ? { says: 'runs a command before the model reads it (dynamic context)', found: true, ...at(dynAt, false) }
    : saysNoChange ? { says: 'the author says it changes nothing', found: false, ...at(noChangeAt, true) }
    : { says: 'no request to change files or run a mutating command', found: false };
  const untrustedEv: Evidence = takesUntrusted ? { says: 'reads outside content (ticket, issue, web page)', found: true, ...at(descLen + untrustedAt, true) }
    : { says: 'no ticket, issue, web page or other outside content read', found: false };

  if (!a.name) out.push(d(a, 'missing-name', 'high', 'frontmatter has no `name`'));
  if (!a.description) out.push(d(a, 'missing-description', 'high', 'frontmatter has no `description` — the harness cannot route to this artifact'));
  // The Agent Skills specification caps a skill `description` at 1024 characters. Loaders
  // accept more today, but a stricter loader (or a Skills API upload) drops or rejects it.
  const descChars = [...a.description].length;
  if (a.kind === 'skill' && descChars > SPEC_DESCRIPTION_MAX)
    out.push(d(a, 'description-over-spec', 'high', `description is ${descChars} characters — the Agent Skills specification allows ${SPEC_DESCRIPTION_MAX}; shorten it (lead with when to use it) or a strict loader drops the skill`, { line: a.fm.lines.description, precedent: 'agentskills.io/specification' }));
  const cap = o.descriptionChars ?? primary?.listing.descCap ?? 1536;
  if (a.description.length > cap)
    out.push(d(a, 'description-too-long', a.description.length > cap * 1.5 ? 'medium' : 'low', `description is ${a.description.length} chars (budget ${cap}); it is paid in EVERY session — keep the routing sentence, move the method into the body`, { line: a.fm.lines.description, precedent: 'T1' }));

  // ---- allowlist presence / semantics -------------------------------------------------
  if (list === null) {
    const why = asksToMutate && takesUntrusted ? ' — it reads untrusted content and asks for changes or a shell, so injected text can act with every tool'
      : asksToMutate ? ' — its text asks for changes or a shell; nothing narrows what it may touch'
      : ' — its text reads or reports only, so this is least-privilege hygiene';
    // one finding for one problem: with no allowlist, "the model may also start it on its own" is
    // part of this finding (and its mechanical mitigation), not a second one
    const auto = a.kind === 'skill' && a.modelInvocable && asksToMutate;
    out.push(d(a, 'no-allowlist', asksToMutate && takesUntrusted ? 'high' : asksToMutate ? 'medium' : 'low',
      (a.kind === 'skill'
        ? 'no `allowed-tools` — on Claude Code the skill runs with the session\'s full toolset (Write, Edit, Agent, web, every MCP tool)'
        : 'no `tools:` — the agent inherits every tool of the parent session') + why + (auto ? '; the model may also start it on its own' : ''),
      { precedent: 'S1', evidence: [mutateEv, untrustedEv], ...(auto && a.kind === 'skill' && a.userInvocable ? { autofix: { op: 'set', key: 'disable-model-invocation', value: true, label: 'Set disable-model-invocation: true (until it has an allowlist)', safety: 'review' } as Autofix, line: a.fm.lines.name } : {}) }));
  } else {
    for (const t of list) {
      for (const h of o.harnesses) {
        const v = classifyTool(t, o.registry, h.id);
        if (h.id !== primary?.id && (v === 'unknown' || v === 'legacy')) continue;   // builtin names are Claude-Code-shaped; judge once
        if (v === 'unknown') out.push(d(a, 'unknown-tool', 'medium', `"${t.raw}" is not a known tool name on ${h.title} — a dead name grants nothing and masks the capability loss`, { line: listLine, harness: h.id }));
        else if (v === 'legacy') {
          const now = LEGACY_REPLACEMENT[t.base];
          const autofix: Autofix | undefined = !now || t.spec ? undefined
            : list.some((x) => x.base === now)
              ? (list.length > 1 ? { op: 'list-remove', key: listKey, item: t.raw, label: `Remove ${t.raw} (${now} is already granted)`, safety: 'safe' } : undefined)
              : { op: 'list-replace', key: listKey, item: t.raw, with: now, label: `Replace ${t.raw} with ${now}`, safety: 'safe' };
          out.push(d(a, 'legacy-tool', 'info', `"${t.base}" is a legacy tool name on ${h.title}${now ? ` — the current name is ${now}` : ''}`, { line: listLine, harness: h.id, autofix }));
        }
        else if (v === 'mcp-unknown-server') out.push(d(a, 'unknown-mcp-server', 'medium', `"${t.raw}" names MCP server "${t.mcp!.server}", which the catalog does not list`, { line: listLine, precedent: 'C1' }));
        else if (v === 'mcp-unknown-tool') out.push(d(a, 'unknown-mcp-tool', 'medium', `"${t.raw}" is not among the tools the catalog lists for server "${t.mcp!.server}"`, { line: listLine, precedent: 'C1' }));
      }
    }
    // dead privileges: granted, never referenced. The description counts as evidence too
    // ("writes memory/…/_raw.md" is a Write); so does a templated `mcp__<serverKey>__…` or a
    // pointer at the allowlist itself ("the tracker tools listed in the frontmatter") — the body
    // calls every granted server — and a catalog role word ("the tracker MCP", "a docs server").
    const prose = `${a.body}\n${a.description ?? ''}`;
    const templatedMcp = /\bmcp__<[^>\n]+>|\btools (?:listed |granted )?in (?:the |your |this )?(?:frontmatter|allowlist)\b/i.test(a.body);
    for (const t of list) {
      if (t.spec) continue;                                   // scoped rules are deliberate
      // MCP: the exact name, the server (`atlassian`), or the tool's first word (`jira`) in prose count as evidence
      const serverWord = t.mcp ? new RegExp(`\\b${t.mcp.server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
      const toolWord = t.mcp?.tool ? new RegExp(`\\b${t.mcp.tool.split(/[_-]/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
      const role = t.mcp ? o.registry.servers.find((sv) => sv.serverKey === t.mcp!.server)?.role : undefined;
      const roleWord = role ? new RegExp(`\\b${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(?:MCP|servers?|tools?)\\b`, 'i') : null;
      const referenced = t.mcp
        ? [...mentions.mcp].some((m) => m === t.base || (t.mcp!.tool === null && m.startsWith(`mcp__${t.mcp!.server}__`)) || (t.mcp!.tool?.includes('*') && m.startsWith(t.base.replace('*', ''))))
          || templatedMcp || (serverWord?.test(prose) ?? false) || (toolWord && toolWord.source.length > 6 && toolWord.test(prose)) || (roleWord?.test(prose) ?? false)
        : mentions.builtin.has(t.base) || mentions.evidence.has(t.base) || evidenceIn(a.description ?? '', t.base);
      if (!referenced) out.push(d(a, 'dead-privilege', 'low', `"${t.raw}" is granted but the body never mentions it — remove it, or say where it is used`,
        { line: listLine, precedent: 'S4', autofix: list.length > 1 ? { op: 'list-remove', key: listKey, item: t.raw, label: `Remove ${t.raw} from ${listKey}`, safety: 'review' } : undefined }));
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
      if (!ok) out.push(d(a, 'body-tool-not-allowed', 'medium', `body cites ${m}, which is not in \`${listKey}\` — the harness will not have it (or will prompt); the feature is dead or degraded`, { precedent: 'C1', line: bodyLine(a, new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) }));
    }
    for (const b of mentions.builtin) {
      if (!list.some((t) => t.base === b) && !(a.kind === 'skill' && a.disallowedTools?.some((t) => t.base === b)))
        out.push(d(a, 'body-tool-not-allowed', 'low', `body uses \`${b}\` as a tool, which is not in \`${listKey}\``, { precedent: 'C1', line: lineAt(a, mentions.builtinAt.get(b)!) }));
    }
    // unscoped Bash on a read-only role where the harness supports scoping
    if (claimsReadOnly && list.some((t) => (t.base === 'Bash' || t.base === 'PowerShell') && !t.spec) && primary?.toolScopedSyntax)
      out.push(d(a, 'bash-unscoped-readonly', 'medium', 'claims read-only but grants bare `Bash` — narrow it to the verbs it needs (`Bash(git status *)`, …) where the harness supports scoped rules', { line: listLine, precedent: 'S7', harness: primary.id }));
    // agent writes through Bash because Write was not granted
    if (a.kind === 'agent' && /\b(writes?|records?|saves?)\b[^.\n]{0,60}\b(\.md|file|report)\b/i.test(a.description + ' ' + a.body.slice(0, 2000))
      && list.some((t) => t.base === 'Bash') && !list.some((t) => t.base === 'Write' || t.base === 'Edit'))
      out.push(d(a, 'agent-writes-via-bash', 'low', 'the agent is described as writing a file but has `Bash` and no `Write`/`Edit` — Bash is a superset of Write; grant the narrow tool', { line: listLine, precedent: 'S3' }));
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
      out.push(d(a, 'readonly-not-enforced', 'medium', `on ${grant.map((h) => h.title).join('/')} \`allowed-tools\` only PRE-APPROVES; a read-only promise needs \`disallowed-tools\` (or a settings deny rule) — today it holds on prose alone`,
        { harness: grant.map((h) => h.id).join(','), precedent: 'grant≠restriction', autofix: { op: 'list-add', key: 'disallowed-tools', items: ['Write', 'Edit'], label: 'Add disallowed-tools: Write, Edit', safety: 'review' } }));
    if (prose.length)
      out.push(d(a, 'readonly-not-enforced', 'low', `on ${prose.map((h) => h.id).join('/')} the tool allowlist is informational — the read-only promise is prose only`, { harness: prose.map((h) => h.id).join(','), precedent: 'S7' }));
  }

  // ---- model invocation ------------------------------------------------------------
  if (a.kind === 'skill') {
    const expensiveRole = /(stack-engine|spa-mock|run-stack|docker|bring(?:s)? up the stack)/i.test(JSON.stringify(a.metadata ?? {}) + ' ' + a.description);
    const mutators = [...writers, ...shells.filter((t) => !t.spec)];
    // only when a person can still start it — otherwise the fix would make it unreachable
    const userOnly: Autofix | undefined = a.userInvocable ? { op: 'set', key: 'disable-model-invocation', value: true, label: 'Set disable-model-invocation: true', safety: 'review' } : undefined;
    // without an allowlist the full toolset alone is the no-allowlist finding; this one needs the
    // skill to actually ask for changes (or to be granted mutators, or to drive a costly runtime)
    // with no allowlist this is part of no-allowlist; here: mutators granted, or a costly runtime
    const autoMutates = list !== null && mutators.length > 0;
    if (a.modelInvocable && (autoMutates || (expensiveRole && list !== null)))
      out.push(d(a, 'model-invocable-writer', autoMutates && takesUntrusted ? 'high' : 'medium',
        `model may invoke this skill on its own (no \`disable-model-invocation: true\`) and it ${mutators.length ? `can mutate (${mutators.map((t) => t.raw).join(', ')})` : 'drives an expensive runtime'}${autoMutates && takesUntrusted ? ' — and it reads untrusted content' : ''}`,
        { line: a.fm.lines['disable-model-invocation'] ?? a.fm.lines.name, precedent: 'S2', autofix: userOnly, ...(autoMutates ? { evidence: [{ says: `granted ${mutators.map((t) => t.raw).join(', ')}`, found: true, line: listLine }, untrustedEv] } : {}) }));
    const SUPERVISED = /\b(supervised|owner (?:must|has to) (?:approve|confirm)|never (?:run )?unattended)\b/i;
    if (a.modelInvocable && SUPERVISED.test(a.body))
      out.push(d(a, 'supervised-but-auto', 'medium', 'body demands supervision but the model may invoke the skill autonomously', { precedent: 'S2', line: bodyLine(a, SUPERVISED), autofix: userOnly }));
    if (!a.userInvocable && !a.modelInvocable)
      out.push(d(a, 'unreachable', 'high', '`user-invocable: false` AND `disable-model-invocation: true` — nobody can invoke this skill',
        { line: a.fm.lines['user-invocable'], autofix: { op: 'set', key: 'user-invocable', value: true, label: 'Set user-invocable: true', safety: 'safe' } }));
  }

  // ---- dynamic context + Bash ----------------------------------------------------------
  if (DYNAMIC_CONTEXT.test(a.body)) {
    const bare = list === null || list.some((t) => (t.base === 'Bash' || t.base === 'PowerShell') && !t.spec);
    out.push(d(a, 'dynamic-context', bare ? 'high' : 'medium', 'body contains dynamic context (!`cmd`) — it EXECUTES before the model sees anything; with bare Bash granted this is the malicious-skill pattern (Reversec/Datadog 2026)', { precedent: 'Reversec', line: bodyLine(a, DYNAMIC_CONTEXT) }));
  }

  // ---- untrusted external content ----------------------------------------------------
  // matters when injected text could act: the artifact can change things or run a shell
  const canAct = list === null ? asksToMutate : writers.length > 0 || shells.length > 0;
  if (takesUntrusted && !UNTRUSTED_RULE.test(a.body))
    out.push(d(a, 'untrusted-content-rule', canAct ? 'medium' : 'low', 'the artifact pulls external content (tracker/web/attachments/MCP docs) but states no rule that such content is DATA, not instructions', { precedent: 'S5', line: untrustedEv.line, evidence: [untrustedEv, list === null ? mutateEv : { says: canAct ? `granted ${[...writers, ...shells].map((t) => t.raw).join(', ')}` : 'no write or shell tool granted', found: canAct, line: listLine }] }));

  // ---- injection heuristics / secrets --------------------------------------------------
  for (const p of INJECTION) {
    const at = p.find(a.body);
    if (at < 0) continue;
    const lineText = a.body.slice(a.body.lastIndexOf('\n', at) + 1).split('\n')[0].trim();
    // show the line so the reader can judge it — but never echo invisible control characters
    const shown = /[\u200B-\u200F\u2060\uFEFF\u202A-\u202E]/.test(lineText) ? '' : `: "${lineText.length > 90 ? lineText.slice(0, 87) + '…' : lineText}"`;
    out.push(d(a, 'injection-heuristic', /invisible|download/.test(p.what) ? 'high' : 'medium', `body ${p.what}${shown}`, { precedent: 'ToxicSkills', line: lineAt(a, at) }));
  }
  for (const p of SECRET) if (p.test(a.body) || p.test(a.fm.data ? JSON.stringify(a.fm.data) : '')) out.push(d(a, 'secret-pattern', 'high', 'a secret-shaped value appears in the artifact', { precedent: 'scan-secrets', line: bodyLine(a, p) }));

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
  return ds.filter((x) => { const k = `${x.code}|${x.harness ?? ''}|${x.line ?? ''}|${x.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
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
// `vcs`: the target was a remote repository fetched into a throwaway directory — the URIs stay
// relative to its root and the run records which repository and commit they belong to.
export function toSarif(ds: Diagnostic[], version: string, base?: string, vcs?: { repositoryUri: string; revisionId: string; branch?: string }): unknown {
  const rules = [...new Set(ds.map((x) => x.code))].map((id) => {
    const info = ruleInfo(id);
    return info
      ? { id, name: info.title, shortDescription: { text: info.title }, fullDescription: { text: info.why }, help: { text: info.fix }, helpUri: docFor(id) }
      : { id, shortDescription: { text: id } };
  });
  const level = (s: string) => (s === 'high' ? 'error' : s === 'medium' ? 'warning' : 'note');
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'saut', version, informationUri: 'https://github.com/yurgeno/saut', rules } },
      ...(vcs ? { versionControlProvenance: [{ repositoryUri: vcs.repositoryUri, revisionId: vcs.revisionId, ...(vcs.branch ? { branch: vcs.branch } : {}), mappedTo: { uriBaseId: 'ROOT' } }] }
        : base ? { originalUriBaseIds: { ROOT: { uri: `file://${base.endsWith('/') ? base : base + '/'}` } } } : {}),
      results: ds.map((x) => ({
        ruleId: x.code, level: level(x.severity), message: { text: x.message + (x.harness ? ` [${x.harness}]` : '') },
        ...(x.suppressed ? { suppressions: [{ kind: 'external', justification: x.suppressed.reason }] } : {}),
        // GitHub code scanning needs a URI relative to a checkout root; an absolute local
        // path either fails upload or attaches findings to a file nobody has.
        locations: [{ physicalLocation: { artifactLocation: { uri: base ? path.relative(base, x.path) : x.path, uriBaseId: base ? 'ROOT' : undefined }, region: { startLine: x.line ?? 1 } } }],
        // why this severity: the lines it rests on (code scanning shows related locations) and the full list
        ...(x.evidence ? {
          relatedLocations: x.evidence.filter((e) => e.found && e.line).map((e, id) => ({ id, message: { text: e.says }, physicalLocation: { artifactLocation: { uri: base ? path.relative(base, x.path) : x.path, uriBaseId: base ? 'ROOT' : undefined }, region: { startLine: e.line } } })),
          properties: { evidence: x.evidence },
        } : {}),
      })),
    }],
  };
}
