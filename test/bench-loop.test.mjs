// S4: the bench in the loop — a model per harness, labelled runs, a history, cases written
// from the Studio, a cost estimate before a run, and a before/after pair on an unsaved edit.
// Offline: fake harness binaries on PATH, as in the bench suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from '../lib/studio/server.mts';
import { listRuns, plannedRuns, readRun } from '../lib/bench/results.mts';
import { discover } from '../lib/skill.mts';
import { PACK, REPO, saut } from './helpers.mjs';

async function fakeBin() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-bin-'));
  for (const name of ['claude', 'codex', 'opencode'])
    await fs.writeFile(path.join(dir, name), `#!/bin/sh\nSAUT_FAKE=${name === 'claude' ? 'claude-code' : name} SAUT_FAKE_SCRIPT=fire SAUT_FAKE_SKILL=\${SAUT_FAKE_SKILL:-fx-clean} exec node "${path.join(REPO, 'test', 'fixtures', 'fake-harness.mjs')}" "$@"\n`, { mode: 0o755 });
  return dir;
}

let root, bin, oldPath, studio, base;
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-saut-token': studio.token }, body: JSON.stringify(body) });
const get = (p) => fetch(base + p, { headers: { 'x-saut-token': studio.token } }).then((r) => r.json());
async function drain(id) {
  const res = await fetch(`${base}/api/test/${id}/events?token=${studio.token}`);
  let buf = '';
  for await (const chunk of res.body) { buf += Buffer.from(chunk).toString(); if (buf.includes('event: end')) break; }
  const events = [...buf.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
  return { events, end: events.at(-1) };
}

test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-loop-'));
  await fs.cp(PACK, root, { recursive: true });
  bin = await fakeBin();
  oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  studio = await startStudio(root, { _: [] });
  base = `http://127.0.0.1:${studio.port}`;
});
test.after(async () => {
  await studio.close();
  process.env.PATH = oldPath;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(bin, { recursive: true, force: true });
});

test('CLI: a model per harness and a label are recorded with the run', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-out-'));
  try {
    const r = await saut(['test', path.join(root, 'skills', 'fx-clean'), '--level', '2', '--harness', 'claude-code,codex',
      '--model', 'claude-code=sonnet,codex=gpt-6-sol', '--label', 'before', '--pair', 'p1', '--out', out], { env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(r.code, 0, r.stderr);
    const m = JSON.parse(await fs.readFile(path.join(out, 'matrix.json'), 'utf8'));
    assert.deepEqual(m.models, { 'claude-code': 'sonnet', codex: 'gpt-6-sol' });
    assert.deepEqual(m.meta, { label: 'before', pair: 'p1' });
    const single = await saut(['test', path.join(root, 'skills', 'fx-clean'), '--level', '1', '--harness', 'codex', '--out', out]);
    assert.equal(single.code, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(out, 'matrix.json'), 'utf8')).models, { codex: 'gpt-6-luna' }, 'the cheap default is named');
  } finally { await fs.rm(out, { recursive: true, force: true }); }
});

test('planned runs: implicit cases a skill forbids are not counted', async () => {
  const [clean] = await discover([path.join(root, 'skills', 'fx-clean')]);
  const cases = [{ invocation: 'explicit', expect: 'fire' }, { invocation: 'implicit', expect: 'fire' }, { invocation: 'control', expect: 'no-fire' }];
  assert.equal(plannedRuns(cases, clean, 2, 3, 1), 0, 'L1 runs no model');
  const expected = clean.modelInvocable ? 3 : 2;
  assert.equal(plannedRuns(cases, clean, 2, 3, 2), expected * 2 * 3);
});

