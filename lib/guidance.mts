// Current vendor guidance: is the model a harness would run still offered, does the effort
// level exist for it, does the prompt style fit the current models, is a hardening available
// that the artifact does not use yet.
//
// Everything judged here is DATA with a date and a source — model catalogs in
// lib/harnesses/<id>.json (`models`), prompt guidance in lib/guidance.json — so a stale verdict
// is visible as stale (guidanceStatus) instead of looking like a fact. Where a harness keeps
// its own catalog on the machine (Codex: $CODEX_HOME/models_cache.json) that fresher evidence
// is consulted first.
//
// Class A findings are outdated settings (fix them); class B are prompt-level hypotheses —
// both vendors say to change prompts only against a measurement, so they never carry an
// autofix; class D are hardening opportunities.
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Artifact, Autofix, Diagnostic, GuidanceMark, HarnessCaps, ModelEntry } from './types.mts';
import type { TautContext } from './adapters/taut.mts';
import { claimsReadOnlyOf } from './lint.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
interface GuidanceRule { class: 'A' | 'B' | 'D'; verifiedAt: string; sources: string[]; appliesTo?: string }
const DATA = JSON.parse(readFileSync(path.join(HERE, 'guidance.json'), 'utf8')) as { maxAgeDays: number; rules: Record<string, GuidanceRule> };

export const SPEC_BODY_MAX_LINES = 500;

// ---- freshness of the guidance itself ------------------------------------------------------

export interface GuidanceStatus {
  verifiedAt: string; ageDays: number; maxAgeDays: number; stale: boolean;
  parts: { what: string; verifiedAt: string; ageDays: number; stale: boolean; sources: string[] }[];
}

// Days since a YYYY-MM-DD date. A date that is not one (a typo in the data) is NaN, and a NaN
// age counts as stale — an unreadable date must never read as fresh.
const days = (iso: string, now: Date) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Math.floor((now.getTime() - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000) : NaN;
const tooOld = (age: number, max: number) => !(age <= max);

export function guidanceStatus(harnesses: HarnessCaps[], now = new Date()): GuidanceStatus {
  const max = DATA.maxAgeDays;
  const parts: GuidanceStatus['parts'] = [];
  for (const h of harnesses) if (h.models)
    parts.push({ what: `${h.title} models`, verifiedAt: h.models.verifiedAt, ageDays: days(h.models.verifiedAt, now), stale: tooOld(days(h.models.verifiedAt, now), max), sources: h.models.sources });
  const own = Object.values(DATA.rules).filter((r) => r.verifiedAt !== 'harness');
  if (own.length) {
    const oldest = own.map((r) => r.verifiedAt).sort()[0];
    parts.push({ what: 'prompting guidance', verifiedAt: oldest, ageDays: days(oldest, now), stale: tooOld(days(oldest, now), max), sources: [...new Set(own.flatMap((r) => r.sources))] });
  }
  const oldest = parts.map((p) => p.verifiedAt).sort()[0] ?? now.toISOString().slice(0, 10);
  return { verifiedAt: oldest, ageDays: days(oldest, now), maxAgeDays: max, stale: parts.some((p) => p.stale), parts };
}

function mark(code: string, h?: HarnessCaps): GuidanceMark | undefined {
  const r = DATA.rules[code];
  if (!r) return undefined;
  const fromHarness = r.verifiedAt === 'harness';
  return {
    class: r.class,
    verifiedAt: fromHarness ? h?.models?.verifiedAt ?? '' : r.verifiedAt,
    sources: fromHarness ? (h?.models?.sources ?? []) : r.sources,
    ...(r.appliesTo ? { appliesTo: r.appliesTo } : {}),
  };
}

// ---- the harness's own model catalog on this machine ---------------------------------------

export interface LocalCatalog { file: string; fetchedAt: string | null; clientVersion: string | null; models: Map<string, { efforts: string[]; upgrade: string | null; listed: boolean }> }
const localCache = new Map<string, LocalCatalog | null>();

export async function localCatalog(h: HarnessCaps): Promise<LocalCatalog | null> {
  const spec = h.models?.localCatalog;
  if (!spec) return null;
  const home = process.env[spec.homeEnv] || spec.homeDefault.replace(/^~(?=$|\/)/, os.homedir());
  const file = path.join(home, spec.file);
  if (localCache.has(file)) return localCache.get(file)!;
  let out: LocalCatalog | null = null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (raw.length > 8 * 1024 * 1024) throw new Error('too large');
    const j = JSON.parse(raw);
    if (spec.format === 'codex-models-cache' && Array.isArray(j.models)) {
      const models = new Map<string, { efforts: string[]; upgrade: string | null; listed: boolean }>();
      for (const m of j.models) {
        if (typeof m?.slug !== 'string') continue;
        const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((x: { effort?: unknown }) => String(x?.effort ?? '')).filter(Boolean) : [];
        const upgrade = typeof m.upgrade === 'string' ? m.upgrade : typeof m.upgrade?.model === 'string' ? m.upgrade.model : null;
        models.set(m.slug, { efforts, upgrade, listed: m.visibility !== 'hide' });
      }
      out = { file, fetchedAt: typeof j.fetched_at === 'string' ? j.fetched_at.slice(0, 10) : null, clientVersion: typeof j.client_version === 'string' ? j.client_version : null, models };
    }
  } catch { out = null; }   // absent, unreadable or another shape: the registry alone judges
  localCache.set(file, out);
  return out;
}

