// Inputs that must not crash, hang, escape a root, or read a file they were not pointed at.
// Every case here is a defect that was reproduced before it was fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.mts';
import { referencedFiles } from '../lib/cost.mts';
import { within } from '../lib/bench/graders.mts';
import { discoverDetailed } from '../lib/skill.mts';
import { runLint } from '../lib/commands.mts';
import { readCatalog } from '../lib/tools.mts';
import { walk } from '../lib/util.mts';
import { PACK, saut } from './helpers.mjs';

test('dangerous frontmatter keys are data, not prototype writes', async () => {
  const fm = parseFrontmatter('---\nname: p\n__proto__: x\nconstructor: y\nprototype: z\n---\nbody\n', 'p.md');
  assert.deepEqual(fm.diagnostics, []);
  assert.equal(fm.data.name, 'p');
  assert.equal(fm.data.__proto__, 'x', 'read back as an ordinary key');
  assert.equal(({}).polluted, undefined, 'nothing leaked onto Object.prototype');
  assert.equal(Object.getPrototypeOf(fm.data), Object.prototype, 'the parsed map has a normal prototype');
  // and end to end: the fixture lints instead of throwing
  const r = await saut(['lint', path.join(PACK, 'skills', 'fx-proto')]);
  assert.notEqual(r.code, 2, `crashed: ${r.stderr.slice(0, 200)}`);
  assert.match(r.stdout, /skill fx-proto/);
});

test('a referenced path may not leave the artifact directory, by any spelling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-adv-'));
  try {
    await fs.mkdir(path.join(root, 'skills', 'x'), { recursive: true });
    await fs.mkdir(path.join(root, 'skills', 'x-secrets'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'x-secrets', 'creds.json'), '{"token":"SECRET"}');
    await fs.mkdir(path.join(root, 'skills', 'x', 'refs'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'x', 'refs', 'ok.md'), 'legitimate');
    await fs.writeFile(path.join(root, 'skills', 'x', 'SKILL.md'), `---
name: x
description: 'Reads its references. Invoke: x.'
disable-model-invocation: true
allowed-tools: [Read]
---
Read refs/ok.md, then a/../../x-secrets/creds.json and ../x-secrets/creds.json.
`);
    const { artifacts } = await discoverDetailed([path.join(root, 'skills', 'x')]);
    const refs = await referencedFiles(artifacts[0]);
    assert.deepEqual(refs.map((f) => path.basename(f)), ['ok.md'], 'only the file inside the skill directory');
    assert.ok(!refs.some((f) => f.includes('x-secrets')), 'the sibling whose name shares the prefix is not read');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a large or pathological body is linted and costed in bounded time', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-adv-'));
  try {
    await fs.mkdir(path.join(root, 'skills', 'big'), { recursive: true });
    const body = 'aaaa/bbbb/cccc/dddd/eeee.json '.repeat(9000)            // 270 KB of path-shaped text
      + 'read-only '.repeat(2000) + '`git status` '.repeat(2000);
    await fs.writeFile(path.join(root, 'skills', 'big', 'SKILL.md'),
      `---\nname: big\ndescription: 'Big. Invoke: big.'\ndisable-model-invocation: true\nallowed-tools: [Read]\n---\n${body}`);
    const started = Date.now();
    await runLint([path.join(root, 'skills', 'big')], { _: [] });
    const { artifacts } = await discoverDetailed([path.join(root, 'skills', 'big')]);
    await referencedFiles(artifacts[0]);
    const ms = Date.now() - started;
    assert.ok(ms < 5000, `took ${ms} ms — a 270 KB body must not be quadratic`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('containment helper rejects siblings that share a prefix', () => {
  assert.equal(within('/a/b', '/a/b/c.md'), true);
  assert.equal(within('/a/b', '/a/b'), true);
  assert.equal(within('/a/b', '/a/b-2/c.md'), false, 'a sibling with a shared prefix is outside');
  assert.equal(within('/a/b', '/a/c.md'), false);
  assert.equal(within('/a/b', '/etc/hosts'), false);
});

test('a malformed or wrong-shaped catalog names the file instead of throwing a stack', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-adv-'));
  try {
    const bad = path.join(root, 'bad.json');
    await fs.writeFile(bad, '{"servers":');
    await assert.rejects(readCatalog(bad), (e) => e.message.includes('bad.json'));
    const shape = path.join(root, 'shape.json');
    await fs.writeFile(shape, JSON.stringify({ servers: { x: { tools: 'not-an-array' } } }));
    await assert.rejects(readCatalog(shape), (e) => /"tools" must be an array/.test(e.message));
    const r = await saut(['tools', root, '--catalog', bad]);
    assert.equal(r.code, 2);
    assert.ok(!r.stderr.includes('    at '), 'a user-facing error carries no stack trace');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('one unreadable artifact does not abort the walk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-adv-'));
  try {
    for (const n of ['good', 'bad']) await fs.mkdir(path.join(root, 'skills', n), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'good', 'SKILL.md'),
      "---\nname: good\ndescription: 'Fine. Invoke: good.'\ndisable-model-invocation: true\nallowed-tools: [Read]\n---\nbody\n");
    const badFile = path.join(root, 'skills', 'bad', 'SKILL.md');
    await fs.writeFile(badFile, 'x'.repeat(16 * 1024 * 1024));      // over the read cap
    const { artifacts, failures } = await discoverDetailed([root]);
    assert.deepEqual(artifacts.map((a) => a.name), ['good'], 'the readable one is still linted');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'load-failed');
    assert.equal(failures[0].path, badFile);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('walk follows symlinks and survives a loop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-adv-'));
  try {
    await fs.mkdir(path.join(root, 'real'), { recursive: true });
    await fs.writeFile(path.join(root, 'real', 'a.md'), 'a');
    await fs.mkdir(path.join(root, 'tree'), { recursive: true });
    await fs.symlink(path.join(root, 'real'), path.join(root, 'tree', 'linked'));
    await fs.symlink(path.join(root, 'tree'), path.join(root, 'tree', 'loop'));   // a cycle
    const found = [];
    for await (const f of walk(path.join(root, 'tree'))) found.push(path.basename(f));
    assert.ok(found.includes('a.md'), 'a symlinked file is visible');
    assert.ok(found.length < 50, 'the cycle terminates');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
