// A small TOML reader for the harness files SAUT inspects (Codex `.codex/config.toml`, Gemini
// command files, Codex agent TOML). Zero dependencies, so a subset: tables and arrays of
// tables with dotted / quoted keys, dotted keys in assignments, basic and literal strings
// (single- and multi-line), integers, floats, booleans, dates kept as strings, arrays and
// inline tables. Every value remembers its 1-based line, so a finding can point at it.
// Malformed input throws a TomlError with the line — the caller turns it into a finding.

export class TomlError extends Error {
  line: number;
  constructor(msg: string, line: number) { super(`line ${line}: ${msg}`); this.line = line; }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [k: string]: TomlValue }
export interface TomlDoc { data: TomlTable; lines: Map<string, number> }   // "a.b.c" → line

export function parseToml(src: string): TomlDoc {
  const data: TomlTable = {};
  const lines = new Map<string, number>();
  let i = 0, line = 1;
  let current: TomlTable = data;
  let currentPath: string[] = [];
  const n = src.length;

  const err = (m: string): never => { throw new TomlError(m, line); };
  const peek = (k = 0) => src[i + k];
  const ws = () => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
  const comment = () => { if (src[i] === '#') while (i < n && src[i] !== '\n') i++; };
  const eol = () => {
    ws(); comment();
    if (i < n && src[i] === '\r') i++;
    if (i < n && src[i] !== '\n') err(`unexpected "${src[i]}"`);
    if (i < n) { i++; line++; }
  };
  const blank = () => { for (;;) { ws(); comment(); if (src[i] === '\r') i++; if (src[i] === '\n') { i++; line++; } else break; } };

  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (src[i] === '"' || src[i] === "'") parts.push(str());
      else {
        const s = i;
        while (i < n && /[A-Za-z0-9_-]/.test(src[i])) i++;
        if (s === i) err('expected a key');
        parts.push(src.slice(s, i));
      }
      ws();
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
  }

  function str(): string {
    const q = src[i];
    const multi = src.startsWith(q.repeat(3), i);
    if (multi) {
      i += 3;
      if (src[i] === '\r') i++;
      if (src[i] === '\n') { i++; line++; }     // a newline right after the opener is trimmed
      let out = '';
      for (;;) {
        if (i >= n) err('unterminated multi-line string');
        if (src.startsWith(q.repeat(3), i)) {
          i += 3;
          while (src[i] === q && src.startsWith(q.repeat(3), i - 2)) { out += q; i++; }   // up to two quotes may close it
          return out;
        }
        const c = src[i];
        if (c === '\n') line++;
        if (q === '"' && c === '\\') {
          if (/^\\[ \t]*\r?\n/.test(src.slice(i, i + 40))) {          // line-ending backslash: trim the break and indent
            i++; while (src[i] !== '\n') i++;
            while (i < n && /\s/.test(src[i])) { if (src[i] === '\n') line++; i++; }
            continue;
          }
          out += escape(); continue;
        }
        out += c; i++;
      }
    }
    i++;
    let out = '';
    for (;;) {
      if (i >= n || src[i] === '\n') err('unterminated string');
      const c = src[i];
      if (c === q) { i++; return out; }
      if (q === '"' && c === '\\') { out += escape(); continue; }
      out += c; i++;
    }
  }

  function escape(): string {
    i++;
    const c = src[i++];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (simple[c] !== undefined) return simple[c];
    if (c === 'u' || c === 'U') {
      const len = c === 'u' ? 4 : 8;
      const hex = src.slice(i, i + len);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) err('bad unicode escape');
      i += len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return err(`bad escape "\\${c}"`);
  }

  function value(): TomlValue {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        blank();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        blank();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        err('expected , or ] in an array');
      }
    }
    if (c === '{') {
      i++;
      const t: TomlTable = {};
      ws();
      if (src[i] === '}') { i++; return t; }
      for (;;) {
        const k = key();
        ws();
        if (src[i] !== '=') err('expected = in an inline table');
        i++;
        setPath(t, k, value());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return t; }
        err('expected , or } in an inline table');
      }
    }
    const s = i;
    while (i < n && !/[,\]\}\n#\r]/.test(src[i])) i++;
    const raw = src.slice(s, i).trim();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$|^[+-]?(?:inf|nan)$/.test(raw)) return Number(raw.replace(/_/g, '').replace('inf', 'Infinity'));
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;     // dates and times stay strings
    return err(raw ? `cannot read value "${raw.slice(0, 30)}"` : 'expected a value');
  }

  // The file is untrusted (a remote repository's config): a key that names the prototype would
  // write onto Object.prototype and change every object in the process — refuse it.
  const guard = (k: string[]) => { for (const part of k) if (part === '__proto__' || part === 'constructor' || part === 'prototype') err(`key "${part}" is not allowed`); };
  function setPath(t: TomlTable, k: string[], v: TomlValue) {
    guard(k);
    let o = t;
    for (const part of k.slice(0, -1)) {
      if (o[part] === undefined) o[part] = {};
      const next = o[part];
      if (typeof next !== 'object' || Array.isArray(next)) err(`"${part}" is not a table`);
      o = next as TomlTable;
    }
    const last = k[k.length - 1];
    if (Object.hasOwn(o, last)) err(`duplicate key "${k.join('.')}"`);
    o[last] = v;
  }

  function tableAt(p: string[], array: boolean): TomlTable {
    guard(p);
    let o: TomlTable = data;
    for (let j = 0; j < p.length; j++) {
      const part = p[j];
      const lastPart = j === p.length - 1;
      if (lastPart && array) {
        if (o[part] === undefined) o[part] = [];
        const arr = o[part];
        if (!Array.isArray(arr)) err(`"${p.join('.')}" is not an array of tables`);
        const t: TomlTable = {};
        (arr as TomlValue[]).push(t);
        return t;
      }
      if (o[part] === undefined) o[part] = {};
      let next = o[part];
      if (Array.isArray(next)) next = next[next.length - 1];    // [[a]] then [a.b] → the last a
      if (typeof next !== 'object' || next === null || Array.isArray(next)) err(`"${part}" is not a table`);
      o = next as TomlTable;
    }
    return o;
  }

  blank();
  while (i < n) {
    if (src[i] === '[') {
      const array = peek(1) === '[';
      i += array ? 2 : 1;
      const p = key();
      if (src[i] !== ']' || (array && src[i + 1] !== ']')) err('unterminated table header');
      i += array ? 2 : 1;
      current = tableAt(p, array);
      currentPath = p;
      lines.set(p.join('.'), line);
      eol();
    } else {
      const k = key();
      ws();
      if (src[i] !== '=') err('expected =');
      i++;
      const at = line;
      const v = value();
      setPath(current, k, v);
      lines.set([...currentPath, ...k].join('.'), at);
      eol();
    }
    blank();
  }
  return { data, lines };
}
