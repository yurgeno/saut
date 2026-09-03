// SAUT Studio — the acting local UI: one loopback HTTP server serving a self-contained page
// (lib/studio/studio.html — a real HTML file, so client code needs no JS-string escaping) plus
// a small JSON API. Reads are computed in-process by the same library functions the CLI verbs
// call; the bench streams its events over SSE. Nothing here re-implements a rule.
//
// CSRF stance for a MUTATING localhost UI (mirrors the TAUT panel): bind 127.0.0.1 only; POST
// requires a per-session token in a CUSTOM header (which forces a preflight we never answer)
// plus an Origin check; no CORS headers are ever sent, so a foreign page can read nothing. A
// DNS-rebinding guard pins the Host header to this loopback origin. Writes are contained под
// the root the studio was started with, and only to a skill's SKILL.md or an agent .md.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runBench } from '../bench/bench.mts';
import type { BenchResult } from '../bench/types.mts';
import { costOf, overBudget } from '../cost.mts';
import { emitFrontmatter } from '../frontmatter.mts';
import { lintArtifact, matrix, sortDiags } from '../lint.mts';
import type { Artifact, Diagnostic } from '../types.mts';
import { exists, readText } from '../util.mts';
import { previews } from '../adapters/taut.mts';
import { load, type Opts } from '../commands.mts';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(path.join(HERE, 'studio.html'), 'utf8');
const renderPage = (token: string): string => PAGE.replace('%%TOKEN%%', token);

const NAME = /^[a-z0-9][a-z0-9-]*$/;                       // skill/agent id (spec shape)
const MAX_JOBS = 32;                                       // completed bench runs kept for replay

// Constant-time compare so a token cannot be recovered byte by byte from response timing.
// Lengths differ → reject without comparing (the length is not a secret).
function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export interface StudioHandle { server: Server; token: string; port: number; close: () => Promise<void> }

interface BenchJob { id: string; events: { kind: string; text: string }[]; done: boolean; result?: BenchResult; error?: string; listeners: Set<(e: { kind: string; text: string } | null) => void> }

