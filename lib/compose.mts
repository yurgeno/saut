// Saving from the form without losing what the form does not show.
//
// The form edits a handful of fields; a real SKILL.md carries more — `disallowed-tools`,
// `hooks`, `paths`, `license`, comments, and in a TAUT pack capability-marker branches where a
// key appears twice with different values. Re-emitting the frontmatter from the form dropped
// all of that. `compose` starts from the file text instead and changes only the fields whose
// value changed, line by line; what it cannot change safely it refuses, naming the field, so
// the edit can be made in the Source view.
import { applyFix } from './fix.mts';
import { emitFrontmatter, emitScalar, parseFrontmatter } from './frontmatter.mts';

export interface FormFields {
  name?: string; description?: string; 'argument-hint'?: string; model?: string; effort?: string;
  'user-invocable'?: boolean; 'disable-model-invocation'?: boolean;
  tools?: string[];                                         // the allowlist: allowed-tools (skill) / tools (agent)
  taut?: Record<string, unknown> | null;                    // metadata.taut; undefined = the form does not edit it
}

export type ComposeResult = { ok: true; text: string; changed: string[] } | { ok: false; reason: string };

const keyRe = (key: string) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(?:\\s|$)`);

function block(lines: string[]): number {
  if (lines[0]?.trimEnd() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === '---') return i;
  return -1;
}

// Replace every top-level occurrence of `key` — the key line and its indented continuation
// (folded text, a block list, a nested map) — with `replacement` (null removes it). A key
// that is absent is inserted before the closing `---`.
function setKey(lines: string[], key: string, replacement: string[] | null): string[] {
  const out: string[] = [];
  const end = block(lines);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i < end && keyRe(key).test(lines[i])) {
      found = true;
      if (replacement) out.push(...replacement);
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) i++;       // its indented continuation
      continue;
    }
    if (i === end && !found && replacement) out.push(...replacement);
    out.push(lines[i]);
  }
  return out;
}

const norm = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : typeof v === 'string' ? v.trim() : v);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const asList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean) : [];

export function compose(original: string, kind: 'skill' | 'agent', form: FormFields, body: string): ComposeResult {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let lines = original.split(/\r?\n/);
  const end = block(lines);
  if (end < 0) return { ok: false, reason: 'the file has no frontmatter block — edit it in the Source view' };
  const fm = parseFrontmatter(original, 'compose');
  const data = fm.data, all = fm.all;
  const dup = new Set(fm.duplicates);
  const changed: string[] = [];
  const varies = (k: string) => dup.has(k) && new Set((all[k] ?? []).map((v) => JSON.stringify(v))).size > 1;
  const refuse = (k: string) => ({ ok: false as const, reason: `\`${k}\` differs by capability branch — edit it in the Source view` });

  // plain scalars
  for (const k of ['name', 'description', 'argument-hint', 'model', 'effort'] as const) {
    if (!(k in form)) continue;
    const next = norm(form[k]), prev = norm(data[k]);
    if (next === prev) continue;
    if (varies(k)) return refuse(k);
    const v = typeof next === 'string' ? next.replace(/\s*\n\s*/g, ' ') : next;
    lines = setKey(lines, k, v === undefined ? null : [`${k}: ${emitScalar(String(v))}`]);
    changed.push(k);
  }
  // invocation flags (skills): compare the effective value, write it explicitly when it changes
  if (kind === 'skill') for (const [k, dflt] of [['user-invocable', true], ['disable-model-invocation', false]] as const) {
    if (!(k in form)) continue;
    const next = form[k] ?? dflt, prev = typeof data[k] === 'boolean' ? data[k] : dflt;
    if (next === prev) continue;
    if (varies(k)) return refuse(k);
    lines = setKey(lines, k, [`${k}: ${next}`]);
    changed.push(k);
  }
  // the allowlist: item by item, so capability branches keep their own extra entries
  const listKey = kind === 'skill' ? 'allowed-tools' : 'tools';
  if (form.tools) {
    const prev = asList(data[listKey]);
    const next = form.tools.map((x) => x.trim()).filter(Boolean);
    if (!sameList(prev, next)) {
      if (!next.length) lines = setKey(lines, listKey, null);
      else if (data[listKey] === undefined) lines = setKey(lines, listKey, [`${listKey}: ${next.join(', ')}`]);
      else {
        let text = lines.join('\n');
        const add = next.filter((x) => !prev.includes(x)), drop = prev.filter((x) => !next.includes(x));
        for (const item of drop) {
          const r = applyFix(text, { op: 'list-remove', key: listKey, item, label: '', safety: 'review' });
          if (!r.ok) return { ok: false, reason: `\`${listKey}\`: ${r.reason} — edit it in the Source view` };
          text = r.text;
        }
        if (add.length) {
          const r = applyFix(text, { op: 'list-add', key: listKey, items: add, label: '', safety: 'review' });
          if (!r.ok) return { ok: false, reason: `\`${listKey}\`: ${r.reason} — edit it in the Source view` };
          text = r.text;
        }
        lines = text.split('\n');
      }
      changed.push(listKey);
    }
  }
  // metadata.taut: a nested map — rewritten as a block, and only when it is not branched
  if (form.taut !== undefined) {
    const meta = data.metadata && typeof data.metadata === 'object' ? { ...(data.metadata as Record<string, unknown>) } : {};
    const prevTaut = meta.taut && typeof meta.taut === 'object' ? meta.taut : {};
    const clean = Object.fromEntries(Object.entries(form.taut ?? {}).filter(([, v]) => Array.isArray(v) ? v.length : v !== undefined && v !== null && v !== ''));
    if (JSON.stringify(clean) !== JSON.stringify(Object.fromEntries(Object.entries(prevTaut).filter(([, v]) => Array.isArray(v) ? v.length : v !== '')))) {
      if (dup.has('metadata')) return refuse('metadata');
      if (Object.keys(clean).length) meta.taut = clean; else delete meta.taut;
      const emitted = Object.keys(meta).length ? emitFrontmatter({ metadata: meta }).split('\n').slice(1, -2) : null;
      lines = setKey(lines, 'metadata', emitted);
      changed.push('metadata.taut');
    }
  }

  const head = lines.slice(0, block(lines) + 1).join(eol);
  const tail = body.replace(/\r?\n/g, eol);
  const text = head + eol + (tail.endsWith(eol) || tail === '' ? tail : tail + eol);
  if (bodyChanged(original, fm.bodyOffset, body)) changed.push('body');
  const after = parseFrontmatter(text, 'compose');
  const syntax = (x: typeof after) => x.diagnostics.filter((d) => d.code === 'frontmatter-syntax' || d.code === 'no-frontmatter').length;
  if (syntax(after) > syntax(fm)) return { ok: false, reason: 'the result would not parse — edit it in the Source view' };
  return { ok: true, text, changed };
}

function bodyChanged(original: string, bodyOffset: number, body: string): boolean {
  const was = original.split(/\r?\n/).slice(bodyOffset - 1).join('\n');
  return was.replace(/\n+$/, '') !== body.replace(/\r?\n/g, '\n').replace(/\n+$/, '');
}
