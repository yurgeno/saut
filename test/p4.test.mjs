// P4 surfaces beyond the graders: the rented content scanner, the usage column from a
// compiled workspace's telemetry, and the pack-level role-collision rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCANNERS, detectScanners, scan } from '../lib/scan.mts';
import { readUsage, usageFor } from '../lib/usage.mts';
import { runCost, runLint } from '../lib/commands.mts';
import { findEngine } from '../lib/adapters/taut.mts';
import { PACK } from './helpers.mjs';

// ---- scanner (rented) --------------------------------------------------------------------
test('no scanner installed: a plain note, never a fabricated clean bill', async () => {
  const withoutPath = { ...process.env };
  const old = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    assert.deepEqual(await detectScanners(), []);
    const r = await scan('/tmp');
    assert.deepEqual(r.diagnostics, []);
    assert.deepEqual(r.ran, []);
    assert.match(r.note, /no content scanner installed/);
    for (const s of SCANNERS) assert.ok(r.note.includes(s.home), `${s.id} is named with its home`);
  } finally { process.env.PATH = old; void withoutPath; }
});

test('an installed scanner is run and its findings join the lint stream', async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-scan-'));
  // a fake skillspector that exits 1 WITH findings — scanners signal detections that way
  await fs.writeFile(path.join(bin, 'skillspector'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({
    findings: [{ id: 'PROMPT_INJECTION', severity: 'critical', message: 'instruction override phrase', file: 'skills/x/SKILL.md', line: 12 },
      { id: 'net-exfil', severity: 'low', title: 'outbound URL' }],
  })}\nEOF\nexit 1\n`, { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${old}`;
  try {
    const r = await scan(PACK);
    assert.deepEqual(r.ran, ['skillspector']);
    assert.equal(r.note, null);
    const crit = r.diagnostics.find((d) => d.code === 'scan-prompt_injection');
    assert.equal(crit.severity, 'high', 'critical maps to high');
    assert.equal(crit.line, 12);
    assert.match(crit.message, /\[skillspector\]$/);
    assert.equal(r.diagnostics.find((d) => d.code === 'scan-net-exfil').severity, 'low');
    // and through the lint verb
    const lint = await runLint([PACK], { _: [], scan: true, noTaut: true });
    assert.deepEqual(lint.scanners, ['skillspector']);
    assert.ok(lint.diagnostics.some((d) => d.code === 'scan-prompt_injection'));
  } finally { process.env.PATH = old; await fs.rm(bin, { recursive: true, force: true }); }
});

// ---- usage (local telemetry) --------------------------------------------------------------
test('usage: invoke events are counted per artifact; nothing else is read', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-ws-'));
  const dir = path.join(ws, 'memory', 'telemetry');
  await fs.mkdir(dir, { recursive: true });
  const rows = [
    { event: 'meta', v: 1, level: 'extended' },
    { ts: '2026-09-01T10:00:00Z', event: 'session_start', harness: 'claude-code' },
    { ts: '2026-09-01T10:01:00Z', event: 'invoke', kind: 'skill', name: 'fx-clean', decision: 'allow' },
    { ts: '2026-09-02T10:02:00Z', event: 'invoke', kind: 'skill', name: 'fx-clean', decision: 'allow' },
    { ts: '2026-09-02T10:03:00Z', event: 'invoke', kind: 'skill', name: 'fx-clean', decision: 'deny', cause: 'drift' },
    { ts: '2026-09-02T10:04:00Z', event: 'invoke', kind: 'agent', name: 'fx-agent', decision: 'allow' },
  ];
  await fs.writeFile(path.join(dir, '2026-09-01.jsonl'), rows.slice(0, 3).map((r) => JSON.stringify(r)).join('\n') + '\n');
  await fs.writeFile(path.join(dir, '2026-09-02.jsonl'), rows.slice(3).map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    const u = await readUsage(ws);
    assert.equal(u.days, 2);
    assert.equal(u.from, '2026-09-01');
    assert.equal(u.to, '2026-09-02');
    assert.deepEqual(usageFor(u, 'fx-clean'), { name: 'fx-clean', kind: 'skill', allow: 2, deny: 1 });
    assert.deepEqual(usageFor(u, 'fx-agent'), { name: 'fx-agent', kind: 'agent', allow: 1, deny: 0 });
    assert.equal(usageFor(u, 'never-invoked'), null);
    const win = await readUsage(ws, { since: '2026-09-02' });
    assert.equal(usageFor(win, 'fx-clean').allow, 1, 'the window filters by day');
    assert.equal(await readUsage(path.join(ws, 'nope')), null, 'no telemetry is null, not an error');
    // through the cost verb
    const { usage, lines } = await runCost([PACK], { _: [], workspace: ws, noTaut: true });
    assert.equal(usage.rows.size, 2);
    assert.ok(lines.length > 0);
  } finally { await fs.rm(ws, { recursive: true, force: true }); }
});

// ---- role collision (TAUT, pack level) ------------------------------------------------------
const engine = await findEngine(process.env.SAUT_TAUT_ENGINE ?? null);
test('two skills claiming the same metadata.taut.role collide (the engine resolves one)', { skip: engine ? false : 'no TAUT engine reachable' }, async () => {
  const enginePack = path.join(engine, 'test', 'fixtures', 'pack');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-role-'));
  await fs.cp(enginePack, tmp, { recursive: true });
  await fs.mkdir(path.join(tmp, 'skills', 'fx-rival'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'skills', 'fx-rival', 'SKILL.md'), `---
name: fx-rival
description: A second claimant of the init role. Invoke: fx-rival.
disable-model-invocation: true
allowed-tools: [Read]
metadata:
  taut:
    role: init
---
# fx-rival
Read only.
`);
  try {
    const { diagnostics } = await runLint([path.join(tmp, 'skills', 'fx-rival')], { _: [], taut: engine, deployment: 'fxdep' });
    const hit = diagnostics.find((d) => d.code === 'taut-role-collision');
    assert.ok(hit, 'the collision is reported');
    assert.equal(hit.severity, 'high');
    assert.match(hit.message, /also declared by fx-onboard|also declared by/);
    // the incumbent alone is clean
    const solo = await runLint([path.join(enginePack, 'skills')], { _: [], taut: engine, deployment: 'fxdep' });
    assert.ok(!solo.diagnostics.some((d) => d.code === 'taut-role-collision'), 'one claimant per role is fine');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
