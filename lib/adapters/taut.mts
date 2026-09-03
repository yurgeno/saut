// TAUT adapter — what SAUT adds when the target is a TAUT data pack and a TAUT engine is
// reachable. Nothing here is required for plain skills; nothing in the engine knows SAUT.
//
// The engine is IMPORTED (Node ≥ 24 runs its .mts natively — the same seam its own panel
// uses), never re-implemented:
//   • frontmatter is parsed by the ENGINE parser (the strict subset that decides a compile),
//     under the all-gates-ON view — the union the pack can ship;
//   • `metadata.taut` wiring is validated against the pack's real catalog: agents, MCP roles,
//     repo map, requires, role;
//   • each artifact gets its COMPILE PREVIEW per harness from `taut render` (exact bytes the
//     installer writes, target path, the adapter's recorded degradations);
//   • the engine's degradation records replace SAUT's registry rows in the matrix.
// Engine location: --taut <dir> | SAUT_TAUT_ENGINE | ~/taut.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFrontmatter } from '../frontmatter.mts';
import { toolList } from '../skill.mts';
import type { Artifact, Diagnostic, SkillArtifact, ToolCatalogServer } from '../types.mts';
import { exists, isDir, readText } from '../util.mts';

export interface TautPreview { harness: string; id: string; bytes: number; content: string; transform: string; degradations: { id: string; text: string }[] }

export interface TautContext {
  packRoot: string;
  engine: string;
  engineCommit: string | null;
  projects: { name: string; dir: string }[];
  project: { name: string; dir: string; manifest: any; repos: { mandatory?: string[]; known?: Record<string, unknown> } | null } | null;
  harnessIds: string[];
  caps: Record<string, { skillsDir: string; agentsDir: string; agentFormat: 'md' | 'toml'; skillAllowlist: string; agentAllowlist: string; degradations: { id: string; text: string }[] }>;
  catalog: { skills: Map<string, { path: string; origin: string; description: string; meta: any }>; agents: Map<string, { path: string }> };
  mcp: Record<string, { role?: string; serverKey?: string; tools?: string[] }>;
  // engine modules (typed loosely on purpose: the engine is a moving dependency)
  api: {
    parseFrontmatter: (text: string, id?: string) => { fm: any; body: string };
    applyMarkers: (text: string, gates: Record<string, boolean>, id?: string) => string;
    gatesAll: (v: boolean) => Record<string, boolean>;
    renderPreview: (o: { skill?: string; agent?: string; harness: string; gates?: Record<string, boolean>; deployment?: string | null }) => Promise<{ harness: string; id: string; content: string; transform: string; degradations: { id: string; text: string }[] }>;
  };
}

async function findPackRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  if (!(await isDir(dir))) dir = path.dirname(dir);
  for (let i = 0; i < 8; i++) {
    if (await exists(path.join(dir, 'pack.json')) && (await exists(path.join(dir, 'skills')) || await hasProject(dir))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

async function hasProject(dir: string): Promise<boolean> {
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true }))
      if (e.isDirectory() && (await exists(path.join(dir, e.name, 'deployment.json')))) return true;
  } catch { /* unreadable */ }
  return false;
}

export async function findEngine(explicit?: string | null): Promise<string | null> {
  const cands = [explicit, process.env.SAUT_TAUT_ENGINE, path.join(os.homedir(), 'taut')].filter(Boolean) as string[];
  for (const c of cands) if (await exists(path.join(c, 'lib', 'commands.mts')) && await exists(path.join(c, 'taut.mjs'))) return path.resolve(c);
  return null;
}

