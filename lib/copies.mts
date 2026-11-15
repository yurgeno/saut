// Copies: one skill shipped in several harness folders (skills/x and .openclaw/skills/x), one
// instruction text saved as AGENTS.md, .clinerules and copilot-instructions.md. Reported once —
// a finding that holds for every copy is one finding, not N. Findings stay attached to their
// files underneath (SARIF and suppressions still see every path); this is a view.
import crypto from 'node:crypto';
import path from 'node:path';
import type { Artifact, Diagnostic } from './types.mts';
import type { Surface } from './workspace.mts';

export interface UnitFinding { d: Diagnostic; paths: string[] }
export interface Unit {
  key: string;
  kind: string;                 // skill | agent | instructions | hooks | …
  name: string;
  paths: string[];              // every copy; the first is the one shown
  identical: boolean;           // the copies have the same content
  findings: UnitFinding[];      // merged: one entry per distinct finding, with the copies it is in
  surface: Surface | null;
}

const hash = (t: string) => crypto.createHash('sha256').update(t.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
const artifactHash = (a: Artifact) => hash(`${JSON.stringify(a.fm.data)}\n${a.body}`);
// A finding's identity across copies: what it says, not where (line numbers differ between copies).
export const identity = (d: Diagnostic) => `${d.code}|${d.severity}|${d.harness ?? ''}|${d.message}|${d.suppressed ? 's' : ''}`;

// Which artifacts are copies of one: same kind and name AND the same place once the harness
// folders are set aside — skills/x and .openclaw/skills/x are one skill shipped twice;
// plugins/a/skills/review and plugins/b/skills/review are two skills that share a name.
export const copyKey = (a: Pick<Artifact, 'kind' | 'name' | 'path'>) =>
  `${a.kind}:${a.name}:${path.dirname(a.path).split(/[\\/]/).filter((seg) => !seg.startsWith('.')).join('/')}`;

export function unitsOf(artifacts: Artifact[], surfaces: Surface[], diagnostics: Diagnostic[], nameOf: (p: string) => string): { units: Unit[]; other: Diagnostic[] } {
  const units = new Map<string, Unit>();
  const unitOfPath = new Map<string, Unit>();
  const hashes = new Map<string, Set<string>>();
  const put = (key: string, kind: string, name: string, p: string, h: string, surface: Surface | null) => {
    let u = units.get(key);
    if (!u) { u = { key, kind, name, paths: [], identical: true, findings: [], surface }; units.set(key, u); hashes.set(key, new Set()); }
    u.paths.push(p);
    hashes.get(key)!.add(h);
    unitOfPath.set(p, u);
  };
  for (const a of artifacts) put(copyKey(a), a.kind, a.name, a.path, artifactHash(a), null);
  for (const s of surfaces) {
    // prose files with the same text are one document; everything else is its own unit
    const byContent = (s.kind === 'instructions' || s.kind === 'command') && s.hash;
    put(byContent ? `${s.kind}:#${s.hash}` : `${s.kind}:${s.path}`, s.kind, nameOf(s.path), s.path, s.hash || s.path, s);
  }
  for (const [k, u] of units) u.identical = hashes.get(k)!.size === 1;

  const other: Diagnostic[] = [];
  for (const d of diagnostics) {
    const u = unitOfPath.get(d.path);
    if (!u) { other.push(d); continue; }
    const id = identity(d);
    const f = u.findings.find((x) => identity(x.d) === id);
    if (f) { if (!f.paths.includes(d.path)) f.paths.push(d.path); }
    else u.findings.push({ d, paths: [d.path] });
  }
  return { units: [...units.values()], other };
}

// What the headline numbers count: a finding once per unit, not once per copy.
export function liveFindings(units: Unit[], other: Diagnostic[]): Diagnostic[] {
  return [...units.flatMap((u) => u.findings.map((f) => f.d)), ...other].filter((d) => !d.suppressed);
}
