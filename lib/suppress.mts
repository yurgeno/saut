// Suppressing a finding — with a reason, in saut.json, never in the artifact the model reads.
//
//   { "suppress": [ { "rule": "injection-heuristic", "artifact": "env-check",
//                     "match": "never echo credentials", "reason": "prose, not a read — …" } ] }
//
// A suppressed finding is not deleted: it stays in every output marked `suppressed` with its
// reason (SARIF: `suppressions`), and it no longer counts toward the exit code or the totals.
// A suppression that matches nothing is itself reported — the finding it silenced was fixed,
// or the entry drifted — so the file cannot quietly accumulate dead exemptions.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Artifact, Diagnostic } from './types.mts';
import { exists, readText } from './util.mts';

export interface Suppression { rule: string; artifact: string; reason: string; match?: string; line?: number }
export interface SuppressionSet { file: string | null; list: Suppression[]; problems: Diagnostic[] }

export const MIN_REASON = 8;

// saut.json next to the start or in an ancestor — the same lookup the cost budgets use.
export async function findConfig(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  try { if (!(await fs.stat(dir)).isDirectory()) dir = path.dirname(dir); } catch { dir = path.dirname(dir); }
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, 'saut.json');
    if (await exists(p)) return p;
    const up = path.dirname(dir); if (up === dir) break; dir = up;
  }
  return null;
}

export async function loadSuppressions(start: string): Promise<SuppressionSet> {
  const file = await findConfig(start);
  if (!file) return { file: null, list: [], problems: [] };
  const problems: Diagnostic[] = [];
  let raw: unknown;
  try { raw = JSON.parse(await readText(file)); } catch (e) {
    return { file, list: [], problems: [{ code: 'suppression-invalid', severity: 'medium', path: file, message: `saut.json does not parse: ${(e as Error).message}` }] };
  }
  const entries = (raw as { suppress?: unknown })?.suppress;
  if (entries === undefined) return { file, list: [], problems };
  if (!Array.isArray(entries)) return { file, list: [], problems: [{ code: 'suppression-invalid', severity: 'medium', path: file, message: '`suppress` must be a list' }] };
  const list: Suppression[] = [];
  entries.forEach((e: any, i: number) => {
    const where = `suppress[${i}]`;
    if (!e || typeof e !== 'object' || typeof e.rule !== 'string' || typeof e.artifact !== 'string')
      return problems.push({ code: 'suppression-invalid', severity: 'medium', path: file, message: `${where}: needs "rule" and "artifact"` });
    if (typeof e.reason !== 'string' || e.reason.trim().length < MIN_REASON)
      return problems.push({ code: 'suppression-invalid', severity: 'medium', path: file, message: `${where} (${e.rule} on ${e.artifact}): a suppression needs a reason of at least ${MIN_REASON} characters — it is ignored until it has one` });
    list.push({ rule: e.rule, artifact: e.artifact, reason: e.reason.trim(), ...(typeof e.match === 'string' && e.match ? { match: e.match } : {}), ...(Number.isInteger(e.line) ? { line: e.line } : {}) });
  });
  return { file, list, problems };
}

export function matches(s: Suppression, d: Diagnostic, artifactName: string | undefined): boolean {
  return d.code === s.rule && artifactName === s.artifact
    && (s.line === undefined || d.line === s.line)
    && (!s.match || d.message.includes(s.match));
}

// Mark the suppressed findings; report the suppressions that silenced nothing. `names` maps a
// finding's path to its artifact name (compiled copies of one skill share it).
// `only`: the artifacts this run linted, when it linted part of what saut.json covers — an
// entry for an artifact outside it was not tested, so it is not reported as unused.
export function applySuppressions(ds: Diagnostic[], names: Map<string, string>, set: SuppressionSet, opts: { reportUnused?: boolean; only?: Set<string> } = {}): Diagnostic[] {
  if (!set.list.length) return [...ds, ...set.problems];
  const used = new Set<number>();
  const out = ds.map((d) => {
    const i = set.list.findIndex((s) => matches(s, d, names.get(d.path)));
    if (i < 0) return d;
    used.add(i);
    return { ...d, suppressed: { reason: set.list[i].reason, file: set.file! } };
  });
  const unused = opts.reportUnused === false ? [] : set.list.flatMap((s, i) => used.has(i) || (opts.only && !opts.only.has(s.artifact)) ? [] : [{
    code: 'suppression-unused', severity: 'low' as const, path: set.file!,
    message: `the suppression of ${s.rule} on ${s.artifact}${s.match ? ` ("${s.match}")` : ''} matches no finding — the finding was fixed, or the entry drifted; remove it`,
  }]);
  return [...out, ...set.problems, ...unused];
}

export const namesOf = (artifacts: Artifact[]) => new Map(artifacts.map((a) => [a.path, a.name]));
export const active = (ds: Diagnostic[]) => ds.filter((d) => !d.suppressed);

// The distinctive part of a finding to pin a suppression to: its quoted subject (a tool name,
// the line it matched) when it has one — so a suppression survives the file moving around.
export function matchFor(d: Diagnostic): string | undefined {
  const q = d.message.match(/"([^"]{3,})"/);
  return q ? q[1].replace(/…$/, '') : undefined;
}
