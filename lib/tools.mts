// Tool registry: the names an allowlist may legitimately cite. Three sources —
//   1. builtin tools per harness (registry JSON),
//   2. an MCP catalog file (TAUT `catalog/mcp.json` shape: servers.<id>.{serverKey,tools[]};
//      or a plain `.mcp.json` / opencode.json: server keys only, tools unknown),
//   3. LIVE discovery: spawn a catalog server and ask it `tools/list` over stdio JSON-RPC
//      (the same handshake `taut check` performs) — `saut tools --live`.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadHarnesses } from './caps.mts';
import type { ToolCatalogServer, ToolRef, ToolRegistry } from './types.mts';
import { exists, fail, readText } from './util.mts';

const MAX_STDOUT_CHARS = 4 * 1024 * 1024;

interface CatalogServer { serverKey?: string; role?: string; tools?: string[]; command?: string; args?: string[]; env?: string[]; fixedEnv?: Record<string, string> }
interface Catalog { servers?: Record<string, CatalogServer>; mcpServers?: Record<string, CatalogServer> }

export async function findCatalog(start: string): Promise<string | null> {
  // walk up from `start` looking for a TAUT catalog or a harness MCP config
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    for (const cand of ['catalog/mcp.json', 'upe/catalog/mcp.json', '.mcp.json', 'opencode.json']) {
      const p = path.join(dir, cand);
      if (await exists(p)) return p;
    }
    // TAUT packs keep the catalog under <project>/catalog — probe one level of subdirs
    try {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name, 'catalog', 'mcp.json');
        if (await exists(p)) return p;
      }
    } catch { /* unreadable */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export async function readCatalog(file: string): Promise<{ servers: ToolCatalogServer[]; raw: Record<string, CatalogServer> }> {
  let j: Catalog;
  try { j = JSON.parse(await readText(file)) as Catalog; }
  catch (e) { return fail(`${file}: ${(e as Error).message}`); }
  const raw = j?.servers ?? j?.mcpServers ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail(`${file}: "servers" must be an object of server id → definition`);
  const servers: ToolCatalogServer[] = Object.entries(raw).map(([id, s]) => {
    if (typeof s !== 'object' || s === null) return fail(`${file}: server "${id}" must be an object`);
    if (s.tools !== undefined && !Array.isArray(s.tools)) return fail(`${file}: server "${id}": "tools" must be an array of tool names`);
    if (s.env !== undefined && !Array.isArray(s.env)) return fail(`${file}: server "${id}": "env" must be an array of variable NAMES`);
    return {
      serverKey: typeof s.serverKey === 'string' ? s.serverKey : id,
      role: typeof s.role === 'string' ? s.role : undefined,
      tools: (s.tools ?? []).map((t) => (String(t).startsWith('mcp__') ? String(t) : `mcp__${s.serverKey ?? id}__${String(t)}`)),
      source: file,
    };
  });
  return { servers, raw };
}

// Live `tools/list` over stdio. Env: names listed in `env` are passed through from the
// process environment when present (values never leave the machine); `fixedEnv` applied.
// What a spawned server may see: the base a process needs to run, plus exactly the variable
// NAMES the catalog declares, plus its fixedEnv. Handing it the whole environment would give
// every catalog entry — auto-discovered from repository data — the caller's API keys and
// agent sockets.
const BASE_ENV = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'SystemRoot', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'];

export function serverEnv(s: CatalogServer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...(s.env ?? [])]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...(s.fixedEnv ?? {}) };
}

export async function liveTools(id: string, s: CatalogServer, timeoutMs = 20000): Promise<string[]> {
  if (!s.command) throw new Error(`server "${id}" has no command`);
  const env = serverEnv(s);
  return new Promise((resolve, reject) => {
    const child = spawn(s.command!, s.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');          // a multi-byte char split across chunks must not corrupt a line
    let buf = '';
    let settled = false;
    const stop = () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); };
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); stop(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error(`server "${id}": tools/list timed out`))), timeoutMs);
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', (d: Buffer) => {
      buf += decoder.write(d);
      // A server that never emits a newline must not grow the buffer without limit.
      if (buf.length > MAX_STDOUT_CHARS) return done(() => reject(new Error(`server "${id}": more than ${MAX_STDOUT_CHARS / 1024} KB without a complete message`)));
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] }; error?: { message: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        if (msg.id === 2) {
          if (msg.error) done(() => reject(new Error(`server "${id}": ${msg.error!.message}`)));
          else done(() => resolve((msg.result?.tools ?? []).map((t) => `mcp__${s.serverKey ?? id}__${t.name}`)));
        }
      }
    });
    child.on('error', (e) => done(() => reject(e)));
    child.on('exit', (code) => done(() => reject(new Error(`server "${id}" exited (${code}) before answering tools/list`))));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'saut', version: '0.1.0' } } });
  });
}

export async function buildRegistry(opts: { catalog?: string | null; live?: boolean; start?: string }): Promise<ToolRegistry> {
  const hs = await loadHarnesses();
  const builtin: Record<string, string[]> = {};
  const legacy: Record<string, string[]> = {};
  for (const h of hs.values()) { builtin[h.id] = h.builtinTools; legacy[h.id] = h.legacyTools; }
  const servers: ToolCatalogServer[] = [];
  const catalog = opts.catalog === undefined ? await findCatalog(opts.start ?? process.cwd()) : opts.catalog;
  if (catalog) {
    const { servers: listed, raw } = await readCatalog(catalog);
    for (const s of listed) {
      if (opts.live) {
        const id = Object.keys(raw).find((k) => (raw[k].serverKey ?? k) === s.serverKey)!;
        try { s.tools = await liveTools(id, raw[id]); s.source = `live:${id}`; }
        catch (e) { s.source = `${catalog} (live failed: ${(e as Error).message})`; s.liveFailed = true; }
      }
      servers.push(s);
    }
  }
  return { builtin, legacy, servers };
}

export type ToolVerdict = 'builtin' | 'legacy' | 'mcp-known' | 'mcp-server-known' | 'mcp-unknown-server' | 'mcp-unknown-tool' | 'unknown';

// Classify one allowlist entry against the registry for a harness.
export function classifyTool(ref: ToolRef, reg: ToolRegistry, harnessId: string): ToolVerdict {
  if (ref.mcp) {
    const server = reg.servers.find((s) => s.serverKey === ref.mcp!.server);
    if (!server) return reg.servers.length ? 'mcp-unknown-server' : 'mcp-server-known';   // no catalog → can't judge servers
    if (!ref.mcp.tool || ref.mcp.tool.includes('*')) return 'mcp-server-known';
    if (!server.tools.length) return 'mcp-server-known';                                      // catalog lists no tools for it
    return server.tools.includes(ref.base) ? 'mcp-known' : 'mcp-unknown-tool';
  }
  if ((reg.builtin[harnessId] ?? []).includes(ref.base)) return 'builtin';
  if ((reg.legacy[harnessId] ?? []).includes(ref.base)) return 'legacy';
  return 'unknown';
}
