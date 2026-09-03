// Test bench data model — neutral across harnesses. A RUN executes one CASE on one HARNESS
// inside a SCRATCH workspace and yields a TRACE; the MATRIX aggregates traces per artifact.

export interface BenchCase {
  name: string;
  source: 'evals' | 'auto';        // authored under <skill>/evals/**/prompt.md, or generated
  prompt: string;                  // harness-neutral; runners substitute {skill} invocation forms
  invocation: 'explicit' | 'implicit' | 'control';
  expect: 'fire' | 'no-fire';
  tags: string[];
  maxTurns: number;
  timeoutSeconds: number;
  model?: string;                  // per-case override (case frontmatter `model`)
  file?: string;                   // the prompt.md this came from
  assertions?: { kind: string; value: string }[];   // agentskills evals.json assertions, imported
}

export interface ToolCall {
  name: string;                    // harness-native name (Bash, Write, shell, apply_patch, mcp__x__y, skill…)
  neutral: string;                 // mapped to the Claude-shaped vocabulary used by allowlists (Bash, Write, Edit, Read, Skill, mcp__…)
  digest: string;                  // short, secret-free summary of the input (command / path / skill name)
  denied: boolean;                 // the harness refused it (permission denial, sandbox block)
  error: boolean;                  // the tool ran and failed
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface Trace {
  harness: string;
  case: BenchCase;
  run: number;                     // 1-based run index
  status: 'ok' | 'error' | 'unavailable' | 'timeout' | 'budget';
  error?: string;
  listed: boolean | null;          // the harness advertised the skill in its listing (null = not observable)
  competing: number | null;        // other skills in the listing (isolation caveat), null = not observable
  // how the skill entered the run; 'blocked' = it was invoked and the harness REFUSED the
  // invocation (a gate, a permission rule) — a finding about the workspace, not the author
  fired: 'tool' | 'expansion' | 'read' | 'none' | 'blocked' | 'unknown';
  firedOther: string[];            // OTHER skills the run invoked — an implicit prompt lost to them
  tools: ToolCall[];
  usage: Usage | null;
  costUsd: number | null;          // only where the harness reports it
  durationMs: number;
  turns: number | null;
  finalText: string;
  rawFile?: string;                // path to the stored raw event stream
  graders?: { name: string; type: string; pass: boolean; detail: string }[];   // L4
  score?: number;                  // L4: fraction of graders passed
}

export interface Obedience {
  declared: string[];              // the artifact's allowlist (raw entries)
  observed: string[];              // neutral names actually attempted
  violations: string[];            // attempted, outside the allowlist, NOT denied
  denied: string[];                // attempted and refused by the harness
  enforcement: string;             // the harness's allowlist semantics (grant/restrict/prose/dropped)
}

export interface RunReport {
  harness: string;
  available: boolean;
  reason?: string;                 // why unavailable
  traces: Trace[];
  trigger: { fireRate: number | null; controlClean: boolean | null; lostTo: string[] };  // over runs of expect=fire / expect=no-fire; lostTo = skills that fired instead
  obedience: Obedience | null;
  scenario: { score: number | null; graded: number; failed: string[] } | null;   // L4
  skipped: { case: string; why: string }[];   // cases that cannot fire by construction
  costUsd: number;
  tokens: number;
}

export interface BenchResult {
  version: string;
  artifact: { kind: 'skill' | 'agent'; name: string; path: string };
  mode: 'generic' | 'taut';
  levels: number[];
  scratch: string;
  compiled: { ok: boolean; detail: string; verify?: string };
  reports: RunReport[];
  startedAt: string;
  finishedAt: string;
  budget: { maxCostUsd: number | null; spentUsd: number; exhausted: boolean };
}
