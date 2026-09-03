// Cases: authored (Claude Code `plugin eval` layout — <skill>/evals/**/prompt.md with
// frontmatter; graders/*.md are for the scenario level, ignored here) or auto-generated
// when a skill ships none. SAUT reads two extra frontmatter keys: `expect: fire|no-fire`
// (default fire) and `invocation: explicit|implicit|control` (default implicit).
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter, bodyOf } from '../frontmatter.mts';
import type { Artifact } from '../types.mts';
import { exists, walk } from '../util.mts';
import type { BenchCase } from './types.mts';

const CONTROL_PROMPT = 'Reply with the single word PONG and nothing else.';

export async function loadCases(a: Artifact, filter?: string): Promise<BenchCase[]> {
  const dir = a.kind === 'skill' ? path.join(a.dir, 'evals') : path.join(path.dirname(a.path), 'evals', a.name);
  const out: BenchCase[] = [];
  if (await exists(dir)) {
    for await (const f of walk(dir)) {
      if (path.basename(f) !== 'prompt.md') continue;
      const text = await fs.readFile(f, 'utf8');
      const fm = parseFrontmatter(text, f);
      const d = fm.data;
      const name = typeof d.name === 'string' ? d.name : path.basename(path.dirname(f));
      out.push({
        name,
        source: 'evals',
        prompt: bodyOf(text, fm).trim(),
        invocation: d.invocation === 'explicit' || d.invocation === 'control' ? d.invocation : 'implicit',
        expect: d.expect === 'no-fire' ? 'no-fire' : 'fire',
        tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
        maxTurns: typeof d.max_turns === 'number' ? d.max_turns : 8,
        timeoutSeconds: typeof d.timeout_seconds === 'number' ? d.timeout_seconds : 300,
        model: typeof d.model === 'string' ? d.model : undefined,
        file: f,
      });
    }
  }
  if (!out.length) out.push(...autoCases(a));
  const g = filter ? globToRe(filter) : null;
  return g ? out.filter((c) => g.test(c.name)) : out;
}

// Three generated cases: explicit invocation (the harness's own syntax), an implicit task
// phrased from the description (with the "Invoke:" sentence removed), and a control that
// must NOT fire.
export function autoCases(a: Artifact): BenchCase[] {
  const desc = a.description.replace(/\s*Invoke:.*$/s, '').replace(/^['"]|['"]$/g, '').trim();
  const hint = (a.kind === 'skill' && typeof a.fm.data['argument-hint'] === 'string' ? (a.fm.data['argument-hint'] as string) : '')
    .replace(/[<>\[\]]/g, '').split(/\s+/).filter(Boolean).map((w) => (w.endsWith('…') ? '' : `demo-${w.toLowerCase()}`)).filter(Boolean).join(' ');
  const base = { source: 'auto' as const, tags: ['auto'], maxTurns: 6, timeoutSeconds: 240 };
  return [
    { ...base, name: 'explicit', invocation: 'explicit', expect: 'fire', prompt: hint },
    { ...base, name: 'implicit', invocation: 'implicit', expect: 'fire', prompt: `Task for this workspace: ${desc || a.name}. Do it now; if a skill covers this, use it.` },
    { ...base, name: 'control', invocation: 'control', expect: 'no-fire', prompt: CONTROL_PROMPT, maxTurns: 1 },
  ];
}

function globToRe(g: string): RegExp {
  return new RegExp('^' + g.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}
