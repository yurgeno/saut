import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { saut, PACK, CATALOG } from './helpers.mjs';

test('help / version / unknown command exit codes', async () => {
  assert.equal((await saut([])).code, 0);
  for (const v of [['version'], ['--version'], ['-V']]) assert.match((await saut(v)).stdout, /^\d+\.\d+\.\d+\n$/, v.join(' '));
  for (const h of [['--help'], ['-h'], ['help']]) assert.match((await saut(h)).stdout, /^SAUT — Skill Assurance Under Trust/, h.join(' '));
  assert.equal((await saut(['bogus'])).code, 2);
  assert.equal((await saut(['lint', '--nope'])).code, 2);
  assert.equal((await saut(['lint', '-x'])).code, 2, 'a short unknown flag is a usage error too');
});

test('argument validation: a flag without a value, a bad number, a bad date are usage errors', async () => {
  // Every one of these used to pass `undefined` on and change behaviour silently three
  // modules later (NaN runs, a dropped budget, a stack trace from .split on undefined).
  for (const flag of ['--harness', '--catalog', '--budget', '--runs', '--level', '--max-cost', '--out', '--model']) {
    const r = await saut(['lint', flag]);
    assert.equal(r.code, 2, flag);
    assert.match(r.stderr, new RegExp(`${flag} needs a value`), flag);
  }
  const nan = await saut(['lint', '--runs', 'abc']);
  assert.equal(nan.code, 2);
  assert.match(nan.stderr, /expected an integer in 1\.\.100, got "abc"/);
  assert.equal((await saut(['lint', '--runs', '0'])).code, 2, 'out of range');
  assert.equal((await saut(['lint', '--level', '9'])).code, 2, 'out of range');
  assert.equal((await saut(['lint', '--max-cost', '-1'])).code, 2, 'negative budget');
  assert.equal((await saut(['lint', '--port', '99999'])).code, 2, 'port out of range');
  const day = await saut(['cost', '--since', '2026-9-1']);
  assert.equal(day.code, 2);
  assert.match(day.stderr, /expected YYYY-MM-DD/);
  // a value that looks like the next flag is refused rather than swallowed
  const swallow = await saut(['lint', '--catalog', '--strict']);
  assert.equal(swallow.code, 2);
  assert.match(swallow.stderr, /--catalog needs a value/);
});

test('lint: text output, exit 1 on high findings, 0 on a clean skill', async () => {
  const r = await saut(['lint', PACK, '--catalog', CATALOG]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /skill fx-noallow .* — \d+ findings/);
  assert.match(r.stdout, /enforcement claude-code=grant · codex=prose/);
  const clean = await saut(['lint', path.join(PACK, 'skills', 'fx-clean'), '--catalog', CATALOG]);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /clean/);
});

test('lint --json and --sarif are machine-readable', async () => {
  const j = JSON.parse((await saut(['lint', PACK, '--catalog', CATALOG, '--json'])).stdout);
  assert.ok(Array.isArray(j.diagnostics) && j.diagnostics.length > 10);
  assert.ok(j.artifacts.some((a) => a.kind === 'agent' && a.name === 'fx-agent'));
  const s = JSON.parse((await saut(['lint', PACK, '--catalog', CATALOG, '--sarif'])).stdout);
  assert.equal(s.version, '2.1.0');
  assert.equal(s.runs[0].tool.driver.name, 'saut');
  assert.ok(s.runs[0].results.some((r) => r.ruleId === 'no-allowlist' && r.level === 'error'));
});

test('lint --harness subset and --strict', async () => {
  const r = await saut(['lint', path.join(PACK, 'skills', 'fx-readonly'), '--catalog', CATALOG, '--harness', 'codex']);
  assert.match(r.stdout, /enforcement codex=prose\n/);
  assert.ok(!r.stdout.includes('claude-code='));
  const strict = await saut(['lint', path.join(PACK, 'skills', 'fx-dead'), '--catalog', CATALOG, '--strict']);
  assert.equal(strict.code, 1, 'medium-only findings fail under --strict');
});

test('cost: table + --json; harnesses and tools registries print', async () => {
  const r = await saut(['cost', PACK, '--catalog', CATALOG]);
  assert.match(r.stdout, /cost passport \(estimate, listing per claude-code\)/);
  assert.match(r.stdout, /TOTAL/);
  const j = JSON.parse((await saut(['cost', PACK, '--catalog', CATALOG, '--json'])).stdout);
  assert.ok(j.lines.some((l) => l.artifact === 'fx-branches' && l.transitive.length));
  const h = await saut(['harnesses']);
  assert.match(h.stdout, /claude-code\s+Claude Code/);
  assert.match(h.stdout, /cursor .*registry-only/);
  const t = await saut(['tools', PACK, '--catalog', CATALOG]);
  assert.match(t.stdout, /mcp docs role=docs/);
  assert.match(t.stdout, /mcp__kb__write/);
});

test('passport: one JSON with findings, cost and matrix per artifact', async () => {
  const j = JSON.parse((await saut(['passport', path.join(PACK, 'skills', 'fx-clean'), '--catalog', CATALOG])).stdout);
  assert.equal(j.passports.length, 1);
  const p = j.passports[0];
  assert.deepEqual(p.findings, []);
  assert.ok(p.cost.alwaysOnTokens > 0);
  assert.ok(p.matrix.some((m) => m.harness === 'codex' && m.allowlist === 'prose'));
});
