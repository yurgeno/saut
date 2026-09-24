// Saving from the form without losing what the form does not show.
//
// The form edits a handful of fields; a real SKILL.md carries more — `disallowed-tools`,
// `hooks`, `paths`, `license`, comments, and in a TAUT pack capability-marker branches where a
// key appears twice with different values. Re-emitting the frontmatter from the form dropped
// all of that. `compose` starts from the file text instead and changes only the fields whose
// value changed, line by line; what it cannot change safely it refuses, naming the field, so
// the edit can be made in the Source view.
import { applyFix, eolOf, frontmatterBlock } from './fix.mts';
import { emitFrontmatter, emitScalar, parseFrontmatter } from './frontmatter.mts';

export interface FormFields {
  name?: string; description?: string; 'argument-hint'?: string; model?: string; effort?: string;
  'user-invocable'?: boolean; 'disable-model-invocation'?: boolean;
  tools?: string[];                                         // the allowlist: allowed-tools (skill) / tools (agent)
  taut?: Record<string, unknown> | null;                    // metadata.taut; undefined = the form does not edit it
}

export type ComposeResult = { ok: true; text: string; changed: string[] } | { ok: false; reason: string };

// A key line, bare or quoted (`"description": …`).
const keyRe = (key: string) => new RegExp(`^(["']?)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1:(?:\\s|$)`);

const block = (lines: string[]): number => frontmatterBlock(lines)?.end ?? -1;

