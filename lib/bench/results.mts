// Where bench runs land. Never inside the project: traces carry full model transcripts, and a
// compiled workspace's skill directories are sealed by an integrity lock. One directory per
// artifact — keyed by its real path — so a run started from the CLI and one started from the
// Studio share a history.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Artifact } from '../types.mts';

// $SAUT_HOME/results, default ~/.saut/results
export function resultsHome(): string {
  return path.join(process.env.SAUT_HOME || path.join(os.homedir(), '.saut'), 'results');
}

export function runStamp(d = new Date(), suffix = ''): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + (suffix ? `-${suffix}` : '');
}

// <home>/<name>--<8 hex of the artifact's real path>
export async function artifactResultsRoot(a: Artifact): Promise<string> {
  const real = await fs.realpath(a.path).catch(() => path.resolve(a.path));
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 8);
  const name = (a.name || 'artifact').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
  return path.join(resultsHome(), `${name}--${hash}`);
}

export async function newResultsDir(a: Artifact, suffix = ''): Promise<string> {
  return path.join(await artifactResultsRoot(a), runStamp(new Date(), suffix));
}

// ---- history -----------------------------------------------------------------------------

export interface RunSummary {
  id: string;                        // the run directory name (a timestamp)
  startedAt: string;
  label: string | null; pair: string | null; note: string | null;
  levels: number[];
  compiledOk: boolean;
  costUsd: number; tokens: number;
  models: Record<string, string | null>;
  harnesses: { harness: string; available: boolean; fireRate: number | null; controlClean: boolean | null; violations: number; scenario: number | null; costUsd: number; tokens: number }[];
}

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-[a-z0-9-]+)?$/;

export function summarize(id: string, r: import('./types.mts').BenchResult): RunSummary {
  return {
    id, startedAt: r.startedAt,
    label: r.meta?.label ?? null, pair: r.meta?.pair ?? null, note: r.meta?.note ?? null,
    levels: r.levels, compiledOk: r.compiled.ok,
    costUsd: r.reports.reduce((n, x) => n + (x.costUsd ?? 0), 0),
    tokens: r.reports.reduce((n, x) => n + (x.tokens ?? 0), 0),
    models: r.models ?? {},
    harnesses: r.reports.map((x) => ({
      harness: x.harness, available: x.available, fireRate: x.trigger.fireRate, controlClean: x.trigger.controlClean,
      violations: x.obedience?.violations.length ?? 0, scenario: x.scenario?.score ?? null, costUsd: x.costUsd ?? 0, tokens: x.tokens ?? 0,
    })),
  };
}

// Every run of this artifact, newest first. A directory that is not a finished run (no
// matrix.json, or one that does not parse) is skipped, not fatal.
export async function listRuns(a: Artifact): Promise<RunSummary[]> {
  const dir = await artifactResultsRoot(a);
  const ids = (await fs.readdir(dir).catch(() => [] as string[])).filter((x) => RUN_ID.test(x)).sort().reverse();
  const out: RunSummary[] = [];
  for (const id of ids) {
    try { out.push(summarize(id, JSON.parse(await fs.readFile(path.join(dir, id, 'matrix.json'), 'utf8')))); } catch { /* unfinished */ }
  }
  return out;
}

export async function readRun(a: Artifact, id: string): Promise<import('./types.mts').BenchResult> {
  if (!RUN_ID.test(id)) throw new Error('not a run id');
  return JSON.parse(await fs.readFile(path.join(await artifactResultsRoot(a), id, 'matrix.json'), 'utf8'));
}

// Model runs a bench will make — the number the cost follows. Cases that cannot fire by
// construction are skipped by the bench and not counted here either.
export function plannedRuns(cases: { invocation: string; expect: string }[], a: Artifact, harnesses: number, runs: number, level: number): number {
  if (level < 2) return 0;
  const live = cases.filter((c) => !(c.invocation === 'implicit' && c.expect === 'fire' && a.kind === 'skill' && !a.modelInvocable));
  return live.length * harnesses * runs;
}
