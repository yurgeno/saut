// CLI verbs: lint / cost / passport / harnesses / tools. Each verb is also a library
// function (the Studio server and the TAUT adapter call the same code).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnesses } from './caps.mts';
import { costOf, estimateTokens, overBudget } from './cost.mts';
import { lintArtifact, matrix, sortDiags, toSarif } from './lint.mts';
import { discover, loadAgent } from './skill.mts';
import { buildRegistry } from './tools.mts';
import { scan } from './scan.mts';
import { readUsage, usageFor, type UsageData } from './usage.mts';
import { catalogServers, detectTaut, lintWiring, previews, refine, type TautContext, type TautPreview } from './adapters/taut.mts';
import { runBench } from './bench/bench.mts';
import { startStudio } from './studio/server.mts';
import type { BenchResult } from './bench/types.mts';
import type { AgentArtifact, Artifact, Budgets, CostLine, Diagnostic, HarnessCaps, ToolRegistry } from './types.mts';
import { c, count, exists, fail, isDir, readText, rel } from './util.mts';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const VERSION: string = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

export interface Opts {
  _: string[];
  json?: boolean;
  sarif?: boolean;
  harness?: string[];
  catalog?: string;
  live?: boolean;
  exact?: boolean;
  budget?: string;
  strict?: boolean;        // exit 1 on medium too
  taut?: string;           // TAUT engine dir (adapter); auto: SAUT_TAUT_ENGINE, ~/taut, ~/federation
  deployment?: string;     // TAUT deployment (project) when the pack has several
  noTaut?: boolean;        // force plain mode on a TAUT pack
  scan?: boolean;          // fold an installed content scanner's findings into the lint
  scanner?: string;        // pin one scanner id
  workspace?: string;      // a compiled TAUT workspace — reads its telemetry for the usage column
  since?: string;
  until?: string;
  // test bench
  level?: number;          // 1 compile · 2 + trigger · 3 + obedience · 4 + scenario graders (default 3)
  runs?: number;           // per case (default 1)
  model?: string;          // harness model override (default: the runner's cheap tier)
  judgeModel?: string;     // L4 LLM-grader model (default haiku)
  maxCost?: number;        // USD ceiling over Claude-reported costs
  landscape?: string;      // TAUT: a real landscape dir, COPIED into scratch (default: stub repos)
  case?: string;           // case name glob
  out?: string;            // results dir (default <artifact>/evals/results/<timestamp>)
  keep?: boolean;          // keep the scratch workspace
  timeout?: number;        // seconds per run (default 300)
  port?: number;           // studio
  help?: boolean;
}

async function selectHarnesses(opts: Opts): Promise<HarnessCaps[]> {
  const all = await loadHarnesses();
  if (!opts.harness?.length) return [...all.values()];
  return opts.harness.map((id) => all.get(id) ?? fail(`unknown harness "${id}" (known: ${[...all.keys()].join(', ')})`));
}

async function budgetsFor(targets: string[], opts: Opts): Promise<Budgets> {
  if (opts.budget) return JSON.parse(await readText(opts.budget)) as Budgets;
  // saut.json next to the first target or in an ancestor
  let dir = path.resolve(targets[0] ?? '.');
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'saut.json');
    if (await exists(p)) return (JSON.parse(await readText(p)) as { budgets?: Budgets }).budgets ?? {};
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return {};
}

export interface Loaded { artifacts: Artifact[]; harnesses: HarnessCaps[]; registry: ToolRegistry; agentsByName: Map<string, AgentArtifact>; taut: TautContext | null; tautFindings: Diagnostic[]; note: string | null }