async function gitHead(dir: string): Promise<string | null> {
  try {
    const head = (await fs.readFile(path.join(dir, '.git', 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    return (await fs.readFile(path.join(dir, '.git', head.slice(5)), 'utf8')).trim().slice(0, 7);
  } catch { return null; }
}

// Activate the adapter for a set of targets, or return null when this is not a TAUT pack
// (or no engine is reachable — reported by the caller as a note, never an error).
export async function detectTaut(targets: string[], opts: { taut?: string | null; deployment?: string | null }): Promise<{ ctx: TautContext | null; note: string | null }> {
  const packRoot = await findPackRoot(targets[0] ?? '.');
  if (!packRoot) return { ctx: null, note: null };
  const engine = await findEngine(opts.taut);
  if (!engine) return { ctx: null, note: `TAUT pack at ${packRoot} but no engine found (--taut <dir> or SAUT_TAUT_ENGINE) — linting as plain skills` };
  const mod = async (f: string) => import(pathToFileURL(path.join(engine, 'lib', f)).href);
  const [constants, artifacts, markers, commands, config, caps] = await Promise.all([
    mod('constants.mts'), mod('artifacts.mts'), mod('markers.mts'), mod('commands.mts'), mod('config.mts'), mod('harness-caps.mts'),
  ]);
  if (!commands.renderPreview || !caps.HARNESS_CAPS || !artifacts.gatesAll)
    return { ctx: null, note: `TAUT engine at ${engine} predates the render/harness-caps seams (engine commit 3e00050 or later) — linting as plain skills` };
  await constants.initDataFor({ explicit: packRoot });
  const deployments: { name: string; dir: string; manifest?: any; repos?: { mandatory?: string[]; known?: Record<string, unknown> } }[] = await config.listDeployments();
  const project = opts.deployment
    ? deployments.find((d) => d.name === opts.deployment) ?? null
    : deployments.length === 1 ? deployments[0] : null;
  if (opts.deployment && !project) throw new Error(`unknown deployment "${opts.deployment}" (pack has: ${deployments.map((d) => d.name).join(', ') || 'none'})`);
  if (project) constants.initProject(project.dir);
  const catalog = await artifacts.loadCatalog(project);
  return {
    ctx: {
      packRoot,
      engine,
      engineCommit: await gitHead(engine),
      projects: deployments.map((d) => ({ name: d.name, dir: d.dir })),
      project: project ? { name: project.name, dir: project.dir, manifest: project.manifest ?? null, repos: project.repos ?? null } : null,
      harnessIds: caps.HARNESS_IDS,
      caps: caps.HARNESS_CAPS,
      catalog,
      mcp: constants.MCP_CATALOG ?? {},
      api: { parseFrontmatter: artifacts.parseFrontmatter, applyMarkers: markers.applyMarkers, gatesAll: artifacts.gatesAll, renderPreview: commands.renderPreview },
    },
    note: null,
  };
}

export function catalogServers(ctx: TautContext): ToolCatalogServer[] {
  return Object.entries(ctx.mcp).map(([id, s]) => ({
    serverKey: s.serverKey ?? id, role: s.role,
    tools: (s.tools ?? []).map((t) => (t.startsWith('mcp__') ? t : `mcp__${s.serverKey ?? id}__${t}`)),
    source: `taut catalog (${ctx.project ? ctx.project.name : 'pack'})`,
  }));
}

// Re-read a skill or agent through the ENGINE parser under the all-on gate view. The
// generic parse stays as fallback when the engine refuses the source (that refusal is
// itself a finding: the pack will not compile).
export async function refine(a: Artifact, ctx: TautContext): Promise<{ artifact: Artifact; findings: Diagnostic[] }> {
  const raw = await readText(a.path);
  const rel = path.relative(ctx.packRoot, a.path);
  const findings: Diagnostic[] = [];
  let on: string; let off: string;
  try {
    on = ctx.api.applyMarkers(raw, ctx.api.gatesAll(true), rel);
    off = ctx.api.applyMarkers(raw, ctx.api.gatesAll(false), rel);
  } catch (e) {
    findings.push({ code: 'taut-compile', severity: 'high', message: `the engine refuses this source: ${(e as Error).message}`, path: a.path });
    return { artifact: a, findings };
  }
  // The engine parses SKILL frontmatter (strict subset) at compile time; agents it copies
  // byte-for-byte (or re-renders from a regex on `model:`), so their frontmatter is judged
  // by the generic parser over the gated text.
  if (a.kind === 'agent') {
    const fm = parseFrontmatter(on, a.path);
    const dOn = fm.data;
    return { artifact: { ...a, fm, description: typeof dOn.description === 'string' ? dOn.description : a.description, body: on.replace(/^---\n[\s\S]*?\n---\n?/, ''), tools: unionTools(a.tools, toolList(dOn.tools)), model: typeof dOn.model === 'string' ? dOn.model : null }, findings };
  }
  let fmOn: any; let fmOff: any;
  try {
    fmOn = ctx.api.parseFrontmatter(on, rel).fm;
    fmOff = ctx.api.parseFrontmatter(off, rel).fm;
  } catch (e) {
    findings.push({ code: 'taut-compile', severity: 'high', message: `the engine parser refuses this frontmatter: ${(e as Error).message}`, path: a.path });
    return { artifact: a, findings };
  }
  if (JSON.stringify(fmOn.metadata?.taut ?? {}) !== JSON.stringify(fmOff.metadata?.taut ?? {}))
    findings.push({ code: 'taut-compile', severity: 'high', message: 'metadata.taut varies by capability branch — the engine fails the compile (wiring is capability-independent)', path: a.path });
  if (fmOn.metadata?.federation !== undefined)
    findings.push({ code: 'taut-compile', severity: 'high', message: 'legacy wiring key metadata.federation — the engine fails the compile; use metadata.taut', path: a.path });
  // `{}` reads as a STRING in the engine parser — a pack idiom the engine tolerates but a
  // spec YAML parser and the SAUT emitter do not
  if (typeof fmOn.metadata?.taut === 'string')
    findings.push({ code: 'taut-empty-wiring', severity: 'info', message: '`metadata.taut: {}` — the engine reads `{}` as a string (harmless); write no `metadata` key instead', path: a.path, line: a.fm.lines.metadata });
  // the engine view replaces the generic parse: same shape, engine-decided values
  const generic = parseFrontmatter(on, a.path);      // for line numbers / duplicates bookkeeping
  const fm = { ...generic, data: fmOn };
  if (a.kind === 'skill') {
    const s: SkillArtifact = {
      ...a, fm,
      description: typeof fmOn.description === 'string' ? fmOn.description : a.description,
      body: on.replace(/^---\n[\s\S]*?\n---\n?/, ''),
      allowedTools: unionTools(a.allowedTools, toolList(fmOn['allowed-tools'])),
      disallowedTools: unionTools(a.disallowedTools, toolList(fmOn['disallowed-tools'])),
      modelInvocable: fmOn['disable-model-invocation'] !== true,
      userInvocable: fmOn['user-invocable'] !== false,
      model: typeof fmOn.model === 'string' ? fmOn.model : null,
      effort: typeof fmOn.effort === 'string' ? fmOn.effort : null,
      metadata: fmOn.metadata && typeof fmOn.metadata === 'object' ? fmOn.metadata : null,
    };
    if (fmOn.name !== path.basename(a.dir))
      findings.push({ code: 'taut-compile', severity: 'high', message: `frontmatter name "${fmOn.name}" != directory name "${path.basename(a.dir)}" — the engine fails the compile`, path: a.path, line: a.fm.lines.name });
    return { artifact: s, findings };
  }
  return { artifact: a, findings };
}

function unionTools(a: SkillArtifact['allowedTools'], b: SkillArtifact['allowedTools']): SkillArtifact['allowedTools'] {
  if (!a && !b) return null;
  const seen = new Map<string, NonNullable<typeof a>[number]>();
  for (const t of [...(a ?? []), ...(b ?? [])]) if (!seen.has(t.raw)) seen.set(t.raw, t);
  return [...seen.values()];
}

const KNOWN_ROLES = new Set(['stack-engine', 'spa-mock', 'init', 'knowledge']);
const KNOWN_REQUIRES = new Set(['kaut', 'atlas']);

// metadata.taut against the pack's real catalog (closes review finding C2: the key was
// documentary — now it is checked where the pack is).
export function lintWiring(a: Artifact, ctx: TautContext): Diagnostic[] {
  if (a.kind !== 'skill' || !a.metadata?.taut || typeof a.metadata.taut !== 'object') return [];
  const w = a.metadata.taut as Record<string, unknown>;
  const out: Diagnostic[] = [];
  const line = a.fm.lines.metadata;
  const d = (code: string, severity: Diagnostic['severity'], message: string, precedent?: string) => out.push({ code, severity, message, path: a.path, line, precedent });
  for (const k of Object.keys(w)) if (!['agents', 'requires', 'mcp', 'repos', 'role'].includes(k)) d('taut-wiring-unknown-key', 'medium', `metadata.taut.${k} is not a wiring key the engine reads (agents, requires, mcp, repos, role)`);
  for (const ag of Array.isArray(w.agents) ? w.agents.map(String) : []) if (!ctx.catalog.agents.has(ag)) d('taut-agent-missing', 'high', `metadata.taut.agents names "${ag}" — not in the pack catalog (the engine fails setup: named-but-missing agent)`);
  const roles = new Set(Object.values(ctx.mcp).map((s) => s.role).filter(Boolean));
  for (const r of Array.isArray(w.mcp) ? w.mcp.map(String) : []) if (!roles.has(r)) d('taut-mcp-role-unknown', 'medium', `metadata.taut.mcp names role "${r}" — no server in the catalog carries it (roles: ${[...roles].join(', ') || 'none'})`, 'C2');
  for (const r of Array.isArray(w.requires) ? w.requires.map(String) : []) if (!KNOWN_REQUIRES.has(r)) d('taut-requires-unknown', 'high', `metadata.taut.requires names "${r}" — the engine only gates on "kaut"`);
  const known = ctx.project?.repos?.known ? Object.keys(ctx.project.repos.known) : null;
  for (const r of Array.isArray(w.repos) ? w.repos.map(String) : []) if (known && !known.includes(r)) d('taut-repo-unknown', 'high', `metadata.taut.repos names "${r}" — not in deployment "${ctx.project!.name}" repo map (the engine fails the compile)`);
  if (typeof w.role === 'string' && !KNOWN_ROLES.has(w.role)) d('taut-role-unknown', 'info', `metadata.taut.role "${w.role}" is not a role the engine consumes (${[...KNOWN_ROLES].join(', ')})`);
  // Role COLLISION: the engine resolves a role to ONE skill (the generated instructions name
  // it, `renderStackSkill` wraps it). Two claimants make which one wins depend on catalog
  // order — found the hard way when a new skill silently took `init` from another.
  if (typeof w.role === 'string' && KNOWN_ROLES.has(w.role)) {
    const rivals = [...ctx.catalog.skills].filter(([n, e]) => n !== a.name && (e.meta as { role?: string } | undefined)?.role === w.role).map(([n]) => n);
    if (rivals.length) d('taut-role-collision', 'high', `metadata.taut.role "${w.role}" is also declared by ${rivals.join(', ')} — the engine resolves the role to ONE skill, so which one the compiled instructions name depends on catalog order`);
  }
  return out;
}

// Compile preview on every engine harness: exact bytes + target path + degradations.
export async function previews(a: Artifact, ctx: TautContext): Promise<TautPreview[]> {
  const out: TautPreview[] = [];
  const key = a.kind === 'skill' ? { skill: a.name } : { agent: a.name };
  if (a.kind === 'skill' ? !ctx.catalog.skills.has(a.name) : !ctx.catalog.agents.has(a.name)) return out;   // outside the catalog (e.g. another project)
  for (const h of ctx.harnessIds) {
    try {
      const r = await ctx.api.renderPreview({ ...key, harness: h, deployment: ctx.project?.name ?? null });
      out.push({ harness: h, id: r.id, bytes: Buffer.byteLength(r.content), content: r.content, transform: r.transform, degradations: r.degradations });
    } catch (e) {
      out.push({ harness: h, id: '', bytes: 0, content: '', transform: 'error', degradations: [{ id: 'render-error', text: (e as Error).message }] });
    }
  }
  return out;
}
