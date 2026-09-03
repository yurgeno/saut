// Cost passport: what a skill/agent adds to context ALWAYS (its listing entry: name +
// description, paid in every session) and ON INVOKE (the body plus what the body pulls in).
//
// Default counting is an ESTIMATE (no key, no network) — labelled as such, like
// `claude plugin details`. `--exact` uses the Claude token-counting API
// (https://platform.claude.com/docs/en/build-with-claude/token-counting) with
// ANTHROPIC_API_KEY from the environment.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, Budgets, CostLine, HarnessCaps } from './types.mts';
import { exists } from './util.mts';

// Heuristic tokenizer: words ≈ 1 token per ~4.5 letters (min 1), digits ≈ 1 per 3,
// every punctuation/symbol char ≈ 1, whitespace free. On English markdown this lands
// within ~10 % of a BPE tokenizer; on dense tables/code it over-counts slightly — the
// conservative direction for a budget.
export function estimateTokens(text: string): number {
  let n = 0;
  const re = /[A-Za-zÀ-ɏЀ-ӿ]+|\d+|[^\sA-Za-zÀ-ɏЀ-ӿ\d]/g;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (/^[A-Za-zÀ-ɏЀ-ӿ]/.test(s)) n += Math.max(1, Math.round(s.length / 4.5));
    else if (/^\d/.test(s)) n += Math.ceil(s.length / 3);
    else n += 1;
  }
  return n;
}

export async function exactTokens(text: string, model = 'claude-sonnet-5'): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('--exact needs ANTHROPIC_API_KEY in the environment');
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text || '.' }] }),
  });
  if (!res.ok) throw new Error(`count_tokens ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { input_tokens: number };
  return j.input_tokens;
}

// What the listing entry looks like per harness. Claude Code lists `name` + `description`
// (capped); Codex/OpenCode list name + description too (Codex: ≤ 2 % of context / 8 000
// chars for the whole list). We count name + description as the always-on payload and let
// the harness registry cap the description when it documents a cap.
export function listingText(a: Artifact, h: HarnessCaps | null): string {
  const cap = h?.listing.descCap ?? null;
  const desc = cap && a.description.length > cap ? a.description.slice(0, cap) : a.description;
  return `${a.name}: ${desc}`;
}

// Files the body references by relative path (references/, scripts/, runbooks…) that a
// harness would read on invoke. Conservative: only paths that exist next to the artifact.
export async function referencedFiles(a: Artifact): Promise<string[]> {
  const base = a.kind === 'skill' ? a.dir : path.dirname(a.path);
  const cands = new Set<string>();
  for (const m of a.body.matchAll(/(?:\.\/|\b)((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:md|txt|json|yaml|yml|sh|py|mjs|js|ts))\b/g)) cands.add(m[1]);
  const out: string[] = [];
  for (const c of cands) {
    const p = path.resolve(base, c);
    if (p.startsWith(base) && (await exists(p)) && !(await fs.stat(p)).isDirectory()) out.push(p);
  }
  return out;
}

export async function costOf(
  a: Artifact,
  opts: { harness: HarnessCaps | null; exact: boolean; agentsByName: Map<string, Artifact> },
): Promise<CostLine> {
  const count = opts.exact ? exactTokens : async (t: string) => estimateTokens(t);
  const listing = listingText(a, opts.harness);
  const alwaysOnTokens = await count(listing);
  const invokeTokens = await count(a.body);
  const transitive: CostLine['transitive'] = [];
  // agents wired from a skill: Claude Code `agent:`/`context: fork`, TAUT `metadata.taut.agents`
  if (a.kind === 'skill') {
    const wired = new Set<string>();
    const taut = (a.metadata?.taut as { agents?: unknown } | undefined)?.agents;
    if (Array.isArray(taut)) for (const x of taut) wired.add(String(x));
    const ag = a.fm.data.agent;
    if (typeof ag === 'string') wired.add(ag);
    for (const name of wired) {
      const ad = opts.agentsByName.get(name);
      if (ad) transitive.push({ name: `agent:${name}`, tokens: await count(ad.body) });
    }
  }
  for (const f of await referencedFiles(a)) {
    const text = await fs.readFile(f, 'utf8');
    transitive.push({ name: path.relative(a.kind === 'skill' ? a.dir : path.dirname(a.path), f), tokens: await count(text) });
  }
  return {
    artifact: a.name,
    kind: a.kind,
    alwaysOnChars: listing.length,
    alwaysOnTokens,
    invokeChars: a.body.length,
    invokeTokens,
    transitive,
    method: opts.exact ? 'exact' : 'estimate',
  };
}

export function overBudget(line: CostLine, a: Artifact, b: Budgets): string[] {
  const out: string[] = [];
  if (b.descriptionChars && a.description.length > b.descriptionChars) out.push(`description ${a.description.length} chars > budget ${b.descriptionChars}`);
  if (b.alwaysOnTokens && line.alwaysOnTokens > b.alwaysOnTokens) out.push(`always-on ${line.alwaysOnTokens} tok > budget ${b.alwaysOnTokens}`);
  const inv = line.invokeTokens + line.transitive.reduce((s, t) => s + t.tokens, 0);
  if (b.invokeTokens && inv > b.invokeTokens) out.push(`on-invoke ${inv} tok > budget ${b.invokeTokens}`);
  return out;
}
