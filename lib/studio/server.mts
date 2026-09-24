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
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { runBench } from '../bench/bench.mts';
import { DEFAULT_MODEL } from '../bench/runners.mts';
import { newResultsDir } from '../bench/results.mts';
import type { BenchResult } from '../bench/types.mts';
import { costOf, overBudget } from '../cost.mts';
import { emitFrontmatter } from '../frontmatter.mts';
import { lintArtifact, matrix, sortDiags } from '../lint.mts';
import { explain } from '../rules.mts';
import { deploymentOf, guidanceStatus, lintGuidance, lintModelTiers, localCatalogs, sandboxedAgents } from '../guidance.mts';
import { applyFix, lineDiff } from '../fix.mts';
import type { Artifact, Diagnostic } from '../types.mts';
import { exists, onPath, readText } from '../util.mts';
import { previews } from '../adapters/taut.mts';
import { load, type Opts } from '../commands.mts';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The page is split into a shell, a script, a stylesheet and the vendored editor, all served
// from this directory by name (never by a path the request chooses). The shell carries the
// session token in a <meta>, so no script needs to be inline and the policy can forbid them.
const ASSETS: Record<string, { file: string; type: string }> = {
  '/studio.js': { file: 'studio.js', type: 'text/javascript; charset=utf-8' },
  '/studio.css': { file: 'studio.css', type: 'text/css; charset=utf-8' },
  '/vendor/codemirror.js': { file: 'vendor/codemirror.js', type: 'text/javascript; charset=utf-8' },
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const renderPage = (token: string): string => readFileSync(path.join(HERE, 'studio.html'), 'utf8').replace('%%TOKEN%%', token);

const NAME = /^[a-z0-9][a-z0-9-]*$/;                       // skill/agent id (spec shape)
const MAX_JOBS = 32;                                       // completed bench runs kept for replay
const VALIDATE_TIMEOUT_MS = 30 * 60 * 1000;                // a pack script that hangs must not wedge the server

// Constant-time compare so a token cannot be recovered byte by byte from response timing.
// Lengths differ → reject without comparing (the length is not a secret).
function tokenOk(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export interface StudioHandle { server: Server; token: string; port: number; close: () => Promise<void> }

interface BenchJob { id: string; events: { kind: string; text: string }[]; done: boolean; result?: BenchResult; runId?: string; pair?: { id: string; before: string; after: string }; error?: string; listeners: Set<(e: { kind: string; text: string } | null) => void> }

export async function startStudio(root: string, opts: Opts & { port?: number }): Promise<StudioHandle> {
  const token = crypto.randomBytes(16).toString('hex');
  let boundPort = 0;
  const jobs = new Map<string, BenchJob>();
  let busy = false;

  const hostOk = (host: string | undefined): boolean =>
    host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;

  // Paths cross the API relative to the root — the page never needs (or shows) where the root
  // lives on this machine, which a hosted Studio must not reveal. Absolute paths are still
  // accepted from local callers.
  const resolveIn = (p: unknown): string => path.resolve(root, String(p ?? ''));
  const relOf = (abs: string): string => path.relative(root, abs) || '.';

  // A compiled TAUT workspace seals its files with taut.lock: an edit there is overwritten by
  // the next `taut update` and makes `taut verify` fail. Those files are shown read-only, with
  // the pack source they were compiled from.
  interface Compiled { source: string; pack: string | null; commit: string | null; lockDir: string }
  async function lockMap(): Promise<Map<string, Compiled>> {
    const out = new Map<string, Compiled>();
    let dir = realRoot;
    for (let i = 0; i < 5; i++) {
      const lock = path.join(dir, 'taut.lock');
      try {
        const j = JSON.parse(await readText(lock));
        for (const e of Array.isArray(j.artifacts) ? j.artifacts : [])
          if (typeof e?.id === 'string') out.set(path.join(dir, e.id), { source: String(e.source ?? ''), pack: j.data?.pack ?? null, commit: typeof j.data?.commit === 'string' ? j.data.commit.slice(0, 7) : null, lockDir: dir });
        return out;
      } catch { /* not here — look one level up */ }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return out;
  }
  const compiledOf = async (abs: string): Promise<Compiled | null> => (await lockMap()).get(await fs.realpath(abs).catch(() => abs)) ?? null;

  // Which harness a compiled copy is for: the discovery directory it sits in.
  function harnessFor(abs: string, lockDir: string, harnesses: { id: string; skillsDirs: string[]; agentsDir: string | null }[]): string | null {
    const r = path.relative(lockDir, abs);
    const h = harnesses.find((x) => x.skillsDirs.some((d) => r.startsWith(d + path.sep)) || (x.agentsDir && r.startsWith(x.agentsDir + path.sep)));
    return h?.id ?? null;
  }

  // Everything the page needs to draw itself: artifacts, harness registry, tool registry,
  // TAUT context. Recomputed per request — a file edited in an IDE shows up on reload.
  async function context() {
    const { artifacts, harnesses, registry, taut, note } = await load([root], opts);
    const locked = await lockMap();
    const real = async (p: string) => fs.realpath(p).catch(() => p);
    return {
      root: path.basename(root),
      note,
      mode: taut ? 'taut' : locked.size ? 'compiled' : 'generic',
      // what this backend can do — the page shows or hides by these, never by guessing where it runs
      capabilities: { write: true, fix: true, check: true, compose: true, bench: harnesses.some((h) => h.runner), validate: !!taut, history: true, suppress: true, scan: true, llmReview: await onPath('claude') },
      taut: taut ? { engineCommit: taut.engineCommit, deployment: taut.project?.name ?? null, projects: taut.projects.map((p) => p.name) } : null,
      harnesses: harnesses.map((h) => ({
        id: h.id, title: h.title, runner: !!h.runner, skillsDirs: h.skillsDirs, agentsDir: h.agentsDir, docs: h.docs,
        toolAllowlist: h.toolAllowlist, agentAllowlist: h.agentAllowlist, denyMechanism: h.denyMechanism,
        frontmatterFields: h.frontmatterFields, builtinTools: h.builtinTools, degradations: h.degradations,
        listing: h.listing, modelPin: h.modelPin, models: h.models ?? null,
      })),
      tools: { builtin: registry.builtin, servers: registry.servers },
      benchDefaults: DEFAULT_MODEL,
      artifacts: await Promise.all(artifacts.map(async (a) => {
        const c = locked.get(await real(a.path)) ?? null;
        return { kind: a.kind, name: a.name, path: relOf(a.path), description: a.description,
          compiled: c ? { source: c.source, pack: c.pack, commit: c.commit, harness: harnessFor(await real(a.path), c.lockDir, harnesses) } : null };
      })),
      // how old the vendor guidance is, and what the pack's own model ladder says against it
      guidance: guidanceStatus(harnesses),
      packFindings: await (async () => {
        const dep = taut ? await deploymentOf(taut) : null;
        return dep ? sortDiags(explain(lintModelTiers(dep, harnesses, await localCatalogs(harnesses)))).map((x) => ({ ...x, path: relOf(x.path) })) : [];
      })(),
    };
  }

  // One artifact's passport: source text, findings, cost, per-harness matrix and (TAUT) the
  // compiled bytes. The same functions `saut lint|cost|passport` call. With `text`, the
  // passport of an UNSAVED edit: linted in memory, nothing written, no compile preview.
  async function passport(file: string, text?: string) {
    const abs = resolveIn(file);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const { artifacts, harnesses, registry, agentsByName, taut, tautFindings } = await load([abs], opts);
    const onDisk = artifacts[0];
    if (!onDisk) throw new Error(`no skill or agent at ${relOf(abs)}`);
    const { skillFromText, agentFromText, toFileLines } = await import('../skill.mts');
    const { parseFrontmatter } = await import('../frontmatter.mts');
    // In a TAUT pack `load` already hands back the engine-gated artifact and the engine's
    // findings; an unsaved text goes through the same gate here.
    let a: Artifact = onDisk;
    let engine: Diagnostic[] = tautFindings.filter((x) => x.path === onDisk.path);
    if (text !== undefined) {
      a = onDisk.kind === 'skill' ? skillFromText(onDisk.path, text) : agentFromText(onDisk.path, text);
      if (taut) { const { refine } = await import('../adapters/taut.mts'); const r = await refine(a, taut, text); a = r.artifact; engine = r.findings; }
    }
    let findings: Diagnostic[] = lintArtifact(a, { harnesses, registry, agentsByName });
    if (taut) {
      const { lintWiring } = await import('../adapters/taut.mts');
      findings = findings.filter((x) => !x.code.startsWith('taut-'));
      findings.push(...lintWiring(a, taut));
    }
    const dep = taut ? await deploymentOf(taut) : null;
    findings.push(...lintGuidance(a, { harnesses, local: await localCatalogs(harnesses), taut, sandboxed: sandboxedAgents(dep) }));
    findings = [...toFileLines(findings, a), ...engine];      // file lines, the ones the editor shows
    if (lastScan) findings.push(...lastScan.diagnostics.filter((x) => x.path === a.path));
    const { applySuppressions, loadSuppressions } = await import('../suppress.mts');
    findings = applySuppressions(findings, new Map([[a.path, a.name]]), await loadSuppressions(a.path), { reportUnused: false });
    const cost = await costOf(a, { harness: harnesses.find((h) => h.id === 'claude-code') ?? null, exact: false, agentsByName: agentsByName as Map<string, Artifact> });
    const compiled = taut && text === undefined ? (await previews(a, taut)).map((p) => ({ harness: p.harness, id: p.id, bytes: p.bytes, transform: p.transform, degradations: p.degradations, content: p.content.slice(0, 200000) })) : [];
    const source = text ?? await readText(a.path);
    const raw = parseFrontmatter(source, a.path);           // the form edits the FILE, branches and all
    const lock = await compiledOf(a.path);
    return {
      kind: a.kind, name: a.name, path: relOf(a.path),
      text: source, base: hashOf(source),
      readOnly: lock ? `compiled from ${lock.pack ?? 'the pack'}: ${lock.source}${lock.commit ? ` @${lock.commit}` : ''} — edit the source and recompile` : null,
      frontmatter: raw.data, duplicates: raw.duplicates, lines: raw.lines, bodyOffset: raw.bodyOffset,
      findings: sortDiags(explain(findings)).map((x) => ({ ...x, path: relOf(x.path) })), cost, over: overBudget(cost, a, {}), matrix: matrix(a, harnesses), compiled,
    };
  }

  const hashOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

  // The table on the Overview: per artifact, the counts a reader sorts by. Compiled copies of
  // one skill (one per harness) collapse to one row.
  async function overview() {
    const { runLint } = await import('../commands.mts');
    const lint = await runLint([root], opts);
    if (lastScan) lint.diagnostics.push(...explain(lastScan.diagnostics));
    const locked = await lockMap();
    const byPath = new Map<string, Diagnostic[]>();
    for (const x of lint.diagnostics) byPath.set(x.path, [...(byPath.get(x.path) ?? []), x]);
    const cc = lint.harnesses.find((h) => h.id === 'claude-code') ?? null;
    const rows = new Map<string, any>();
    for (const a of lint.artifacts) {
      const ds = byPath.get(a.path) ?? [];
      const realPath = await fs.realpath(a.path).catch(() => a.path);
      const c = locked.get(realPath) ?? null;
      const key = c ? `${a.kind}:${a.name}` : a.path;
      const harness = c ? harnessFor(realPath, c.lockDir, lint.harnesses) : null;
      const prev = rows.get(key);
      if (prev) { prev.copies.push({ path: relOf(a.path), harness }); continue; }
      const cost = await costOf(a, { harness: cc, exact: false, agentsByName: new Map(lint.artifacts.filter((x) => x.kind === 'agent').map((x) => [x.name, x])) as Map<string, Artifact> });
      const live = ds.filter((x) => !x.suppressed);
      const count = (s: string) => live.filter((x) => x.severity === s).length;
      rows.set(key, {
        kind: a.kind, name: a.name, path: relOf(a.path), description: a.description,
        high: count('high'), medium: count('medium'), low: count('low'), info: count('info'),
        fixable: live.filter((x) => x.autofix).length,
        guidance: { A: live.filter((x) => x.guidance?.class === 'A').length, B: live.filter((x) => x.guidance?.class === 'B').length, D: live.filter((x) => x.guidance?.class === 'D').length },
        security: live.filter((x) => x.category === 'security' || x.category === 'scanner').length,
        suppressed: ds.length - live.length,
        codes: [...new Set(live.map((x) => x.code))],
        alwaysOn: cost.alwaysOnTokens, invoke: cost.invokeTokens + (cost.transitive ?? []).reduce((n, t) => n + t.tokens, 0),
        enforcement: Object.fromEntries(matrix(a, lint.harnesses).map((m) => [m.harness, m.allowlist])),
        compiled: c ? { source: c.source, pack: c.pack, commit: c.commit } : null,
        copies: c ? [{ path: relOf(a.path), harness }] : [],
      });
    }
    const list = [...rows.values()];
    const sum = (k: string) => list.reduce((n, r) => n + r[k], 0);
    // Security at a glance: every security finding by rule, the artifacts it is in, and what
    // the content scanner said (or that none is installed).
    const sec = new Map<string, { code: string; title: string; severity: string; artifacts: Set<string> }>();
    for (const x of lint.diagnostics) {
      if (x.suppressed || !(x.category === 'security' || x.category === 'scanner' || x.code === 'no-allowlist' || x.code === 'model-invocable-writer' || x.code === 'dynamic-context')) continue;
      const name = lint.artifacts.find((a) => a.path === x.path)?.name ?? relOf(x.path);
      const e = sec.get(x.code) ?? { code: x.code, title: x.title ?? x.code, severity: x.severity, artifacts: new Set<string>() };
      e.artifacts.add(name); sec.set(x.code, e);
    }
    const { detectScanners, SCANNERS } = await import('../scan.mts');
    const installed = (await detectScanners()).map((x) => x.id);
    const outside = lint.diagnostics.filter((x) => !x.suppressed && !lint.artifacts.some((a) => a.path === x.path)).map((x) => ({ ...x, path: relOf(x.path) }));
    return {
      security: {
        rules: [...sec.values()].map((e) => ({ ...e, artifacts: [...e.artifacts].sort() })).sort((a, b) => (a.severity === 'high' ? 0 : 1) - (b.severity === 'high' ? 0 : 1) || b.artifacts.length - a.artifacts.length),
        scanners: { installed, known: SCANNERS.map((x) => ({ id: x.id, home: x.home })), last: lastScan ? { at: lastScan.at, ran: lastScan.ran, note: lastScan.note, findings: lastScan.diagnostics.length } : null },
        suppressed: lint.diagnostics.filter((x) => x.suppressed).length,
        config: outside,
      },
      rows: list,
      totals: { artifacts: list.length, high: sum('high'), medium: sum('medium'), fixable: sum('fixable'), security: sum('security'), alwaysOn: sum('alwaysOn'),
        outdated: list.reduce((n, r) => n + r.guidance.A, 0), hypotheses: list.reduce((n, r) => n + r.guidance.B, 0) },
    };
  }

  // Containment resolves SYMLINKS: path.resolve is lexical, so `<root>/agents/link.md`
  // pointing at /etc/hosts passes a string test while reading (or writing) outside the root.
  // The nearest existing ancestor is realpath'd — the target itself may not exist yet.
  async function contained(abs: string): Promise<boolean> {
    let probe = abs;
    for (let i = 0; i < 64; i++) {
      try {
        const real = await fs.realpath(probe);
        const rest = path.relative(probe, abs);
        const resolved = rest ? path.join(real, rest) : real;
        const r = path.relative(realRoot, resolved);
        return resolved === realRoot || (!!r && !r.startsWith('..') && !path.isAbsolute(r));
      } catch { /* does not exist yet — try the parent */ }
      const up = path.dirname(probe);
      if (up === probe) return false;
      probe = up;
    }
    return false;
  }

  // Where a NEW artifact goes: a TAUT pack's shared skills/ (or <project>/skills/), else
  // <root>/skills/<name>/SKILL.md — the layout the spec and every harness discover.
  async function targetFor(kind: string, name: string, project: string | null): Promise<string> {
    if (!NAME.test(name)) throw new Error('name must be lowercase letters, digits and dashes');
    const base = project ? path.join(root, project) : root;
    return kind === 'agent' ? path.join(base, 'agents', `${name}.md`) : path.join(base, 'skills', name, 'SKILL.md');
  }

  // Two ways in. An EXISTING file is saved as text — composed from the form (/api/compose) or
  // edited in the Source view — against the hash of the text it was read as, so an edit made
  // meanwhile in an IDE is refused rather than overwritten. A NEW artifact is emitted from the
  // form's frontmatter into the spec layout.
  async function writable(file: string): Promise<void> {
    if (!(await contained(file))) throw new Error('path outside the studio root');
    if (path.basename(file) !== 'SKILL.md' && !file.endsWith('.md')) throw new Error('refusing to write a non-markdown file');
    const lock = await exists(file) ? await compiledOf(file) : null;
    if (lock) throw new Error(`read-only: compiled from ${lock.pack ?? 'the pack'} (${lock.source}) — edit the source and recompile`);
  }

  async function save(payload: any): Promise<{ path: string; created: boolean }> {
    if (typeof payload.text === 'string') {
      const file = resolveIn(payload.path);
      await writable(file);
      if (!(await exists(file))) throw new Error('no such file — a new artifact is created from the form');
      const current = await readText(file);
      if (payload.base !== hashOf(current)) throw new Error('the file changed on disk since it was opened — reload it (your edit is still in the editor)');
      const { parseFrontmatter } = await import('../frontmatter.mts');
      const broken = (t: string) => parseFrontmatter(t, file).diagnostics.filter((d) => d.code === 'frontmatter-syntax' || d.code === 'no-frontmatter').length;
      if (broken(payload.text) > broken(current)) throw new Error('the frontmatter would not parse — fix the reported line first');
      await writeContained(file, payload.text, false);
      return { path: file, created: false };
    }
    const kind = payload.kind === 'agent' ? 'agent' : 'skill';
    const name = String(payload.name ?? '');
    const body = String(payload.body ?? '');
    const fm = payload.frontmatter && typeof payload.frontmatter === 'object' ? payload.frontmatter : null;
    if (!fm) throw new Error('frontmatter is required');
    const file = payload.path ? resolveIn(payload.path) : await targetFor(kind, name, payload.project ?? null);
    await writable(file);
    // Re-emitting an existing file from the form drops every key the form does not show
    // (disallowed-tools, hooks, capability branches…) — existing files go through compose.
    if (await exists(file)) throw new Error(`${relOf(file)} already exists — an existing file is saved as text (compose it from the form first)`);
    const text = emitFrontmatter(fm) + (body.startsWith('\n') ? body : '\n' + body);
    await writeContained(file, text.endsWith('\n') ? text : text + '\n', true);
    return { path: file, created: true };
  }

  // The form's edit, applied to the file text field by field (lib/compose.mts), returned as a
  // diff for the reader to confirm before /api/save writes it.
  // The text an edit amounts to: the Source view's text as is, or the form applied to the text
  // it was filled from (`from` — the Source text after a switch — else the file on disk).
  async function editedText(payload: any): Promise<{ file: string; disk: string; text: string; changed: string[] } | { reason: string }> {
    const file = resolveIn(payload.path);
    if (!(await contained(file))) throw new Error('path outside the studio root');
    const disk = await readText(file);
    if (typeof payload.text === 'string') return { file, disk, text: payload.text, changed: ['source'] };
    const { compose } = await import('../compose.mts');
    const kind = payload.kind === 'agent' ? 'agent' : 'skill';
    const r = compose(typeof payload.from === 'string' ? payload.from : disk, kind, payload.form ?? {}, String(payload.body ?? ''));
    return r.ok ? { file, disk, text: r.text, changed: r.changed } : { reason: r.reason };
  }

  async function composeEdit(payload: any) {
    const e = await editedText(payload);
    if ('reason' in e) return { ok: false, reason: e.reason };
    return { ok: true, text: e.text, changed: e.changed, diff: lineDiff(e.disk, e.text), base: hashOf(e.disk) };
  }

  // Callers have checked containment. O_NOFOLLOW on the final component: a symlink planted at
  // the target must not redirect the write (containment already resolved the directory chain).
  async function writeContained(file: string, text: string, created: boolean): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const flags = created ? 'wx' : fsSync.constants.O_WRONLY | fsSync.constants.O_TRUNC | fsSync.constants.O_NOFOLLOW;
    const h = await fs.open(file, flags as never);
    try { await h.writeFile(text); } finally { await h.close(); }
  }

  // A mechanical fix, previewed then applied. Only a fix the linter proposes for the file AS
  // IT IS NOW is accepted — the page cannot smuggle an arbitrary edit through this route —
  // and the apply step carries the hash of the text the preview was computed from, so a file
  // edited in between is refused rather than patched blind.
  async function fix(payload: any) {
    const file = resolveIn(payload.path);
    if (!(await contained(file))) throw new Error('path outside the studio root');
    if (payload.apply) await writable(file);
    const pass = await passport(file);
    const want = JSON.stringify(payload.autofix ?? null);
    const finding = pass.findings.find((x) => x.autofix && JSON.stringify(x.autofix) === want);
    if (!finding?.autofix) throw new Error('that fix is not proposed for this file any more — reload it');
    const base = hashOf(pass.text);
    const r = applyFix(pass.text, finding.autofix);
    if (!r.ok) return { ok: false, reason: r.reason, diff: '', base };
    if (!payload.apply) return { ok: true, diff: lineDiff(pass.text, r.text), base, label: finding.autofix.label };
    if (payload.base !== base) throw new Error('the file changed since the preview — review the fix again');
    await writeContained(file, r.text, false);
    return { ok: true, applied: true, label: finding.autofix.label, passport: await passport(file) };
  }

  // Pack validation: the pack's own script is the gate (compile + verify + the SAUT step);
  // without one, a strict lint of the root is the closest equivalent.
  async function validate(): Promise<{ ok: boolean; command: string; output: string }> {
    const { taut } = await load([root], opts);
    const script = taut ? path.join(taut.packRoot, 'tools', 'validate-pack.sh') : null;
    const env = { ...process.env, ...(taut ? { TAUT_ENGINE: taut.engine, SAUT: path.dirname(HERE).replace(/\/lib$/, '') } : {}) } as Record<string, string>;
    if (script && (await exists(script))) {
      try {
        const r = await run(script, [], { cwd: taut!.packRoot, env, maxBuffer: 16 * 1024 * 1024, timeout: VALIDATE_TIMEOUT_MS, killSignal: 'SIGKILL', shell: false });
        return { ok: true, command: 'tools/validate-pack.sh', output: r.stdout.slice(-20000) };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        return { ok: false, command: 'tools/validate-pack.sh', output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000) };
      }
    }
    const cli = path.join(path.dirname(HERE).replace(/\/lib$/, ''), 'saut.mjs');
    try {
      const r = await run(process.execPath, [cli, 'lint', root, '--strict'], { env, maxBuffer: 16 * 1024 * 1024, timeout: VALIDATE_TIMEOUT_MS, killSignal: 'SIGKILL' });
      return { ok: true, command: 'saut lint --strict', output: r.stdout.slice(-20000) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, command: 'saut lint --strict', output: ((err.stdout ?? '') + (err.stderr ?? '')).slice(-20000) };
    }
  }

  function newJob() {
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
    // Bench events name scratch and copy directories; the page is not told where anything lives.
    const push = (e: { kind: string; text: string }) => { const x = { kind: e.kind, text: scrub(e.text) }; job.events.push(x); for (const l of job.listeners) l(x); };
    const finish = () => { job.done = true; for (const l of job.listeners) l(null); };
    return { id, job, push, finish };
  }

  // Bench options shared by a single run and a before/after pair; everything from the page
  // is validated here — a model name is a string of model-name characters, nothing else.
  function benchParams(payload: any, harnesses: { id: string; runner: unknown }[]) {
    const wanted: string[] = Array.isArray(payload.harnesses) ? payload.harnesses.map(String) : [];
    const selected = harnesses.filter((h) => h.runner && (!wanted.length || wanted.includes(h.id)));
    const models: Record<string, string> = {};
    if (payload.models && typeof payload.models === 'object')
      for (const [h, m] of Object.entries(payload.models)) if (typeof m === 'string' && /^[A-Za-z0-9._:\/\[\]-]{1,80}$/.test(m.trim()) && selected.some((x) => x.id === h)) models[h] = m.trim();
    const level = Math.min(4, Math.max(1, Math.trunc(Number(payload.level)) || 3)) as 1 | 2 | 3 | 4;
    const runs = Math.max(1, Math.min(5, Number(payload.runs) || 1));
    const maxCostUsd = payload.maxCost === undefined || payload.maxCost === null || payload.maxCost === '' ? null : Number(payload.maxCost);
    const caseFilter = typeof payload.case === 'string' && /^[A-Za-z0-9._*-]{1,80}$/.test(payload.case) ? payload.case : undefined;
    return { selected, models, level, runs, maxCostUsd, caseFilter };
  }

  async function startBench(payload: any): Promise<string> {
    const file = resolveIn(payload.path);
    if (!(await contained(file))) throw new Error('path outside the studio root');
    if (typeof payload.variantText === 'string') return startPair(file, payload);
    const { artifacts, harnesses, taut } = await load([file], opts);
    const a = artifacts[0];
    if (!a) throw new Error('no artifact at that path');
    const p = benchParams(payload, harnesses);
    const { id, job, push, finish } = newJob();
    const siblings = taut ? (await load([taut.packRoot], opts)).artifacts : artifacts;
    const outDir = await newResultsDir(a);
    runBench({
      artifact: a, siblings, harnesses: p.selected as typeof harnesses, taut, level: p.level, runs: p.runs,
      models: Object.keys(p.models).length ? p.models : undefined, meta: typeof payload.label === 'string' && payload.label ? { label: payload.label.slice(0, 60) } : undefined,
      maxCostUsd: p.maxCostUsd, landscape: null, caseFilter: p.caseFilter, outDir, keepScratch: false,
      timeoutMs: 300000, version: 'studio', onEvent: push,
    }).then((result) => { job.result = result; job.runId = path.basename(outDir); push({ kind: 'done', text: relHome(outDir) }); finish(); })
      .catch((e: Error) => { job.error = e.message; push({ kind: 'fail', text: e.message }); finish(); });
    return id;
  }

  const relHome = (p: string) => p.replace(os.homedir(), '~');
  const TMP = [fsSync.realpathSync(os.tmpdir()), os.tmpdir()];
  const scrub = (t: string) => {
    let out = t.split(realRoot).join('<root>').split(root).join('<root>');
    for (const d of TMP) out = out.split(d).join('<tmp>');
    return out.split(os.homedir()).join('~');
  };

  // Before/after: the same cases, the same models, once on the file as saved and once on the
  // unsaved edit — in a throwaway copy, so the project is never touched. Each side is a
  // separate `saut test` process: the TAUT engine keeps process-wide state (the pack it was
  // pointed at), and a copy of the pack must not share it with this server.
  async function startPair(file: string, payload: any): Promise<string> {
    const { artifacts, harnesses, taut } = await load([file], opts);
    const a = artifacts[0];
    if (!a) throw new Error('no artifact at that path');
    const p = benchParams(payload, harnesses);
    const { id, job, push, finish } = newJob();
    const pair = crypto.randomBytes(4).toString('hex');
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-variant-'));
    const skip = (src: string) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src);
    let variant: string;
    if (taut) {
      await fs.cp(taut.packRoot, path.join(tmp, 'pack'), { recursive: true, filter: skip });
      variant = path.join(tmp, 'pack', path.relative(taut.packRoot, a.path));
    } else if (a.kind === 'skill') {
      await fs.cp(a.dir, path.join(tmp, path.basename(a.dir)), { recursive: true, filter: skip });
      variant = path.join(tmp, path.basename(a.dir), 'SKILL.md');
    } else {
      await fs.mkdir(path.join(tmp, 'agents'), { recursive: true });
      variant = path.join(tmp, 'agents', path.basename(a.path));
    }
    await fs.writeFile(variant, payload.variantText);
    const target = (f: string) => (a.kind === 'skill' ? path.dirname(f) : f);
    const cli = path.join(HERE, '..', '..', 'saut.mjs');
    const common = ['--level', String(p.level), '--runs', String(p.runs), '--harness', p.selected.map((h) => h.id).join(','),
      ...(Object.keys(p.models).length ? ['--model', Object.entries(p.models).map(([h, m]) => `${h}=${m}`).join(',')] : []),
      ...(p.maxCostUsd !== null ? ['--max-cost', String(p.maxCostUsd)] : []), ...(p.caseFilter ? ['--case', p.caseFilter] : []),
      ...(taut ? ['--taut', taut.engine, ...(taut.project ? ['--deployment', taut.project.name] : [])] : []), '--pair', pair];
    const side = async (label: 'before' | 'after', f: string) => {
      const outDir = await newResultsDir(a, label);
      push({ kind: 'step', text: `${label}: ${label === 'before' ? 'the file as saved' : 'your unsaved edit (a throwaway copy)'}` });
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, [cli, 'test', target(f), ...common, '--label', label, '--out', outDir], { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
        let buf = '';
        child.stderr.on('data', (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
            const m = line.match(/^(\S+)\s+(.*)$/);
            if (line) push({ kind: m?.[1] ?? 'log', text: `[${label}] ${m?.[2] ?? line}` });
          }
        });
        child.on('close', () => resolve());
      });
      return { outDir, result: JSON.parse(await readText(path.join(outDir, 'matrix.json'))) as BenchResult };
    };
    (async () => {
      try {
        const before = await side('before', a.path);
        const after = await side('after', variant);
        job.result = after.result;
        job.pair = { id: pair, before: path.basename(before.outDir), after: path.basename(after.outDir) };
        push({ kind: 'done', text: `pair ${pair}: ${job.pair.before} → ${job.pair.after}` });
      } catch (e) { job.error = (e as Error).message; push({ kind: 'fail', text: job.error }); }
      finally { await fs.rm(tmp, { recursive: true, force: true }); finish(); }
    })();
    return id;
  }

  // A content scan of the root by whichever scanner is installed; its findings join the
  // passport and the Overview until the next scan (they are not stored anywhere).
  let lastScan: { at: string; ran: string[]; note: string | null; diagnostics: Diagnostic[] } | null = null;
  async function runScan() {
    const { scan } = await import('../scan.mts');
    const { taut } = await load([root], opts);
    const r = await scan(taut ? taut.packRoot : root);
    lastScan = { at: new Date().toISOString(), ran: r.ran, note: r.note, diagnostics: r.diagnostics };
    return { ran: r.ran, note: r.note, findings: r.diagnostics.length };
  }

  // Suppress a finding — or lift a suppression — in saut.json: the nearest one above the
  // artifact when it lies under the root, else <root>/saut.json. Previewed as a diff, applied
  // against the hash of the file as previewed, like every other write.
  async function suppress(payload: any) {
    const abs = resolveIn(payload.path);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const { findConfig, MIN_REASON } = await import('../suppress.mts');
    const near = await findConfig(abs);
    const file = near && (await contained(near)) ? near : path.join(root, 'saut.json');
    const before = (await exists(file)) ? await readText(file) : '';
    let cfg: any = {};
    if (before) { try { cfg = JSON.parse(before); } catch { throw new Error(`${relOf(file)} does not parse — fix it by hand first`); } }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${relOf(file)} is not a JSON object`);
    const list: any[] = Array.isArray(cfg.suppress) ? cfg.suppress : [];
    const rule = String(payload.rule ?? ''), artifact = String(payload.artifact ?? '');
    if (!/^[a-z0-9_-]{2,80}$/.test(rule) || !NAME.test(artifact)) throw new Error('a suppression names a rule and an artifact');
    const match = typeof payload.match === 'string' && payload.match ? payload.match.slice(0, 200) : undefined;
    if (payload.remove) {
      const i = list.findIndex((e) => e?.rule === rule && e?.artifact === artifact && (e?.match ?? undefined) === match);
      if (i < 0) throw new Error('no such suppression');
      list.splice(i, 1);
    } else {
      const reason = String(payload.reason ?? '').trim();
      if (reason.length < MIN_REASON) throw new Error(`a suppression needs a reason — at least ${MIN_REASON} characters on why the finding does not apply here`);
      list.push({ rule, artifact, ...(match ? { match } : {}), reason });
    }
    cfg.suppress = list;
    if (!list.length) delete cfg.suppress;
    const after = JSON.stringify(cfg, null, 2) + '\n';
    const base = hashOf(before);
    if (!payload.apply) return { file: relOf(file), diff: lineDiff(before, after), base };
    if (payload.base !== base) throw new Error('saut.json changed since the preview — review it again');
    await writeContained(file, after, !before);
    return { file: relOf(file), applied: true };
  }

  // An agent's review against the findings and the current guidance: proposals only. Each is
  // checked (its text occurs exactly once), applied in memory, re-linted — what it resolves and
  // what it introduces — and the review is kept outside the project for the record.
  async function review(payload: any) {
    const abs = resolveIn(payload.path);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const base: string = typeof payload.text === 'string' ? payload.text : await readText(abs);
    const pass = await passport(abs, base);
    const { buildReviewPrompt, runReviewer, parseReview, applyChange, DEFAULT_REVIEW_MODEL } = await import('../review.mts');
    const { RULES } = await import('../rules.mts');
    const model = typeof payload.model === 'string' && /^[A-Za-z0-9._:\[\]-]{1,60}$/.test(payload.model.trim()) ? payload.model.trim() : DEFAULT_REVIEW_MODEL;
    const active = pass.findings.filter((f) => !f.suppressed);
    const prompt = buildReviewPrompt({
      name: pass.name, kind: pass.kind as 'skill' | 'agent', file: pass.path, text: base, findings: active,
      guidanceFix: Object.fromEntries(Object.entries(RULES).filter(([, r]) => r.category === 'guidance').map(([id, r]) => [id, r.fix])),
      harnesses: pass.matrix.map((m) => ({ id: m.harness, allowlist: m.allowlist })),
    });
    const { estimateTokens } = await import('../cost.mts');
    if (payload.estimate) return { model, inputTokens: estimateTokens(prompt), findings: active.length };
    const { reply, costUsd } = await runReviewer(prompt, model);
    const parsed = parseReview(reply);
    const key = (f: Diagnostic) => `${f.code}|${f.message}`;
    const before = new Set(active.map(key));
    const changes = [];
    for (const c of parsed.changes) {
      const r = applyChange(base, c);
      if (!r.ok) { changes.push({ ...c, ok: false, reason: r.reason }); continue; }
      const after = (await passport(abs, r.text)).findings.filter((f) => !f.suppressed);
      const afterKeys = new Set(after.map(key));
      changes.push({ ...c, ok: true, diff: lineDiff(base, r.text),
        resolves: [...new Set(active.filter((f) => !afterKeys.has(key(f))).map((f) => f.code))],
        introduces: [...new Set(after.filter((f) => !before.has(key(f))).map((f) => f.code))] });
    }
    const result = { model, costUsd, summary: parsed.summary, changes, keep: parsed.keep, at: new Date().toISOString(), base: hashOf(base) };
    const { artifacts } = await load([abs], opts);
    if (artifacts[0]) {
      const { artifactResultsRoot, runStamp } = await import('../bench/results.mts');
      const dir = path.join(await artifactResultsRoot(artifacts[0]), 'reviews');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${runStamp()}.json`), JSON.stringify({ ...result, file: pass.path }, null, 2) + '\n');
    }
    return result;
  }

  // The cases a bench runs: authored under evals/, else the three generated ones.
  async function cases(file: string) {
    const abs = resolveIn(file);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const { artifacts } = await load([abs], opts);
    const a = artifacts[0];
    if (!a) throw new Error('no artifact at that path');
    const { loadCases } = await import('../bench/cases.mts');
    const list = await loadCases(a);
    return {
      authored: list.some((c) => c.source === 'evals'),
      dir: relOf(evalsDir(a)),
      cases: list.map((c) => ({ name: c.name, source: c.source, invocation: c.invocation, expect: c.expect, prompt: c.prompt, maxTurns: c.maxTurns, file: c.file ? relOf(c.file) : null })),
    };
  }
  const evalsDir = (a: Artifact) => (a.kind === 'skill' ? path.join(a.dir, 'evals') : path.join(path.dirname(a.path), 'evals', a.name));

  // Write one case as <evals>/<name>/prompt.md — the Claude Code plugin-eval layout the bench
  // reads, plus SAUT's `expect` / `invocation` keys.
  async function saveCase(payload: any) {
    const abs = resolveIn(payload.path);
    await writable(abs);
    const { artifacts } = await load([abs], opts);
    const a = artifacts[0];
    if (!a) throw new Error('no artifact at that path');
    const list = Array.isArray(payload.cases) ? payload.cases : [payload];
    const written: string[] = [];
    for (const c of list) {
      const name = String(c.name ?? '');
      if (!NAME.test(name)) throw new Error('a case name is lowercase letters, digits and dashes');
      const invocation = ['explicit', 'implicit', 'control'].includes(c.invocation) ? c.invocation : 'implicit';
      const expect = c.expect === 'no-fire' ? 'no-fire' : 'fire';
      const maxTurns = Math.max(1, Math.min(200, Math.trunc(Number(c.maxTurns)) || 8));
      const file = path.join(evalsDir(a), name, 'prompt.md');
      if (!(await contained(file))) throw new Error('path outside the studio root');
      const text = emitFrontmatter({ name, invocation, expect, max_turns: maxTurns }) + String(c.prompt ?? '').trim() + '\n';
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeContained(file, text, !(await exists(file)));
      written.push(relOf(file));
    }
    return { written, ...(await cases(payload.path)) };
  }

  async function runs(file: string) {
    const abs = resolveIn(file);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const { artifacts } = await load([abs], opts);
    if (!artifacts[0]) throw new Error('no artifact at that path');
    const { listRuns } = await import('../bench/results.mts');
    return { runs: await listRuns(artifacts[0]) };
  }

  async function runDetail(file: string, runId: string) {
    const abs = resolveIn(file);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const { artifacts } = await load([abs], opts);
    if (!artifacts[0]) throw new Error('no artifact at that path');
    const { readRun, summarize } = await import('../bench/results.mts');
    const r = await readRun(artifacts[0], runId);
    return JSON.parse(scrub(JSON.stringify({ summary: summarize(runId, r), result: { ...r, scratch: undefined, artifact: { ...r.artifact, path: relOf(r.artifact.path) } } })));
  }

  // What a bench will cost before it runs: model runs from the cases, and — where this
  // artifact has been benched before — the average spend per run on each harness.
  async function estimate(payload: any) {
    const abs = resolveIn(payload.path);
    if (!(await contained(abs))) throw new Error('path outside the studio root');
    const { artifacts, harnesses } = await load([abs], opts);
    const a = artifacts[0];
    if (!a) throw new Error('no artifact at that path');
    const p = benchParams(payload, harnesses);
    const { loadCases } = await import('../bench/cases.mts');
    const { plannedRuns, listRuns, readRun } = await import('../bench/results.mts');
    const list = await loadCases(a, p.caseFilter);
    const perRun: Record<string, number | null> = {};
    const history = await listRuns(a);
    for (const h of p.selected) {
      perRun[h.id] = null;
      for (const r of history) {
        const row = r.harnesses.find((x) => x.harness === h.id && x.costUsd > 0);
        if (!row) continue;
        const full = await readRun(a, r.id).catch(() => null);
        const traces = full?.reports.find((x) => x.harness === h.id)?.traces.length ?? 0;
        if (traces) { perRun[h.id] = row.costUsd / traces; break; }
      }
    }
    const each = plannedRuns(list, a, 1, p.runs, p.level);
    const pairFactor = payload.pair ? 2 : 1;
    const known = p.selected.filter((h) => perRun[h.id] !== null);
    return {
      cases: list.length, modelRuns: each * p.selected.length * pairFactor,
      perHarness: p.selected.map((h) => ({ harness: h.id, runs: each * pairFactor, costPerRun: perRun[h.id] })),
      estimateUsd: known.length ? known.reduce((n, h) => n + (perRun[h.id] ?? 0) * each * pairFactor, 0) : null,
      unknown: p.selected.filter((h) => perRun[h.id] === null).map((h) => h.id),
      ceiling: p.maxCostUsd,
    };
  }

  const realRoot = await fs.realpath(root).catch(() => root);
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : String(body));
    };
    try {
      if (!hostOk(req.headers.host)) return send(403, { error: 'bad host' });
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/') {
        // A mutating loopback UI must not be frameable: the token lives INSIDE the page, so
        // CSRF headers do not protect against a foreign page iframing it and stealing clicks.
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
          'content-security-policy': CSP,
          'referrer-policy': 'no-referrer',
        });
        return res.end(renderPage(token));
      }
      if (req.method === 'GET' && Object.hasOwn(ASSETS, pathname)) {
        const asset = ASSETS[pathname];
        const body = await fs.readFile(path.join(HERE, asset.file)).catch(() => null);
        if (!body) return send(404, { error: 'not found' });
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
        return res.end(body);
      }
      // READS carry content (artifact bodies, pack layout) — the same-origin policy stops a
      // foreign PAGE, not another local process scanning loopback ports. Every /api route
      // requires the token; the page has it, nothing else does.
      if (pathname.startsWith('/api/') && !pathname.startsWith('/api/test/')
        && !tokenOk(req.headers['x-saut-token'] ?? url.searchParams.get('token'), token))
        return send(403, { error: 'bad or missing token' });
      if (req.method === 'GET' && pathname === '/api/context') return send(200, await context());
      if (req.method === 'GET' && pathname === '/api/overview') return send(200, await overview());
      if (req.method === 'GET' && (pathname === '/api/cases' || pathname === '/api/runs' || pathname === '/api/run')) {
        const p = url.searchParams.get('path') ?? '';
        try {
          if (pathname === '/api/cases') return send(200, await cases(p));
          if (pathname === '/api/runs') return send(200, await runs(p));
          return send(200, await runDetail(p, url.searchParams.get('id') ?? ''));
        } catch (e) { return send(400, { error: (e as Error).message }); }
      }
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
          else { res.write(`event: end\ndata: ${scrub(JSON.stringify({ result: job.result ? { ...job.result, scratch: undefined } : null, runId: job.runId ?? null, pair: job.pair ?? null, error: job.error ?? null }))}\n\n`); res.end(); }
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
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 4 * 1024 * 1024) { req.destroy(); return send(413, { error: 'request body too large' }); }
          chunks.push(chunk as Buffer);
        }
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          let payload: any;
          try { payload = raw ? JSON.parse(raw) : {}; }
          catch (e) { return send(400, { error: `malformed JSON body: ${(e as Error).message}` }); }
          if (pathname === '/api/emit') return send(200, { text: emitFrontmatter(payload.frontmatter ?? {}) });
          if (pathname === '/api/save') { const r = await save(payload); return send(200, { ...r, path: relOf(r.path), passport: await passport(r.path) }); }
          if (pathname === '/api/compose') return send(200, await composeEdit(payload));
          if (pathname === '/api/check') {
            const e = await editedText(payload);
            if ('reason' in e) return send(200, { composeError: e.reason });
            return send(200, await passport(e.file, e.text));
          }
          if (pathname === '/api/fix') return send(200, await fix(payload));
          if (pathname === '/api/test') return send(200, { id: await startBench(payload) });
          if (pathname === '/api/case') return send(200, await saveCase(payload));
          if (pathname === '/api/suppress') return send(200, await suppress(payload));
          if (pathname === '/api/review') {
            if (payload.estimate) return send(200, await review(payload));
            if (busy) return send(409, { error: 'another action is still running' });
            busy = true;
            try { return send(200, await review(payload)); } finally { busy = false; }
          }
          if (pathname === '/api/scan') {
            if (busy) return send(409, { error: 'another action is still running' });
            busy = true;
            try { return send(200, await runScan()); } finally { busy = false; }
          }
          if (pathname === '/api/estimate') return send(200, await estimate(payload));
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
