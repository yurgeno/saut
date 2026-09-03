// CLI verbs: lint / cost / passport / harnesses / tools. Each verb is also a library
// function (the Studio server and the TAUT adapter call the same code).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHarnesses } from './caps.mts';
import { costOf, overBudget } from './cost.mts';
import { lintArtifact, matrix, sortDiags, toSarif } from './lint.mts';
import { discover } from './skill.mts';
import { buildRegistry } from './tools.mts';
import type { AgentArtifact, Artifact, Budgets, CostLine, Diagnostic, HarnessCaps, ToolRegistry } from './types.mts';
import { c, count, exists, rel } from './util.mts';

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
  help?: boolean;
}

async function selectHarnesses(opts: Opts): Promise<HarnessCaps[]> {
  const all = await loadHarnesses();
  if (!opts.harness?.length) return [...all.values()];
  return opts.harness.map((id) => all.get(id) ?? (() => { throw new Error(`unknown harness "${id}" (known: ${[...all.keys()].join(', ')})`); })());
}

async function budgetsFor(targets: string[], opts: Opts): Promise<Budgets> {
  if (opts.budget) return JSON.parse(await fs.readFile(opts.budget, 'utf8')) as Budgets;
  // saut.json next to the first target or in an ancestor
  let dir = path.resolve(targets[0] ?? '.');
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'saut.json');
    if (await exists(p)) return (JSON.parse(await fs.readFile(p, 'utf8')) as { budgets?: Budgets }).budgets ?? {};
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return {};
}

export async function load(targets: string[], opts: Opts): Promise<{ artifacts: Artifact[]; harnesses: HarnessCaps[]; registry: ToolRegistry; agentsByName: Map<string, AgentArtifact> }> {
  if (!targets.length) targets = ['.'];
  const artifacts = await discover(targets);
  const harnesses = await selectHarnesses(opts);
  const registry = await buildRegistry({ catalog: opts.catalog, live: opts.live, start: path.resolve(targets[0]) });
  const agentsByName = new Map<string, AgentArtifact>();
  for (const a of artifacts) if (a.kind === 'agent') agentsByName.set(a.name, a);
  return { artifacts, harnesses, registry, agentsByName };
}

// ---- lint ---------------------------------------------------------------------------
export async function runLint(targets: string[], opts: Opts): Promise<{ diagnostics: Diagnostic[]; artifacts: Artifact[]; harnesses: HarnessCaps[] }> {
  const { artifacts, harnesses, registry, agentsByName } = await load(targets, opts);
  const diagnostics: Diagnostic[] = [];
  for (const a of artifacts) diagnostics.push(...lintArtifact(a, { harnesses, registry, agentsByName }));
  return { diagnostics: sortDiags(diagnostics), artifacts, harnesses };
}

export async function cmdLint(opts: Opts): Promise<number> {
  const { diagnostics, artifacts, harnesses } = await runLint(opts._, opts);
  if (opts.sarif) { process.stdout.write(JSON.stringify(toSarif(diagnostics, VERSION), null, 2) + '\n'); }
  else if (opts.json) { process.stdout.write(JSON.stringify({ version: VERSION, artifacts: artifacts.map((a) => ({ kind: a.kind, name: a.name, path: a.path })), diagnostics }, null, 2) + '\n'); }
  else {
    if (!artifacts.length) { process.stdout.write('no skills or agents found\n'); return 1; }
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
    process.stdout.write(`\n${count(artifacts.length, 'artifact')}, ${count(diagnostics.length, 'finding')} (${hi} high, ${med} medium)\n`);
  }
  const hi = diagnostics.some((x) => x.severity === 'high');
  const med = diagnostics.some((x) => x.severity === 'medium');
  return hi || (opts.strict && med) ? 1 : 0;
}

