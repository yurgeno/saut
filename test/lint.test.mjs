import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runLint } from '../lib/commands.mts';
import { PACK, CATALOG, codes } from './helpers.mjs';

const opts = { _: [], catalog: CATALOG };
let diags;
test.before(async () => { ({ diagnostics: diags } = await runLint([PACK], opts)); });

test('S1: a skill without allowed-tools is a high finding (and read-only is not enforced)', () => {
  const c = codes(diags, 'fx-noallow/SKILL.md');
  assert.ok(c.includes('no-allowlist'));
  assert.ok(c.includes('model-invocable-writer'));
  assert.ok(c.includes('readonly-not-enforced'));
});

test('S2: a model-invocable writer / supervised skill', () => {
  const c = codes(diags, 'fx-writer-auto/SKILL.md');
  assert.ok(c.includes('model-invocable-writer'));
  assert.ok(c.includes('supervised-but-auto'));
  assert.ok(!c.includes('dead-privilege'), 'Write/Edit are evidenced by the body');
});

test('S4: dead privileges (WebFetch, an MCP tool the body never calls)', () => {
  const found = diags.filter((x) => x.path.endsWith('fx-dead/SKILL.md') && x.code === 'dead-privilege').map((x) => x.message);
  assert.ok(found.some((m) => m.includes('"WebFetch"')));
  assert.ok(found.some((m) => m.includes('mcp__docs__query')));
  assert.ok(!found.some((m) => m.includes('mcp__docs__lookup')));
  assert.ok(!found.some((m) => m.includes('"Read"')), 'Read is ambient');
});

test('C1: body cites tools outside the allowlist; unknown names; unknown catalog server/tool', () => {
  const ds = diags.filter((x) => x.path.endsWith('fx-cites/SKILL.md'));
  const c = ds.map((x) => x.code);
  assert.ok(ds.some((x) => x.code === 'body-tool-not-allowed' && x.message.includes('mcp__kb__read')));
  assert.ok(ds.some((x) => x.code === 'body-tool-not-allowed' && x.message.includes('mcp__browser__')));
  assert.ok(ds.some((x) => x.code === 'body-tool-not-allowed' && x.message.includes('`Write`')));
  assert.ok(ds.some((x) => x.code === 'unknown-tool' && x.message.includes('"Bogus"')));
  assert.ok(c.includes('unknown-mcp-server'));
  assert.ok(c.includes('unknown-mcp-tool'));
});

test('C3/S7: read-only claim vs Write grant, bare Bash on a read-only role, grant≠restriction', () => {
  const ds = diags.filter((x) => x.path.endsWith('fx-readonly/SKILL.md'));
  const c = ds.map((x) => x.code);
  assert.ok(c.includes('readonly-claim-vs-writes'));
  assert.ok(c.includes('bash-unscoped-readonly'));
  const ro = ds.filter((x) => x.code === 'readonly-not-enforced');
  assert.ok(ro.some((x) => x.severity === 'high' && x.harness === 'claude-code'));
  assert.ok(ro.some((x) => x.severity === 'medium' && x.harness.includes('codex')));
});

test('dynamic context with bare Bash, untrusted-content rule, secret pattern', () => {
  const c = codes(diags, 'fx-dyn/SKILL.md');
  assert.ok(c.includes('dynamic-context'));
  assert.ok(c.includes('untrusted-content-rule'));
  assert.ok(c.includes('secret-pattern'));
});

test('the clean reference skill has no findings', () => {
  assert.deepEqual(codes(diags, 'fx-clean/SKILL.md'), []);
});

test('marker branches: union of allowlists, first description, TAUT wiring checked against the catalog', () => {
  const ds = diags.filter((x) => x.path.endsWith('fx-branches/SKILL.md'));
  const c = ds.map((x) => x.code);
  assert.ok(c.includes('duplicate-key'));
  assert.ok(!c.includes('body-tool-not-allowed'), 'mcp__docs__lookup is granted in the ON branch');
  assert.ok(!c.includes('taut-agent-missing'), 'fx-agent exists in the pack');
  assert.ok(!c.includes('taut-mcp-role-unknown'));
});

test('S3: an agent that writes a report through Bash without Write; README under agents/ is skipped', () => {
  const c = codes(diags, 'fx-agent.md');
  assert.ok(c.includes('agent-writes-via-bash'));
  assert.ok(!diags.some((x) => x.path.endsWith('agents/README.md')));
});

test('taut-agent-missing fires only when agents were in scope', async () => {
  const { diagnostics } = await runLint([path.join(PACK, 'skills', 'fx-branches')], opts);
  assert.ok(!codes(diagnostics).includes('taut-agent-missing'));
});
