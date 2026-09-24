// S3: current vendor guidance — models, effort, prompt style, hardening — judged against dated,
// sourced data, with the harness's own catalog on the machine consulted first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadHarnesses } from '../lib/caps.mts';
import { guidanceStatus, judgeModel, lintGuidance, lintModelTiers, localCatalog } from '../lib/guidance.mts';
import { saut } from './helpers.mjs';

const hs = await loadHarnesses();
const cc = hs.get('claude-code');
const cx = hs.get('codex');
const codes = (vs) => vs.map((v) => v.code);

test('registry: every model block is dated and sourced, and statuses are known', () => {
  for (const h of [cc, cx]) {
    assert.match(h.models.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(h.models.sources.length);
    for (const m of h.models.catalog) assert.ok(['current', 'previous', 'legacy', 'unsupported', 'retired'].includes(m.status), m.id);
    for (const target of Object.values(h.models.aliases)) if (target) assert.ok(h.models.catalog.some((m) => m.id === target), `${h.id} alias → ${target}`);
  }
});

test('Claude Code models: aliases, dated ids, previous models, effort per model', () => {
  assert.deepEqual(codes(judgeModel(cc, 'opus', 'xhigh', null)), []);
  assert.deepEqual(codes(judgeModel(cc, 'claude-haiku-4-5-20251001', null, null)), [], 'a dated id is the same model');
  assert.deepEqual(codes(judgeModel(cc, 'sonnet[1m]', 'high', null)), []);
  assert.deepEqual(codes(judgeModel(cc, 'inherit', 'max', null)), [], 'a dynamic alias is judged against every level the harness knows');
  assert.deepEqual(codes(judgeModel(cc, 'inherit', 'ultra', null)), ['effort-unsupported'], 'ultra is a Codex level, not a Claude one');
  const haiku = judgeModel(cc, 'haiku', 'low', null);
  assert.deepEqual(codes(haiku), ['effort-unsupported']);
  assert.match(haiku[0].message, /claude-haiku-4-5\) has no effort levels/);
  assert.deepEqual(codes(judgeModel(cc, 'claude-opus-4-6', 'xhigh', null)), ['model-previous', 'effort-unsupported'], 'Opus 4.6 has no xhigh');
  const prev = judgeModel(cc, 'claude-opus-4-7', null, null);
  assert.equal(prev[0].autofixModel, 'opus');
  assert.deepEqual(codes(judgeModel(cc, 'claude-opus-9', null, null)), ['model-unknown']);
});

test('Codex models: the 2026-09-23 precedents — gpt-5.6 does not run, 5.6 luna/terra move to GPT-6', () => {
  const broken = judgeModel(cx, 'gpt-5.6', 'high', null);
  assert.deepEqual(codes(broken), ['model-unsupported'], 'an unsupported model is not also judged on effort');
  assert.equal(broken[0].severity, 'high');
  assert.equal(broken[0].autofixModel, 'gpt-6-sol');
  assert.equal(judgeModel(cx, 'gpt-5.6-terra', 'medium', null)[0].autofixModel, 'gpt-6-sol');
  assert.deepEqual(codes(judgeModel(cx, 'gpt-5.4-mini', null, null)), ['model-unsupported'], 'retired');
  assert.deepEqual(codes(judgeModel(cx, 'gpt-6-luna', 'ultra', null)), ['effort-unsupported'], 'luna stops at max');
  assert.deepEqual(codes(judgeModel(cx, 'gpt-6-sol', 'ultra', null)), []);
});

test('the local Codex catalog is fresher evidence than the registry', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-codexhome-'));
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    await fs.writeFile(path.join(home, 'models_cache.json'), JSON.stringify({
      fetched_at: '2026-12-01T00:00:00Z', client_version: '0.200.0',
      models: [
        { slug: 'gpt-7-nova', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'turbo' }] },
        { slug: 'gpt-6-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }], upgrade: 'gpt-7-nova' },
      ],
    }));
    const local = await localCatalog(cx);
    assert.equal(local.fetchedAt, '2026-12-01');
    assert.deepEqual(codes(judgeModel(cx, 'gpt-7-nova', 'turbo', local)), [], 'a model and a level only the machine knows are accepted');
    assert.deepEqual(codes(judgeModel(cx, 'gpt-6-sol', 'high', local)), ['effort-unsupported'], 'the local effort list wins');
    const unknown = judgeModel(cx, 'gpt-8', null, local);
    assert.match(unknown[0].message, /nor in the local OpenAI Codex CLI catalog \(fetched 2026-12-01\)/);
  } finally { process.env.CODEX_HOME = old; await fs.rm(home, { recursive: true, force: true }); }
});

test('a TAUT model ladder: the pre-2026-09-23 ladder is caught, line by line', () => {
  const manifest = { modelTiers: { ladder: [
    { tier: 'cheap', models: { 'claude-code': 'haiku', codex: 'gpt-5.6-luna' }, reasoningEffort: { 'claude-code': 'low', codex: 'low' } },
    { tier: 'frontier', models: { 'claude-code': 'opus', codex: 'gpt-5.6' }, reasoningEffort: { 'claude-code': 'high', codex: 'high' } },
  ] } };
  const text = JSON.stringify({ name: 'x', manifest }, null, 2);
  const ds = lintModelTiers({ file: '/p/deployment.json', text, manifest }, [cc, cx], new Map());
  const got = ds.map((x) => `${x.code}:${x.line}`);
  const line = (s) => text.split('\n').findIndex((l) => l.includes(s)) + 1;
  assert.ok(got.includes(`model-unsupported:${line('"codex": "gpt-5.6"')}`), got.join(' '));
  assert.ok(got.includes(`effort-unsupported:${line('"claude-code": "low"')}`), 'haiku takes no effort');
  assert.ok(got.includes(`model-previous:${line('"codex": "gpt-5.6-luna"')}`));
  assert.ok(ds.every((x) => x.guidance.class === 'A' && x.guidance.verifiedAt && x.guidance.sources.length));
  assert.equal(ds.length, 3);
});

