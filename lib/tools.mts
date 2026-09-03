// Tool registry: the names an allowlist may legitimately cite. Three sources —
//   1. builtin tools per harness (registry JSON),
//   2. an MCP catalog file (TAUT `catalog/mcp.json` shape: servers.<id>.{serverKey,tools[]};
//      or a plain `.mcp.json` / opencode.json: server keys only, tools unknown),
//   3. LIVE discovery: spawn a catalog server and ask it `tools/list` over stdio JSON-RPC
//      (the same handshake `taut check` performs) — `saut tools --live`.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadHarnesses } from './caps.mts';
import type { ToolCatalogServer, ToolRef, ToolRegistry } from './types.mts';
import { exists, readText } from './util.mts';

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
  const j = JSON.parse(await readText(file)) as Catalog;
  const raw = j.servers ?? j.mcpServers ?? {};
  const servers: ToolCatalogServer[] = Object.entries(raw).map(([id, s]) => ({
    serverKey: s.serverKey ?? id,
    role: s.role,
    tools: (s.tools ?? []).map((t) => (t.startsWith('mcp__') ? t : `mcp__${s.serverKey ?? id}__${t}`)),
    source: file,
  }));
  return { servers, raw };
}

// Live `tools/list` over stdio. Env: names listed in `env` are passed through from the
// process environment when present (values never leave the machine); `fixedEnv` applied.
export async function liveTools(id: string, s: CatalogServer, timeoutMs = 20000): Promise<string[]> {
  if (!s.command) throw new Error(`server "${id}" has no command`);
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(s.fixedEnv ?? {}) };
  return new Promise((resolve, reject) => {
    const child = spawn(s.command!, s.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server "${id}": tools/list timed out`)); }, timeoutMs);
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] }; error?: { message: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        if (msg.id === 2) {
          clearTimeout(timer); child.kill();
          if (msg.error) reject(new Error(`server "${id}": ${msg.error.message}`));
          else resolve((msg.result?.tools ?? []).map((t) => `mcp__${s.serverKey ?? id}__${t.name}`));
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server "${id}" exited (${code}) before answering tools/list`)); });
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
        try { s.tools = await liveTools(id, raw[id]); s.source = `live:${id}`; } catch (e) { s.source = `${catalog} (live failed: ${(e as Error).message})`; }
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
