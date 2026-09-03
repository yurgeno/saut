// The bench orchestrator: L1 compile (scratch), L2 trigger (does the harness fire the skill),
// L3 obedience (does the run stay inside the allowlist). Budgeted, isolated, resumable by
// reading the results directory. Levels are cumulative: --level 3 runs 1, 2 and 3.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TautContext } from '../adapters/taut.mts';
import type { Artifact, HarnessCaps } from '../types.mts';
import { loadCases } from './cases.mts';
import { obedience } from './obedience.mts';
import { RUNNERS, available } from './runners.mts';
import { genericScratch, makeScratchRoot, tautScratch } from './scratch.mts';
import type { BenchCase, BenchResult, RunReport, Trace } from './types.mts';

export interface BenchOptions {
  artifact: Artifact;
  siblings: Artifact[];
  harnesses: HarnessCaps[];
  taut: TautContext | null;
  level: 1 | 2 | 3;
  runs: number;
  model?: string;
  maxCostUsd: number | null;
  landscape: string | null;
  caseFilter?: string;
  outDir: string;
  keepScratch: boolean;
  timeoutMs: number;
  version: string;
  onEvent?: (e: { kind: string; text: string }) => void;
}

const say = (o: BenchOptions, kind: string, text: string) => o.onEvent?.({ kind, text });

export async function runBench(o: BenchOptions): Promise<BenchResult> {
  const startedAt = new Date().toISOString();
  const a = o.artifact;
  const root = await makeScratchRoot();
  const runnable = o.harnesses.filter((h) => h.runner);
  const harnessIds = runnable.map((h) => h.id);

  // ---- L1: compile into a scratch workspace ------------------------------------------
  say(o, 'step', `L1 compile → ${root}`);
  const scratch = o.taut
    ? await tautScratch(a, o.taut, harnessIds, root, o.landscape)
    : await genericScratch(a, runnable, root, o.siblings);
  say(o, scratch.compiled.ok ? 'ok' : 'fail', `${scratch.mode}: ${scratch.compiled.detail}${scratch.compiled.verify ? ` · verify ${scratch.compiled.verify}` : ''}`);

  const reports: RunReport[] = [];
  let spent = 0; let exhausted = false;
  const cases: BenchCase[] = o.level >= 2 ? await loadCases(a, o.caseFilter) : [];
  const rawDir = path.join(o.outDir, 'traces');

  for (const h of runnable) {
    const rep: RunReport = { harness: h.id, available: true, traces: [], trigger: { fireRate: null, controlClean: null, lostTo: [] }, obedience: null, costUsd: 0, tokens: 0 };
    reports.push(rep);
    const av = await available(h);
    if (!av.ok) { rep.available = false; rep.reason = av.reason; say(o, 'skip', `${h.id}: ${av.reason}`); continue; }
    if (!scratch.compiled.ok) { rep.available = false; rep.reason = 'L1 failed'; continue; }
    if (o.level < 2) continue;
    // the allowlist the run pre-approves for Claude: the artifact's own grant minus the shell
    // (a shell attempt outside the grant then shows up as a denial, not an execution)
    // `Skill` is the MECHANISM under test — always pre-approved, or the harness's own
    // permission mode would deny the invocation and the trigger measurement would be void.
    // The shell stays out: a mutation attempt then surfaces as a denial instead of running
    // (read-only commands are still allowed by the harness's own classifier).
    const list = (a.kind === 'skill' ? a.allowedTools : a.tools) ?? [];
    const allowedTools = [...new Set([...list.filter((t) => t.base !== 'Bash' && t.base !== 'PowerShell').map((t) => t.raw), 'Skill'])];
    for (const c of cases) {
      for (let run = 1; run <= o.runs; run++) {
        if (exhausted) break;
        say(o, 'run', `${h.id} · ${c.name} (${c.invocation}, expect ${c.expect}) · run ${run}/${o.runs}`);
        const trace: Trace = await RUNNERS[h.id]({ harness: h, artifact: a, cwd: scratch.ws, case: c, run, model: o.model, allowedTools, timeoutMs: Math.min(o.timeoutMs, c.timeoutSeconds * 1000), rawDir });
        rep.traces.push(trace);
        if (trace.costUsd) { spent += trace.costUsd; rep.costUsd += trace.costUsd; }
        if (trace.usage) rep.tokens += trace.usage.input + trace.usage.output + trace.usage.cacheRead + trace.usage.cacheWrite;
        say(o, trace.status === 'ok' ? 'trace' : 'fail', `  → ${trace.status}${trace.error ? ` (${trace.error.slice(0, 120)})` : ''} · fired=${trace.fired}${trace.firedOther.length ? ` (lost to ${trace.firedOther.join(',')})` : ''}${trace.listed !== null ? ` listed=${trace.listed}${trace.competing ? ` (+${trace.competing} competing)` : ''}` : ''} · tools=${trace.tools.map((x) => x.neutral + (x.denied ? '⊘' : '')).join(',') || '—'}${trace.costUsd != null ? ` · $${trace.costUsd.toFixed(3)}` : ''} · ${(trace.durationMs / 1000).toFixed(0)}s`);
        if (trace.status === 'unavailable') { rep.available = false; rep.reason = trace.error; break; }
        if (o.maxCostUsd !== null && spent >= o.maxCostUsd) { exhausted = true; say(o, 'budget', `budget ${o.maxCostUsd} USD reached — stopping`); }
      }
      if (!rep.available || exhausted) break;
    }
    // a run that hit the turn limit still made a routing decision — it counts
    const fireRuns = rep.traces.filter((t) => t.case.expect === 'fire' && (t.status === 'ok' || (t.status === 'error' && t.tools.length > 0)));
    const fired = fireRuns.filter((t) => t.fired === 'tool' || t.fired === 'expansion' || t.fired === 'read');
    rep.trigger.fireRate = fireRuns.length ? fired.length / fireRuns.length : null;
    rep.trigger.lostTo = [...new Set(fireRuns.filter((t) => t.fired === 'none' || t.fired === 'blocked').flatMap((t) => t.firedOther))];
    const controls = rep.traces.filter((t) => t.case.expect === 'no-fire' && t.status === 'ok');
    rep.trigger.controlClean = controls.length ? controls.every((t) => t.fired === 'none') : null;
    if (o.level >= 3) rep.obedience = obedience(a, h, rep.traces);
  }

  const result: BenchResult = {
    version: o.version,
    artifact: { kind: a.kind, name: a.name, path: a.path },
    mode: scratch.mode,
    levels: [1, 2, 3].filter((l) => l <= o.level),
    scratch: root,
    compiled: scratch.compiled,
    reports,
    startedAt,
    finishedAt: new Date().toISOString(),
    budget: { maxCostUsd: o.maxCostUsd, spentUsd: spent, exhausted },
  };
  await fs.mkdir(o.outDir, { recursive: true });
  await fs.writeFile(path.join(o.outDir, 'matrix.json'), JSON.stringify(result, null, 2) + '\n');
  if (!o.keepScratch) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  return result;
}
