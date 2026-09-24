// S2: the workbench — overview, live re-lint of unsaved text, form edits composed onto the file
// text, and a compiled workspace shown read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startStudio } from '../lib/studio/server.mts';
import { gatedLineMap } from '../lib/adapters/taut.mts';
import { toFileLines } from '../lib/skill.mts';
import { PACK } from './helpers.mjs';

async function studioOn(root) {
  const s = await startStudio(root, { _: [] });
  const base = `http://127.0.0.1:${s.port}`;
  const get = (p) => fetch(base + p, { headers: { 'x-saut-token': s.token } }).then((r) => r.json());
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-saut-token': s.token }, body: JSON.stringify(body) });
  return { s, get, post };
}

let root, st;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-wb-'));
  await fs.cp(PACK, root, { recursive: true });
  st = await studioOn(root);
});
test.after(async () => { await st.s.close(); await fs.rm(root, { recursive: true, force: true }); });

test('overview: one row per artifact with the counts a reader sorts by', async () => {
  const o = await st.get('/api/overview');
  const ctx = await st.get('/api/context');
  assert.equal(o.rows.length, ctx.artifacts.length);
  const dead = o.rows.find((r) => r.name === 'fx-dead');
  assert.ok(dead.fixable > 0 && dead.medium > 0);
  assert.ok(dead.alwaysOn > 0 && dead.invoke > 0);
  assert.equal(dead.enforcement['claude-code'], 'grant');
  assert.ok(!path.isAbsolute(dead.path));
  assert.equal(o.totals.artifacts, o.rows.length);
  assert.equal(o.totals.high, o.rows.reduce((n, r) => n + r.high, 0));
});

test('live check: an unsaved text is linted in memory, nothing is written', async () => {
  const file = path.join(root, 'skills', 'fx-dead', 'SKILL.md');
  const disk = await fs.readFile(file, 'utf8');
  const text = disk.replace('WebFetch, ', '');
  const r = await (await st.post('/api/check', { path: 'skills/fx-dead/SKILL.md', text })).json();
  assert.ok(!r.findings.some((f) => f.code === 'dead-privilege' && /WebFetch/.test(f.message)), 'the unsaved edit is what was linted');
  assert.equal(r.text, text);
  assert.equal(await fs.readFile(file, 'utf8'), disk, 'nothing written');
  const viaForm = await (await st.post('/api/check', { path: 'skills/fx-dead/SKILL.md', kind: 'skill', form: { tools: ['Read', 'mcp__docs__lookup', 'mcp__docs__query'] }, body: disk.slice(disk.indexOf('\n---\n') + 5) })).json();
  assert.ok(!viaForm.findings.some((f) => /WebFetch/.test(f.message)), 'a form edit is composed, then linted');
});

test('compose: a form edit on a branched skill keeps the branches; a branched field is refused', async () => {
  const rel = 'skills/fx-branches/SKILL.md';
  const disk = await fs.readFile(path.join(root, rel), 'utf8');
  const body = disk.split('\n').slice(disk.split('\n').findIndex((l, i) => i > 0 && l === '---') + 1).join('\n');
  const flag = await (await st.post('/api/compose', { path: rel, kind: 'skill', form: { 'disable-model-invocation': false }, body })).json();
  assert.equal(flag.ok, true);
  assert.deepEqual(flag.changed, ['disable-model-invocation']);
  assert.deepEqual(flag.diff.split('\n').filter((l) => /^[-+]/.test(l)).map((l) => l.replace(/^([-+])\s+\d+\s+/, '$1')), ['-disable-model-invocation: true', '+disable-model-invocation: false']);
  for (const marker of ['# docs:on', '# docs:off', '# docs:end']) assert.ok(flag.text.includes(marker));
  const desc = await (await st.post('/api/compose', { path: rel, kind: 'skill', form: { description: 'one for both' }, body })).json();
  assert.equal(desc.ok, false);
  assert.match(desc.reason, /differs by capability branch/);
});

test('a compiled workspace: copies collapse, files are read-only, the source is named', async () => {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-ws-'));
  const skill = '---\nname: w\ndescription: A compiled skill. Invoke: w.\ndisable-model-invocation: true\nallowed-tools: [Read, WebFetch]\n---\n# w\nRead the files.\n';
  for (const d of ['.claude/skills/w', '.agents/skills/w']) { await fs.mkdir(path.join(ws, d), { recursive: true }); await fs.writeFile(path.join(ws, d, 'SKILL.md'), skill); }
  await fs.writeFile(path.join(ws, 'taut.lock'), JSON.stringify({ lockVersion: 3, data: { pack: 'my-pack', commit: 'abcdef1234567' }, artifacts: [
    { id: '.claude/skills/w/SKILL.md', source: 'proj/skills/w/SKILL.md' }, { id: '.agents/skills/w/SKILL.md', source: 'proj/skills/w/SKILL.md' }] }));
  const w = await studioOn(ws);
  try {
    const ctx = await w.get('/api/context');
    assert.equal(ctx.mode, 'compiled');
    assert.deepEqual(ctx.artifacts.map((a) => a.compiled.harness).sort(), ['claude-code', 'codex']);
    const o = await w.get('/api/overview');
    assert.equal(o.rows.length, 1, 'one skill, not one row per harness copy');
    assert.deepEqual(o.rows[0].copies.map((c) => c.harness).sort(), ['claude-code', 'codex']);
    const pass = await w.get('/api/artifact?path=' + encodeURIComponent('.claude/skills/w/SKILL.md'));
    assert.match(pass.readOnly, /compiled from my-pack: proj\/skills\/w\/SKILL\.md @abcdef1/);
    const save = await w.post('/api/save', { path: '.claude/skills/w/SKILL.md', text: skill.replace('Read the files.', 'x'), base: pass.base });
    assert.equal(save.status, 400);
    assert.match((await save.json()).error, /read-only: compiled from my-pack/);
    const f = pass.findings.find((x) => x.autofix);
    const fix = await w.post('/api/fix', { path: '.claude/skills/w/SKILL.md', autofix: f.autofix, base: pass.base, apply: true });
    assert.equal(fix.status, 400);
    assert.equal(await fs.readFile(path.join(ws, '.claude/skills/w/SKILL.md'), 'utf8'), skill, 'the sealed file is untouched');
  } finally { await w.s.close(); await fs.rm(ws, { recursive: true, force: true }); }
});

test('engine-gated line numbers are reported as file lines', () => {
  const raw = ['---', 'name: x', '# docs:on', 'description: on', '# docs:off', 'description: off', '# docs:end', 'model: opus', '---', 'body one', '# docs:on', 'only on', '# docs:end', 'body two'].join('\n');
  const gated = ['---', 'name: x', 'description: on', 'model: opus', '---', 'body one', 'only on', 'body two'].join('\n');
  const map = gatedLineMap(raw, gated);
  assert.equal(map[3], 4, 'the ON description');
  assert.equal(map[4], 8, 'model');
  assert.equal(map[8], 14, 'the last body line');
  const a = { fm: { lineMap: map } };
  assert.deepEqual(toFileLines([{ code: 'x', line: 4 }, { code: 'y' }], a).map((d) => d.line), [8, undefined]);
  assert.deepEqual(toFileLines([{ code: 'x', line: 4 }], { fm: {} }).map((d) => d.line), [4], 'an ungated artifact is left alone');
});