export async function load(targets: string[], opts: Opts): Promise<Loaded> {
  if (!targets.length) targets = ['.'];
  let artifacts = await discover(targets);
  const harnesses = await selectHarnesses(opts);
  let taut: TautContext | null = null;
  let note: string | null = null;
  const tautFindings: Diagnostic[] = [];
  if (!opts.noTaut) {
    const det = await detectTaut(targets, { taut: opts.taut ?? null, deployment: opts.deployment ?? null });
    taut = det.ctx; note = det.note;
  }
  const registry = await buildRegistry({ catalog: taut ? null : opts.catalog, live: opts.live, start: path.resolve(targets[0]) });
  if (taut) {
    registry.servers = catalogServers(taut);
    const refined: Artifact[] = [];
    for (const a of artifacts) { const r = await refine(a, taut); refined.push(r.artifact); tautFindings.push(...r.findings); }
    artifacts = refined;
    // the engine's adapter records override the registry rows for the harnesses it ships
    for (const h of harnesses) {
      const c = taut.caps[h.id];
      if (c) { h.degradations = c.degradations; h.toolAllowlist = c.skillAllowlist as HarnessCaps['toolAllowlist']; h.agentAllowlist = c.agentAllowlist as HarnessCaps['agentAllowlist']; }
    }
  }
  const agentsByName = new Map<string, AgentArtifact>();
  for (const a of artifacts) if (a.kind === 'agent') agentsByName.set(a.name, a);
  // a TAUT pack's agents live in the catalog even when the target was one skill dir
  if (taut) for (const [name, entry] of taut.catalog.agents) if (!agentsByName.has(name)) agentsByName.set(name, (await refine(await loadAgent(entry.path), taut)).artifact as AgentArtifact);
  return { artifacts, harnesses, registry, agentsByName, taut, tautFindings, note };
}

// ---- lint ---------------------------------------------------------------------------
export async function runLint(targets: string[], opts: Opts): Promise<{ diagnostics: Diagnostic[]; artifacts: Artifact[]; harnesses: HarnessCaps[]; taut: TautContext | null; note: string | null; scanNote?: string | null; scanners?: string[] }> {
  const { artifacts, harnesses, registry, agentsByName, taut, tautFindings, note } = await load(targets, opts);
  const diagnostics: Diagnostic[] = [...tautFindings];
  for (const a of artifacts) {
    let ds = lintArtifact(a, { harnesses, registry, agentsByName });
    if (taut) {
      // the adapter judges the wiring against the real catalog — drop the generic shape checks
      ds = ds.filter((x) => !x.code.startsWith('taut-'));
      ds.push(...lintWiring(a, taut));
    }
    diagnostics.push(...ds);
  }
  let scanNote: string | null = null;
  let scanners: string[] = [];
  if (opts.scan) {
    const target = taut ? taut.packRoot : path.resolve(targets[0] ?? '.');
    const r = await scan(target, { scanner: opts.scanner });
    diagnostics.push(...r.diagnostics);
    scanNote = r.note; scanners = r.ran;
  }
  return { diagnostics: sortDiags(diagnostics), artifacts, harnesses, taut, note, scanNote, scanners };
}