const art = (over = {}) => ({
  kind: 'skill', name: 'x', path: '/x/SKILL.md', dir: '/x', description: 'Does x.', body: '', allowedTools: [], disallowedTools: null,
  modelInvocable: false, userInvocable: true, model: null, effort: null, metadata: null,
  fm: { data: {}, all: {}, diagnostics: [], lines: {}, duplicates: [], bodyOffset: 5 }, ...over,
});
const g = (a, o = {}) => lintGuidance(a, { harnesses: [cc, cx], local: new Map(), ...o });

test('prompt style (class B): undertrigger phrases, caps density, incident fossils, reasoning echo — code fences ignored', () => {
  const phrase = g(art({ body: 'intro\nUse the docs MCP FIRST, unprompted.\n' }));
  assert.deepEqual(phrase.map((x) => [x.code, x.line, x.guidance.class]), [['aggressive-imperative', 6, 'B']]);
  const dense = 'You MUST check. NEVER skip. ALWAYS log. MUST verify. NEVER guess. ' + 'word '.repeat(2000);
  assert.equal(g(art({ body: dense })).filter((x) => x.code === 'aggressive-imperative').length, 0, '5 in ~2,000 words is under the density');
  assert.equal(g(art({ body: 'You MUST check. NEVER skip. ALWAYS log. MUST verify. NEVER guess.\n' + 'word '.repeat(100) })).filter((x) => x.code === 'aggressive-imperative').length, 1);
  assert.equal(g(art({ body: '```\nMUST MUST MUST MUST MUST MUST unprompted\n```\nplain prose\n' })).length, 0, 'fenced code is not prose');
  const fossils = g(art({ body: 'Lesson, 2026-06-22: x.\nok\nmeasured 2026-07 across runs.\n' }));
  assert.deepEqual(fossils.map((x) => x.code), ['incident-fossil']);
  assert.deepEqual(g(art({ body: 'Lesson, 2026-06-22: x.\n' })).map((x) => x.code), [], 'one story is not a pattern');
  assert.deepEqual(g(art({ body: 'Show your reasoning process step by step.\n' })).map((x) => x.code), ['reasoning-echo']);
  assert.deepEqual(g(art({ body: 'Return the verdict + your reasoning.\n' })).map((x) => x.code), [], 'a justification is not an echo');
});

test('frontmatter model/effort, body length, and the Codex sandbox hint', () => {
  const pinned = g(art({ fm: { data: { model: 'claude-opus-4-7', effort: 'max' }, all: {}, diagnostics: [], lines: { model: 3, effort: 4 }, duplicates: [], bodyOffset: 6 } }));
  assert.deepEqual(pinned.map((x) => [x.code, x.line]), [['model-previous', 3]]);
  assert.deepEqual(pinned[0].autofix, { op: 'set', key: 'model', value: 'opus', label: 'Set model: opus', safety: 'review' });
  assert.equal(g(art({ fm: { data: { model: 'anthropic/claude-sonnet-4' }, all: {}, diagnostics: [], lines: {}, duplicates: [], bodyOffset: 5 } })).length, 0, 'an opencode provider/model is not a Claude Code pin');
  const long = g(art({ body: 'x\n'.repeat(520) }));
  assert.deepEqual(long.map((x) => [x.code, x.guidance.class]), [['body-over-spec', 'A']]);
  const agent = art({ kind: 'agent', name: 'reader', tools: [{ raw: 'Read', base: 'Read', spec: null, mcp: null }], description: 'Read-only reviewer; never writes.', body: 'Review.' });
  assert.deepEqual(g(agent).map((x) => [x.code, x.guidance.class]), [['codex-agent-sandbox', 'D']]);
  assert.equal(g(agent, { sandboxed: new Set(['reader']) }).length, 0, 'already sandboxed by the deployment');
  assert.equal(g({ ...agent, tools: [{ raw: 'Write', base: 'Write', spec: null, mcp: null }] }).length, 0, 'a writer is not read-only');
});

test('guidance freshness: stale past maxAgeDays; `saut guidance --json` reports it and the machine', async () => {
  const fresh = guidanceStatus([cc, cx], new Date('2026-09-25T00:00:00Z'));
  assert.equal(fresh.stale, false);
  assert.equal(fresh.maxAgeDays, 60);
  const later = guidanceStatus([cc, cx], new Date('2027-01-01T00:00:00Z'));
  assert.equal(later.stale, true);
  assert.ok(later.parts.every((p) => p.stale));
  const r = await saut(['guidance', '--json']);
  const j = JSON.parse(r.stdout);
  assert.ok(j.status.parts.length >= 3);
  assert.equal(j.local.codex, null, 'the suite plants no local catalog');
  assert.ok(Array.isArray(j.drift));
});
