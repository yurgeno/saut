import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, emitFrontmatter, bodyOf } from '../lib/frontmatter.mts';

test('parses the YAML subset: nested maps, inline/block lists, quotes, booleans, folded scalars', () => {
  const text = `---
name: demo
description: 'It''s quoted: with colon'
argument-hint: "<x>"
allowed-tools: [Read, "Bash(git diff *)", Write]
disable-model-invocation: true
model: opus
metadata:
  taut:
    agents: [a, b]
    mcp:
      - docs
      - tracker
    role: knowledge
    empty: {}
notes: >-
  folded line one
  folded line two
literal: |
  keep
  lines
---
# body
`;
  const fm = parseFrontmatter(text, 'demo.md');
  assert.deepEqual(fm.diagnostics, []);
  assert.equal(fm.data.name, 'demo');
  assert.equal(fm.data.description, "It's quoted: with colon");
  assert.equal(fm.data['argument-hint'], '<x>');
  assert.deepEqual(fm.data['allowed-tools'], ['Read', 'Bash(git diff *)', 'Write']);
  assert.equal(fm.data['disable-model-invocation'], true);
  assert.deepEqual(fm.data.metadata, { taut: { agents: ['a', 'b'], mcp: ['docs', 'tracker'], role: 'knowledge', empty: {} } });
  assert.equal(fm.data.notes, 'folded line one folded line two');
  assert.equal(fm.data.literal, 'keep\nlines\n');
  assert.equal(fm.lines.name, 2);
  assert.equal(bodyOf(text, fm), '# body\n');
});

test('records duplicate keys (marker branches) and keeps the first value', () => {
  const text = `---
name: x
# docs:on
description: on-branch
# docs:off
description: off-branch
# docs:end
allowed-tools: [Read, A]
allowed-tools: [Read, B]
---
`;
  const fm = parseFrontmatter(text, 'x.md');
  assert.deepEqual(fm.duplicates.sort(), ['allowed-tools', 'description']);
  assert.equal(fm.data.description, 'on-branch');
  assert.deepEqual(fm.all['allowed-tools'], [['Read', 'A'], ['Read', 'B']]);
  assert.ok(fm.diagnostics.every((d) => d.code === 'duplicate-key'));
});

test('folded scalar interleaved with column-0 marker comments (TAUT agents) parses', () => {
  const text = `---
name: agent
description: >-
  Line one
# kaut:on
  line two on
# kaut:off
  line two off
# kaut:end
  line three.
tools: Read, Glob, Grep, Bash
model: opus
---
body`;
  const fm = parseFrontmatter(text, 'a.md');
  assert.deepEqual(fm.diagnostics, []);
  assert.equal(fm.data.description, 'Line one line two on line two off line three.');
  assert.equal(fm.data.tools, 'Read, Glob, Grep, Bash');
  assert.equal(fm.data.model, 'opus');
});

test('diagnoses missing / unterminated frontmatter and unsupported constructs', () => {
  assert.equal(parseFrontmatter('# no fm', 'f.md').diagnostics[0].code, 'no-frontmatter');
  assert.equal(parseFrontmatter('---\nname: x\n', 'f.md').diagnostics[0].code, 'frontmatter-syntax');
  const fm = parseFrontmatter('---\nname: x\nlist: [a, b\n---\n', 'f.md');
  assert.match(fm.diagnostics[0].message, /unterminated inline list/);
  const anchor = parseFrontmatter('---\nname: &a x\n---\n', 'f.md');
  assert.match(anchor.diagnostics[0].message, /anchors/);
});

test('emitter round-trips through the parser', () => {
  const data = {
    name: 'rt',
    description: "Quoted: it's here, with [brackets]",
    'argument-hint': '<TASK>',
    'allowed-tools': ['Read', 'Bash(git status *)', 'mcp__docs__lookup'],
    'disable-model-invocation': true,
    metadata: { taut: { agents: ['a'], mcp: ['docs'], role: 'init' } },
  };
  const text = emitFrontmatter(data) + 'body\n';
  const fm = parseFrontmatter(text, 'rt.md');
  assert.deepEqual(fm.diagnostics, []);
  assert.deepEqual(fm.data, data);
  // and the emitted block is single-line-per-key, 2-space nested (the TAUT engine's subset)
  assert.ok(!/\n {3,}[a-z]/.test(text.split('---')[1].replace(/\n {4}/g, '\n  ')));
});