export async function cmdLint(opts: Opts): Promise<number> {
  const { diagnostics, artifacts, harnesses, taut, note, scanNote, scanners } = await runLint(opts._, opts);
  // one verdict for every output format — a CI job that adds --json must not stop catching
  // "the target matched nothing"
  const exit = !artifacts.length ? 1
    : diagnostics.some((x) => x.severity === 'high') || (opts.strict && diagnostics.some((x) => x.severity === 'medium')) ? 1 : 0;
  if (opts.sarif) { process.stdout.write(JSON.stringify(toSarif(diagnostics, VERSION), null, 2) + '\n'); }
  else if (opts.json) { process.stdout.write(JSON.stringify({ version: VERSION, artifacts: artifacts.map((a) => ({ kind: a.kind, name: a.name, path: a.path })), diagnostics }, null, 2) + '\n'); }
  else {
    if (!artifacts.length) process.stdout.write('no skills or agents found\n');
    if (taut) process.stdout.write(c.dim(`TAUT pack ${rel(taut.packRoot)} · engine ${rel(taut.engine)}${taut.engineCommit ? ` @${taut.engineCommit}` : ''}${taut.project ? ` · deployment ${taut.project.name}` : ''} — engine-parsed frontmatter, wiring checked against the catalog\n`));
    else if (note) process.stdout.write(c.dim(note + '\n'));
    if (scanners?.length) process.stdout.write(c.dim(`content scan: ${scanners.join(', ')}\n`));
    if (scanNote) process.stdout.write(c.yellow(scanNote + '\n'));
    const byPath = new Map<string, Diagnostic[]>();
    for (const x of diagnostics) byPath.set(x.path, [...(byPath.get(x.path) ?? []), x]);
    for (const a of artifacts) {
      const ds = byPath.get(a.path) ?? [];
      const tag = a.kind === 'skill' ? 'skill' : 'agent';
      process.stdout.write(`${c.bold(`${tag} ${a.name}`)} ${c.dim(rel(a.path))} — ${ds.length ? count(ds.length, 'finding') : c.green('clean')}\n`);
      for (const x of ds) {
        const sev = x.severity === 'high' ? c.red('high  ') : x.severity === 'medium' ? c.yellow('medium') : x.severity === 'low' ? 'low   ' : c.dim('info  ');
        process.stdout.write(`  ${sev} ${x.code}${x.harness ? c.dim(` [${x.harness}]`) : ''}${x.line ? c.dim(`:${x.line}`) : ''} — ${x.message}${x.precedent ? c.dim(` (${x.precedent})`) : ''}\n`);
      }
      const m = matrix(a, harnesses);
      process.stdout.write(`  ${c.dim('enforcement')} ${m.map((r) => `${r.harness}=${r.allowlist}`).join(' · ')}\n`);
    }
    const hi = diagnostics.filter((x) => x.severity === 'high').length;
    const med = diagnostics.filter((x) => x.severity === 'medium').length;
    if (artifacts.length) process.stdout.write(`\n${count(artifacts.length, 'artifact')}, ${count(diagnostics.length, 'finding')} (${hi} high, ${med} medium)\n`);
  }
  return exit;
}