export async function localCatalogs(harnesses: HarnessCaps[]): Promise<Map<string, LocalCatalog | null>> {
  return new Map(await Promise.all(harnesses.map(async (h) => [h.id, await localCatalog(h)] as [string, LocalCatalog | null])));
}

// ---- one model reference ----------------------------------------------------------------

export interface ModelVerdict { code: string; severity: Diagnostic['severity']; message: string; autofixModel?: string }

export function judgeModel(h: HarnessCaps, model: string, effort: string | null, local: LocalCatalog | null): ModelVerdict[] {
  const reg = h.models;
  if (!reg) return [];
  const out: ModelVerdict[] = [];
  const raw = model.trim();
  const asOf = `verified ${reg.verifiedAt}`;
  const localNote = local?.fetchedAt ? `, nor in the local ${h.title} catalog (fetched ${local.fetchedAt})` : '';
  const aliased = Object.prototype.hasOwnProperty.call(reg.aliases, raw);
  const target = aliased ? reg.aliases[raw] : raw.replace(/\[1m\]$/, '');
  const entry: ModelEntry | undefined = target ? reg.catalog.find((m) => m.id === target || m.id === target.replace(/-\d{8}$/, '')) : undefined;
  const loc = local?.models.get(raw) ?? null;
  let efforts: string[] | null = null;                        // null = dynamic (an alias like `inherit`)

  if (!entry && !aliased && !loc) {
    out.push({ code: 'model-unknown', severity: 'medium', message: `"${raw}" is not a ${h.title} model this registry knows (${asOf})${localNote} — a typo, or a model newer than the registry` });
  } else if (entry && (entry.status === 'unsupported' || entry.status === 'retired')) {
    out.push({ code: 'model-unsupported', severity: 'high', message: `"${raw}" — ${entry.note ?? entry.status}; use ${entry.replacement ?? 'a current model'} (${asOf})`, autofixModel: entry.replacement });
    return out;                                               // its effort is moot: the model itself does not run
  } else if (entry && (entry.status === 'previous' || entry.status === 'legacy') && !aliased) {
    const next = loc?.upgrade ?? entry.replacement;
    out.push({ code: 'model-previous', severity: 'low', message: `"${raw}" is a ${entry.status} ${h.title} model${next ? `; the current one is ${next}` : ''}${entry.note ? ` — ${entry.note}` : ''} (${asOf})`, autofixModel: next });
    efforts = loc?.efforts ?? entry.efforts;
  } else {
    efforts = loc?.efforts ?? entry?.efforts ?? null;
  }

  if (effort) {
    const e = effort.trim();
    const known = new Set([...reg.efforts, ...(loc?.efforts ?? [])]);
    if (!known.has(e)) out.push({ code: 'effort-unsupported', severity: 'medium', message: `effort "${e}" is not a level ${h.title} knows (${reg.efforts.join(', ')}; ${asOf})` });
    else if (efforts && efforts.length === 0) out.push({ code: 'effort-unsupported', severity: 'medium', message: `${raw}${aliased && target ? ` (${target})` : ''} has no effort levels — effort "${e}" has no effect (${asOf})` });
    else if (efforts && !efforts.includes(e)) out.push({ code: 'effort-unsupported', severity: 'medium', message: `${raw}${aliased && target ? ` (${target})` : ''} supports ${efforts.join(', ')} — not "${e}" (${asOf})` });
  }
  return out;
}