export async function startStudio(root: string, opts: Opts & { port?: number }): Promise<StudioHandle> {
  const token = crypto.randomBytes(16).toString('hex');
  let boundPort = 0;
  const jobs = new Map<string, BenchJob>();
  let busy = false;

  const hostOk = (host: string | undefined): boolean =>
    host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;

  // Everything the page needs to draw itself: artifacts, harness registry, tool registry,
  // TAUT context. Recomputed per request — a file edited in an IDE shows up on reload.
  async function context() {
    const { artifacts, harnesses, registry, taut, note } = await load([root], opts);
    return {
      root,
      note,
      taut: taut ? { packRoot: taut.packRoot, engine: taut.engine, engineCommit: taut.engineCommit, deployment: taut.project?.name ?? null, projects: taut.projects.map((p) => p.name) } : null,
      harnesses: harnesses.map((h) => ({
        id: h.id, title: h.title, runner: !!h.runner, skillsDirs: h.skillsDirs, agentsDir: h.agentsDir,
        toolAllowlist: h.toolAllowlist, agentAllowlist: h.agentAllowlist, denyMechanism: h.denyMechanism,
        frontmatterFields: h.frontmatterFields, builtinTools: h.builtinTools, degradations: h.degradations,
        listing: h.listing,
      })),
      tools: { builtin: registry.builtin, servers: registry.servers },
      artifacts: artifacts.map((a) => ({ kind: a.kind, name: a.name, path: a.path, description: a.description })),
    };
  }

  // One artifact's passport: source text, findings, cost, per-harness matrix and (TAUT) the
  // compiled bytes. The same functions `saut lint|cost|passport` call.
  async function passport(file: string) {
    const abs = path.resolve(file);
    if (!contained(abs)) throw new Error('path outside the studio root');
    const { artifacts, harnesses, registry, agentsByName, taut } = await load([abs], opts);
    const a = artifacts[0];
    if (!a) throw new Error(`no skill or agent at ${file}`);
    let findings: Diagnostic[] = lintArtifact(a, { harnesses, registry, agentsByName });
    if (taut) {
      const { lintWiring, refine } = await import('../adapters/taut.mts');
      findings = findings.filter((x) => !x.code.startsWith('taut-'));
      const r = await refine(a, taut);
      findings.push(...r.findings, ...lintWiring(r.artifact, taut));
    }
    const cost = await costOf(a, { harness: harnesses.find((h) => h.id === 'claude-code') ?? null, exact: false, agentsByName: agentsByName as Map<string, Artifact> });
    const compiled = taut ? (await previews(a, taut)).map((p) => ({ harness: p.harness, id: p.id, bytes: p.bytes, transform: p.transform, degradations: p.degradations, content: p.content.slice(0, 200000) })) : [];
    return {
      kind: a.kind, name: a.name, path: a.path,
      text: await readText(a.path),
      frontmatter: a.fm.data, duplicates: a.fm.duplicates,
      findings: sortDiags(findings), cost, over: overBudget(cost, a, {}), matrix: matrix(a, harnesses), compiled,
    };
  }

  const contained = (abs: string): boolean => abs === root || abs.startsWith(root + path.sep);

  // Where a NEW artifact goes: a TAUT pack's shared skills/ (or <project>/skills/), else
  // <root>/skills/<name>/SKILL.md — the layout the spec and every harness discover.
  async function targetFor(kind: string, name: string, project: string | null): Promise<string> {
    if (!NAME.test(name)) throw new Error('name must be lowercase letters, digits and dashes');
    const base = project ? path.join(root, project) : root;
    return kind === 'agent' ? path.join(base, 'agents', `${name}.md`) : path.join(base, 'skills', name, 'SKILL.md');
  }

  async function save(payload: any): Promise<{ path: string; created: boolean }> {
    const kind = payload.kind === 'agent' ? 'agent' : 'skill';
    const name = String(payload.name ?? '');
    const body = String(payload.body ?? '');
    const fm = payload.frontmatter && typeof payload.frontmatter === 'object' ? payload.frontmatter : null;
    if (!fm) throw new Error('frontmatter is required');
    const file = payload.path ? path.resolve(String(payload.path)) : await targetFor(kind, name, payload.project ?? null);
    if (!contained(file)) throw new Error('path outside the studio root');
    if (path.basename(file) !== 'SKILL.md' && !file.endsWith('.md')) throw new Error('refusing to write a non-markdown file');
    const created = !(await exists(file));
    const text = emitFrontmatter(fm) + (body.startsWith('\n') ? body : '\n' + body);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text.endsWith('\n') ? text : text + '\n');
    return { path: file, created };
  }

  // Pack validation: the pack's own script is the gate (compile + verify + the SAUT step);
  // without one, a strict lint of the root is the closest equivalent.
  async function validate(): Promise<{ ok: boolean; command: string; output: string }> {
    const { taut } = await load([root], opts);
    const script = taut ? path.join(taut.packRoot, 'tools', 'validate-pack.sh') : null;
    const env = { ...process.env, ...(taut ? { TAUT_ENGINE: taut.engine, SAUT: path.dirname(HERE).replace(/\/lib$/, '') } : {}) } as Record<string, string>;
    if (script && (await exists(script))) {
      try {
        const r = await run('bash', [script], { cwd: taut!.packRoot, env, maxBuffer: 16 * 1024 * 1024 });
        return { ok: true, command: 'tools/validate-pack.sh', output: r.stdout.slice(-20000) };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        return { ok: false, command: 'tools/validate-pack.sh', output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000) };
      }
    }
    const cli = path.join(path.dirname(HERE).replace(/\/lib$/, ''), 'saut.mjs');
    try {
      const r = await run('node', [cli, 'lint', root, '--strict'], { env, maxBuffer: 16 * 1024 * 1024 });
      return { ok: true, command: 'saut lint --strict', output: r.stdout.slice(-20000) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, command: 'saut lint --strict', output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000) };
    }
  }

  async function startBench(payload: any): Promise<string> {
    const file = path.resolve(String(payload.path ?? ''));
    if (!contained(file)) throw new Error('path outside the studio root');
    const { artifacts, harnesses, taut } = await load([file], opts);
    const a = artifacts[0];
    if (!a) throw new Error('no artifact at that path');
    const wanted: string[] = Array.isArray(payload.harnesses) ? payload.harnesses.map(String) : [];
    const selected = harnesses.filter((h) => h.runner && (!wanted.length || wanted.includes(h.id)));
    const id = crypto.randomBytes(6).toString('hex');
    const job: BenchJob = { id, events: [], done: false, listeners: new Set() };
    jobs.set(id, job);
    // keep the last MAX_JOBS runs for replay; evict the oldest FINISHED ones (a running job
    // is never dropped — its stream would end without a verdict)
    if (jobs.size > MAX_JOBS) {
      for (const [key, j] of jobs) {
        if (jobs.size <= MAX_JOBS) break;
        if (j.done && !j.listeners.size) jobs.delete(key);
      }
    }
    const push = (e: { kind: string; text: string }) => { job.events.push(e); for (const l of job.listeners) l(e); };
    const siblings = taut ? (await load([taut.packRoot], opts)).artifacts : artifacts;
    const outDir = path.join(a.kind === 'skill' ? a.dir : path.dirname(a.path), 'evals', 'results', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    runBench({
      artifact: a, siblings, harnesses: selected, taut, level: (Number(payload.level) || 3) as 1 | 2 | 3,
      runs: Math.max(1, Math.min(5, Number(payload.runs) || 1)), model: payload.model || undefined,
      maxCostUsd: payload.maxCost === undefined || payload.maxCost === null || payload.maxCost === '' ? null : Number(payload.maxCost),
      landscape: null, caseFilter: payload.case || undefined, outDir, keepScratch: false,
      timeoutMs: 300000, version: 'studio', onEvent: push,
    }).then((result) => { job.result = result; job.done = true; push({ kind: 'done', text: outDir }); for (const l of job.listeners) l(null); })
      .catch((e: Error) => { job.error = e.message; job.done = true; push({ kind: 'fail', text: e.message }); for (const l of job.listeners) l(null); });
    return id;
  }

  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : String(body));
    };
    try {
      if (!hostOk(req.headers.host)) return send(403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/') return send(200, renderPage(token), 'text/html; charset=utf-8');
      if (req.method === 'GET' && pathname === '/api/context') return send(200, await context());
      if (req.method === 'GET' && pathname === '/api/artifact') {
        const p = url.searchParams.get('path') ?? '';
        try { return send(200, await passport(p)); } catch (e) { return send(400, { error: (e as Error).message }); }
      }
      if (req.method === 'GET' && pathname.startsWith('/api/test/') && pathname.endsWith('/events')) {
        // SSE: the token rides in the query (EventSource cannot set headers); the Host guard
        // above and the loopback bind keep it local, and the stream is read-only.
        if (!tokenOk(url.searchParams.get('token'), token)) return send(403, { error: 'bad token' });
        const job = jobs.get(pathname.split('/')[3]);
        if (!job) return send(404, { error: 'no such run' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
        const write = (e: { kind: string; text: string } | null) => {
          if (e) res.write(`data: ${JSON.stringify(e)}\n\n`);
          else { res.write(`event: end\ndata: ${JSON.stringify({ result: job.result ?? null, error: job.error ?? null })}\n\n`); res.end(); }
        };
        for (const e of job.events) write(e);
        if (job.done) return write(null);
        job.listeners.add(write);
        req.on('close', () => job.listeners.delete(write));
        return undefined;
      }

      if (req.method === 'POST') {
        if (!tokenOk(req.headers['x-saut-token'], token)) return send(403, { error: 'bad or missing token' });
        const origin = req.headers.origin;
        if (origin && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) return send(403, { error: 'bad origin' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) return send(413, { error: 'request body too large' }); }
        const payload = body ? JSON.parse(body) : {};
        try {
          if (pathname === '/api/emit') return send(200, { text: emitFrontmatter(payload.frontmatter ?? {}) });
          if (pathname === '/api/save') { const r = await save(payload); return send(200, { ...r, passport: await passport(r.path) }); }
          if (pathname === '/api/test') return send(200, { id: await startBench(payload) });
          if (pathname === '/api/validate') {
            if (busy) return send(409, { error: 'another action is still running' });
            busy = true;
            try { return send(200, await validate()); } finally { busy = false; }
          }
        } catch (e) { return send(400, { error: (e as Error).message }); }
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  boundPort = (server.address() as AddressInfo).port;
  return { server, token, port: boundPort, close: () => new Promise<void>((r) => server.close(() => r())) };
}