// ---- cost ---------------------------------------------------------------------------
export async function runCost(targets: string[], opts: Opts): Promise<{ lines: { line: CostLine; over: string[]; artifact: Artifact }[]; harness: HarnessCaps | null; budgets: Budgets; usage: UsageData | null }> {
  const { artifacts, harnesses, agentsByName } = await load(targets, opts);
  const harness = harnesses.length === 1 ? harnesses[0] : harnesses.find((h) => h.id === 'claude-code') ?? null;
  const budgets = await budgetsFor(targets, opts);
  const lines = [];
  for (const a of artifacts) {
    const line = await costOf(a, { harness, exact: !!opts.exact, agentsByName: agentsByName as Map<string, Artifact> });
    lines.push({ line, over: overBudget(line, a, budgets), artifact: a });
  }
  const usage = opts.workspace ? await readUsage(opts.workspace, { since: opts.since, to: opts.until }) : null;
  return { lines, harness, budgets, usage };
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export async function cmdCost(opts: Opts): Promise<number> {
  const { lines, harness, budgets, usage } = await runCost(opts._, opts);
  if (opts.json) { process.stdout.write(JSON.stringify({ version: VERSION, harness: harness?.id ?? null, budgets, usage: usage ? { workspace: usage.workspace, days: usage.days, from: usage.from, to: usage.to } : null, lines: lines.map((l) => ({ ...l.line, over: l.over, usage: usageFor(usage, l.artifact.name) })) }, null, 2) + '\n'); return lines.some((l) => l.over.length) ? 1 : 0; }
  if (!lines.length) { process.stdout.write('no skills or agents found\n'); return 1; }
  const method = lines[0].line.method;
  process.stdout.write(`${c.bold('cost passport')} ${c.dim(`(${method}${harness ? `, listing per ${harness.id}` : ''})`)}\n`);
  process.stdout.write(`  ${'artifact'.padEnd(28)} ${'always-on'.padStart(10)} ${'on-invoke'.padStart(10)} ${'transitive'.padStart(10)}${usage ? `${'used'.padStart(10)}` : ''}\n`);
  let on = 0, inv = 0;
  for (const { line, over, artifact } of lines) {
    const tr = line.transitive.reduce((s, t) => s + t.tokens, 0);
    on += line.alwaysOnTokens; inv += line.invokeTokens + tr;
    const u = usageFor(usage, line.artifact);
    const uText = u ? `${u.allow}${u.deny ? `/${u.deny}⊘` : ''}` : '0';
    const uCol = usage ? ' '.repeat(Math.max(0, 10 - uText.length)) + (u ? (u.allow ? uText : c.yellow(uText)) : c.dim(uText)) : '';
    process.stdout.write(`  ${`${artifact.kind === 'agent' ? '@' : ''}${line.artifact}`.padEnd(28)} ${k(line.alwaysOnTokens).padStart(10)} ${k(line.invokeTokens).padStart(10)} ${(tr ? '+' + k(tr) : '').padStart(10)}${uCol}${over.length ? '  ' + c.yellow('over: ' + over.join('; ')) : ''}\n`);
    for (const t of line.transitive) process.stdout.write(`  ${c.dim(`  ↳ ${t.name}`.padEnd(28))} ${''.padStart(10)} ${''.padStart(10)} ${k(t.tokens).padStart(10)}\n`);
  }
  process.stdout.write(`  ${'TOTAL'.padEnd(28)} ${k(on).padStart(10)} ${k(inv).padStart(10)}\n`);
  process.stdout.write(c.dim(`  always-on = name + description, paid in every session; on-invoke = body (+ wired agents / referenced files). ${method === 'estimate' ? 'Estimates — run with --exact (ANTHROPIC_API_KEY) for API-counted tokens.' : 'Counted by the Claude token-counting API.'}\n`));
  if (usage) process.stdout.write(c.dim(`  used = invocations recorded by ${rel(usage.workspace)} over ${usage.days} day(s)${usage.from ? ` (${usage.from}…${usage.to})` : ''}; ⊘ = denied. Local telemetry, never sent anywhere.\n`));
  else if (opts.workspace) process.stdout.write(c.yellow(`  no telemetry under ${rel(path.resolve(opts.workspace))}/memory/telemetry\n`));
  return lines.some((l) => l.over.length) ? 1 : 0;
}

// ---- passport (lint + cost + matrix in one JSON) ---------------------------------------
export async function cmdPassport(opts: Opts): Promise<number> {
  const { diagnostics, artifacts, harnesses, taut } = await runLint(opts._, opts);
  const { lines } = await runCost(opts._, opts);
  const out = [];
  for (const a of artifacts) {
    const compiled: (Omit<TautPreview, 'content'> & { tokens: number })[] = taut
      ? (await previews(a, taut)).map((p) => ({ harness: p.harness, id: p.id, bytes: p.bytes, transform: p.transform, degradations: p.degradations, tokens: estimateTokens(p.content) }))
      : [];
    out.push({
      kind: a.kind, name: a.name, path: a.path,
      findings: diagnostics.filter((x) => x.path === a.path),
      cost: lines.find((l) => l.artifact.path === a.path)?.line ?? null,
      matrix: matrix(a, harnesses),
      ...(taut ? { compiled } : {}),
    });
  }
  process.stdout.write(JSON.stringify({ version: VERSION, taut: taut ? { packRoot: taut.packRoot, engine: taut.engine, engineCommit: taut.engineCommit, deployment: taut.project?.name ?? null } : null, passports: out }, null, 2) + '\n');
  return 0;
}

// ---- preview (TAUT compile preview of one artifact on one harness) --------------------
export async function cmdPreview(opts: Opts): Promise<number> {
  const name = opts._[0];
  if (!name) { process.stderr.write('saut preview <skill-or-agent name> --harness <id> [--taut <engine>] [--deployment <n>]\n'); return 2; }
  const { artifacts, taut } = await load([opts._[1] ?? '.'], opts);
  if (!taut) { process.stderr.write('preview needs a TAUT pack and engine (not a TAUT pack here, or no engine: --taut <dir> / SAUT_TAUT_ENGINE)\n'); return 2; }
  const a = artifacts.find((x) => x.name === name);
  if (!a) { process.stderr.write(`"${name}" not found under ${opts._[1] ?? '.'}\n`); return 2; }
  const hs = opts.harness?.length ? opts.harness : taut.harnessIds;
  const all = (await previews(a, taut)).filter((p) => hs.includes(p.harness));
  if (opts.json) { process.stdout.write(JSON.stringify(all, null, 2) + '\n'); return 0; }
  for (const p of all) {
    process.stdout.write(`${c.bold(`── ${p.harness} → ${p.id || '(render error)'}`)} ${c.dim(`${p.bytes} bytes · ~${estimateTokens(p.content)} tok · ${p.transform}`)}\n`);
    for (const d of p.degradations) process.stdout.write(`${c.yellow('   degradation')} ${d.id}: ${d.text}\n`);
    if (all.length === 1 || opts.harness?.length === 1) process.stdout.write(p.content + (p.content.endsWith('\n') ? '' : '\n'));
  }
  if (all.length > 1 && !(opts.harness?.length === 1)) process.stdout.write(c.dim('(pass --harness <id> to print the compiled bytes)\n'));
  return 0;
}

// ---- registries -----------------------------------------------------------------------
export async function cmdHarnesses(opts: Opts): Promise<number> {
  const hs = [...(await loadHarnesses()).values()];
  if (opts.json) { process.stdout.write(JSON.stringify(hs, null, 2) + '\n'); return 0; }
  for (const h of hs) {
    process.stdout.write(`${c.bold(h.id.padEnd(12))} ${h.title}${h.runner ? '' : c.dim('  (registry-only, no runner)')}\n`);
    process.stdout.write(`  skills: ${h.skillsDirs.join(', ')} · agents: ${h.agentsDir ?? '—'} (${h.agentFormat}) · builtin tools: ${h.builtinTools.length}\n`);
    process.stdout.write(`  allowlist: skills=${h.toolAllowlist} agents=${h.agentAllowlist} · deny: ${h.denyMechanism ?? '—'}\n`);
    process.stdout.write(`  listing: ${h.listing.budget}${h.listing.descCap ? ` · desc cap ${h.listing.descCap}` : ''} · mcp names: ${h.mcpToolNaming}\n`);
    for (const dg of h.degradations) process.stdout.write(`  ${c.dim(dg.id)} ${dg.text}\n`);
  }
  return 0;
}

export async function cmdTools(opts: Opts): Promise<number> {
  const reg = await buildRegistry({ catalog: opts.catalog, live: opts.live, start: path.resolve(opts._[0] ?? '.') });
  // a CI job running `saut tools --live` to prove the catalog is wired must FAIL when a
  // server did not answer — the failure used to hide inside a `source` string
  const failed = reg.servers.filter((s) => s.liveFailed);
  if (opts.json) { process.stdout.write(JSON.stringify(reg, null, 2) + '\n'); return failed.length ? 1 : 0; }
  for (const [h, tools] of Object.entries(reg.builtin)) if (tools.length) process.stdout.write(`${c.bold(h)}: ${tools.join(' ')}\n`);
  if (!reg.servers.length) process.stdout.write(c.dim('no MCP catalog found (pass --catalog <file>)\n'));
  for (const s of reg.servers) process.stdout.write(`${s.liveFailed ? c.red('mcp ' + s.serverKey) : c.bold('mcp ' + s.serverKey)}${s.role ? c.dim(` role=${s.role}`) : ''} ${c.dim(`[${s.source}]`)}\n  ${s.tools.length ? s.tools.join(' ') : c.dim('(no tool list — use --live)')}\n`);
  if (failed.length) process.stderr.write(c.red(`${count(failed.length, 'server')} did not answer tools/list\n`));
  return failed.length ? 1 : 0;
}

// ---- test bench (L1 compile · L2 trigger · L3 obedience) ---------------------------------
export async function cmdTest(opts: Opts): Promise<number> {
  const target = opts._[0];
  if (!target) { process.stderr.write('saut test <skill dir | agent .md> [--harness ids] [--level 1|2|3] [--runs n] [--model m] [--max-cost usd] [--landscape dir] [--case glob] [--out dir] [--keep] [--json]\n'); return 2; }
  const { artifacts, harnesses, taut } = await load([target], opts);
  const targets = artifacts.filter((a) => a.kind === 'skill' || (path.resolve(target).endsWith('.md')));
  if (!targets.length) { process.stderr.write(`no skill or agent at ${target}\n`); return 2; }
  if (targets.length > 1 && !(await isDir(path.resolve(target)) && (await exists(path.join(path.resolve(target), 'SKILL.md'))))) {
    process.stderr.write(`saut test benches ONE artifact at a time — ${targets.length} found under ${target}; point at a skill directory or an agent file\n`); return 2;
  }
  const a = targets[0];
  const siblings = taut ? [...(await load([taut.packRoot], { ...opts, _: [] })).artifacts] : artifacts;
  const level = Math.min(4, Math.max(1, opts.level ?? 3)) as 1 | 2 | 3 | 4;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = opts.out ?? path.join(a.kind === 'skill' ? a.dir : path.dirname(a.path), 'evals', 'results', ts);
  const log = (e: { kind: string; text: string }) => { if (!opts.json) process.stderr.write(`${e.kind === 'fail' ? c.red(e.kind.padEnd(6)) : e.kind === 'ok' ? c.green(e.kind.padEnd(6)) : c.dim(e.kind.padEnd(6))} ${e.text}\n`); };
  if (!opts.json) process.stderr.write(`${c.bold(`bench ${a.kind} ${a.name}`)} ${c.dim(`level ${level} · runs ${opts.runs ?? 1} · ${taut ? `TAUT pack ${rel(taut.packRoot)} via ${rel(taut.engine)}` : 'generic'} · harnesses ${harnesses.filter((h) => h.runner).map((h) => h.id).join(',')}`)}\n`);
  const result = await runBench({
    artifact: a, siblings, harnesses, taut, level, runs: opts.runs ?? 1, model: opts.model, judgeModel: opts.judgeModel, maxCostUsd: opts.maxCost ?? null,
    landscape: opts.landscape ? path.resolve(opts.landscape) : null, caseFilter: opts.case, outDir, keepScratch: !!opts.keep,
    timeoutMs: (opts.timeout ?? 300) * 1000, version: VERSION, onEvent: log,
  });
  if (opts.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return benchExit(result); }
  printBench(result);
  process.stdout.write(c.dim(`results: ${rel(outDir)}/matrix.json${opts.keep ? ` · scratch kept: ${result.scratch}` : ''}\n`));
  return benchExit(result);
}

function benchExit(r: BenchResult): number {
  if (!r.compiled.ok) return 1;
  const bad = r.reports.some((rep) => rep.available && ((rep.trigger.fireRate !== null && rep.trigger.fireRate === 0) || rep.trigger.controlClean === false || (rep.obedience?.violations.length ?? 0) > 0 || (rep.scenario !== null && rep.scenario.score !== null && rep.scenario.score < 1)));
  return bad ? 1 : 0;
}

function printBench(r: BenchResult): void {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  process.stdout.write(`\n${c.bold('matrix')} ${c.dim(`${r.artifact.kind} ${r.artifact.name} · ${r.mode} · L${r.levels.at(-1)}`)}\n`);
  process.stdout.write(`  L1 compile   ${r.compiled.ok ? c.green('ok') : c.red('FAIL')} ${c.dim(r.compiled.detail)}${r.compiled.verify && r.compiled.verify !== 'ok' ? ' ' + c.red(r.compiled.verify) : ''}\n`);
  for (const rep of r.reports) {
    if (!rep.available) { process.stdout.write(`  ${rep.harness.padEnd(12)} ${c.dim('unavailable')} ${c.dim(rep.reason ?? '')}\n`); continue; }
    const t = rep.trigger;
    const ob = rep.obedience;
    process.stdout.write(`  ${c.bold(rep.harness.padEnd(12))} trigger ${t.fireRate === null ? '—' : t.fireRate > 0 ? c.green(pct(t.fireRate)) : c.red(pct(t.fireRate))} · control ${t.controlClean === null ? '—' : t.controlClean ? c.green('clean') : c.red('FIRED')}`
      + (t.lostTo.length ? c.yellow(` · lost to ${t.lostTo.join(', ')}`) : '')
      + (rep.scenario && rep.scenario.score !== null ? ` · scenario ${rep.scenario.score === 1 ? c.green('100%') : c.red(Math.round(rep.scenario.score * 100) + '%')}${rep.scenario.failed.length ? c.dim(` (${rep.scenario.failed.join(', ')})`) : ''}` : '')
      + (ob ? ` · obedience ${ob.violations.length ? c.red(`${ob.violations.length} outside allowlist`) : c.green('inside allowlist')}${ob.denied.length ? c.dim(` · ${ob.denied.length} denied`) : ''} ${c.dim(`[${ob.enforcement}]`)}` : '')
      + c.dim(` · ${rep.traces.length} runs · ${rep.costUsd ? `$${rep.costUsd.toFixed(3)}` : `${(rep.tokens / 1000).toFixed(0)}k tok`}`) + '\n');
    for (const tr of rep.traces) {
      process.stdout.write(c.dim(`    ${tr.case.name.padEnd(10)} ${tr.status.padEnd(7)} fired=${tr.fired.padEnd(9)}${tr.firedOther.length ? ` lost-to=${tr.firedOther.join(',')} ` : ''} tools=${tr.tools.map((x) => x.neutral + (x.denied ? '⊘' : '')).join(',') || '—'}\n`));
      for (const g of tr.graders ?? []) process.stdout.write(`      ${g.pass ? c.green('pass') : c.red('FAIL')} ${g.name} ${c.dim(`(${g.type}) ${g.detail}`)}\n`);
    }
    if (ob?.violations.length) process.stdout.write(`    ${c.yellow('outside allowlist:')} ${ob.violations.join(', ')}\n`);
    for (const sk of rep.skipped) process.stdout.write(`    ${c.dim(sk.case.padEnd(10))} ${c.yellow('skipped')} ${c.dim(sk.why)}\n`);
    const blocked = rep.traces.filter((x) => x.fired === 'blocked');
    if (blocked.length) process.stdout.write(`    ${c.yellow('invocation refused:')} the harness denied the Skill call in ${blocked.length} run(s) — a gate or a permission rule in this workspace, not the artifact\n`);
    const comp = rep.traces.find((x) => x.competing)?.competing;
    if (comp) process.stdout.write(c.dim(`    caveat: ${comp} other skills were installed for this session — implicit triggering competes with them\n`));
  }
  if (r.budget.exhausted) process.stdout.write(c.yellow(`  budget ${r.budget.maxCostUsd} USD exhausted after $${r.budget.spentUsd.toFixed(3)}\n`));
}

// ---- studio (the loopback UI over the same verbs) ----------------------------------------
export async function cmdStudio(opts: Opts): Promise<number> {
  const root = path.resolve(opts._[0] ?? '.');
  if (!(await isDir(root))) { process.stderr.write(`saut studio <dir>: ${root} is not a directory\n`); return 2; }
  const h = await startStudio(root, opts);
  const url = `http://127.0.0.1:${h.port}/`;
  process.stdout.write(`${c.bold('SAUT Studio')} ${url}\n`);
  process.stdout.write(c.dim(`  root ${rel(root)} · loopback only · per-session token · Ctrl-C to stop\n`));
  await new Promise(() => undefined);          // serve until interrupted
  return 0;
}
