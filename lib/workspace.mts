// The agent WORKSPACE beyond skills and agents: everything a harness loads or runs from a
// project — hooks, MCP servers, settings and permissions, always-on instruction files,
// commands, plugin manifests and the code they wire in. Where each harness looks is data
// (lib/workspace.json); this module finds those files, reads them (JSON, JSONC, TOML,
// Markdown), normalises hooks / MCP servers / permissions across harnesses, follows what a
// manifest or a hook points at, reads that code statically, and turns what it finds into
// ordinary Diagnostics. Nothing here executes repository content.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './cost.mts';
import { parseFrontmatter } from './frontmatter.mts';
import { downloadExec, INJECTION, SECRET } from './lint.mts';
import { parseToml, TomlError } from './toml.mts';
import type { Diagnostic } from './types.mts';
import { exists, readText, walk } from './util.mts';

export type SurfaceKind = 'instructions' | 'command' | 'settings' | 'mcp' | 'hooks' | 'manifest' | 'code';
interface Pattern { pattern: string; kind: SurfaceKind; format: 'md' | 'text' | 'json' | 'jsonc' | 'toml' | 'code' | 'rules' | 'env'; harness: string; note?: string }
interface Registry { verifiedAt: string; sources: string[]; files: Pattern[]; limits: { codexProjectDocBytes: number; instructionsHeavyTokens: number } }

const REG: Registry = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'workspace.json'), 'utf8'));
export const WORKSPACE_REGISTRY = { verifiedAt: REG.verifiedAt, sources: REG.sources };

// ---- what the scan hands back ---------------------------------------------------------------

export interface HookEntry { event: string; matcher: string | null; type: string; command: string | null; url: string | null; line: number | null; scripts: string[] }
export interface McpEntry { name: string; transport: 'stdio' | 'http'; command: string | null; url: string | null; trusted: boolean; line: number | null }
export interface CodeCaps { network: number | null; subprocess: number | null; background: number | null; readsInput: number | null; credentials: number | null; dynamicCode: number | null }
export interface Surface {
  kind: SurfaceKind; harness: string; path: string; format: string; note: string | null;
  tokens: number | null;            // instructions: what each session pays
  hooks: HookEntry[]; mcp: McpEntry[];
  caps: CodeCaps | null;            // code: what it can do
  reachedBy: string[];              // code: the triggers that end up running it ("hook UserPromptSubmit · hooks/x.json")
  via: string[];                    // code: the scripts that load or spawn it, when not a trigger itself
  hash: string;                     // normalised content — identical copies share it
  error: string | null;
}
export interface WorkspaceScan { surfaces: Surface[]; diagnostics: Diagnostic[] }

// ---- glob ------------------------------------------------------------------------------------

