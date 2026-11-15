// `saut report <dir | git url>` — one complete document for a repository: what was scanned
// (repository, commit, when, with which guidance), the totals, security at a glance, and per
// skill or agent its enforcement on every harness, its cost and every finding with how to fix
// it. Built from the same runLint / runCost the other verbs call; rendered as Markdown (the
// default), a self-contained HTML page, or JSON.
import path from 'node:path';
import { runCost, runLint, VERSION, type Opts } from './commands.mts';
import { guidanceStatus } from './guidance.mts';
import { matrix } from './lint.mts';
import { active } from './suppress.mts';
import type { Diagnostic } from './types.mts';
import { rel as relShown, shownText } from './util.mts';
// inside the report a path is relative to the repository — the header names repository and commit
const rel = (p: string) => relShown(p).replace(/^.*?@[0-9a-f]{12}\//, '');
import { liveFindings, unitsOf, type Unit, type UnitFinding } from './copies.mts';
import type { Surface } from './workspace.mts';

// "security" counts what the Studio counts (security rules + a content scanner); the at-a-glance
// table adds the privilege rules that make an injection dangerous, as the Studio's card does
const isSecurity = (x: Diagnostic) => x.category === 'security' || x.category === 'scanner';
const atGlance = isSecurity;
const SEV = ['high', 'medium', 'low', 'info'] as const;

export interface ReportFinding { code: string; category: string | null; title: string | null; severity: string; line: number | null; harness: string | null; message: string; fix: string | null; why: string | null; doc: string | null; heuristic: boolean; guidance: { class: string; verifiedAt: string; sources: string[] } | null; autofix: string | null; suppressed: string | null; file: string | null; in: string[] | null; evidence: { says: string; found: boolean; line: number | null; quote: string | null }[] | null }
export interface ReportArtifact { kind: string; name: string; label: string; path: string; copies: string[]; identical: boolean; description: string; counts: Record<string, number>; enforcement: { harness: string; allowlist: string }[]; cost: { alwaysOnTokens: number; invokeTokens: number; transitiveTokens: number; over: string[] } | null; findings: ReportFinding[] }
export interface ReportWorkspaceUnit { kind: string; label: string; paths: string[]; identical: boolean; counts: Record<string, number>; findings: ReportFinding[] }
export interface ReportWorkspace {
  files: number; byKind: Record<string, number>;
  instructions: { paths: string[]; harnesses: string[]; tokens: number | null; note: string | null }[];
  hooks: { event: string; matcher: string | null; run: string; file: string }[];
  mcp: { name: string; transport: string; target: string; file: string }[];
  code: { path: string; runBy: string[]; via: string[]; can: string[] }[];
  units: ReportWorkspaceUnit[];      // with findings only
}
export interface Report {
  tool: { name: 'saut'; version: string };
  generatedAt: string;
  source: { kind: 'remote'; url: string; ref: string | null; commit: string; path: string | null } | { kind: 'local'; path: string };
  harnesses: string[];
  guidance: { verifiedAt: string; stale: boolean };
  taut: { deployment: string | null } | null;
  notes: string[];
  totals: { artifacts: number; files: number; skills: number; agents: number; workspaceFiles: number; high: number; medium: number; low: number; info: number; security: number; fixable: number; suppressed: number; repeated: number; guidanceA: number; guidanceB: number; guidanceD: number; alwaysOnTokens: number; instructionTokens: number; invokeTokens: number };
  security: { code: string; title: string; severity: string; groups: { severity: string; artifacts: string[] }[]; artifacts: string[] }[];
  artifacts: ReportArtifact[];
  workspace: ReportWorkspace;
  other: ReportFinding[];          // findings anchored to no artifact (a model ladder, saut.json)
  verdict: { exit: number; reason: string };
}

const finding = (x: Diagnostic, u?: Unit, f?: { paths: string[] }): ReportFinding => ({
  code: x.code, category: x.category ?? null, title: x.title ?? null, severity: x.severity, line: x.line ?? null, harness: x.harness ?? null,
  message: shownText(x.message), fix: x.autofix ? null : x.fix ?? null, why: x.why ?? null, doc: x.doc ?? null, heuristic: !!x.heuristic,
  guidance: x.guidance ? { class: x.guidance.class, verifiedAt: x.guidance.verifiedAt, sources: x.guidance.sources } : null,
  autofix: x.autofix?.label ?? null, suppressed: x.suppressed?.reason ?? null,
  file: u && x.path !== u.paths[0] ? rel(x.path) : null,
  in: u && f && u.paths.length > 1 && f.paths.length < u.paths.length ? f.paths.map(rel) : null,
  evidence: x.evidence ? x.evidence.map((e) => ({ says: e.says, found: e.found, line: e.line ?? null, quote: e.quote ? shownText(e.quote) : null })) : null,
});
// "why this severity", one line per fact: + found (line N: "quote"), − looked for and absent
const evidenceLine = (e: NonNullable<ReportFinding['evidence']>[number]) => `${e.found ? '+' : '−'} ${e.says}${e.line ? ` — line ${e.line}` : ''}${e.quote ? `: “${e.quote}”` : ''}`;
const countsOf = (fs: UnitFinding[]) => {
  const on = fs.filter((f) => !f.d.suppressed).map((f) => f.d);
  return Object.fromEntries([...SEV.map((s) => [s, on.filter((x) => x.severity === s).length]), ['security', on.filter(isSecurity).length], ['suppressed', fs.length - on.length]]);
};
const CAN: [keyof NonNullable<Surface['caps']>, string][] = [['network', 'network'], ['subprocess', 'runs processes'], ['background', 'background process'], ['readsInput', 'reads hook input'], ['credentials', 'credentials'], ['dynamicCode', 'dynamic code']];

// The agent workspace as one block — the same in the report and in the Studio: what loads into
// every session, what the harness runs, the MCP servers, the code behind them, and the files
// with findings (copies merged). `relp` names a path the way the caller shows paths.
export function workspaceSection(surfaces: Surface[], units: Unit[], relp: (p: string) => string): ReportWorkspace {
  const wsUnits = units.filter((u) => u.surface);
  const fnd = (x: Diagnostic, u: Unit, f: { paths: string[] }): ReportFinding => ({ ...finding(x), file: x.path !== u.paths[0] ? relp(x.path) : null, in: u.paths.length > 1 && f.paths.length < u.paths.length ? f.paths.map(relp) : null });
  return {
    files: surfaces.length,
    byKind: surfaces.reduce((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {} as Record<string, number>),
    instructions: wsUnits.filter((u) => u.kind === 'instructions').map((u) => ({ paths: u.paths.map(relp), harnesses: [...new Set(u.paths.map((p) => surfaces.find((s) => s.path === p)!.harness))], tokens: u.surface!.tokens, note: u.surface!.note })),
    hooks: surfaces.flatMap((s) => s.hooks.map((k) => ({ event: k.event, matcher: k.matcher, run: k.command ?? k.url ?? k.type, file: relp(s.path) }))),
    mcp: surfaces.flatMap((s) => s.mcp.map((m) => ({ name: m.name, transport: m.transport, target: m.url ?? m.command ?? '', file: relp(s.path) }))),
    code: surfaces.filter((s) => s.kind === 'code').map((s) => ({ path: relp(s.path), runBy: s.reachedBy.map(shownText), via: s.via, can: CAN.filter(([k]) => s.caps?.[k]).map(([, n]) => n) })),
    units: wsUnits.filter((u) => u.findings.length).map((u) => ({ kind: u.kind, label: u.paths.length > 1 ? u.paths.map(relp).join(', ') : relp(u.paths[0]), paths: u.paths.map(relp), identical: u.identical, counts: countsOf(u.findings), findings: u.findings.map((f) => fnd(f.d, u, f)) }))
      .sort((p, q) => (q.counts.high - p.counts.high) || (q.counts.medium - p.counts.medium) || p.label.localeCompare(q.label)),
  };
}

export async function buildReport(targets: string[], opts: Opts): Promise<Report> {
  const lint = await runLint(targets, opts);
  const { lines } = await runCost(targets, { ...opts, preloaded: { artifacts: lint.artifacts, harnesses: lint.harnesses, taut: lint.taut } });
  const root = path.resolve(lint.taut ? lint.taut.packRoot : targets[0] ?? '.');
  const { units, other } = unitsOf(lint.artifacts, lint.surfaces, lint.diagnostics, (p) => path.relative(root, p).split(path.sep).join('/') || path.basename(p));
  const live = active(lint.diagnostics);
  const uniq = liveFindings(units, other);
  const sev = (s: string) => uniq.filter((x) => x.severity === s).length;
  const g = (c: string) => uniq.filter((x) => x.guidance?.class === c).length;
  const byPath = new Map(lint.artifacts.map((a) => [a.path, a]));

  const artifacts: ReportArtifact[] = units.filter((u) => !u.surface).map((u) => {
    const a = byPath.get(u.paths[0])!;
    const l = lines.find((y) => y.artifact.path === a.path);
    return {
      kind: a.kind, name: a.name, label: a.name, path: rel(a.path), copies: u.paths.map(rel), identical: u.identical, description: a.description ?? '',
      counts: countsOf(u.findings),
      enforcement: matrix(a, lint.harnesses).map((m) => ({ harness: m.harness, allowlist: m.allowlist })),
      cost: l ? { alwaysOnTokens: l.line.alwaysOnTokens, invokeTokens: l.line.invokeTokens, transitiveTokens: l.line.transitive.reduce((n, t) => n + t.tokens, 0), over: l.over } : null,
      findings: u.findings.map((f) => finding(f.d, u, f)),
    };
  }).sort((p, q) => (q.counts.high - p.counts.high) || (q.counts.medium - p.counts.medium) || p.name.localeCompare(q.name));

  const workspace = workspaceSection(lint.surfaces, units, rel);

  const sec = new Map<string, { code: string; title: string; bySeverity: Map<string, Set<string>> }>();
  for (const u of units) for (const f of u.findings) {
    const x = f.d;
    if (x.suppressed || !atGlance(x)) continue;
    // one line per rule, its artifacts split by severity — the worst case never speaks for all
    const e = sec.get(x.code) ?? { code: x.code, title: x.title ?? x.code, bySeverity: new Map<string, Set<string>>() };
    if (!e.bySeverity.has(x.severity)) e.bySeverity.set(x.severity, new Set());
    e.bySeverity.get(x.severity)!.add(u.surface ? rel(x.path) : u.name);
    sec.set(x.code, e);
  }

  const remote = opts.remote?.length === 1 ? opts.remote[0] : null;
  const st = guidanceStatus(lint.harnesses);
  const high = sev('high'), medium = sev('medium');
  const found = lint.artifacts.length + lint.surfaces.length;
  const exit = !found ? 1 : high || (opts.strict && medium) ? 1 : 0;
  const instructionTokens = workspace.instructions.reduce((n, i) => n + (i.tokens ?? 0), 0);
  const skillsAlwaysOn = artifacts.reduce((n, a) => n + (a.cost?.alwaysOnTokens ?? 0), 0);
  return {
    tool: { name: 'saut', version: VERSION },
    generatedAt: new Date().toISOString(),
    source: remote ? { kind: 'remote', url: remote.spec.url, ref: remote.spec.ref, commit: remote.commit, path: remote.spec.subpath || null }
      : { kind: 'local', path: path.resolve(targets[0] ?? '.') },
    harnesses: lint.harnesses.map((h) => h.id),
    guidance: { verifiedAt: st.verifiedAt, stale: st.stale },
    taut: lint.taut ? { deployment: lint.taut.project?.name ?? null } : null,
    notes: [lint.note, lint.scanNote, lint.ignored.length ? `ignored (not a skill, agent, workspace file or directory): ${lint.ignored.map(rel).join(', ')}` : null].filter((n): n is string => !!n).map(shownText),
    totals: {
      artifacts: artifacts.length, files: lint.artifacts.length, skills: artifacts.filter((a) => a.kind === 'skill').length, agents: artifacts.filter((a) => a.kind === 'agent').length, workspaceFiles: lint.surfaces.length,
      high, medium, low: sev('low'), info: sev('info'), security: uniq.filter(isSecurity).length,
      fixable: uniq.filter((x) => x.autofix).length, suppressed: lint.diagnostics.length - live.length, repeated: live.length - uniq.length,
      guidanceA: g('A'), guidanceB: g('B'), guidanceD: g('D'),
      alwaysOnTokens: skillsAlwaysOn + instructionTokens, instructionTokens,
      invokeTokens: artifacts.reduce((n, a) => n + (a.cost?.invokeTokens ?? 0), 0),
    },
    security: [...sec.values()].map((e) => {
      const groups = [...e.bySeverity].sort((p, q) => SEV.indexOf(p[0] as typeof SEV[number]) - SEV.indexOf(q[0] as typeof SEV[number])).map(([severity, s]) => ({ severity, artifacts: [...s].sort() }));
      return { code: e.code, title: e.title, severity: groups[0].severity, groups, artifacts: groups.flatMap((g) => g.artifacts) };
    }).sort((p, q) => SEV.indexOf(p.severity as typeof SEV[number]) - SEV.indexOf(q.severity as typeof SEV[number]) || q.groups[0].artifacts.length - p.groups[0].artifacts.length || p.code.localeCompare(q.code)),
    artifacts,
    workspace,
    other: other.map((x) => ({ ...finding(x), message: `${rel(x.path)}${x.line ? `:${x.line}` : ''} — ${shownText(x.message)}` })),
    verdict: {
      exit,
      reason: !found ? 'no skills, agents or agent workspace files found' : high ? `${high} high finding(s)` : opts.strict && medium ? `${medium} medium finding(s) (--strict)` : 'no high findings',
    },
  };
}

const KIND_NAMES: Record<string, [string, string]> = { instructions: ['instruction file', 'instruction files'], command: ['command', 'commands'], settings: ['settings file', 'settings files'], mcp: ['MCP file', 'MCP files'], hooks: ['hook file', 'hook files'], manifest: ['manifest', 'manifests'], code: ['code module', 'code modules'] };
const kindsLine = (by: Record<string, number>) => Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${(KIND_NAMES[k] ?? [k, k])[n === 1 ? 0 : 1]}`).join(' · ');

// ---- Markdown ------------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const tick = (s: string) => '`' + s.replace(/`/g, "'") + '`';

function sourceLine(r: Report): string {
  return r.source.kind === 'remote'
    ? `${r.source.url}${r.source.ref ? ` · ref ${tick(r.source.ref)}` : ''} · commit ${tick(r.source.commit)}${r.source.path ? ` · path ${tick(r.source.path)}` : ''}`
    : tick(r.source.path);
}

export function toMarkdown(r: Report): string {
  const t = r.totals;
  const out: string[] = [];
  out.push(`# SAUT report — ${r.source.kind === 'remote' ? r.source.url.replace(/^https?:\/\//, '').replace(/\.git$/, '') : path.basename(r.source.path)}`, '');
  out.push(`- **Source:** ${sourceLine(r)}`);
  out.push(`- **Generated:** ${r.generatedAt.replace('T', ' ').slice(0, 16)} UTC by saut ${r.tool.version}`);
  out.push(`- **Harnesses:** ${r.harnesses.join(', ')}`);
  out.push(`- **Vendor guidance verified:** ${r.guidance.verifiedAt}${r.guidance.stale ? ' (stale — re-verify with `saut guidance`)' : ''}`);
  if (r.taut) out.push(`- **TAUT pack:** deployment ${r.taut.deployment ?? '—'}`);
  out.push(`- **Verdict:** ${r.verdict.exit ? '❌' : '✅'} ${r.verdict.reason}`);
  for (const n of r.notes) out.push(`- _${n}_`);
  out.push('', '## Summary', '');
  out.push('| Skills | Agents | Workspace files | High | Medium | Low | Security | Outdated (A) | Hypotheses (B) | Mechanical fixes | Suppressed | Tokens every session | Tokens on invoke |');
  out.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  out.push(`| ${t.skills} | ${t.agents} | ${t.workspaceFiles} | ${t.high} | ${t.medium} | ${t.low} | ${t.security} | ${t.guidanceA} | ${t.guidanceB} | ${t.fixable} | ${t.suppressed} | ${t.alwaysOnTokens} | ${t.invokeTokens} |`);
  out.push('', `_Counts are per finding, once for every copy of a skill or file (${t.repeated} repeated in copies). Tokens every session = skill listings + always-on instructions (${t.instructionTokens})._`);

  out.push('', '## Security at a glance', '');
  if (!r.security.length) out.push('No security or privilege findings. SAUT\'s own rules only — a content scanner (`--scan`) adds injection and exfiltration analysis.');
  else {
    out.push('| Severity | Rule | Where |', '|---|---|---|');
    for (const s of r.security) out.push(`| ${s.groups.map((g) => `${g.severity} ${g.artifacts.length}`).join(' · ')} | ${cell(s.title)} (${tick(s.code)}) | ${s.groups.map((g) => (s.groups.length > 1 ? `**${g.severity}:** ` : '') + cell(g.artifacts.join(', '))).join('<br>')} |`);
  }

  if (r.artifacts.length) {
    out.push('', '## Artifacts', '');
    out.push(`| Artifact | High | Medium | Low | Security | Always-on | On invoke | ${r.harnesses.join(' | ')} |`);
    out.push(`|---|---:|---:|---:|---:|---:|---:|${r.harnesses.map(() => '---').join('|')}|`);
    for (const a of r.artifacts)
      out.push(`| ${a.kind} **${cell(a.label)}** | ${a.counts.high} | ${a.counts.medium} | ${a.counts.low} | ${a.counts.security} | ${a.cost?.alwaysOnTokens ?? '—'} | ${a.cost ? a.cost.invokeTokens + (a.cost.transitiveTokens ? ` +${a.cost.transitiveTokens}` : '') : '—'} | ${a.enforcement.map((e) => e.allowlist).join(' | ')} |`);
  }

  for (const a of r.artifacts) {
    out.push('', `### ${a.kind} ${a.label}`, '');
    out.push(`${a.copies.length > 1 ? `${a.copies.length} copies${a.identical ? ', identical' : ', they differ'}: ${a.copies.map(tick).join(', ')}` : tick(a.path)}${a.description ? ` — ${cell(a.description)}` : ''}`, '');
    if (a.cost?.over.length) out.push(`**Over budget:** ${a.cost.over.join('; ')}`, '');
    if (!a.findings.length) { out.push('Clean.'); continue; }
    for (const f of a.findings) {
      const where = [f.line ? `line ${f.line}` : null, f.harness].filter(Boolean).join(' · ');
      const g = f.guidance ? ` · guidance ${f.guidance.class}, verified ${f.guidance.verifiedAt}` : '';
      out.push(`- **${f.suppressed ? 'suppressed' : f.severity}** ${tick(f.code)}${f.title ? ` ${f.title}` : ''}${where ? ` (${where})` : ''}${g}${f.heuristic ? ' · heuristic' : ''}`);
      out.push(`  ${f.message}${f.in ? ` _(in ${f.in.join(', ')})_` : ''}`);
      if (f.evidence && !f.suppressed) out.push(`  Why ${f.severity}:`, ...f.evidence.map((e) => `  ${evidenceLine(e)}  `));
      if (f.suppressed) out.push(`  Suppressed: ${f.suppressed}`);
      else if (f.autofix) out.push(`  Fix: ${f.autofix} (\`saut lint --fix\`)`);
      else if (f.fix) out.push(`  Fix: ${f.fix}`);
    }
  }

  // ---- the agent workspace ----
  const w = r.workspace;
  out.push('', '## Agent workspace', '');
  if (!w.files) out.push('No hooks, MCP servers, settings, instruction files, commands or plugin manifests found.');
  else {
    out.push(`${w.files} files: ${kindsLine(w.byKind)}.`);
    if (w.instructions.length) {
      out.push('', '**Loaded into every session**', '', '| File(s) | Harness | Tokens |', '|---|---|---:|');
      for (const i of w.instructions) out.push(`| ${i.paths.map(tick).join(', ')}${i.note ? ` _(${i.note})_` : ''} | ${i.harnesses.join(', ')} | ${i.tokens ?? '—'} |`);
    }
    if (w.hooks.length) {
      out.push('', '**Hooks and commands the harness runs**', '', '| Event | Runs | Declared in |', '|---|---|---|');
      for (const k of w.hooks) out.push(`| ${k.event}${k.matcher ? ` (${cell(k.matcher)})` : ''} | ${tick(k.run.length > 90 ? k.run.slice(0, 87) + '…' : k.run)} | ${tick(k.file)} |`);
    }
    if (w.mcp.length) {
      out.push('', '**MCP servers**', '', '| Server | Transport | Command / URL | File |', '|---|---|---|---|');
      for (const m of w.mcp) out.push(`| ${cell(m.name)} | ${m.transport} | ${tick(m.target)} | ${tick(m.file)} |`);
    }
    if (w.code.length) {
      out.push('', '**Code it runs** (read, never executed)', '', '| File | Run by | Can |', '|---|---|---|');
      for (const c of w.code) out.push(`| ${tick(c.path)} | ${cell(c.runBy.join('; ') || '—')}${c.via.length ? ` _via ${cell(c.via.join(', '))}_` : ''} | ${c.can.join(', ') || '—'} |`);
    }
    for (const u of w.units) {
      out.push('', u.paths.length > 1 ? `### ${u.kind} (${u.paths.length} copies)` : `### ${u.kind} ${tick(u.label)}`, '');
      if (u.paths.length > 1) out.push(u.paths.map(tick).join(', '), '');
      for (const f of u.findings) {
        out.push(`- **${f.suppressed ? 'suppressed' : f.severity}** ${tick(f.code)}${f.title ? ` ${f.title}` : ''}${f.file ? ` · ${tick(f.file)}` : ''}${f.line ? ` (line ${f.line})` : ''}${f.heuristic ? ' · heuristic' : ''}`);
        out.push(`  ${f.message}`);
        if (f.suppressed) out.push(`  Suppressed: ${f.suppressed}`);
        else if (f.fix) out.push(`  Fix: ${f.fix}`);
      }
    }
  }

  if (r.other.length) {
    out.push('', '## Other findings', '');
    for (const f of r.other) out.push(`- **${f.severity}** ${tick(f.code)} — ${f.message}${f.fix ? `\n  Fix: ${f.fix}` : ''}`);
  }
  out.push('', '---', '', `Rules: https://github.com/yurgeno/saut/blob/main/docs/RULES.md · enforcement: _restrict_ the harness holds the allowlist, _grant_ it pre-approves only, _prose_ / _dropped_ nothing holds it.`, '');
  return out.join('\n');
}

// ---- HTML: one self-contained file, light and dark ------------------------------------------

const h = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const code = (s: string) => h(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export function toHtml(r: Report): string {
  const t = r.totals;
  const title = r.source.kind === 'remote' ? r.source.url.replace(/^https?:\/\//, '').replace(/\.git$/, '') : path.basename(r.source.path);
  const src = r.source.kind === 'remote'
    ? `<a href="${h(r.source.url)}">${h(r.source.url)}</a>${r.source.ref ? ` · ref <code>${h(r.source.ref)}</code>` : ''} · commit <code>${h(r.source.commit)}</code>${r.source.path ? ` · path <code>${h(r.source.path)}</code>` : ''}`
    : `<code>${h(r.source.path)}</code>`;
  const card = (n: number | string, label: string, tone = '') => `<div class="stat ${tone}"><b>${h(n)}</b><span>${h(label)}</span></div>`;
  const pill = (s: string) => `<span class="sev ${h(s)}">${h(s)}</span>`;
  const enf = (s: string) => `<span class="enf ${h(s)}">${h(s)}</span>`;
  const findingHtml = (f: ReportFinding) => `<li class="${f.suppressed ? 'muted' : ''}">${pill(f.suppressed ? 'suppressed' : f.severity)} <code>${h(f.code)}</code> ${h(f.title ?? '')}` +
    `<span class="meta">${[f.line ? `line ${f.line}` : '', f.harness ?? '', f.guidance ? `guidance ${f.guidance.class} · verified ${f.guidance.verifiedAt}` : '', f.heuristic ? 'heuristic' : ''].filter(Boolean).map(h).join(' · ')}</span>` +
    (f.file ? ` <code>${h(f.file)}</code>` : '') + `<div>${code(f.message)}${f.in ? ` <span class="muted">(in ${h(f.in.join(', '))})</span>` : ''}</div>` +
    (f.evidence && !f.suppressed ? `<div class="ev"><span class="muted">Why ${h(f.severity)}:</span>${f.evidence.map((e) => `<div class="${e.found ? 'yes' : 'no'}">${h(evidenceLine(e))}</div>`).join('')}</div>` : '') +
    (f.suppressed ? `<div class="fix">Suppressed: ${h(f.suppressed)}</div>` : f.autofix ? `<div class="fix">Fix: ${h(f.autofix)} (<code>saut lint --fix</code>)</div>` : f.fix ? `<div class="fix">Fix: ${code(f.fix)}</div>` : '') +
    (f.guidance?.sources.length ? `<div class="meta">${f.guidance.sources.filter((s) => /^https?:/.test(s)).map((s) => `<a href="${h(s)}">${h(s.replace(/^https?:\/\//, ''))}</a>`).join(' · ')}</div>` : '') + '</li>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAUT report — ${h(title)}</title>
<style>
:root { --bg:#ffffff; --panel:#f6f7f9; --text:#1c2230; --muted:#5d6676; --border:#dfe3ea; --hi:#c0392b; --med:#b7791f; --ok:#2f855a; --accent:#2b5fd9; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1218; --panel:#171c25; --text:#dde2ea; --muted:#8a93a3; --border:#283041; --hi:#ef8b8b; --med:#e4b45e; --ok:#6fd49a; --accent:#7aa5ff; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width:1100px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:22px; margin:0 0 8px; } h2 { font-size:17px; margin:28px 0 10px; } h3 { font-size:15px; margin:0 0 4px; }
a { color:var(--accent); } code { font:12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--panel); border:1px solid var(--border); border-radius:4px; padding:0 4px; overflow-wrap:anywhere; }
.meta, .muted { color:var(--muted); } .ev { font-size:12.5px; margin:2px 0 0 8px; } .ev .no { color:var(--muted); } .meta { font-size:12px; margin-left:6px; }
dl { display:grid; grid-template-columns:max-content 1fr; gap:4px 12px; margin:0; } dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
.stats { display:grid; grid-template-columns:repeat(auto-fill, minmax(130px, 1fr)); gap:8px; }
.stat { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:10px 12px; } .stat b { display:block; font-size:20px; } .stat span { color:var(--muted); font-size:12px; }
.stat.bad b { color:var(--hi); } .stat.warn b { color:var(--med); } .stat.good b { color:var(--ok); }
.wrap { overflow-x:auto; border:1px solid var(--border); border-radius:8px; }
table { border-collapse:collapse; width:100%; font-size:13px; } th, td { padding:6px 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; } th { color:var(--muted); font-weight:600; white-space:nowrap; } td.n { text-align:right; font-variant-numeric:tabular-nums; }
.sev { display:inline-block; font-size:11px; border-radius:999px; padding:0 7px; border:1px solid var(--border); } .sev.high { color:var(--hi); border-color:currentColor; } .sev.medium { color:var(--med); border-color:currentColor; } .sev.low, .sev.info, .sev.suppressed { color:var(--muted); }
.enf { font-size:11px; } .enf.restrict { color:var(--ok); } .enf.grant { color:var(--med); } .enf.prose, .enf.dropped { color:var(--hi); }
.art { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px 14px; margin:10px 0; }
td code, li > code { white-space:nowrap; }
.art ul { margin:8px 0 0; padding-left:18px; } .art li { margin:6px 0; } .fix { color:var(--muted); font-size:13px; }
.verdict { font-weight:600; } .verdict.fail { color:var(--hi); } .verdict.pass { color:var(--ok); }
</style></head><body><main>
<h1>SAUT report — ${h(title)}</h1>
<dl>
<dt>Source</dt><dd>${src}</dd>
<dt>Generated</dt><dd>${h(r.generatedAt.replace('T', ' ').slice(0, 16))} UTC · saut ${h(r.tool.version)}</dd>
<dt>Harnesses</dt><dd>${h(r.harnesses.join(', '))}</dd>
<dt>Guidance</dt><dd>vendor guidance verified ${h(r.guidance.verifiedAt)}${r.guidance.stale ? ' — stale, re-verify with <code>saut guidance</code>' : ''}</dd>
${r.taut ? `<dt>TAUT pack</dt><dd>deployment ${h(r.taut.deployment ?? '—')}</dd>` : ''}
<dt>Verdict</dt><dd class="verdict ${r.verdict.exit ? 'fail' : 'pass'}">${h(r.verdict.reason)}</dd>
${r.notes.map((n) => `<dt></dt><dd class="muted">${h(n)}</dd>`).join('')}
</dl>
<h2>Summary</h2>
<div class="stats">${card(t.artifacts, 'skills and agents')}${card(t.workspaceFiles, 'workspace files')}${card(t.high, 'high findings', t.high ? 'bad' : 'good')}${card(t.medium, 'medium findings', t.medium ? 'warn' : 'good')}${card(t.security, 'security findings', t.security ? 'warn' : 'good')}${card(t.guidanceA, 'outdated settings (A)')}${card(t.guidanceB, 'prompt hypotheses (B)')}${card(t.fixable, 'mechanical fixes')}${card(t.alwaysOnTokens, 'tokens every session')}${card(t.invokeTokens, 'tokens on invoke')}${t.suppressed ? card(t.suppressed, 'suppressed') : ''}</div>
<p class="muted">Counts are per finding, once for every copy of a skill or file${t.repeated ? ` (${t.repeated} more repeated in copies)` : ''}. Tokens every session = skill listings + always-on instructions (${t.instructionTokens}).</p>
<h2>Security at a glance</h2>
${r.security.length ? `<div class="wrap"><table><tr><th>Severity</th><th>Rule</th><th>Where</th></tr>${r.security.map((s) => `<tr><td>${s.groups.map((g) => `${pill(g.severity)} ${g.artifacts.length}`).join(' ')}</td><td>${h(s.title)} <code>${h(s.code)}</code></td><td>${s.groups.map((g) => (s.groups.length > 1 ? `<span class="muted">${h(g.severity)}:</span> ` : '') + h(g.artifacts.join(', '))).join('<br>')}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">No security or privilege findings. SAUT\'s own rules only — a content scanner (<code>--scan</code>) adds injection and exfiltration analysis.</p>'}
${r.artifacts.length ? `<h2>Artifacts</h2><div class="wrap"><table><tr><th>Artifact</th><th>High</th><th>Medium</th><th>Low</th><th>Security</th><th>Always-on</th><th>On invoke</th>${r.harnesses.map((x) => `<th>${h(x)}</th>`).join('')}</tr>` +
    r.artifacts.map((a, i) => `<tr><td><span class="muted">${h(a.kind)}</span> <a href="#a${i}">${h(a.label)}</a></td><td class="n">${a.counts.high}</td><td class="n">${a.counts.medium}</td><td class="n">${a.counts.low}</td><td class="n">${a.counts.security}</td><td class="n">${a.cost?.alwaysOnTokens ?? '—'}</td><td class="n">${a.cost ? a.cost.invokeTokens + (a.cost.transitiveTokens ? ' +' + a.cost.transitiveTokens : '') : '—'}</td>${a.enforcement.map((e) => `<td>${enf(e.allowlist)}</td>`).join('')}</tr>`).join('') + '</table></div>' : ''}
${r.artifacts.map((a, i) => `<section class="art" id="a${i}"><h3>${h(a.kind)} ${h(a.label)}</h3><div class="meta" style="margin:0">${a.copies.length > 1 ? `${a.copies.length} copies${a.identical ? ', identical' : ', they differ'}: ` : ''}${a.copies.map((p) => `<code>${h(p)}</code>`).join(' ')}</div>${a.description ? `<div class="muted">${h(a.description)}</div>` : ''}${a.cost?.over.length ? `<div class="fix">Over budget: ${h(a.cost.over.join('; '))}</div>` : ''}` +
    (a.findings.length ? `<ul>${a.findings.map(findingHtml).join('')}</ul>` : '<p class="muted">Clean.</p>') + '</section>').join('\n')}
<h2>Agent workspace</h2>
${(() => {
  const w = r.workspace;
  if (!w.files) return '<p class="muted">No hooks, MCP servers, settings, instruction files, commands or plugin manifests found.</p>';
  const table = (head: string[], rows: string[][]) => `<div class="wrap"><table><tr>${head.map((x) => `<th>${h(x)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
  const c = (s: string) => `<code>${h(s)}</code>`;
  return `<p>${w.files} files: ${h(kindsLine(w.byKind))}.</p>` +
    (w.instructions.length ? `<h3>Loaded into every session</h3>` + table(['File(s)', 'Harness', 'Tokens'], w.instructions.map((i) => [i.paths.map(c).join(' ') + (i.note ? ` <span class="muted">${h(i.note)}</span>` : ''), h(i.harnesses.join(', ')), String(i.tokens ?? '—')])) : '') +
    (w.hooks.length ? `<h3>Hooks and commands the harness runs</h3>` + table(['Event', 'Runs', 'Declared in'], w.hooks.map((k) => [h(k.event + (k.matcher ? ` (${k.matcher})` : '')), c(k.run.length > 110 ? k.run.slice(0, 107) + '…' : k.run), c(k.file)])) : '') +
    (w.mcp.length ? `<h3>MCP servers</h3>` + table(['Server', 'Transport', 'Command / URL', 'File'], w.mcp.map((m) => [h(m.name), h(m.transport), c(m.target), c(m.file)])) : '') +
    (w.code.length ? `<h3>Code it runs <span class="muted">(read, never executed)</span></h3>` + table(['File', 'Run by', 'Can'], w.code.map((x) => [c(x.path), h(x.runBy.join('; ') || '—') + (x.via.length ? ` <span class="muted">via ${h(x.via.join(', '))}</span>` : ''), h(x.can.join(', ') || '—')])) : '') +
    w.units.map((u) => `<section class="art"><h3>${h(u.kind)}${u.paths.length > 1 ? ` <span class="muted">${u.paths.length} copies</span>` : ''}</h3><div class="meta" style="margin:0">${u.paths.map(c).join(' ')}</div><ul>${u.findings.map(findingHtml).join('')}</ul></section>`).join('');
})()}
${r.other.length ? `<h2>Other findings</h2><section class="art"><ul>${r.other.map(findingHtml).join('')}</ul></section>` : ''}
<p class="muted">Rules: <a href="https://github.com/yurgeno/saut/blob/main/docs/RULES.md">docs/RULES.md</a> · enforcement: <span class="enf restrict">restrict</span> the harness holds the allowlist, <span class="enf grant">grant</span> it pre-approves only, <span class="enf prose">prose</span> / <span class="enf dropped">dropped</span> nothing holds it.</p>
</main></body></html>
`;
}

// ---- the verb ----------------------------------------------------------------------------

export async function cmdReport(opts: Opts & { format?: string }): Promise<number> {
  const fmt = opts.json ? 'json' : (opts.format ?? (opts.out ? ({ '.html': 'html', '.htm': 'html', '.json': 'json' } as Record<string, string>)[path.extname(opts.out).toLowerCase()] ?? 'md' : 'md'));
  if (!['md', 'html', 'json'].includes(fmt)) { process.stderr.write(`saut report: --format md | html | json, got "${fmt}"\n`); return 2; }
  const r = await buildReport(opts._, opts);
  const text = fmt === 'json' ? JSON.stringify(r, null, 2) + '\n' : fmt === 'html' ? toHtml(r) : toMarkdown(r);
  if (opts.out) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(opts.out, text);
    process.stderr.write(`saut report: ${r.totals.artifacts} artifact(s), ${r.totals.high} high, ${r.totals.medium} medium → ${opts.out}\n`);
  } else process.stdout.write(text);
  return r.verdict.exit;
}
