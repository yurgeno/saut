// Frontmatter parser — the YAML SUBSET real-world SKILL.md files use, no dependency.
//
// Understood: nested maps by 2+-space indent, block lists (`- scalar` / `- key: v` maps),
// inline lists `[a, b, "c, d"]` with quoted items, inline maps `{}` / `{k: v, k2: v2}`,
// single/double-quoted scalars, booleans, null, numbers, folded/literal blocks (`>`, `>-`,
// `|`, `|-`), `#` comments. NOT understood (diagnosed, never silently misread): anchors,
// aliases, tags, multi-document streams, flow-style nesting beyond one level.
//
// Duplicate keys are recorded (last value wins) — in a TAUT pack a duplicated
// `description:`/`allowed-tools:` almost always means capability-marker branches
// (`# kaut:on` … `# kaut:off`), which the TAUT adapter parses with the engine's own parser.
import type { Diagnostic, Frontmatter } from './types.mts';

interface Line { n: number; indent: number; text: string }

function scalar(s: string): unknown {
  s = s.trim();
  if (s === '') return '';
  if (/^'.*'$/s.test(s)) return s.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/s.test(s)) return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, ch) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' }[ch as string] ?? ch));
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// Split an inline list body on commas outside quotes.
function splitInline(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of inner) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function inlineValue(v: string, diag: (m: string) => void): unknown {
  const t = v.trim();
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) { diag('unterminated inline list'); return t; }
    return splitInline(t.slice(1, -1)).map(scalar);
  }
  if (t.startsWith('{')) {
    if (!t.endsWith('}')) { diag('unterminated inline map'); return t; }
    const inner = t.slice(1, -1).trim();
    const o: Record<string, unknown> = Object.create(null);
    if (!inner) return o;
    for (const kv of splitInline(inner)) {
      const i = kv.indexOf(':');
      if (i < 0) { diag(`inline map entry without ":" — ${kv}`); continue; }
      o[kv.slice(0, i).trim()] = scalar(kv.slice(i + 1));
    }
    return o;
  }
  if (t.startsWith('&') || t.startsWith('*') || t.startsWith('!')) diag(`YAML anchors/aliases/tags are not supported — ${t.slice(0, 20)}`);
  return scalar(t);
}

const KEY = /^([A-Za-z0-9_.\-]+|"[^"]+"|'[^']+'):(?:\s+(.*)|$)/;