// ---- cost ---------------------------------------------------------------------------
export async function runCost(targets: string[], opts: Opts): Promise<{ lines: { line: CostLine; over: string[]; artifact: Artifact }[]; harness: HarnessCaps | null; budgets: Budgets }> {
  const { artifacts, harnesses, agentsByName } = await load(targets, opts);
  const harness = harnesses.length === 1 ? harnesses[0] : harnesses.find((h) => h.id === 'claude-code') ?? null;
  const budgets = await budgetsFor(targets, opts);
  const lines = [];
  for (const a of artifacts) {
    const line = await costOf(a, { harness, exact: !!opts.exact, agentsByName: agentsByName as Map<string, Artifact> });
    lines.push({ line, over: overBudget(line, a, budgets), artifact: a });
  }
  return { lines, harness, budgets };
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export async function cmdCost(opts: Opts): Promise<number> {
  const { lines, harness, budgets } = await runCost(opts._, opts);
  if (opts.json) { process.stdout.write(JSON.stringify({ version: VERSION, harness: harness?.id ?? null, budgets, lines: lines.map((l) => ({ ...l.line, over: l.over })) }, null, 2) + '\n'); return lines.some((l) => l.over.length) ? 1 : 0; }
  if (!lines.length) { process.stdout.write('no skills or agents found\n'); return 1; }
  const method = lines[0].line.method;
  process.stdout.write(`${c.bold('cost passport')} ${c.dim(`(${method}${harness ? `, listing per ${harness.id}` : ''})`)}\n`);
  process.stdout.write(`  ${'artifact'.padEnd(28)} ${'always-on'.padStart(10)} ${'on-invoke'.padStart(10)} ${'transitive'.padStart(10)}\n`);
  let on = 0, inv = 0;
  for (const { line, over, artifact } of lines) {
    const tr = line.transitive.reduce((s, t) => s + t.tokens, 0);
    on += line.alwaysOnTokens; inv += line.invokeTokens + tr;
    process.stdout.write(`  ${`${artifact.kind === 'agent' ? '@' : ''}${line.artifact}`.padEnd(28)} ${k(line.alwaysOnTokens).padStart(10)} ${k(line.invokeTokens).padStart(10)} ${(tr ? '+' + k(tr) : '').padStart(10)}${over.length ? '  ' + c.yellow('over: ' + over.join('; ')) : ''}\n`);
    for (const t of line.transitive) process.stdout.write(`  ${c.dim(`  ↳ ${t.name}`.padEnd(28))} ${''.padStart(10)} ${''.padStart(10)} ${k(t.tokens).padStart(10)}\n`);
  }
  process.stdout.write(`  ${'TOTAL'.padEnd(28)} ${k(on).padStart(10)} ${k(inv).padStart(10)}\n`);
  process.stdout.write(c.dim(`  always-on = name + description, paid in every session; on-invoke = body (+ wired agents / referenced files). ${method === 'estimate' ? 'Estimates — run with --exact (ANTHROPIC_API_KEY) for API-counted tokens.' : 'Counted by the Claude token-counting API.'}\n`));
  return lines.some((l) => l.over.length) ? 1 : 0;
}

// ---- passport (lint + cost + matrix in one JSON) ---------------------------------------
export async function cmdPassport(opts: Opts): Promise<number> {
  const { diagnostics, artifacts, harnesses } = await runLint(opts._, opts);
  const { lines } = await runCost(opts._, opts);
  const out = artifacts.map((a) => ({
    kind: a.kind, name: a.name, path: a.path,
    findings: diagnostics.filter((x) => x.path === a.path),
    cost: lines.find((l) => l.artifact.path === a.path)?.line ?? null,
    matrix: matrix(a, harnesses),
  }));
  process.stdout.write(JSON.stringify({ version: VERSION, passports: out }, null, 2) + '\n');
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
  if (opts.json) { process.stdout.write(JSON.stringify(reg, null, 2) + '\n'); return 0; }
  for (const [h, tools] of Object.entries(reg.builtin)) if (tools.length) process.stdout.write(`${c.bold(h)}: ${tools.join(' ')}\n`);
  if (!reg.servers.length) process.stdout.write(c.dim('no MCP catalog found (pass --catalog <file>)\n'));
  for (const s of reg.servers) process.stdout.write(`${c.bold('mcp ' + s.serverKey)}${s.role ? c.dim(` role=${s.role}`) : ''} ${c.dim(`[${s.source}]`)}\n  ${s.tools.length ? s.tools.join(' ') : c.dim('(no tool list — use --live)')}\n`);
  return 0;
}
