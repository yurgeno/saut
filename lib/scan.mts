// Content security scanning is RENTED, not rebuilt: the field already has strong scanners
// (NVIDIA SkillSpector, Snyk Agent Scan, Cisco skill-scanner). `saut lint --scan` runs
// whichever one is installed and folds its findings into the same diagnostic stream, so a
// SAUT report is one list rather than two tools' worth of output.
//
// Nothing is downloaded or spawned implicitly: without an installed scanner the flag reports
// that plainly and the lint proceeds with SAUT's own rules. What SAUT owns is the part no
// scanner produces — the per-harness privilege semantics (grant vs restriction vs prose).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Diagnostic, Severity } from './types.mts';
import { onPath } from './util.mts';

const run = promisify(execFile);
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;    // a scanner that hangs must not hang the lint

export interface ScannerSpec {
  id: string;
  bin: string;
  args: (target: string) => string[];
  parse: (stdout: string, target: string) => Diagnostic[];
  home: string;
}

const sev = (s: string): Severity => {
  const x = s.toLowerCase();
  if (['critical', 'high', 'error'].includes(x)) return 'high';
  if (['medium', 'moderate', 'warning', 'warn'].includes(x)) return 'medium';
  if (['low', 'note', 'info'].includes(x)) return 'low';
  return 'medium';
};

// SARIF 2.1.0 — the format Cisco's scanner emits and the one most CI tooling reads.
function parseSarif(stdout: string, target: string, id: string): Diagnostic[] {
  const j = JSON.parse(stdout) as { runs?: { results?: any[]; tool?: { driver?: { rules?: any[] } } }[] };
  const out: Diagnostic[] = [];
  for (const r of j.runs ?? []) {
    for (const res of r.results ?? []) {
      const loc = res.locations?.[0]?.physicalLocation;
      out.push({
        code: `scan-${res.ruleId ?? 'finding'}`,
        severity: sev(String(res.level ?? 'warning')),
        message: `${String(res.message?.text ?? '').slice(0, 400)} [${id}]`,
        path: loc?.artifactLocation?.uri ? path.resolve(target, String(loc.artifactLocation.uri)) : target,
        line: loc?.region?.startLine,
        precedent: id,
      });
    }
  }
  return out;
}

// A generic JSON findings array — the shape SkillSpector and Snyk's agent scan both emit
// (field names differ, so every plausible key is read).
function parseJsonFindings(stdout: string, target: string, id: string): Diagnostic[] {
  const j = JSON.parse(stdout) as any;
  const items: any[] = Array.isArray(j) ? j : j.findings ?? j.issues ?? j.results ?? j.vulnerabilities ?? [];
  return items.map((f) => ({
    code: `scan-${String(f.id ?? f.rule ?? f.check ?? f.category ?? 'finding').replace(/\s+/g, '-').toLowerCase()}`,
    severity: sev(String(f.severity ?? f.level ?? f.risk ?? 'medium')),
    message: `${String(f.message ?? f.title ?? f.description ?? f.detail ?? 'finding').slice(0, 400)} [${id}]`,
    path: f.file ?? f.path ?? f.location ?? target,
    line: typeof f.line === 'number' ? f.line : undefined,
    precedent: id,
  }));
}

export const SCANNERS: ScannerSpec[] = [
  { id: 'skillspector', bin: 'skillspector', home: 'https://github.com/nvidia/skillspector',
    args: (t) => ['scan', t, '--format', 'json'], parse: (o, t) => parseJsonFindings(o, t, 'skillspector') },
  { id: 'snyk-agent-scan', bin: 'snyk', home: 'https://github.com/snyk/agent-scan',
    args: (t) => ['agent', 'scan', t, '--json'], parse: (o, t) => parseJsonFindings(o, t, 'snyk-agent-scan') },
  { id: 'skill-scanner', bin: 'skill-scanner', home: 'https://github.com/cisco-ai-defense/skill-scanner',
    args: (t) => ['scan', t, '--format', 'sarif'], parse: (o, t) => parseSarif(o, t, 'skill-scanner') },
];

export async function detectScanners(): Promise<ScannerSpec[]> {
  const found: ScannerSpec[] = [];
  for (const s of SCANNERS) if (await onPath(s.bin)) found.push(s);
  return found;
}

export async function scan(target: string, opts: { scanner?: string } = {}): Promise<{ diagnostics: Diagnostic[]; ran: string[]; note: string | null }> {
  const available = (await detectScanners()).filter((s) => !opts.scanner || s.id === opts.scanner);
  if (!available.length) {
    return {
      diagnostics: [], ran: [],
      note: `--scan: no content scanner installed (${SCANNERS.map((s) => `${s.id} → ${s.home}`).join(' · ')}). SAUT's own rules ran; the content scan did not.`,
    };
  }
  const diagnostics: Diagnostic[] = [];
  const ran: string[] = [];
  const notes: string[] = [];
  for (const s of available) {
    try {
      const r = await run(s.bin, s.args(target), { maxBuffer: 32 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS, killSignal: 'SIGKILL' }).catch((e: { stdout?: string; code?: number; message?: string }) => {
        // scanners exit non-zero WHEN THEY FIND SOMETHING — that is a result, not a failure
        if (e.stdout && (e.stdout.trim().startsWith('{') || e.stdout.trim().startsWith('['))) return { stdout: e.stdout } as { stdout: string };
        throw new Error(e.message ?? `exit ${e.code}`);
      });
      diagnostics.push(...s.parse(r.stdout, target));
      ran.push(s.id);
    } catch (e) {
      notes.push(`${s.id} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { diagnostics, ran, note: notes.length ? notes.join(' · ') : null };
}