function globRe(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') { re += p[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += p[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '{') { const end = p.indexOf('}', i); re += '(?:' + p.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const PATTERNS = REG.files.map((f) => ({ ...f, re: globRe(f.pattern) }));
// skills and agents are SAUT's own artifacts — a commands/ folder inside a skill is not a plugin's
const INSIDE_SKILL = /(?:^|\/)skills\/[^/]+\//;

// ---- small readers ---------------------------------------------------------------------------

const clipWords = (s: string, n: number) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n)).replace(/[,;:(]+$/, '') + '…');
const lineOf = (text: string, index: number) => (index < 0 ? null : text.slice(0, index).split('\n').length);
function stripJsonc(t: string): string {
  let out = '', i = 0, inStr = false;
  while (i < t.length) {
    const c = t[i];
    if (inStr) { out += c; if (c === '\\') { out += t[i + 1] ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && t[i + 1] === '*') { while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) { out += t[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, ' $1');           // trailing commas
}
// The line of a JSON string value: its literal as JSON.stringify writes it.
const lineOfValue = (text: string, v: unknown, from = 0) => (typeof v === 'string' ? lineOf(text, text.indexOf(JSON.stringify(v).slice(1, -1), from)) : null);
const lineOfKey = (text: string, k: string) => lineOf(text, text.indexOf(`"${k}"`));
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null);
const hashOf = async (t: string) => (await import('node:crypto')).createHash('sha256').update(t.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);

// ---- code: what a script can do (static, line of the first sign) ----------------------------

const CAPS: Record<keyof CodeCaps, RegExp> = {
  network: /\bfetch\s*\(|\.fetch\s*\(|\bhttps?\.(?:request|get)\s*\(|\brequire\(['"]https?['"]\)|from ['"](?:node:)?https?['"]|\baxios\b|\bXMLHttpRequest\b|\bnew WebSocket\b|\bundici\b|\bcurl\s|\bwget\s|\brequests\.(?:get|post|put)\b|\burllib\.request\b|\bhttpx\b|Invoke-(?:WebRequest|RestMethod)|\bnc\s+-/,
  subprocess: /\bchild_process\b|\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bBun\.spawn\b|\bsubprocess\.\w+\(|\bos\.system\(|\bexeca\b|\bStart-Process\b/,
  background: /\bdetached\s*:\s*true\b|\bnohup\b|\bdisown\b|\.unref\(\)|Start-Process\b[^\n]*-WindowStyle\s+Hidden/,
  readsInput: /\btranscript_path\b|\btool_input\b|\btool_response\b|\buser_prompt\b|\.prompt\b|\["prompt"\]|\blast_assistant_message\b/,
  credentials: /\.aws\/credentials|\bid_rsa\b|\.netrc\b|\.ssh\/|\bfind-generic-password\b|\bsecret-tool\b|\bkeytar\b|process\.env\.[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b|os\.environ\[['"][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)/,
  // a literal argument is code that can be read right here — only a computed one is opaque
  dynamicCode: /\beval\s*\(\s*(?!['"`])|\bnew Function\s*\((?!\s*['"`][^'"`]*['"`]\s*\))|\bvm\.runIn\w+\(\s*(?!['"`])|\bexec\(compile\(/,
};
function capsOf(text: string): CodeCaps {
  const out = {} as CodeCaps;
  for (const [k, re] of Object.entries(CAPS) as [keyof CodeCaps, RegExp][]) { const m = re.exec(text); out[k] = m ? lineOf(text, m.index) : null; }
  return out;
}

// Script paths a command or a script names: hooks/x.js, ./run.sh, ${CLAUDE_PLUGIN_ROOT}/hooks/x.js,
// path.join(__dirname, 'x.js'), require('./lib') — resolved against the places a harness runs from.
const SCRIPT_REF = /(?:\$\{?[A-Z_]+\}?[\\/]|\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:js|mjs|cjs|ts|tsx|mts|py|sh|bash|zsh|ps1|rb)\b/g;
const REQUIRE_REF = /(?:require\(|import\s*\(|from\s+)\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const PKG_RUNNER = /\b(npx|pnpm\s+dlx|bunx|yarn\s+dlx|uvx|pipx\s+run)\s+(?:-[-\w]+\s+)*([@\w./=+-]+)/;
const PINNED = /@\d+\.\d+\.\d+(?:[-+][\w.]+)?$|==\d|@sha256:/;

function scriptRefs(textIn: string): string[] {
  const text = textIn.replace(/\b[a-z][\w+.-]*:\/\/[^\s'"`)]+/gi, ' ');   // a URL names a remote file, not a local script
  const out = new Set<string>();
  for (const m of text.matchAll(SCRIPT_REF)) out.add(m[0].replace(/^\$\{?[A-Z_]+\}?[\\/]/, ''));
  for (const m of text.matchAll(REQUIRE_REF)) out.add(m[1]);
  return [...out];
}

// ---- normalising hooks / MCP across harness shapes ------------------------------------------

// Event names across harnesses, to recognise a hook file whose top level IS the event map
// (Devin's hooks.v1.json) — never a settings file that merely has array values.
const EVENT_NAME = /^(?:Session|UserPrompt|PreToolUse|PostToolUse|PermissionRequest|Subagent|Stop|PreCompact|PostCompact|Notification|BeforeTool|AfterTool|BeforeAgent|AfterAgent|BeforeModel|AfterModel|sessionStart|sessionEnd|preToolUse|postToolUse|beforeSubmitPrompt|beforeShellExecution|afterFileEdit|userPromptSubmitted|agentStop|stop)/;
function hooksFrom(cfg: Record<string, any>, text: string, isHookFile = false): HookEntry[] {
  const out: HookEntry[] = [];
  // commands a harness runs that are not called hooks: LSP servers, monitors, helpers
  const extra = (event: string, cmd: unknown, args?: unknown) => {
    const c = Array.isArray(cmd) ? cmd.map(String).join(' ') : typeof cmd === 'string' ? [cmd, ...(Array.isArray(args) ? args.map(String) : [])].join(' ') : null;
    if (c) out.push({ event, matcher: null, type: 'command', command: c, url: null, line: lineOfValue(text, Array.isArray(cmd) ? String(cmd[0]) : cmd), scripts: scriptRefs(c) });
  };
  for (const k of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper']) extra(k, cfg[k]);
  if (typeof obj(cfg.statusLine)?.command === 'string') extra('statusLine', cfg.statusLine.command);
  for (const [n, s] of Object.entries(obj(cfg.lspServers) ?? {})) extra(`LSP server ${n}`, obj(s)?.command, obj(s)?.args);
  for (const m of [...(Array.isArray(cfg.monitors) ? cfg.monitors : []), ...(Array.isArray(obj(cfg.experimental)?.monitors) ? cfg.experimental.monitors : [])]) extra('monitor', obj(m)?.command, obj(m)?.args);
  let h = obj(cfg.hooks);
  if (!h && isHookFile && Object.keys(cfg).some((k) => EVENT_NAME.test(k))) h = cfg;
  if (!h) return out;
  for (const [event, list] of Object.entries(h)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const e = obj(entry);
      if (!e) continue;
      const inner = Array.isArray(e.hooks) ? e.hooks.map(obj).filter(Boolean) as Record<string, any>[] : [e];
      for (const x of inner) {
        // Claude/Codex: command · Copilot: bash / powershell · Cursor: command · http hooks: url
        for (const cmd of [x.command, x.bash, x.powershell].filter((c) => typeof c === 'string') as string[])
          out.push({ event, matcher: typeof e.matcher === 'string' ? e.matcher : null, type: String(x.type ?? 'command'), command: cmd, url: null, line: lineOfValue(text, cmd), scripts: scriptRefs(cmd) });
        if (typeof x.url === 'string') out.push({ event, matcher: typeof e.matcher === 'string' ? e.matcher : null, type: String(x.type ?? 'http'), command: null, url: x.url, line: lineOfValue(text, x.url), scripts: [] });
        if (x.type === 'prompt' && typeof x.prompt === 'string') out.push({ event, matcher: e.matcher ?? null, type: 'prompt', command: null, url: null, line: lineOfValue(text, x.prompt), scripts: [] });
      }
    }
  }
  return out;
}

function mcpFrom(cfg: Record<string, any>, text: string, lines?: Map<string, number>): McpEntry[] {
  // Claude/Cursor/Gemini: mcpServers · VS Code: servers · Codex: mcp_servers · OpenCode: mcp
  const servers = obj(cfg.mcpServers) ?? obj(cfg.servers) ?? obj(cfg.mcp_servers) ?? obj(obj(cfg.mcp)?.servers) ?? obj(cfg.mcp);
  if (!servers) return [];
  return Object.entries(servers).filter(([, v]) => obj(v)).map(([name, v]) => {
    const s = v as Record<string, any>;
    const cmd = Array.isArray(s.command) ? s.command.map(String).join(' ') : typeof s.command === 'string' ? [s.command, ...(Array.isArray(s.args) ? s.args.map(String) : [])].join(' ') : null;
    const url = typeof s.url === 'string' ? s.url : typeof s.httpUrl === 'string' ? s.httpUrl : typeof s.serverUrl === 'string' ? s.serverUrl : null;
    const helper = typeof s.headersHelper === 'string' ? s.headersHelper : null;
    return { name, transport: url ? 'http' : 'stdio', command: cmd ?? helper, url, trusted: s.trust === true, line: lines?.get(`mcp_servers.${name}`) ?? lineOfKey(text, name) };
  });
}

// ---- the scan ---------------------------------------------------------------------------------

export async function scanWorkspace(roots: string[]): Promise<WorkspaceScan> {
  const surfaces: Surface[] = [];
  const diagnostics: Diagnostic[] = [];
  const byPath = new Map<string, Surface>();
  const codeQueue: { file: string; root: string; by: string; via?: string }[] = [];

  const surface = (kind: SurfaceKind, harness: string, file: string, format: string, note: string | null): Surface => {
    const s: Surface = { kind, harness, path: file, format, note, tokens: null, hooks: [], mcp: [], caps: null, reachedBy: [], via: [], hash: '', error: null };
    byPath.set(file, s);
    surfaces.push(s);
    return s;
  };
  const diag = (x: Diagnostic) => diagnostics.push(x);
  // A script a hook or a manifest names: in the scan root, next to the naming file, or one up
  // (a plugin's root) — and never outside the root.
  const resolveRef = async (ref: string, from: string, root: string): Promise<string | null> => {
    for (const base of [root, path.dirname(from), path.dirname(path.dirname(from))]) {
      const abs = path.resolve(base, ref);
      if ((abs === root || abs.startsWith(root + path.sep)) && await exists(abs)) return abs;
    }
    // an install-time placeholder ("PONYTAIL_DIR/hooks/x.js", "<plugin>/hooks/x.js"): the
    // longest tail of the path that exists in the repository
    const parts = ref.split(/[\\/]/).filter(Boolean);
    for (let k = 1; k < parts.length; k++) {
      const abs = path.resolve(root, ...parts.slice(k));
      if (abs.startsWith(root + path.sep) && await exists(abs)) return abs;
    }
    return null;
  };

  for (const rootIn of roots) {
    const root = path.resolve(rootIn);
    let st; try { st = await fs.stat(root); } catch { continue; }
    const files: string[] = [];
    if (st.isDirectory()) for await (const f of walk(root, 8)) files.push(f);
    else files.push(root);
    const scanRoot = st.isDirectory() ? root : path.dirname(root);
    // A repository can hold plugins in subfolders (a marketplace: plugins/<x>/.claude-plugin/…).
    // Each plugin's files are found relative to that plugin's root, as the harness installs it.
    const pluginRoots = [...new Set(files.flatMap((f) => {
      const r = path.relative(scanRoot, f).split(path.sep).join('/');
      const m = /^(.*?)\/?(?:\.[\w-]+-plugin\/plugin\.json|gemini-extension\.json)$/.exec(r);
      return m && m[1] ? [path.join(scanRoot, m[1])] : [];
    }))].sort((a, b) => b.length - a.length);
    const rootOf = (f: string) => pluginRoots.find((p) => f.startsWith(p + path.sep)) ?? scanRoot;

    // files a manifest wires in, whatever their name: scanned as what the manifest says they are
    const forced = new Map<string, SurfaceKind>();
    for (const file of files) {
      if (byPath.has(file)) continue;
      const base = rootOf(file);
      const relPath = path.relative(base, file).split(path.sep).join('/');
      if (INSIDE_SKILL.test(relPath) || path.basename(file) === 'SKILL.md') continue;
      const f = forced.get(file);
      // a file named on the command line (`saut lint .claude/settings.json`) is matched by the tail
      // of its path, so patterns with a folder part still recognise it
      const tails = st.isDirectory() ? [relPath] : file.split(path.sep).map((_, k, all) => all.slice(k).join('/')).slice(-4).reverse();
      const p: Pattern | undefined = PATTERNS.find((x) => tails.some((t) => x.re.test(t))) ?? (f ? { pattern: relPath, kind: f, format: f === 'code' ? 'code' : 'jsonc', harness: 'other', note: 'wired in by a manifest' } : undefined);
      if (!p) continue;
      const s = surface(p.kind, p.harness, file, p.format, p.note ?? null);
      let text: string;
      try { text = await readText(file, 2 * 1024 * 1024); } catch (e) { s.error = (e as Error).message; continue; }
      s.hash = await hashOf(text);

      // ---- prose surfaces: instructions and commands ----
      if (p.kind === 'instructions' || p.kind === 'command') {
        const isToml = p.format === 'toml';
        let prose = text;
        let allowed: string | null = null;
        if (isToml) {
          try { const t = parseToml(text).data; prose = typeof t.prompt === 'string' ? t.prompt : ''; }
          catch (e) { diag({ code: 'config-syntax', severity: 'medium', message: `cannot be read as TOML: ${(e as Error).message} — the harness will skip or reject it`, path: file, line: e instanceof TomlError ? e.line : undefined }); continue; }
        } else if (text.startsWith('---')) {
          const fm = parseFrontmatter(text, file);
          prose = text.slice(text.indexOf('\n', text.indexOf('\n---', 3) + 1) + 1);
          const at = fm.data['allowed-tools'];
          allowed = Array.isArray(at) ? at.join(',') : typeof at === 'string' ? at : null;
          if (p.kind === 'instructions' && p.pattern.endsWith('.mdc') && fm.data.alwaysApply !== true) s.note = 'loads by glob or on request (alwaysApply is not true)';
        }
        if (p.kind === 'instructions') {
          s.tokens = s.note?.startsWith('loads by glob') ? null : estimateTokens(text);
          const bytes = Buffer.byteLength(text);
          if (p.harness === 'codex' && bytes > REG.limits.codexProjectDocBytes)
            diag({ code: 'instructions-over-limit', severity: 'medium', message: `${(bytes / 1024).toFixed(1)} KiB — Codex reads at most ${REG.limits.codexProjectDocBytes / 1024} KiB of project instructions (project_doc_max_bytes); the rest is silently dropped`, path: file });
          else if (s.tokens && s.tokens > REG.limits.instructionsHeavyTokens)
            diag({ code: 'instructions-heavy', severity: 'low', message: `about ${s.tokens.toLocaleString('en')} tokens loaded into every session — move procedures into skills that load on demand`, path: file });
          const imp = /^@(?:~|\/)[^\s]+/m.exec(text);
          if (imp && p.harness === 'claude-code') diag({ code: 'instructions-import-outside', severity: 'low', message: `imports ${imp[0]} from outside the repository — every clone loads something different, and a reviewer cannot see it`, path: file, line: lineOf(text, imp.index) ?? undefined });
        }
        // shell that runs before the model reads the command: !`cmd` (Claude/Cursor/OpenCode) or !{cmd} (Gemini)
        const dyn = isToml ? /!\{[^}]+\}/.exec(prose) : /!`[^`]+`/.exec(prose);
        if (p.kind === 'command' && dyn) {
          const bare = allowed !== null && /(?:^|[\s,])(?:Bash|PowerShell)(?:\s*,|\s*$|\(\s*\*?\s*\))/.test(allowed);
          diag({ code: 'dynamic-context', severity: bare ? 'high' : 'medium', message: `runs shell before the model sees the command: ${dyn[0].slice(0, 60)}${bare ? ' — with bare Bash allowed' : ''}`, path: file, line: lineOf(text, text.indexOf(dyn[0])) ?? undefined });
        }
        proseFindings(prose, text, file, diag);
        continue;
      }

      // ---- structured surfaces ----
      if (p.kind === 'code') { codeQueue.push({ file, root: base, by: `${p.harness} ${p.pattern.includes('hooks') ? 'hook script' : 'plugin (loaded at start)'}` }); continue; }
      if (p.format === 'env' || p.format === 'rules') {
        for (const re of SECRET) { const m = re.exec(text); if (m) { diag({ code: 'secret-pattern', severity: 'high', message: 'a secret-shaped value is committed in this file — rotate it and keep the file out of the repository', path: file, line: lineOf(text, m.index) ?? undefined }); break; } }
        if (p.format === 'env' && /^\s*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S{8,}/m.test(text) && !SECRET.some((re) => re.test(text)))
          diag({ code: 'secret-pattern', severity: 'high', message: 'a token-like variable has a value in a committed environment file', path: file, line: lineOf(text, text.search(/^\s*[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=/m)) ?? undefined });
        for (const m of text.matchAll(/prefix_rule\s*\(([^)]*?)decision\s*=\s*["']allow["']/gs)) {
          const pat = /pattern\s*=\s*\[([^\]]*)\]/.exec(m[1])?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
          diag({ code: 'permissions-broad-allow', severity: /^["']?(?:bash|sh|zsh|python3?|node|npx|curl|rm)["']?\s*$|^$/.test(pat) ? 'high' : 'low', message: `prefix_rule allows [${pat}] — matching commands run outside the sandbox without asking`, path: file, line: lineOf(text, m.index) ?? undefined });
        }
        continue;
      }
      let cfg: Record<string, any> | null = null;
      let tomlLines: Map<string, number> | undefined;
      try {
        if (p.format === 'toml') { const d = parseToml(text); cfg = d.data; tomlLines = d.lines; }
        else cfg = obj(JSON.parse(p.format === 'jsonc' ? stripJsonc(text) : text));
      } catch (e) {
        // .vscode/mcp.json and others accept comments even when named .json
        try { cfg = obj(JSON.parse(stripJsonc(text))); }
        catch { diag({ code: 'config-syntax', severity: 'medium', message: `cannot be read as ${p.format.toUpperCase()}: ${(e as Error).message} — the harness will skip or reject it`, path: file, line: e instanceof TomlError ? e.line : undefined }); continue; }
      }
      if (!cfg) continue;

      s.hooks = hooksFrom(cfg, text, p.kind === 'hooks');
      s.mcp = mcpFrom(cfg, text, tomlLines);
      for (const hk of s.hooks) {
        const where = `hook ${hk.event}${hk.matcher ? ` (${hk.matcher})` : ''} · ${path.relative(base, file)}`;
        if (hk.command) execCommandFindings(hk.command, file, hk.line, where, diag);
        if (hk.url && /^http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/.test(hk.url))
          diag({ code: 'insecure-url', severity: 'high', message: `${where} posts to ${hk.url} over plain http — what the hook sends can be read or altered on the way`, path: file, line: hk.line ?? undefined });
        for (const ref of hk.scripts) {
          const abs = await resolveRef(ref, file, base);
          if (abs) codeQueue.push({ file: abs, root: base, by: where });
          else if (!/^\$|node_modules/.test(ref)) diag({ code: 'missing-file', severity: 'medium', message: `${where} runs ${ref}, which is not in the repository — the hook fails, or runs something nobody reviewed`, path: file, line: hk.line ?? undefined });
        }
      }
      for (const m of s.mcp) mcpFindings(m, cfg, file, diag);
      settingsFindings(cfg, p, text, file, tomlLines, diag);
      for (const re of SECRET) { const m = re.exec(text); if (m) { diag({ code: 'secret-pattern', severity: 'high', message: 'a secret-shaped value is committed in this configuration — rotate it and read it from the environment', path: file, line: lineOf(text, m.index) ?? undefined }); break; } }

      // a manifest wires more files in: hook files, MCP files, code modules
      if (p.kind === 'manifest' || p.kind === 'hooks') {
        const refs: { ref: string; as: SurfaceKind }[] = [];
        const add = (v: unknown, as: SurfaceKind) => { for (const r of Array.isArray(v) ? v : [v]) if (typeof r === 'string') refs.push({ ref: r, as }); };
        if (typeof cfg.hooks === 'string' || Array.isArray(cfg.hooks)) add(cfg.hooks, 'hooks');
        if (typeof cfg.mcpServers === 'string' || Array.isArray(cfg.mcpServers)) add(cfg.mcpServers, 'mcp');
        add(cfg.modules, 'code');
        for (const { ref, as } of refs) {
          const abs = await resolveRef(ref.replace(/^\$\{?[A-Z_]+\}?[\\/]/, ''), file, base);
          if (!abs) { diag({ code: 'missing-file', severity: 'medium', message: `the manifest wires in ${ref}, which is not in the repository — that part of the plugin fails to load`, path: file, line: lineOfValue(text, ref) ?? undefined }); continue; }
          if (as === 'code') codeQueue.push({ file: abs, root: base, by: `module · ${path.relative(base, file)}` });
          // scanned in this same pass — appended even when the walk already passed it: a file listed before
          // its manifest matched no pattern then and was skipped (walk order is the filesystem's)
          else if (!byPath.has(abs) && !forced.has(abs)) { forced.set(abs, as); files.push(abs); }
        }
        const uc = obj(cfg.userConfig);
        for (const [k, v] of Object.entries(uc ?? {})) {
          const f = obj(v);
          if (f && f.type !== 'boolean' && /url|endpoint|address|webhook(?!.*token)/i.test(`${k} ${f.title ?? ''}`) && !/token|secret|key|password/i.test(k))
            diag({ code: 'outbound-option', severity: 'low', message: `user setting "${k}" sends data to an address the user enters (${clipWords(String(f.description ?? f.title ?? ''), 100)}) — off until set; know what it sends before you set it`, path: file, line: lineOfKey(text, k) ?? undefined });
        }
      }
    }
  }

  // ---- the code that hooks, manifests and plugins run — followed one module at a time ----
  const seenCode = new Set<string>();
  const childrenOf = new Map<string, string[]>();
  for (let n = 0; n < codeQueue.length && seenCode.size < 200 && n < 5000; n++) {
    const { file, root, by, via } = codeQueue[n];
    const s = byPath.get(file) ?? surface('code', 'other', file, 'code', null);
    if (s.kind !== 'code') continue;                                       // a hook file named twice
    const newTrigger = !s.reachedBy.includes(by);
    if (newTrigger) s.reachedBy.push(by);
    if (via && !s.via.includes(via)) s.via.push(via);
    if (seenCode.has(file)) {
      // reached again through another trigger: what it loads is run by that trigger too
      if (newTrigger) for (const c of childrenOf.get(file) ?? []) codeQueue.push({ file: c, root, by, via: path.relative(root, file) });
      continue;
    }
    seenCode.add(file);
    let text: string;
    try { text = await readText(file, 2 * 1024 * 1024); } catch (e) { s.error = (e as Error).message; continue; }
    s.hash = await hashOf(text);
    s.caps = capsOf(text);
    for (const ref of scriptRefs(text)) {
      const abs = await resolveRef(ref, file, root)
        ?? (/\.[cm]?[jt]sx?$/.test(ref) ? null : await resolveRef(ref + '.js', file, root) ?? await resolveRef(ref + '.ts', file, root) ?? await resolveRef(path.join(ref, 'index.js'), file, root));
      if (abs && abs !== file) {
        codeQueue.push({ file: abs, root, by, via: path.relative(root, file) });
        childrenOf.set(file, [...(childrenOf.get(file) ?? []), abs]);
      }
    }
    const dl = downloadExec(text);
    if (dl >= 0) diag({ code: 'remote-code', severity: 'high', message: 'downloads code and runs it — whatever the server returns runs with your rights', path: file, line: lineOf(text, dl) ?? undefined });
    const pkg = PKG_RUNNER.exec(text);
    if (pkg && !PINNED.test(pkg[2]) && !pkg[2].startsWith('.')) diag({ code: 'unpinned-package', severity: 'medium', message: `runs ${pkg[2]} through ${pkg[1]} without a pinned version — every run may fetch different code`, path: file, line: lineOf(text, pkg.index) ?? undefined });
  }
  // capability findings once per code file, naming what runs it (hooks see the prompt and tool I/O)
  for (const s of surfaces.filter((x) => x.kind === 'code' && x.caps)) {
    const c = s.caps!;
    const trigger = (s.reachedBy.length ? s.reachedBy[0] + (s.reachedBy.length > 1 ? ` (+${s.reachedBy.length - 1})` : '') : 'loaded by the harness') + (s.via.length ? ` via ${s.via[0]}` : '');
    const content = /UserPromptSubmit|PreToolUse|PostToolUse|Stop|SubagentStop|SessionEnd|PreCompact|beforeSubmitPrompt|afterFileEdit|userPromptSubmitted|preToolUse|postToolUse/.test(s.reachedBy.join(' '));
    if (c.network) diag({ code: 'exec-network', severity: 'medium', message: `can send data over the network (line ${c.network}); run by ${trigger}${content || c.readsInput ? ' — it receives the prompt or tool input, so that is what it could send' : ''}`, path: s.path, line: c.network });
    if (c.credentials) diag({ code: 'exec-credentials', severity: 'medium', message: `reads credentials (line ${c.credentials}); run by ${trigger}`, path: s.path, line: c.credentials });
    if (c.background) diag({ code: 'exec-background', severity: 'low', message: `starts a process that outlives the hook (line ${c.background}); run by ${trigger} — it keeps running after the agent moves on`, path: s.path, line: c.background });
    if (c.dynamicCode) diag({ code: 'exec-dynamic-code', severity: 'medium', message: `builds and runs code at run time (line ${c.dynamicCode}) — what runs cannot be reviewed here`, path: s.path, line: c.dynamicCode });
  }
  return { surfaces, diagnostics };
}

// ---- rules per surface ------------------------------------------------------------------------

function proseFindings(prose: string, text: string, file: string, diag: (x: Diagnostic) => void) {
  for (const p of INJECTION) {
    const at = p.find(prose);
    if (at < 0) continue;
    const abs = text.indexOf(prose) + at;
    diag({ code: 'injection-heuristic', severity: /invisible|download/.test(p.what) ? 'high' : 'medium', message: `${p.what}`, path: file, line: lineOf(text, abs) ?? undefined });
  }
  for (const re of SECRET) { const m = re.exec(text); if (m) { diag({ code: 'secret-pattern', severity: 'high', message: 'a secret-shaped value appears in this file', path: file, line: lineOf(text, m.index) ?? undefined }); break; } }
}

function execCommandFindings(cmd: string, file: string, line: number | null, where: string, diag: (x: Diagnostic) => void) {
  const downloads = downloadExec(cmd) >= 0;
  if (downloads) diag({ code: 'remote-code', severity: 'high', message: `${where} downloads code and runs it: ${cmd.slice(0, 80)}`, path: file, line: line ?? undefined });
  const pkg = PKG_RUNNER.exec(cmd);
  if (pkg && !PINNED.test(pkg[2]) && !pkg[2].startsWith('.')) diag({ code: 'unpinned-package', severity: 'medium', message: `${where} runs ${pkg[2]} through ${pkg[1]} without a pinned version — every session may fetch different code`, path: file, line: line ?? undefined });
  const c = capsOf(cmd);
  if (c.network && !downloads && !/^\s*(?:node|python3?|bash|sh|pwsh|powershell)\b/.test(cmd)) diag({ code: 'exec-network', severity: 'medium', message: `${where} reaches the network itself: ${cmd.slice(0, 80)}`, path: file, line: line ?? undefined });
  if (c.credentials) diag({ code: 'exec-credentials', severity: 'medium', message: `${where} reads credentials: ${cmd.slice(0, 80)}`, path: file, line: line ?? undefined });
}

function mcpFindings(m: McpEntry, cfg: Record<string, any>, file: string, diag: (x: Diagnostic) => void) {
  const where = `MCP server "${m.name}"`;
  if (m.trusted) diag({ code: 'mcp-auto-approve', severity: 'medium', message: `${where} has trust: true — Gemini runs its tools without asking`, path: file, line: m.line ?? undefined });
  if (m.url && /^http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/.test(m.url)) diag({ code: 'insecure-url', severity: 'high', message: `${where} is reached over plain http (${m.url}) — its tool calls and results can be read or altered on the way`, path: file, line: m.line ?? undefined });
  if (m.command) {
    const pkg = PKG_RUNNER.exec(m.command);
    if (pkg && !PINNED.test(pkg[2]) && !pkg[2].startsWith('.')) diag({ code: 'unpinned-package', severity: 'medium', message: `${where} runs ${pkg[2]} through ${pkg[1]} without a pinned version — every start may fetch different code`, path: file, line: m.line ?? undefined });
    const img = /\bdocker\s+run\b[^\n]*?\s([\w./-]+\/[\w.-]+(?::[\w.-]+)?)(?:\s|$)/.exec(m.command);
    if (img && (!img[1].includes(':') || img[1].endsWith(':latest'))) diag({ code: 'unpinned-package', severity: 'medium', message: `${where} runs the image ${img[1]} without a fixed tag or digest`, path: file, line: m.line ?? undefined });
    if (downloadExec(m.command) >= 0) diag({ code: 'remote-code', severity: 'high', message: `${where} downloads code and runs it`, path: file, line: m.line ?? undefined });
  }
  void cfg;
}

function settingsFindings(cfg: Record<string, any>, p: Pattern, text: string, file: string, lines: Map<string, number> | undefined, diag: (x: Diagnostic) => void) {
  const at = (k: string) => lines?.get(k) ?? lineOfKey(text, k.split('.').pop()!) ?? undefined;
  // permissions switched off or loosened — per harness, with what each actually honours
  const perms = obj(cfg.permissions);
  if (perms?.defaultMode === 'bypassPermissions' || perms?.defaultMode === 'auto')
    diag({ code: 'permissions-bypass', severity: perms.defaultMode === 'bypassPermissions' ? 'medium' : 'low', message: `permissions.defaultMode is ${perms.defaultMode} — ${perms.defaultMode === 'bypassPermissions' ? 'tool calls run without asking' : 'a classifier decides instead of the user'} for anyone who opens this project. Claude Code 2.1.257+ ignores it in project settings; older clients and harnesses that import .claude/settings do not`, path: file, line: at('defaultMode') });
  if (perms?.defaultMode === 'acceptEdits') diag({ code: 'permissions-bypass', severity: 'low', message: 'permissions.defaultMode is acceptEdits — file edits are applied without asking', path: file, line: at('defaultMode') });
  if (obj(cfg.sandbox)?.autoAllowBashIfSandboxed === true) diag({ code: 'permissions-bypass', severity: 'low', message: 'sandbox.autoAllowBashIfSandboxed — shell commands run without asking whenever the sandbox is on', path: file, line: at('autoAllowBashIfSandboxed') });
  if (cfg.sandbox_mode === 'danger-full-access') diag({ code: 'permissions-bypass', severity: 'high', message: 'sandbox_mode = "danger-full-access" — Codex runs commands with no sandbox in this project', path: file, line: at('sandbox_mode') });
  if (cfg.approval_policy === 'never') diag({ code: 'permissions-bypass', severity: cfg.sandbox_mode === 'danger-full-access' ? 'high' : 'medium', message: 'approval_policy = "never" — Codex never asks before running a command; only the sandbox limits it', path: file, line: at('approval_policy') });
  const gm = obj(cfg.general)?.defaultApprovalMode;
  if (gm === 'yolo' || gm === 'auto_edit') diag({ code: 'permissions-bypass', severity: gm === 'yolo' ? 'high' : 'low', message: `general.defaultApprovalMode is ${gm} — Gemini ${gm === 'yolo' ? 'approves every tool call' : 'applies edits'} without asking`, path: file, line: at('defaultApprovalMode') });
  // OpenCode: v1 `permission` object/string; v2 `permissions` rules with effect allow
  const op = cfg.permission;
  if (op === 'allow' || (obj(op) && (op['*'] === 'allow' || op.bash === 'allow')))
    diag({ code: 'permissions-bypass', severity: op === 'allow' || op['*'] === 'allow' ? 'high' : 'medium', message: `OpenCode permission ${op === 'allow' ? '"allow"' : op['*'] === 'allow' ? '"*": "allow"' : 'bash: "allow"'} — commands run without asking`, path: file, line: at('permission') });
  for (const r of Array.isArray(cfg.permissions) ? cfg.permissions : []) {
    const x = obj(r);
    if (x?.effect === 'allow' && /^(?:\*|shell|bash|edit|external_directory)$/.test(String(x.action ?? x.permission ?? x.resource ?? '')))
      diag({ code: 'permissions-broad-allow', severity: x.action === '*' ? 'high' : 'medium', message: `OpenCode permissions allow "${x.action ?? x.resource}" without asking`, path: file, line: lineOfValue(text, x.action ?? x.resource) ?? undefined });
  }
  // broad pre-approvals: Claude `permissions.allow`, Cursor CLI `Shell(...)`, Gemini `tools.allowed`
  const allow = [...(Array.isArray(perms?.allow) ? perms!.allow : []), ...(Array.isArray(obj(cfg.tools)?.allowed) ? cfg.tools.allowed : [])];
  for (const rule of allow) {
    if (typeof rule !== 'string') continue;
    if (/^(?:Bash|PowerShell|Shell|run_shell_command)(?:\(\s*\*?\s*(?::\s*\*)?\s*\))?$/.test(rule.trim()))
      diag({ code: 'permissions-broad-allow', severity: 'medium', message: `pre-approves "${rule}" — any shell command runs without asking`, path: file, line: lineOfValue(text, rule) ?? undefined });
  }
  if (cfg.enableAllProjectMcpServers === true) diag({ code: 'mcp-auto-approve', severity: 'medium', message: 'enableAllProjectMcpServers: true — every MCP server in .mcp.json starts without asking, including ones a later commit adds', path: file, line: at('enableAllProjectMcpServers') });
  void p;
}
