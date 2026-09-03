// The TAUT adapter against the engine's own fixture pack. Needs a TAUT engine with the
// render/harness-caps seams (≥ 0.7); skipped when none is reachable, so the suite stays
// green on a machine without TAUT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findEngine } from '../lib/adapters/taut.mts';
import { runLint } from '../lib/commands.mts';
import { saut } from './helpers.mjs';

const engine = await findEngine(process.env.SAUT_TAUT_ENGINE ?? null);
const PACK = engine ? path.join(engine, 'test', 'fixtures', 'pack') : null;
const skip = engine ? false : 'no TAUT engine reachable (set SAUT_TAUT_ENGINE)';

test('adapter activates on a TAUT pack: engine-parsed frontmatter, catalog roles, agents from the catalog', { skip }, async () => {
  const { diagnostics, taut, artifacts } = await runLint([path.join(PACK, 'skills', 'fx-init')], { _: [], taut: engine, deployment: 'fxdep' });
  assert.ok(taut, 'adapter active');
  assert.equal(taut.project.name, 'fxdep');
  assert.ok(taut.harnessIds.includes('codex'));
  const skill = artifacts.find((a) => a.name === 'fx-init');
  assert.match(skill.description, /KAUT system store/, 'all-gates-ON view from the engine parser');
  assert.ok(!diagnostics.some((d) => d.code === 'taut-agent-missing'), 'fx-analyst is in the catalog even though only one skill dir was targeted');
  assert.ok(!diagnostics.some((d) => d.code === 'taut-mcp-role-unknown'), 'role tracker exists in the fixture catalog');
  assert.ok(!diagnostics.some((d) => d.code === 'taut-compile'));
});

test('adapter: wiring findings — unknown agent / role / requires / repo are reported against the catalog', { skip }, async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-taut-'));
  // a throwaway copy of the fixture pack with one broken skill added
  await fs.cp(PACK, tmp, { recursive: true });
  await fs.mkdir(path.join(tmp, 'skills', 'fx-broken'));
  await fs.writeFile(path.join(tmp, 'skills', 'fx-broken', 'SKILL.md'), `---
name: fx-broken
description: Broken wiring. Invoke: fx-broken.
disable-model-invocation: true
allowed-tools: [Read]
metadata:
  taut:
    agents: [ghost-agent]
    mcp: [ghost-role]
    requires: [magic]
    repos: [ghost-repo]
    role: ghost
    extra: 1
---
# fx-broken
Read only.
`);
  try {
    const { diagnostics } = await runLint([path.join(tmp, 'skills', 'fx-broken')], { _: [], taut: engine, deployment: 'fxdep' });
    const codes = diagnostics.map((d) => d.code);
    for (const c of ['taut-agent-missing', 'taut-mcp-role-unknown', 'taut-requires-unknown', 'taut-repo-unknown', 'taut-role-unknown', 'taut-wiring-unknown-key']) assert.ok(codes.includes(c), c);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

test('preview / passport: compiled bytes per harness with the engine degradations', { skip }, async () => {
  const p = await saut(['preview', 'fx-analyst', PACK, '--taut', engine, '--deployment', 'fxdep', '--harness', 'codex']);
  assert.equal(p.code, 0);
  assert.match(p.stdout, /── codex → \.codex\/agents\/fx-analyst\.toml/);
  assert.match(p.stdout, /degradation codex-agent-tools/);
  assert.match(p.stdout, /^name = "fx-analyst"$/m);
  const j = JSON.parse((await saut(['passport', path.join(PACK, 'skills', 'fx-init'), '--taut', engine, '--deployment', 'fxdep'])).stdout);
  assert.equal(j.taut.deployment, 'fxdep');
  const c = j.passports[0].compiled;
  assert.deepEqual(c.map((x) => x.id).sort(), ['.agents/skills/fx-init/SKILL.md', '.agents/skills/fx-init/SKILL.md', '.claude/skills/fx-init/SKILL.md']);
  assert.ok(c.find((x) => x.harness === 'codex').degradations.some((d) => d.id === 'codex-skill-allowlist'));
  assert.ok(c.every((x) => x.tokens > 0));
});

test('--no-taut lints a TAUT pack as plain skills', { skip }, async () => {
  const { taut, note } = await runLint([path.join(PACK, 'skills', 'fx-init')], { _: [], noTaut: true });
  assert.equal(taut, null);
  assert.equal(note, null);
});