// ---- prompt style (class B: hypotheses, never an autofix) ----------------------------------

const CAPS_IMPERATIVE = /\b(MUST|NEVER|ALWAYS|CRITICAL|PROACTIVELY|UNPROMPTED|MANDATORY)\b/g;
const UNDERTRIGGER_PHRASE = /\buse (?:it )?proactively\b|\bunprompted\b|\bif in doubt,? use\b|\bdefault to using\b|\bCRITICAL: you MUST\b/i;
const FOSSIL = /\b(?:lesson|incident|post-?mortem|measured|observed|learned|found)\b[^.\n]{0,60}\b20\d{2}-\d{2}/i;
const REASONING_ECHO = /\b(?:show|output|include|print|write out|reproduce|reveal)\b[^.\n]{0,30}\b(?:chain[- ]of[- ]thought|(?:your|the) (?:internal )?(?:reasoning|thinking) (?:process|trace|steps))\b|\bthink step[- ]by[- ]step and (?:show|write|output)\b/i;
const CAPS_MIN = 5, CAPS_PER_1K = 3;

// The body with fenced code blanked — commands and examples are not prose — lines kept aligned.
function proseLines(body: string): string[] {
  let fenced = false;
  return body.split('\n').map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fenced = !fenced; return ''; }
    return fenced ? '' : l;
  });
}

const clip = (s: string) => { const t = s.trim(); return t.length > 90 ? t.slice(0, 87) + '…' : t; };

export interface GuidanceOptions { harnesses: HarnessCaps[]; local: Map<string, LocalCatalog | null>; taut?: TautContext | null; sandboxed?: Set<string> }

export function lintGuidance(a: Artifact, o: GuidanceOptions): Diagnostic[] {
  const out: Diagnostic[] = [];
  const d = (code: string, severity: Diagnostic['severity'], message: string, extra: Partial<Diagnostic> = {}, h?: HarnessCaps) =>
    out.push({ code, severity, message, path: a.path, guidance: mark(code, h), ...extra });
  const byId = new Map(o.harnesses.map((h) => [h.id, h]));

  // model / effort in frontmatter: Claude Code's fields (an opencode `provider/model` is skipped)
  const cc = byId.get('claude-code');
  const fmModel = typeof a.fm.data.model === 'string' ? a.fm.data.model : null;
  const fmEffort = typeof a.fm.data.effort === 'string' ? a.fm.data.effort : null;
  if (cc && (fmModel || fmEffort) && !(fmModel ?? '').includes('/')) {
    for (const v of judgeModel(cc, fmModel ?? 'inherit', fmEffort, o.local.get('claude-code') ?? null)) {
      const autofix: Autofix | undefined = v.autofixModel && v.code !== 'effort-unsupported'
        ? { op: 'set', key: 'model', value: v.autofixModel, label: `Set model: ${v.autofixModel}`, safety: 'review' } : undefined;
      d(v.code, v.severity, v.message, { line: v.code === 'effort-unsupported' ? a.fm.lines.effort : a.fm.lines.model, autofix }, cc);
    }
  }

  const lines = a.body.split('\n');
  const bodyLines = lines.length - (a.body.endsWith('\n') ? 1 : 0);     // the empty string after the final newline is not a line
  const at = (i: number) => a.fm.bodyOffset + i;
  if (a.kind === 'skill' && bodyLines > SPEC_BODY_MAX_LINES)
    d('body-over-spec', 'medium', `the body is ${bodyLines} lines — the guidance keeps SKILL.md under ${SPEC_BODY_MAX_LINES} and moves detail into referenced files`, { line: at(SPEC_BODY_MAX_LINES) });

  const prose = proseLines(a.body);
  const phrase = prose.findIndex((l) => UNDERTRIGGER_PHRASE.test(l));
  const caps = prose.flatMap((l, i) => [...l.matchAll(CAPS_IMPERATIVE)].map(() => i));
  const words = prose.join(' ').split(/\s+/).filter(Boolean).length || 1;
  const density = (caps.length * 1000) / words;
  if (phrase >= 0 || (caps.length >= CAPS_MIN && density >= CAPS_PER_1K)) {
    const first = phrase >= 0 ? phrase : caps[0];
    const what = phrase >= 0
      ? `an undertrigger-era instruction ("${clip(prose[phrase].match(UNDERTRIGGER_PHRASE)![0])}")`
      : `${caps.length} all-caps imperatives (${density.toFixed(1)} per 1,000 words)`;
    d('aggressive-imperative', 'low', `the body uses ${what}; first at line ${at(first)}: "${clip(prose[first])}"`, { line: at(first) });
  }
  const fossils = prose.map((l, i) => (FOSSIL.test(l) ? i : -1)).filter((i) => i >= 0);
  if (fossils.length >= 2)
    d('incident-fossil', 'low', `${fossils.length} dated incident/measurement stories in the body; first at line ${at(fossils[0])}: "${clip(prose[fossils[0]])}"`, { line: at(fossils[0]) });
  const echo = prose.findIndex((l) => REASONING_ECHO.test(l));
  if (echo >= 0)
    d('reasoning-echo', 'low', `asks the model to reproduce its reasoning: "${clip(prose[echo])}"`, { line: at(echo) });

  // Codex drops an agent's tools list; a read-only agent can still be held by the sandbox
  const cx = byId.get('codex');
  if (a.kind === 'agent' && cx && cx.agentAllowlist === 'dropped' && claimsReadOnlyOf(a)
    && !(a.tools ?? []).some((t) => ['Write', 'Edit', 'NotebookEdit', 'MultiEdit'].includes(t.base)) && !o.sandboxed?.has(a.name))
    d('codex-agent-sandbox', 'info', 'claims read-only, but on Codex its tools list is dropped — nothing mechanical holds the promise there', { line: a.fm.lines.tools ?? a.fm.lines.name }, cx);

  return out;
}

