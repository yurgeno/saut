// The test bench, offline: fake harness binaries on PATH emit canned event streams, so the
// runners' parsers, the obedience comparison and the orchestrator are exercised
// deterministically and for free. Live runs are exercised by hand (see docs/BENCH.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBench } from '../lib/bench/bench.mts';
import { autoCases, loadCases } from '../lib/bench/cases.mts';
import { allowed, obedience } from '../lib/bench/obedience.mts';
import { neutralName, renderPrompt } from '../lib/bench/runners.mts';
import { loadHarnesses } from '../lib/caps.mts';
import { discover, parseToolRef } from '../lib/skill.mts';
import { PACK, REPO } from './helpers.mjs';

const harnesses = [...(await loadHarnesses()).values()];
const runnable = harnesses.filter((h) => h.runner);
const [skill] = await discover([path.join(PACK, 'skills', 'fx-clean')]);

// A bin dir whose `claude` / `codex` / `opencode` are the fake harness.
async function fakeBin(script, target = 'fx-clean') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-bin-'));
  for (const name of ['claude', 'codex', 'opencode']) {
    const kind = name === 'claude' ? 'claude-code' : name;
    await fs.writeFile(path.join(dir, name), `#!/bin/sh\nSAUT_FAKE=${kind} SAUT_FAKE_SCRIPT=${script} SAUT_FAKE_SKILL=${target} exec node "${path.join(REPO, 'test', 'fixtures', 'fake-harness.mjs')}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

async function bench(script, over = {}) {
  const bin = await fakeBin(script);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-out-'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    return await runBench({
      artifact: skill, siblings: [], harnesses: runnable, taut: null, level: 3, runs: 1,
      maxCostUsd: null, landscape: null, outDir: out, keepScratch: false, timeoutMs: 30000, version: 'test', ...over,
    });
  } finally { process.env.PATH = oldPath; await fs.rm(bin, { recursive: true, force: true }); }
}

test('cases: generated explicit/implicit/control, and authored evals/**/prompt.md win', async () => {
  const auto = autoCases(skill);
  assert.deepEqual(auto.map((c) => c.name), ['explicit', 'implicit', 'control']);
  assert.deepEqual(auto.map((c) => c.expect), ['fire', 'fire', 'no-fire']);
  assert.ok(!auto[1].prompt.includes('Invoke:'), 'the invocation sentence is stripped from the implicit task');
  const dir = path.join(skill.dir, 'evals', 'c1');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'prompt.md'), '---\nname: authored\nexpect: fire\ninvocation: implicit\nmax_turns: 3\n---\nDo the thing.\n');
  try {
    const cases = await loadCases(skill);
    assert.deepEqual(cases.map((c) => c.name), ['authored']);
    assert.equal(cases[0].maxTurns, 3);
    assert.equal(cases[0].prompt, 'Do the thing.');
    assert.deepEqual((await loadCases(skill, 'nope*')).map((c) => c.name), []);
  } finally { await fs.rm(path.join(skill.dir, 'evals'), { recursive: true, force: true }); }
});

test('prompt rendering: explicit invocation uses each harness syntax', () => {
  const c = autoCases(skill)[0];
  assert.equal(renderPrompt(harnesses.find((h) => h.id === 'claude-code'), skill, c).split(' ')[0], '/fx-clean');
  assert.equal(renderPrompt(harnesses.find((h) => h.id === 'codex'), skill, c).split(' ')[0], '$fx-clean');
  assert.match(renderPrompt(harnesses.find((h) => h.id === 'opencode'), skill, c), /Use the fx-clean skill/);
});

test('tool-name mapping and scoped-rule matching (Claude Code semantics)', () => {
  assert.equal(neutralName('shell'), 'Bash');
  assert.equal(neutralName('apply_patch'), 'Edit');
  assert.equal(neutralName('mcp__docs__lookup'), 'mcp__docs__lookup');
  const list = [parseToolRef('Bash(git status *)'), parseToolRef('Bash(npm run *)'), parseToolRef('Read'), parseToolRef('mcp__docs__*')];
  const B = (digest) => ({ neutral: 'Bash', digest });
  assert.ok(allowed(B('git status'), list), 'trailing * matches the bare command');
  assert.ok(allowed(B('git status --short'), list));
  assert.ok(!allowed(B('git push'), list));
  assert.ok(allowed(B('git status && npm run build'), list), 'every part of a compound command matches');
  assert.ok(!allowed(B('git status && rm -rf /'), list), 'one unmatched part fails the whole command');
  assert.ok(allowed({ neutral: 'Read', digest: '/x' }, list));
  assert.ok(allowed({ neutral: 'mcp__docs__lookup', digest: '' }, list));
  assert.ok(!allowed({ neutral: 'mcp__kb__read', digest: '' }, list));
});

test('L1 only: the artifact lands in every harness discovery dir, no runs, no cost', async () => {
  const r = await bench('fire', { level: 1 });
  assert.ok(r.compiled.ok);
  assert.match(r.compiled.detail, /\.claude\/skills\/fx-clean/);
  assert.match(r.compiled.detail, /\.agents\/skills\/fx-clean/);
  assert.ok(r.reports.every((rep) => rep.traces.length === 0));
  assert.equal(r.budget.spentUsd, 0);
});

test('L3 fire: trigger 100%, control clean, obedience inside the allowlist, matrix.json written', async () => {
  const bin = await fakeBin('fire');
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-out-'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  let r;
  try {
    r = await runBench({ artifact: skill, siblings: [], harnesses: runnable, taut: null, level: 3, runs: 1, maxCostUsd: null, landscape: null, outDir: out, keepScratch: false, timeoutMs: 30000, version: 'test' });
  } finally { process.env.PATH = oldPath; await fs.rm(bin, { recursive: true, force: true }); }
  const cc = r.reports.find((x) => x.harness === 'claude-code');
  assert.equal(cc.trigger.fireRate, 1);
  assert.equal(cc.trigger.controlClean, true);
  assert.deepEqual(cc.obedience.violations, []);
  assert.equal(cc.obedience.enforcement, 'grant');
  assert.ok(cc.costUsd > 0);
  assert.equal(r.reports.find((x) => x.harness === 'codex').trigger.fireRate, 1, 'codex: reading the SKILL.md counts as fired');
  const saved = JSON.parse(await fs.readFile(path.join(out, 'matrix.json'), 'utf8'));
  assert.equal(saved.artifact.name, 'fx-clean');
  assert.ok(saved.reports.every((rep) => rep.traces.every((t) => t.rawFile)), 'every trace keeps its raw event stream');
  await fs.rm(out, { recursive: true, force: true });
});

test('L3 violate: a shell call outside the allowlist is reported per harness', async () => {
  const r = await bench('violate');
  for (const id of ['claude-code', 'codex', 'opencode']) {
    const rep = r.reports.find((x) => x.harness === id);
    assert.ok(rep.obedience.violations.some((v) => v.includes('rm -rf')), `${id} reports the violation`);
  }
  assert.equal(r.reports.find((x) => x.harness === 'codex').obedience.enforcement, 'prose', 'codex: the allowlist is not enforced — the violation is the degradation, measured');
});

test('L3 denied: a refused call is denial, not violation', async () => {
  const r = await bench('denied');
  const cc = r.reports.find((x) => x.harness === 'claude-code');
  assert.ok(cc.obedience.denied.some((d) => d.includes('curl')));
  assert.ok(!cc.obedience.violations.some((v) => v.includes('curl')));
});

test('an implicit case against a model-invocable skill: lostTo names the winner', async () => {
  const [invocable] = await discover([path.join(PACK, 'skills', 'fx-writer-auto')]);
  const bin = await fakeBin('lost', 'fx-writer-auto');
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-out-'));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  let r;
  try {
    r = await runBench({ artifact: invocable, siblings: [], harnesses: runnable, taut: null, level: 2, runs: 1, maxCostUsd: null, landscape: null, caseFilter: 'implicit', outDir: out, keepScratch: false, timeoutMs: 30000, version: 'test' });
  } finally { process.env.PATH = oldPath; await fs.rm(bin, { recursive: true, force: true }); await fs.rm(out, { recursive: true, force: true }); }
  const cc = r.reports.find((x) => x.harness === 'claude-code');
  assert.equal(cc.trigger.fireRate, 0);
  assert.deepEqual(cc.trigger.lostTo, ['other-a']);
  assert.equal(cc.traces[0].competing, 2, 'the competing-skills caveat is recorded');
  assert.equal(cc.obedience, null, 'L2 stops before obedience');
});

test('an implicit case is SKIPPED, not paid for, when the skill forbids model invocation', async () => {
  const r = await bench('fire', { level: 2, caseFilter: 'implicit' });   // fx-clean: disable-model-invocation
  for (const rep of r.reports.filter((x) => x.available)) {
    assert.deepEqual(rep.traces, [], 'nothing ran');
    assert.equal(rep.skipped.length, 1);
    assert.match(rep.skipped[0].why, /disable-model-invocation/);
  }
  assert.equal(r.budget.spentUsd, 0, 'an unwinnable case costs nothing');
});

test('an unavailable provider is a reported row, never a crash; budget stops the run', async () => {
  const r = await bench('unavailable');
  const oc = r.reports.find((x) => x.harness === 'opencode');
  assert.equal(oc.available, false);
  assert.match(oc.reason, /Cannot connect/);
  const b = await bench('fire', { maxCostUsd: 0.001 });
  assert.equal(b.budget.exhausted, true);
  assert.ok(b.reports.find((x) => x.harness === 'claude-code').traces.length < 3);
});
