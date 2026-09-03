// L4 scenario graders — offline. Every grader type is exercised against a synthetic trace;
// the LLM/baseline judge is exercised through a fake `claude` on PATH, so the parsing of a
// verdict (and the refusal to pass on an unparseable one) is covered without model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grade, gradeAll, loadGraders } from '../lib/bench/graders.mts';
import { loadCases } from '../lib/bench/cases.mts';
import { discover } from '../lib/skill.mts';
import { copySkill, PACK } from './helpers.mjs';

const trace = {
  harness: 'claude-code', run: 1, status: 'ok', listed: true, competing: 0, fired: 'tool', firedOther: [],
  case: { name: 'c', source: 'auto', prompt: '', invocation: 'implicit', expect: 'fire', tags: [], maxTurns: 4, timeoutSeconds: 60 },
  tools: [
    { name: 'Skill', neutral: 'Skill', digest: 'fx-clean', denied: false, error: false },
    { name: 'Read', neutral: 'Read', digest: '/ws/README.md', denied: false, error: false },
    { name: 'Bash', neutral: 'Bash', digest: 'git status --short', denied: false, error: false },
    { name: 'Write', neutral: 'Write', digest: '/ws/memory/report.md', denied: false, error: false },
  ],
  usage: null, costUsd: 0.01, durationMs: 100, turns: 2,
  finalText: 'Wrote the report to memory/report.md. The working tree is clean.',
};

let ws;
test.before(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-grade-'));
  await fs.mkdir(path.join(ws, 'memory'), { recursive: true });
  await fs.writeFile(path.join(ws, 'memory', 'report.md'), '# report\n\nclean\n');
});
test.after(async () => { await fs.rm(ws, { recursive: true, force: true }); });

const g = (type, fm, body = '') => ({ name: type, type, file: path.join(ws, 'g.md'), body, fm: { type, ...fm } });
const ctx = () => ({ trace, ws, judgeModel: 'haiku', skillName: 'fx-clean' });

test('regex: contains, not_contains, count and the trace/files sources', async () => {
  assert.equal((await grade(g('regex', { pattern: 'working tree is clean' }), ctx())).pass, true);
  assert.equal((await grade(g('regex', { pattern: 'catastrophe' }), ctx())).pass, false);
  assert.equal((await grade(g('regex', { pattern: 'catastrophe', match: 'not_contains' }), ctx())).pass, true);
  assert.equal((await grade(g('regex', { pattern: 'memory/report\\.md', match: 'count:1' }), ctx())).pass, true);
  assert.equal((await grade(g('regex', { pattern: 'git status', source: 'trace' }), ctx())).pass, true, 'the trace is a source');
  assert.equal((await grade(g('regex', { pattern: '# report', source: 'files' }), ctx())).pass, true, 'the produced files are a source');
  assert.equal((await grade(g('regex', { pattern: 'clean', source: { source: 'file', path: 'memory/report.md' } }), ctx())).pass, true);
});

test('tool_used: name, input_match, min/max — and Skill honours the trace verdict', async () => {
  assert.equal((await grade(g('tool_used', { tool: 'Write' }), ctx())).pass, true);
  assert.equal((await grade(g('tool_used', { tool: 'WebFetch' }), ctx())).pass, false);
  assert.equal((await grade(g('tool_used', { tool: 'Bash', input_match: 'git status' }), ctx())).pass, true);
  assert.equal((await grade(g('tool_used', { tool: 'Bash', input_match: 'git push' }), ctx())).pass, false);
  assert.equal((await grade(g('tool_used', { tool: 'Read', max: 0 }), ctx())).pass, false);
  const expanded = { ...trace, tools: [], fired: 'expansion' };
  assert.equal((await grade(g('tool_used', { tool: 'Skill' }), { ...ctx(), trace: expanded })).pass, true, 'an expansion leaves no tool call but the skill did fire');
});