// The last line of a key's value: its indented continuation (folded text, a block list, a
// nested map), including blank lines inside it. A column-0 comment inside the value — a
// capability marker splitting it — makes it not editable here: null.
function continuation(lines: string[], at: number, end: number): number | null {
  let last = at;
  for (let j = at + 1; j < end; j++) {
    if (/^\s+\S/.test(lines[j])) { if (j > last + 1 && lines.slice(last + 1, j).some((l) => /^#/.test(l))) return null; last = j; }
    else if (lines[j].trim() === '' || /^#/.test(lines[j])) continue;
    else break;
  }
  return last;
}

// Replace every top-level occurrence of `key` — the key line and its continuation — with
// `replacement` (null removes it). A key that is absent is inserted before the closing
// fence. null when a value cannot be replaced safely (a marker splits it).
function setKey(lines: string[], key: string, replacement: string[] | null): string[] | null {
  const out: string[] = [];
  const end = block(lines);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i < end && keyRe(key).test(lines[i])) {
      found = true;
      const last = continuation(lines, i, end);
      if (last === null) return null;
      if (replacement) out.push(...replacement);
      i = last;
      continue;
    }
    if (i === end && !found && replacement) out.push(...replacement);
    out.push(lines[i]);
  }
  return out;
}

// metadata.taut inside the one top-level `metadata:` block map: only that sub-block is
// replaced (null removes it) — the other metadata keys stay byte for byte. null when the
// metadata is not a block map this can edit.
function setTaut(lines: string[], taut: Record<string, unknown> | null): string[] | null {
  const end = block(lines);
  const at = lines.findIndex((l, i) => i > 0 && i < end && keyRe('metadata').test(l));
  const emitted = (indent: string) => taut ? emitFrontmatter({ taut }).split('\n').slice(1, -2).map((l) => indent + l) : [];
  if (at < 0) return taut ? [...lines.slice(0, end), 'metadata:', ...emitted('  '), ...lines.slice(end)] : lines;
  if (lines[at].replace(/\s+#.*$/, '').trim() !== 'metadata:') return null;       // a flow map or a scalar
  const last = continuation(lines, at, end);
  if (last === null) return null;
  const children = lines.slice(at + 1, last + 1);
  const indent = children.find((l) => /^\s+\S/.test(l))?.match(/^\s+/)![0] ?? '  ';
  const t = children.findIndex((l) => l.startsWith(indent) && !/^\s/.test(l.slice(indent.length)) && keyRe('taut').test(l.slice(indent.length)));
  let next: string[];
  if (t < 0) next = [...children, ...emitted(indent)];
  else {
    let u = t + 1;
    while (u < children.length && (children[u].trim() === '' || (children[u].match(/^\s*/)![0].length > indent.length))) u++;
    while (u > t + 1 && children[u - 1].trim() === '') u--;             // blank lines after it belong to the next key
    next = [...children.slice(0, t), ...emitted(indent), ...children.slice(u)];
  }
  if (!next.some((l) => l.trim())) return [...lines.slice(0, at), ...lines.slice(last + 1)];   // metadata emptied: the key goes
  return [...lines.slice(0, at + 1), ...next, ...lines.slice(last + 1)];
}

const norm = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : typeof v === 'string' ? v.trim() : v);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const asList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean) : [];

export function compose(original: string, kind: 'skill' | 'agent', form: FormFields, body: string): ComposeResult {
  const eol = eolOf(original);
  let lines = original.split(/\r?\n/);
  const end = block(lines);
  if (end < 0) return { ok: false, reason: 'the file has no frontmatter block — edit it in the Source view' };
  const fm = parseFrontmatter(original, 'compose');
  const data = fm.data, all = fm.all;
  const dup = new Set(fm.duplicates);
  const changed: string[] = [];
  const varies = (k: string) => dup.has(k) && new Set((all[k] ?? []).map((v) => JSON.stringify(v))).size > 1;
  const refuse = (k: string) => ({ ok: false as const, reason: `\`${k}\` differs by capability branch — edit it in the Source view` });
  const unsafe = (k: string) => ({ ok: false as const, reason: `\`${k}\` is written in a form the form cannot edit safely — edit it in the Source view` });
  const expect: Record<string, unknown> = {};                 // what each changed field must read back as

  // plain scalars
  for (const k of ['name', 'description', 'argument-hint', 'model', 'effort'] as const) {
    if (!(k in form)) continue;
    const next = norm(form[k]), prev = norm(data[k]);
    if (next === prev) continue;
    if (varies(k)) return refuse(k);
    const v = typeof next === 'string' ? next.replace(/\s*\n\s*/g, ' ') : next;
    const r = setKey(lines, k, v === undefined ? null : [`${k}: ${emitScalar(String(v))}`]);
    if (!r) return unsafe(k);
    lines = r; changed.push(k); expect[k] = v;
  }
  // invocation flags (skills): compare the effective value, write it explicitly when it changes
  if (kind === 'skill') for (const [k, dflt] of [['user-invocable', true], ['disable-model-invocation', false]] as const) {
    if (!(k in form)) continue;
    const next = form[k] ?? dflt, prev = typeof data[k] === 'boolean' ? data[k] : dflt;
    if (next === prev) continue;
    if (varies(k)) return refuse(k);
    const r = setKey(lines, k, [`${k}: ${next}`]);
    if (!r) return unsafe(k);
    lines = r; changed.push(k); expect[k] = next;
  }
  // the allowlist: item by item, so capability branches keep their own extra entries
  const listKey = kind === 'skill' ? 'allowed-tools' : 'tools';
  if (form.tools) {
    const prev = asList(data[listKey]);
    const next = form.tools.map((x) => x.trim()).filter(Boolean);
    // the form adds and removes entries; the same entries in another order are no change
    if (!sameList([...prev].sort(), [...next].sort())) {
      if (!next.length) {
        const r = setKey(lines, listKey, null);
        if (!r) return unsafe(listKey);
        lines = r;
      } else if (data[listKey] === undefined) {
        const r = applyFix(lines.join('\n'), { op: 'list-add', key: listKey, items: next, label: '', safety: 'review' });
        if (!r.ok) return unsafe(listKey);
        lines = r.text.split('\n');
      } else {
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
      if (!dup.has(listKey)) expect[listKey] = next;
    }
  }
  // metadata.taut: a nested map — rewritten as a block, and only when it is not branched
  if (form.taut !== undefined) {
    const meta = data.metadata && typeof data.metadata === 'object' ? { ...(data.metadata as Record<string, unknown>) } : {};
    const prevTaut = meta.taut && typeof meta.taut === 'object' ? meta.taut : {};
    const clean = Object.fromEntries(Object.entries(form.taut ?? {}).filter(([, v]) => Array.isArray(v) ? v.length : v !== undefined && v !== null && v !== ''));
    if (JSON.stringify(clean) !== JSON.stringify(Object.fromEntries(Object.entries(prevTaut).filter(([, v]) => Array.isArray(v) ? v.length : v !== '')))) {
      if (dup.has('metadata')) return refuse('metadata');
      const r = setTaut(lines, Object.keys(clean).length ? clean : null);
      if (!r) return unsafe('metadata');
      lines = r; changed.push('metadata.taut'); expect['metadata.taut'] = clean;
    }
  }

  const head = lines.slice(0, block(lines) + 1).join(eol);
  const tail = body.replace(/\r?\n/g, eol);
  const text = head + eol + (tail.endsWith(eol) || tail === '' ? tail : tail + eol);
  if (bodyChanged(original, fm.bodyOffset, body)) changed.push('body');
  const after = parseFrontmatter(text, 'compose');
  const syntax = (x: typeof after) => x.diagnostics.filter((d) => d.code === 'frontmatter-syntax' || d.code === 'no-frontmatter').length;
  if (syntax(after) > syntax(fm)) return { ok: false, reason: 'the result would not parse — edit it in the Source view' };
  // Read it back: every changed field says what the form said, every other key what it said
  // before. A text edit that got either wrong is refused, never written.
  const J = JSON.stringify;
  const tautOf = (d: Record<string, unknown>) => { const m = d.metadata; const t = m && typeof m === 'object' ? (m as Record<string, unknown>).taut : undefined; return t && typeof t === 'object' ? t : {}; };
  const withoutTaut = (vs: unknown[] | undefined) => (vs ?? []).map((m) => m && typeof m === 'object' ? { ...(m as object), taut: undefined } : m);
  for (const [k, v] of Object.entries(expect)) {
    const got = k === 'metadata.taut' ? tautOf(after.data) : k === listKey ? asList(after.data[k]) : after.data[k];
    if (J(got) !== J(v)) return { ok: false, reason: `\`${k}\` would not read back as the form says — edit it in the Source view` };
  }
  for (const k of new Set([...Object.keys(fm.all), ...Object.keys(after.all)])) {
    if (k in expect || (k === listKey && changed.includes(listKey))) continue;
    const same = k === 'metadata' && 'metadata.taut' in expect ? J(withoutTaut(fm.all[k])) === J(withoutTaut(after.all[k])) : J(fm.all[k]) === J(after.all[k]);
    if (!same) return { ok: false, reason: `the edit would also change \`${k}\` — edit it in the Source view` };
  }
  return { ok: true, text, changed };
}

function bodyChanged(original: string, bodyOffset: number, body: string): boolean {
  const was = original.split(/\r?\n/).slice(bodyOffset - 1).join('\n');
  return was.replace(/\n+$/, '') !== body.replace(/\r?\n/g, '\n').replace(/\n+$/, '');
}
