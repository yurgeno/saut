import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHarnesses, runnableHarnesses } from '../lib/caps.mts';
import { buildRegistry, classifyTool, liveTools } from '../lib/tools.mts';
import { parseToolRef, toolList } from '../lib/skill.mts';
import { CATALOG } from './helpers.mjs';

test('harness registry: every file validates, ids match, three runnable harnesses today', async () => {
  const hs = await loadHarnesses();
  assert.deepEqual([...hs.keys()].sort(), ['claude-code', 'codex', 'copilot', 'cursor', 'opencode']);
  for (const h of hs.values()) {
    assert.ok(h.docs.length, `${h.id} has provenance`);
    assert.ok(['grant', 'restrict', 'prose', 'dropped', 'n/a'].includes(h.toolAllowlist));
    assert.ok(h.degradations.every((d) => d.id && d.text));
  }
  assert.equal(hs.get('claude-code').toolAllowlist, 'grant');
  assert.equal(hs.get('codex').agentAllowlist, 'dropped');
  assert.deepEqual((await runnableHarnesses()).map((h) => h.id).sort(), ['claude-code', 'codex', 'opencode']);
});

test('tool references: scoped rules, MCP server/tool split, string and list forms', () => {
  assert.deepEqual(parseToolRef('Bash(git diff *)'), { raw: 'Bash(git diff *)', base: 'Bash', spec: 'git diff *', mcp: null });
  assert.deepEqual(parseToolRef('mcp__kaut__kaut_lookup').mcp, { server: 'kaut', tool: 'kaut_lookup' });
  assert.deepEqual(parseToolRef('mcp__context7').mcp, { server: 'context7', tool: null });
  assert.deepEqual(parseToolRef('mcp__github__get_*').mcp, { server: 'github', tool: 'get_*' });
  assert.deepEqual(toolList('Read, Bash(npm run *), Write').map((t) => t.base), ['Read', 'Bash', 'Write']);
  assert.deepEqual(toolList(['Read']).map((t) => t.raw), ['Read']);
  assert.equal(toolList(undefined), null);
  assert.deepEqual(toolList(''), []);
});

test('classifyTool against builtin + catalog', async () => {
  const reg = await buildRegistry({ catalog: CATALOG });
  const c = (s) => classifyTool(parseToolRef(s), reg, 'claude-code');
  assert.equal(c('Read'), 'builtin');
  assert.equal(c('MultiEdit'), 'legacy');
  assert.equal(c('Nope'), 'unknown');
  assert.equal(c('mcp__docs__lookup'), 'mcp-known');
  assert.equal(c('mcp__docs__nope'), 'mcp-unknown-tool');
  assert.equal(c('mcp__docs'), 'mcp-server-known');
  assert.equal(c('mcp__docs__*'), 'mcp-server-known');
  assert.equal(c('mcp__ghost__x'), 'mcp-unknown-server');
  const none = await buildRegistry({ catalog: null });
  assert.equal(classifyTool(parseToolRef('mcp__any__x'), none, 'claude-code'), 'mcp-server-known', 'no catalog → cannot judge servers');
});

test('live tools/list over stdio against a tiny in-process MCP server', async () => {
  const script = `
    process.stdin.setEncoding('utf8'); let buf='';
    process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l);
      if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fx' } } }) + '\\n');
      if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'alpha' }, { name: 'beta' }] } }) + '\\n'); } });`;
  const tools = await liveTools('fx', { serverKey: 'fx', command: 'node', args: ['-e', script] });
  assert.deepEqual(tools, ['mcp__fx__alpha', 'mcp__fx__beta']);
});

test('every harness declares how a skill is invoked there, or says the question is unmeasured', async () => {
  const hs = await loadHarnesses();
  const legal = new Set(['tool', 'slash', 'tool+slash', 'read', null]);
  for (const h of hs.values())
    assert.ok(legal.has(h.skillInvocation), `${h.id}: skillInvocation must be a measured value or null, got ${JSON.stringify(h.skillInvocation)}`);
  // Measured 2026-09-04: codex has no skill tool and no slash expansion — its hook surface
  // carries no prompt-expansion event and a slash prompt arrives as literal text, so an
  // invocation is only observable as a read of SKILL.md. This is the fact that decides
  // where usage can be counted at all, so it is pinned rather than left to prose.
  assert.equal(hs.get('codex').skillInvocation, 'read');
  assert.equal(hs.get('claude-code').skillInvocation, 'tool+slash');
  assert.ok(hs.get('codex').degradations.some((d) => d.id === 'CX-NO-SLASH-EXPANSION'),
    'the consequence is recorded as a degradation, with what it was measured against');
});
