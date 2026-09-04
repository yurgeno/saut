// Usage — how often an artifact is ACTUALLY invoked, read from a compiled TAUT workspace's
// own telemetry (memory/telemetry/YYYY-MM-DD.jsonl, written locally by the gate; never sent
// anywhere). Cost answers "what does this cost every session"; usage answers "does anyone
// call it" — together they name the skills worth compressing or dropping.
//
// Only `invoke` events are read, and only their artifact NAMES (framework artifacts, the
// subject of the measurement). Nothing personal is read: prompts, paths, repo names and
// tool arguments are not in these files by the telemetry design.
import fs from 'node:fs/promises';
import path from 'node:path';
import { exists } from './util.mts';

export interface UsageRow { name: string; kind: string; allow: number; deny: number }
export interface UsageData {
  workspace: string; days: number; from: string | null; to: string | null; rows: Map<string, UsageRow>;
  probes: number;          // self-test rows excluded from the counts
  pathsRecorded: boolean;  // false = these files predate the slash-aware gate; a 0 means "not recorded"
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// Two things in a telemetry file are NOT usage, and both used to be counted as if they were.
//
// 1. `taut check` proves the gate is live by invoking it out of band against the first skill
//    in the manifest, once per harness. A workspace checked routinely accumulates a large,
//    entirely synthetic count on whichever skill happens to sit first — the most convincing-
//    looking number in the report and the least real. Current engines mark these `probe`;
//    older files are recognized by the reserved probe name and by the allow-row the same
//    self-test wrote in the same second.
//
// 2. Rows the gate could not name (sibling tools caught by a partial hook matcher). They
//    carry no name and are skipped by the name check below.
const PROBE_NAME = 'taut-check-foreign-probe';

export async function readUsage(workspace: string, opts: { since?: string; to?: string } = {}): Promise<UsageData | null> {
  const dir = path.join(path.resolve(workspace), 'memory', 'telemetry');
  if (!(await exists(dir))) return null;
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => DAY_FILE.test(f) || f === 'usage.jsonl').sort(); } catch { return null; }
  const days = files.filter((f) => DAY_FILE.test(f)).filter((f) => {
    const d = f.slice(0, 10);
    return (!opts.since || d >= opts.since) && (!opts.to || d <= opts.to);
  });
  // Read once, decide after: whether a row is a legacy probe depends on the other rows
  // around it, which a single streaming pass cannot know yet.
  const invokes: any[] = [];
  let from: string | null = null; let to: string | null = null;
  for (const f of [...days, ...(files.includes('usage.jsonl') ? ['usage.jsonl'] : [])]) {
    let text: string;
    try { text = await fs.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.event !== 'invoke' || typeof r.name !== 'string') continue;
      const day = typeof r.ts === 'string' ? r.ts.slice(0, 10) : null;
      if (day) { if (opts.since && day < opts.since) continue; if (opts.to && day > opts.to) continue; if (!from || day < from) from = day; if (!to || day > to) to = day; }
      invokes.push(r);
    }
  }
  const probeSeconds = new Set(invokes.filter((r) => r.name === PROBE_NAME).map((r) => String(r.ts ?? '').slice(0, 19)));
  const isProbe = (r: any) => r.probe === true || r.name === PROBE_NAME
    || (!r.session_id && probeSeconds.has(String(r.ts ?? '').slice(0, 19)));

  const rows = new Map<string, UsageRow>();
  let probes = 0;
  for (const r of invokes) {
    if (isProbe(r)) { probes++; continue; }
    const row = rows.get(r.name) ?? { name: r.name, kind: String(r.kind ?? 'skill'), allow: 0, deny: 0 };
    if (r.decision === 'deny') row.deny++; else row.allow++;
    rows.set(r.name, row);
  }
  // A gate that records both invocation paths labels every row with the one it came from.
  // No label anywhere means these files were written before the slash path was counted at
  // all — and a skill a human drives by hand reaches the harness ONLY that way. Reporting
  // its `0` without saying so would be the measurement lying with a straight face.
  const pathsRecorded = invokes.some((r) => typeof r.via === 'string');
  return { workspace: path.resolve(workspace), days: days.length, from, to, rows, probes, pathsRecorded };
}

// Where a compiled workspace for a pack might live: the caller's --workspace, else nothing.
// (SAUT never guesses a workspace — a wrong one would attribute someone else's usage.)
export function usageFor(usage: UsageData | null, name: string): UsageRow | null {
  return usage?.rows.get(name) ?? null;
}
