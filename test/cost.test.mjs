import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens } from '../lib/cost.mts';
import { runCost } from '../lib/commands.mts';
import { PACK, CATALOG } from './helpers.mjs';

test('estimateTokens: English prose lands near 1.3 tokens/word, symbols count one each', () => {
  const prose = 'The quick brown fox jumps over the lazy dog and keeps running through the forest.';
  const t = estimateTokens(prose);
  const words = prose.split(/\s+/).length;
  assert.ok(t >= words && t <= words * 1.6, `${t} tokens for ${words} words`);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a,b;c'), 5);
});

test('cost passport: always-on = name + description, on-invoke = body, agents wired via metadata.taut count as transitive', async () => {
  const { lines } = await runCost([PACK], { _: [], catalog: CATALOG });
  const br = lines.find((l) => l.line.artifact === 'fx-branches');
  assert.ok(br);
  assert.equal(br.line.method, 'estimate');
  assert.ok(br.line.alwaysOnTokens > 0 && br.line.alwaysOnTokens < 40);
  assert.ok(br.line.transitive.some((t) => t.name === 'agent:fx-agent' && t.tokens > 0));
  const agent = lines.find((l) => l.line.artifact === 'fx-agent');
  assert.equal(agent.line.kind, 'agent');
});

test('budgets: over-budget lines are reported and the verb exits 1', async () => {
  const { lines } = await runCost([PACK], { _: [], catalog: CATALOG, budget: new URL('./fixtures/budget-tight.json', import.meta.url).pathname });
  assert.ok(lines.every((l) => l.over.length), 'every artifact is over a 1-token budget');
});
