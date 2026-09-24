// Mechanical fixes — the `autofix` a finding may carry, applied to the file's TEXT.
//
// Edits are surgical, line by line inside the frontmatter block: comments, key order, quoting
// and TAUT capability-marker branches (`# kaut:on` … `# kaut:off`, where a key legitimately
// appears twice) all survive. Re-emitting the whole frontmatter would normalize them away.
// A fix that cannot be applied safely is refused with a reason — never half-applied.
import type { Autofix } from './types.mts';
import { parseFrontmatter } from './frontmatter.mts';

export interface FixResult { ok: boolean; text: string; reason?: string }

interface Block { start: number; end: number }    // line indexes of the opening and closing `---`

function frontmatterBlock(lines: string[]): Block | null {
  if (lines[0]?.trimEnd() !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].trimEnd() === '---') return { start: 0, end: i };
  return null;
}

const keyLine = (key: string) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(?:\\s(.*))?$`);

// Top-level occurrences of `key:` — more than one in a capability-marker pack.
function occurrences(lines: string[], b: Block, key: string): number[] {
  const re = keyLine(key);
  const out: number[] = [];
  for (let i = b.start + 1; i < b.end; i++) if (re.test(lines[i])) out.push(i);
  return out;
}

// The block-list items under a key line: `  - item` lines until the next column-0 line.
function blockItems(lines: string[], b: Block, at: number): number[] {
  const out: number[] = [];
  for (let i = at + 1; i < b.end; i++) {
    if (/^\S/.test(lines[i])) break;
    if (/^\s+-\s/.test(lines[i])) out.push(i);
    else if (lines[i].trim() && !lines[i].trim().startsWith('#')) return [];   // a nested map, not a list
  }
  return out;
}

// Split on commas outside parentheses and quotes — `Bash(git diff *)` is one entry.
function splitItems(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '', q: string | null = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const bare = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();

type ListShape = { kind: 'flow' | 'plain'; items: string[] } | { kind: 'block'; lines: number[] } | { kind: 'unsupported' };

function listAt(lines: string[], b: Block, at: number, key: string): ListShape {
  const v = (lines[at].match(keyLine(key))?.[1] ?? '').replace(/\s+#.*$/, '').trim();
  if (v === '') {
    const items = blockItems(lines, b, at);
    return items.length ? { kind: 'block', lines: items } : { kind: 'unsupported' };
  }
  if (v.startsWith('[') && v.endsWith(']')) return { kind: 'flow', items: splitItems(v.slice(1, -1)) };
  if (/^['"]/.test(v) || v.startsWith('{') || v === '>' || v === '|' || /^[>|]-?$/.test(v)) return { kind: 'unsupported' };
  return { kind: 'plain', items: splitItems(v) };
}

function writeList(lines: string[], at: number, key: string, shape: 'flow' | 'plain', items: string[]): void {
  lines[at] = shape === 'flow' ? `${key}: [${items.join(', ')}]` : `${key}: ${items.join(', ')}`;
}

function scalarText(v: boolean | string): string {
  if (typeof v === 'boolean') return String(v);
  return /^[A-Za-z0-9_.\-/ ]+$/.test(v) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v) ? v : JSON.stringify(v);
}

export function applyFix(text: string, fix: Autofix): FixResult {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const b = frontmatterBlock(lines);
  if (!b) return { ok: false, text, reason: 'no frontmatter block' };
  const refuse = (reason: string): FixResult => ({ ok: false, text, reason });
  const at = occurrences(lines, b, fix.key);

  if (fix.op === 'set') {
    const value = scalarText(fix.value);
    if (at.length) {
      for (const i of at) {
        if (i + 1 < b.end && /^\s+\S/.test(lines[i + 1])) return refuse(`\`${fix.key}\` holds a multi-line value, not a scalar`);
        lines[i] = `${fix.key}: ${value}`;
      }
    } else lines.splice(b.end, 0, `${fix.key}: ${value}`);
  } else if (fix.op === 'list-add' && !at.length) {
    lines.splice(b.end, 0, `${fix.key}: ${fix.items.join(', ')}`);
  } else {
    if (!at.length) return refuse(`no \`${fix.key}\` key`);
    let touched = false;
    // bottom-up, so removing a block-list line does not shift the indexes still to visit
    for (const i of [...at].reverse()) {
      const shape = listAt(lines, b, i, fix.key);
      if (shape.kind === 'unsupported') return refuse(`\`${fix.key}\` is written in a form the fixer does not edit (quoted, folded or a map)`);
      if (shape.kind === 'block') {
        const indent = lines[shape.lines[0]].match(/^(\s*)-/)![1];
        const present = shape.lines.map((l) => bare(lines[l].replace(/^\s*-\s*/, '')));
        if (fix.op === 'list-add') {
          const add = fix.items.filter((x) => !present.includes(x));
          lines.splice(shape.lines.at(-1)! + 1, 0, ...add.map((x) => `${indent}- ${x}`));
          touched ||= add.length > 0;
          continue;
        }
        const hit = shape.lines.find((_, k) => present[k] === fix.item);
        if (hit === undefined) continue;
        if (fix.op === 'list-remove') {
          if (shape.lines.length === 1) return refuse(`removing "${fix.item}" would leave \`${fix.key}\` empty`);
          lines.splice(hit, 1);
        } else lines[hit] = `${indent}- ${fix.with}`;
        touched = true;
        continue;
      }
      const items = shape.items.map(bare);
      let next = items;
      if (fix.op === 'list-add') next = [...items, ...fix.items.filter((x) => !items.includes(x))];
      else if (fix.op === 'list-remove') next = items.filter((x) => x !== fix.item);
      else next = items.map((x) => (x === fix.item ? fix.with : x));
      if (next.join('\u0000') === items.join('\u0000')) continue;
      if (!next.length) return refuse(`removing "${(fix as { item: string }).item}" would leave \`${fix.key}\` empty`);
      writeList(lines, i, fix.key, shape.kind, next);
      touched = true;
    }
    if (!touched) return refuse(fix.op === 'list-add' ? 'already present' : `"${fix.item}" is not in \`${fix.key}\``);
  }

  const out = lines.join(eol);
  const parsed = parseFrontmatter(out, 'fix');
  const before = parseFrontmatter(text, 'fix');
  const syntax = (fm: typeof parsed) => fm.diagnostics.filter((x) => x.code === 'frontmatter-syntax' || x.code === 'no-frontmatter').length;
  if (syntax(parsed) > syntax(before)) return refuse('the edited frontmatter would not parse');
  return { ok: true, text: out };
}

