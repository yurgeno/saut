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
export interface UsageData { workspace: string; days: number; from: string | null; to: string | null; rows: Map<string, UsageRow> }

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export async function readUsage(workspace: string, opts: { since?: string; to?: string } = {}): Promise<UsageData | null> {
  const dir = path.join(path.resolve(workspace), 'memory', 'telemetry');
  if (!(await exists(dir))) return null;
  let files: string[] = [];
  try { files = (await fs.readdir(dir)).filter((f) => DAY_FILE.test(f) || f === 'usage.jsonl').sort(); } catch { return null; }
  const days = files.filter((f) => DAY_FILE.test(f)).filter((f) => {
    const d = f.slice(0, 10);
    return (!opts.since || d >= opts.since) && (!opts.to || d <= opts.to);
  });
  const rows = new Map<string, UsageRow>();
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
      const key = r.name;
      const row = rows.get(key) ?? { name: key, kind: String(r.kind ?? 'skill'), allow: 0, deny: 0 };
      if (r.decision === 'deny') row.deny++; else row.allow++;
      rows.set(key, row);
    }
  }
  return { workspace: path.resolve(workspace), days: days.length, from, to, rows };
}

// Where a compiled workspace for a pack might live: the caller's --workspace, else nothing.
// (SAUT never guesses a workspace — a wrong one would attribute someone else's usage.)
export function usageFor(usage: UsageData | null, name: string): UsageRow | null {
  return usage?.rows.get(name) ?? null;
}