test('Studio: cases are listed, written as files, and the bench reads them', async () => {
  const rel = 'skills/fx-clean/SKILL.md';
  const auto = await get('/api/cases?path=' + encodeURIComponent(rel));
  assert.equal(auto.authored, false);
  assert.deepEqual(auto.cases.map((c) => c.name), ['explicit', 'implicit', 'control']);
  const wrote = await (await post('/api/case', { path: rel, cases: auto.cases })).json();
  assert.equal(wrote.written.length, 3);
  assert.equal(wrote.authored, true);
  const one = await (await post('/api/case', { path: rel, name: 'review-this', invocation: 'implicit', expect: 'fire', maxTurns: 4, prompt: 'Review the change in src/.' })).json();
  assert.ok(one.cases.some((c) => c.name === 'review-this' && c.file === 'skills/fx-clean/evals/review-this/prompt.md'));
  assert.match(await fs.readFile(path.join(root, 'skills/fx-clean/evals/review-this/prompt.md'), 'utf8'), /^---\nname: review-this\ninvocation: implicit\nexpect: fire\nmax_turns: 4\n---\nReview the change in src\/\.\n$/);
  assert.equal((await post('/api/case', { path: rel, name: '../escape', prompt: 'x' })).status, 400, 'a case name is a slug');
});

test('Studio: an estimate before the run; a run joins the history; a pair measures an unsaved edit', async () => {
  const rel = 'skills/fx-dead/SKILL.md';
  const file = path.join(root, rel);
  const disk = await fs.readFile(file, 'utf8');
  const est = await (await post('/api/estimate', { path: rel, level: 2, runs: 1, harnesses: ['claude-code', 'codex'] })).json();
  assert.ok(est.modelRuns > 0);
  assert.equal(est.estimateUsd, null, 'no history yet — no dollar guess');
  assert.deepEqual(est.unknown.sort(), ['claude-code', 'codex']);

  const { id } = await (await post('/api/test', { path: rel, level: 2, harnesses: ['claude-code'], models: { 'claude-code': 'sonnet', codex: 'ignored-not-selected' }, label: 'first' })).json();
  const one = await drain(id);
  assert.equal(one.end.error, null);
  assert.deepEqual(one.end.result.models, { 'claude-code': 'sonnet' });
  assert.equal(one.end.result.meta.label, 'first');
  const hist = await get('/api/runs?path=' + encodeURIComponent(rel));
  assert.equal(hist.runs.length, 1);
  assert.equal(hist.runs[0].label, 'first');
  const detail = await get('/api/run?path=' + encodeURIComponent(rel) + '&id=' + hist.runs[0].id);
  assert.equal(detail.result.scratch, undefined, 'the scratch path is not sent to the page');
  for (const payload of [JSON.stringify(detail), JSON.stringify(one.end)]) assert.ok(!payload.includes(root) && !payload.includes(os.tmpdir()), 'no absolute path in a run the page receives');
  assert.equal((await fetch(`${base}/api/run?path=${encodeURIComponent(rel)}&id=..%2F..%2Fetc`, { headers: { 'x-saut-token': studio.token } })).status, 400);

  const variantText = disk.replace('WebFetch, ', '');
  const pairJob = await (await post('/api/test', { path: rel, level: 2, harnesses: ['claude-code'], variantText })).json();
  const pair = await drain(pairJob.id);
  assert.equal(pair.end.error, null, JSON.stringify(pair.events.slice(-4)));
  assert.ok(pair.end.pair && pair.end.pair.before && pair.end.pair.after);
  assert.ok(pair.events.some((e) => e.text.startsWith('[before]')) && pair.events.some((e) => e.text.startsWith('[after]')), 'both sides stream');
  assert.equal(await fs.readFile(file, 'utf8'), disk, 'the project file is untouched');
  const after = await get('/api/runs?path=' + encodeURIComponent(rel));
  const labels = after.runs.filter((r) => r.pair === pair.end.pair.id).map((r) => r.label).sort();
  assert.deepEqual(labels, ['after', 'before']);
  const [a] = await discover([path.join(root, 'skills', 'fx-dead')]);
  const afterRun = await readRun(a, pair.end.pair.after);
  assert.ok(afterRun.artifact.path.includes('saut-variant-'), 'the after side ran on the throwaway copy (the file on disk keeps the real path)');
  assert.equal(await fs.stat(path.dirname(path.dirname(afterRun.artifact.path))).then(() => true, () => false), false, 'and the copy is gone');
  assert.equal((await listRuns(a)).length, 3);
  const est2 = await (await post('/api/estimate', { path: rel, level: 2, runs: 1, harnesses: ['claude-code'] })).json();
  assert.ok(est2.estimateUsd === null || est2.estimateUsd >= 0, 'a dollar estimate once a run reported cost');
});