// A line diff for previews: LCS over lines, hunks with `context` unchanged lines around each
// change, `-`/`+` marked and numbered by the line in the old / new file. Skill files are small
// (the spec caps a body at 500 lines), so the quadratic table is fine; past a guard the whole
// file is shown as replaced rather than spending seconds on a preview.
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  if (before === after) return '';
  const n = a.length, m = b.length;
  type Op = { t: ' ' | '-' | '+'; ai: number; bi: number };
  const ops: Op[] = [];
  if (n * m > 4_000_000) {
    a.forEach((_, i) => ops.push({ t: '-', ai: i, bi: -1 }));
    b.forEach((_, j) => ops.push({ t: '+', ai: -1, bi: j }));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push({ t: ' ', ai: i++, bi: j++ }); }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) ops.push({ t: '-', ai: i++, bi: -1 });
      else ops.push({ t: '+', ai: -1, bi: j++ });
    }
  }
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.t !== ' ') for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true; });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { gap = true; return; }
    if (gap && out.length) out.push('  ...');
    gap = false;
    const no = o.t === '+' ? o.bi + 1 : o.ai + 1;
    out.push(`${o.t} ${String(no).padStart(3)}  ${o.t === '+' ? b[o.bi] : a[o.ai]}`);
  });
  return out.join('\n');
}