// ---- a TAUT pack's model ladder ------------------------------------------------------------

export async function deploymentOf(ctx: TautContext): Promise<{ file: string; text: string; manifest: any } | null> {
  if (!ctx.project) return null;
  const file = path.join(ctx.project.dir, 'deployment.json');
  try {
    const text = await fs.readFile(file, 'utf8');
    const j = JSON.parse(text);
    return { file, text, manifest: j.manifest ?? j };
  } catch { return null; }
}

// Agents the deployment already sandboxes on Codex (manifest.agentSandbox) — the D finding
// is satisfied there.
export function sandboxedAgents(dep: { manifest: any } | null): Set<string> {
  const s = dep?.manifest?.agentSandbox;
  return new Set(s && typeof s === 'object' ? Object.keys(s).filter((k) => !k.startsWith('$')) : []);
}

export function lintModelTiers(dep: { file: string; text: string; manifest: any }, harnesses: HarnessCaps[], local: Map<string, LocalCatalog | null>): Diagnostic[] {
  const ladder = dep.manifest?.modelTiers?.ladder;
  if (!Array.isArray(ladder)) return [];
  const lines = dep.text.split('\n');
  const out: Diagnostic[] = [];
  // the line of `"<key>": "<value>"` after the rung's tier line — ladders repeat keys per rung
  const lineOf = (tier: string, key: string, value: string) => {
    const start = Math.max(0, lines.findIndex((l) => l.includes(`"tier": "${tier}"`)));
    const i = lines.findIndex((l, n) => n >= start && l.includes(`"${key}": "${value}"`));
    return i >= 0 ? i + 1 : undefined;
  };
  for (const rung of ladder) {
    const tier = String(rung?.tier ?? '?');
    for (const [hid, model] of Object.entries(rung?.models ?? {})) {
      const h = harnesses.find((x) => x.id === hid);
      if (!h?.models || typeof model !== 'string') continue;
      const effort = typeof rung?.reasoningEffort?.[hid] === 'string' ? rung.reasoningEffort[hid] : null;
      for (const v of judgeModel(h, model, effort, local.get(hid) ?? null))
        out.push({
          code: v.code, severity: v.severity, path: dep.file,
          message: `modelTiers "${tier}" (${hid}): ${v.message}`,
          line: v.code === 'effort-unsupported' ? lineOf(tier, hid, effort ?? '') : lineOf(tier, hid, model),
          guidance: mark(v.code, h),
        });
    }
  }
  return out;
}