export function parseFrontmatter(text: string, file: string): Frontmatter {
  const diagnostics: Diagnostic[] = [];
  const diagAt = (line: number, message: string, code = 'frontmatter-syntax') =>
    diagnostics.push({ code, severity: 'high', message, path: file, line });

  const rawLines = text.split(/\r?\n/);
  if (rawLines[0] !== '---') {
    diagAt(1, 'no frontmatter: file must start with "---" on the first line', 'no-frontmatter');
    return { data: {}, all: {}, diagnostics, lines: {}, duplicates: [], bodyOffset: 1 };
  }
  let end = -1;
  for (let i = 1; i < rawLines.length; i++) if (rawLines[i] === '---' || rawLines[i] === '...') { end = i; break; }
  if (end < 0) {
    diagAt(1, 'unterminated frontmatter: no closing "---"');
    return { data: {}, all: {}, diagnostics, lines: {}, duplicates: [], bodyOffset: 1 };
  }

  const lines: Line[] = [];
  for (let i = 1; i < end; i++) {
    const raw = rawLines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;      // blank / comment (incl. TAUT markers)
    const indent = raw.match(/^ */)![0].length;
    lines.push({ n: i + 1, indent, text: raw.slice(indent) });
  }

  // Null-prototype maps everywhere a KEY comes from the file: `__proto__`, `constructor`
  // and `prototype` are ordinary strings in YAML, and on a normal object they would either
  // crash (`all['__proto__'] ??=` never assigns) or set the prototype of the parsed data.
  const topLines: Record<string, number> = Object.create(null);
  const duplicates: string[] = [];
  const all: Record<string, unknown[]> = Object.create(null);

  // Read a folded/literal block starting after line index i (body lines more indented than `indent`).
  function block(i: number, indent: number, style: string): [string, number] {
    const parts: string[] = [];
    let j = i + 1;
    // block scalars need the RAW lines (comments/blank lines are content) — re-scan by line number
    const startN = lines[i].n;              // 1-based number of the header line
    let k = startN;                          // rawLines index = n - 1 → next raw line is rawLines[startN]
    let baseIndent = -1;
    while (k < end) {
      const raw = rawLines[k];
      const ind = raw.match(/^ */)![0].length;
      if (raw.trim() === '') { parts.push(''); k++; continue; }
      // a `# …` comment line at column 0 inside a block scalar: TAUT capability markers
      // (`# kaut:on` / `# kaut:off` / `# kaut:end`) interleave branches of one folded
      // description — skip the marker, keep reading (generic mode sees the union text).
      if (ind === 0 && raw.startsWith('#') && k + 1 < end && (rawLines[k + 1].match(/^ */)![0].length > indent || rawLines[k + 1].trim() === '')) { k++; continue; }
      if (ind <= indent) break;
      if (baseIndent < 0) baseIndent = ind;
      parts.push(raw.slice(Math.min(baseIndent, ind)));
      k++;
    }
    // advance the token cursor past consumed lines
    while (j < lines.length && lines[j].n <= k) j++;
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    const literal = style.startsWith('|');
    let s = literal ? parts.join('\n') : parts.map((p) => p).join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/\n\n/g, '\n');
    if (!style.endsWith('-')) s += '\n';
    return [s, j];
  }

  // Parse a mapping whose keys sit at `indent`; returns [value, next index].
  function parseMap(i: number, indent: number, top: boolean): [Record<string, unknown>, number] {
    const o: Record<string, unknown> = Object.create(null);
    while (i < lines.length && lines[i].indent === indent) {
      const L = lines[i];
      const m = L.text.match(KEY);
      if (!m) {
        if (L.text.startsWith('- ')) diagAt(L.n, 'list item where a map key was expected');
        else diagAt(L.n, `unsupported frontmatter line (continuation lines are not supported): ${L.text.slice(0, 40)}`);
        i++;
        continue;
      }
      const key = m[1].replace(/^["']|["']$/g, '');
      const rest = m[2] ?? '';
      if (Object.hasOwn(o, key)) duplicates.push(key);
      if (top && !(key in topLines)) topLines[key] = L.n;
      const record = (v: unknown) => { if (top) (all[key] ??= []).push(v); };
      const next = lines[i + 1];
      if (rest.trim() === '' && next && next.indent > indent) {
        // nested block: map or list
        if (next.text.startsWith('- ')) { const [v, j] = parseList(i + 1, next.indent); o[key] = v; record(v); i = j; }
        else { const [v, j] = parseMap(i + 1, next.indent, false); o[key] = v; record(v); i = j; }
        continue;
      }
      if (rest.trim() === '' && next && next.indent === indent && next.text.startsWith('- ')) {
        // YAML allows a list at the SAME indent as its key
        const [v, j] = parseList(i + 1, indent); o[key] = v; record(v); i = j; continue;
      }
      if (/^[>|][+-]?$/.test(rest.trim())) { const [v, j] = block(i, indent, rest.trim()); o[key] = v; record(v); i = j; continue; }
      o[key] = inlineValue(rest, (msg) => diagAt(L.n, msg)); record(o[key]);
      i++;
    }
    return [o, i];
  }

  function parseList(i: number, indent: number): [unknown[], number] {
    const arr: unknown[] = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const L = lines[i];
      const item = L.text.slice(2);
      const m = item.match(KEY);
      if (m) {
        // `- key: value` → a map item; continuation keys sit at indent+2
        const first: Record<string, unknown> = {};
        first[m[1]] = (m[2] ?? '').trim() === '' ? '' : inlineValue(m[2] ?? '', (msg) => diagAt(L.n, msg));
        const next = lines[i + 1];
        if (next && next.indent === indent + 2 && !next.text.startsWith('- ')) {
          const [more, j] = parseMap(i + 1, indent + 2, false);
          Object.assign(first, more);
          i = j;
        } else i++;
        arr.push(first);
      } else { arr.push(inlineValue(item, (msg) => diagAt(L.n, msg))); i++; }
    }
    return [arr, i];
  }

  if (lines.length && lines[0].indent !== 0) diagAt(lines[0].n, 'frontmatter root must be a map at indent 0');
  const [data, last] = lines.length ? parseMap(0, 0, true) : [{}, 0];
  if (last < lines.length) diagAt(lines[last].n, `unexpected indent at line ${lines[last].n}`);
  for (const d of new Set(duplicates))
    diagnostics.push({ code: 'duplicate-key', severity: 'info', message: `key "${d}" appears more than once (capability-marker branches? — the TAUT adapter parses those with the engine)`, path: file, line: topLines[d] });
  // first occurrence wins for display fields (a TAUT `on` branch is written first)
  for (const k of new Set(duplicates)) if (all[k]?.length) data[k] = all[k][0];
  // hand back plain objects (a null-prototype map breaks JSON round-trips downstream)
  const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
  return { data: plain(data), all: plain(all), diagnostics, lines: plain(topLines), duplicates: [...new Set(duplicates)], bodyOffset: end + 2 };
}

export function bodyOf(text: string, fm: Frontmatter): string {
  return text.split(/\r?\n/).slice(fm.bodyOffset - 1).join('\n');
}

// Emit a frontmatter block that this parser (and the TAUT engine's stricter one) re-reads
// identically: single-line scalars, inline lists for flat string arrays, 2-space nesting.
export function emitFrontmatter(data: Record<string, unknown>): string {
  const out: string[] = ['---'];
  const q = (s: string) => (/^[A-Za-z0-9_.\-/ <>]*$/.test(s) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) && !s.includes(': ') && !s.startsWith('[') && !s.startsWith('{') && !s.startsWith('#') && s.trim() === s ? s : `'${s.replaceAll("'", "''")}'`);
  const emit = (k: string, v: unknown, indent: number) => {
    const pad = ' '.repeat(indent);
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string' && !/[,'"\[\]]/.test(x))) out.push(`${pad}${k}: [${v.join(', ')}]`);
      else { out.push(`${pad}${k}:`); for (const x of v) out.push(`${pad}  - ${typeof x === 'string' ? q(x) : JSON.stringify(x)}`); }
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (!entries.length) out.push(`${pad}${k}: {}`);
      else { out.push(`${pad}${k}:`); for (const [kk, vv] of entries) emit(kk, vv, indent + 2); }
    } else if (typeof v === 'string') out.push(`${pad}${k}: ${q(v.replace(/\s*\n\s*/g, ' '))}`);
    else out.push(`${pad}${k}: ${String(v)}`);
  };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) emit(k, v, 0);
  out.push('---');
  return out.join('\n') + '\n';
}