test('tool_order and file_exists', async () => {
  assert.equal((await grade(g('tool_order', { before: 'Read', after: 'Write' }), ctx())).pass, true);
  assert.equal((await grade(g('tool_order', { before: 'Write', after: 'Read' }), ctx())).pass, false);
  assert.equal((await grade(g('tool_order', { before: 'Glob', after: 'Write' }), ctx())).pass, false);
  assert.equal((await grade(g('file_exists', { path: 'memory/*.md' }), ctx())).pass, true);
  assert.equal((await grade(g('file_exists', { path: 'memory/**/nope.md' }), ctx())).pass, false);
});

test('llm and baseline graders: a verdict is parsed, an unparseable reply FAILS', async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-judge-'));
  const write = async (reply) => fs.writeFile(path.join(bin, 'claude'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ result: reply, total_cost_usd: 0.002 })}\nEOF\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    await write('{"pass": true, "why": "the report states the tree is clean"}');
    const ok = await grade(g('llm', { criteria: 'The run reports the working tree state.' }), ctx());
    assert.equal(ok.pass, true);
    assert.match(ok.detail, /tree is clean/);
    assert.equal(ok.costUsd, 0.002);

    await write('{"pass": false, "why": "no evidence"}');
    assert.equal((await grade(g('llm', { criteria: 'x' }), ctx())).pass, false);

    await write('I think it is fine, honestly.');
    const vague = await grade(g('llm', { criteria: 'x' }), ctx());
    assert.equal(vague.pass, false, 'no verdict is a FAILED grader, never a silent pass');
    assert.match(vague.detail, /no verdict/);

    await fs.writeFile(path.join(ws, 'baseline.md'), 'the reference answer');
    await write('{"pass": true, "why": "matches the baseline"}');
    const b = await grade({ ...g('baseline', { criteria: 'same conclusion as the baseline', baseline_file: path.join(ws, 'baseline.md') }), file: path.join(ws, 'g.md') }, ctx());
    assert.equal(b.pass, true);
  } finally { process.env.PATH = oldPath; await fs.rm(bin, { recursive: true, force: true }); }
});

test('unknown grader type fails loudly; gradeAll scores the set', async () => {
  const bad = await grade(g('unknown', {}), ctx());
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /unknown grader type/);
  const set = await gradeAll([g('regex', { pattern: 'clean' }), g('tool_used', { tool: 'WebFetch' })], ctx());
  assert.equal(set.score, 0.5);
  assert.equal(set.verdicts.length, 2);
});

test('graders load from a case folder; agentskills evals.json imports as cases with assertions', async () => {
  const copy = await copySkill('fx-clean');            // the shared fixture stays read-only
  const [skill] = await discover([copy.dir]);
  const dir = path.join(skill.dir, 'evals');
  await fs.mkdir(path.join(dir, 'case-a', 'graders'), { recursive: true });
  await fs.writeFile(path.join(dir, 'case-a', 'prompt.md'), '---\nname: case-a\n---\nDo it.\n');
  await fs.writeFile(path.join(dir, 'case-a', 'graders', 'wrote.md'), '---\ntype: file_exists\npath: memory/*.md\n---\n');
  await fs.writeFile(path.join(dir, 'case-a', 'graders', 'said.md'), '---\ntype: regex\npattern: clean\n---\n');
  await fs.writeFile(path.join(dir, 'evals.json'), JSON.stringify({ evals: [{ name: 'spec-1', prompt: 'Report the status.', assertions: ['working tree', { type: 'not_contains', value: 'error' }] }] }));
  try {
    const cases = await loadCases(skill);
    const spec = cases.find((c) => c.name === 'spec-1');
    assert.ok(spec, 'evals.json case imported');
    assert.equal(spec.prompt, 'Report the status.');
    assert.deepEqual(spec.assertions, [{ kind: 'contains', value: 'working tree' }, { kind: 'not_contains', value: 'error' }]);
    const authored = cases.find((c) => c.name === 'case-a');
    const graders = await loadGraders(authored.file);
    assert.deepEqual(graders.map((x) => x.type).sort(), ['file_exists', 'regex']);
    const scored = await gradeAll(graders, ctx());
    assert.equal(scored.score, 1);
  } finally { await copy.cleanup(); }
});
