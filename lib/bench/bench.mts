// The bench orchestrator: L1 compile (scratch), L2 trigger (does the harness fire the skill),
// L3 obedience (does the run stay inside the allowlist). Budgeted, isolated, resumable by
// reading the results directory. Levels are cumulative: --level 3 runs 1, 2 and 3.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TautContext } from '../adapters/taut.mts';
import type { Artifact, HarnessCaps } from '../types.mts';
import { loadCases } from './cases.mts';
import { obedience } from './obedience.mts';
import { gradeAll, loadGraders } from './graders.mts';
import { RUNNERS, available } from './runners.mts';
import { cleanHarnessState, genericScratch, makeScratchRoot, tautScratch } from './scratch.mts';
import type { BenchCase, BenchResult, RunReport, Trace } from './types.mts';

export interface BenchOptions {
  artifact: Artifact;
  siblings: Artifact[];
  harnesses: HarnessCaps[];
  taut: TautContext | null;
  level: 1 | 2 | 3 | 4;
  runs: number;
  model?: string;
  judgeModel?: string;         // L4 LLM/baseline graders (default: a cheap tier)
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
  const gradersByCase = new Map<string, Awaited<ReturnType<typeof loadGraders>>>();
  if (o.level >= 4) for (const c of cases) gradersByCase.set(c.name, [...(await loadGraders(c.file)), ...assertionGraders(c)]);
  const rawDir = path.join(o.outDir, 'traces');

  for (const h of runnable) {
    const rep: RunReport = { harness: h.id, available: true, traces: [], trigger: { fireRate: null, controlClean: null, lostTo: [] }, obedience: null, scenario: null, skipped: [], costUsd: 0, tokens: 0 };
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
      // A case that cannot possibly fire measures nothing about the description — say so and
      // spend no money on it. `disable-model-invocation: true` is exactly that for an
      // implicit prompt: the harness is forbidden to choose the skill on its own.
      const unwinnable = c.invocation === 'implicit' && c.expect === 'fire' && a.kind === 'skill' && !a.modelInvocable
        ? 'the skill sets `disable-model-invocation: true` — a harness may not choose it on its own; only an explicit invocation can fire it'
        : null;
      if (unwinnable) { say(o, 'skip', `${h.id} · ${c.name}: ${unwinnable}`); rep.skipped.push({ case: c.name, why: unwinnable }); continue; }
      for (let run = 1; run <= o.runs; run++) {
        if (exhausted) break;
        say(o, 'run', `${h.id} · ${c.name} (${c.invocation}, expect ${c.expect}) · run ${run}/${o.runs}`);
        const trace: Trace = await RUNNERS[h.id]({ harness: h, artifact: a, cwd: scratch.ws, case: c, run, model: o.model, allowedTools, timeoutMs: Math.min(o.timeoutMs, c.timeoutSeconds * 1000), rawDir });
        // L4: grade the scenario against this run — a scratch that still holds its files
        if (o.level >= 4 && trace.status === 'ok' && c.expect === 'fire') {
          const gs = gradersByCase.get(c.name) ?? [];
          if (gs.length) {
            const g = await gradeAll(gs, { trace, ws: scratch.ws, judgeModel: o.judgeModel ?? 'haiku', skillName: a.name });
            trace.graders = g.verdicts.map((v) => ({ name: v.name, type: v.type, pass: v.pass, detail: v.detail }));
            trace.score = g.score;
            spent += g.costUsd; rep.costUsd += g.costUsd;
            say(o, g.score === 1 ? 'graded' : 'fail', `  graders ${g.verdicts.filter((v) => v.pass).length}/${g.verdicts.length}${g.verdicts.filter((v) => !v.pass).map((v) => ` · ${v.name}: ${v.detail}`).join('')}`);
          }
        }
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
    const graded = rep.traces.filter((t) => t.score !== undefined);
    rep.scenario = graded.length
      ? { score: graded.reduce((s2, t) => s2 + (t.score ?? 0), 0) / graded.length, graded: graded.length,
          failed: [...new Set(graded.flatMap((t) => (t.graders ?? []).filter((g) => !g.pass).map((g) => g.name)))] }
      : null;
  }

  const result: BenchResult = {
    version: o.version,
    artifact: { kind: a.kind, name: a.name, path: a.path },
    mode: scratch.mode,
    levels: [1, 2, 3, 4].filter((l) => l <= o.level),
    scratch: root,
    compiled: scratch.compiled,
    reports,
    startedAt,
    finishedAt: new Date().toISOString(),
    budget: { maxCostUsd: o.maxCostUsd, spentUsd: spent, exhausted },
  };
  await fs.mkdir(o.outDir, { recursive: true });
  await fs.writeFile(path.join(o.outDir, 'matrix.json'), JSON.stringify(result, null, 2) + '\n');
  if (!o.keepScratch) {
    const swept = await cleanHarnessState(root);
    if (swept.length) say(o, 'clean', `removed ${swept.length} harness state dir(s) the runs created outside the scratch`);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

// An agentskills `evals.json` assertion becomes a regex grader over the final message —
// the spec's assertions are substring/contains checks, which is exactly a regex `contains`.
function assertionGraders(c: BenchCase): { name: string; type: 'regex'; file: string; body: string; fm: Record<string, unknown> }[] {
  return (c.assertions ?? []).map((a, i) => ({
    name: `assert-${i + 1}`,
    type: 'regex' as const,
    file: c.file ?? '',
    body: a.value,
    fm: { type: 'regex', pattern: a.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: 'i', match: a.kind === 'not_contains' ? 'not_contains' : 'contains' },
  }));
}
