// S2: saving from the form changes the fields that changed — and nothing the form does not show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../lib/compose.mts';

const BODY = '# x\n\nDo the thing.\n';
const RICH = [
  '---',
  'name: x',
  '# the owner decided this on 2026-09-01',
  "description: 'Does x. Invoke: x.'",
  'disable-model-invocation: true',
  'allowed-tools: [Read, Glob, Bash(git status *)]',
  'disallowed-tools: Write, Edit',
  'hooks:',
  '  PreToolUse:',
  '    - matcher: Bash',
  'license: Apache-2.0',
  'metadata:',
  '  owner: platform',
  '  taut:',
  '    agents: [a]',
  '---',
].join('\n') + '\n' + BODY;

const bodyOf = (t) => t.slice(t.indexOf('\n---\n') + 5);

test('an untouched form writes the file back byte for byte', () => {
  const r = compose(RICH, 'skill', { name: 'x', description: 'Does x. Invoke: x.', 'disable-model-invocation': true, 'user-invocable': true, tools: ['Read', 'Glob', 'Bash(git status *)'], taut: { agents: ['a'] } }, BODY);
  assert.ok(r.ok, r.reason);
  assert.equal(r.text, RICH);
  assert.deepEqual(r.changed, []);
});

test('changing one field keeps comments, unknown keys, hooks, disallowed-tools and quoting of the rest', () => {
  const r = compose(RICH, 'skill', { description: 'Does x better. Invoke: x.' }, BODY);
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.changed, ['description']);
  const was = RICH.split('\n'), now = r.text.split('\n');
  assert.equal(now.length, was.length);
  assert.deepEqual(now.map((l, i) => (l === was[i] ? null : i)).filter((x) => x !== null), [3], 'only the description line differs');
  assert.equal(now[3], "description: 'Does x better. Invoke: x.'");
});

test('allowlist edits are item by item; emptying it removes the key; a new one is added', () => {
  const add = compose(RICH, 'skill', { tools: ['Read', 'Glob', 'Bash(git status *)', 'Grep'] }, BODY);
  assert.match(add.text, /^allowed-tools: \[Read, Glob, Bash\(git status \*\), Grep\]$/m);
  const drop = compose(RICH, 'skill', { tools: ['Read'] }, BODY);
  assert.match(drop.text, /^allowed-tools: \[Read\]$/m);
  const none = compose(RICH, 'skill', { tools: [] }, BODY);
  assert.doesNotMatch(none.text, /^allowed-tools:/m, 'an empty allowlist in the form means no key (the full toolset)');
  const fresh = compose('---\nname: x\ndescription: d\n---\n' + BODY, 'skill', { tools: ['Read'] }, BODY);
  assert.match(fresh.text, /^allowed-tools: Read$/m);
  assert.match(compose('---\nname: a\ndescription: d\ntools: Read, Bash\n---\n' + BODY, 'agent', { tools: ['Read'] }, BODY).text, /^tools: Read$/m, 'agents use `tools`');
});

test('capability-marker branches survive; a field that differs by branch is refused, not flattened', () => {
  const branched = [
    '---', 'name: x',
    '# docs:on', "description: 'ON branch.'", 'allowed-tools: [Read, WebFetch, mcp__docs__lookup]',
    '# docs:off', "description: 'OFF branch.'", 'allowed-tools: [Read, WebFetch]', '# docs:end',
    'disable-model-invocation: true', '---',
  ].join('\n') + '\n' + BODY;
  const flag = compose(branched, 'skill', { 'disable-model-invocation': false }, BODY);
  assert.ok(flag.ok);
  for (const marker of ['# docs:on', '# docs:off', '# docs:end', "description: 'ON branch.'", "description: 'OFF branch.'"]) assert.ok(flag.text.includes(marker), marker);
  const desc = compose(branched, 'skill', { description: 'Flattened.' }, BODY);
  assert.equal(desc.ok, false);
  assert.match(desc.reason, /`description` differs by capability branch — edit it in the Source view/);
  const tools = compose(branched, 'skill', { tools: ['Read', 'mcp__docs__lookup'] }, BODY);
  assert.ok(tools.ok, tools.reason);
  assert.match(tools.text, /^allowed-tools: \[Read, mcp__docs__lookup\]$/m, 'ON branch loses WebFetch, keeps its extra');
  assert.match(tools.text, /^allowed-tools: \[Read\]$/m, 'OFF branch loses WebFetch too');
});

test('a folded description becomes one line; clearing a field removes its key', () => {
  const folded = '---\nname: x\ndescription: >\n  Long text\n  over lines.\nmodel: opus\n---\n' + BODY;
  const r = compose(folded, 'skill', { description: 'Short.', model: '' }, BODY);
  assert.ok(r.ok, r.reason);
  assert.equal(r.text, '---\nname: x\ndescription: Short.\n---\n' + BODY);
});

test('invocation flags compare the effective value; metadata.taut is rewritten as a block, siblings kept', () => {
  assert.deepEqual(compose('---\nname: x\ndescription: d\n---\n' + BODY, 'skill', { 'user-invocable': true, 'disable-model-invocation': false }, BODY).changed, [], 'defaults are not written');
  assert.match(compose('---\nname: x\ndescription: d\n---\n' + BODY, 'skill', { 'disable-model-invocation': true }, BODY).text, /^disable-model-invocation: true$/m);
  const r = compose(RICH, 'skill', { taut: { agents: ['a', 'b'], role: 'init' } }, BODY);
  assert.ok(r.ok, r.reason);
  assert.match(r.text, /^metadata:\n {2}owner: platform\n {2}taut:\n {4}agents: \[a, b\]\n {4}role: init$/m);
  assert.match(r.text, /^license: Apache-2\.0$/m);
  const gone = compose(RICH, 'skill', { taut: {} }, BODY);
  assert.match(gone.text, /^metadata:\n {2}owner: platform\n---$/m, 'an emptied taut block goes; the rest of metadata stays');
});

test('a body edit leaves the frontmatter byte for byte; CRLF files stay CRLF', () => {
  const r = compose(RICH, 'skill', {}, '# x\n\nDo it differently.\n');
  assert.deepEqual(r.changed, ['body']);
  assert.equal(r.text.slice(0, RICH.length - BODY.length), RICH.slice(0, RICH.length - BODY.length));
  assert.equal(bodyOf(r.text), '# x\n\nDo it differently.\n');
  const crlf = RICH.replaceAll('\n', '\r\n');
  const c = compose(crlf, 'skill', { model: 'opus' }, BODY);
  assert.ok(c.text.includes('\r\nmodel: opus\r\n') && !/[^\r]\n/.test(c.text));
});
