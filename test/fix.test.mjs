// S1: every finding explains itself, and the mechanical ones carry a fix that — applied to the
// file text — makes the finding go away without disturbing anything else in the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyFix, lineDiff } from '../lib/fix.mts';
import { RULES, explain, ruleInfo } from '../lib/rules.mts';
import { toSarif } from '../lib/lint.mts';
import { runLint } from '../lib/commands.mts';
import { PACK, REPO, saut } from './helpers.mjs';

const fm = (lines) => ['---', ...lines, '---', '# body', ''].join('\n');

test('catalog: every code the sources can emit is explained, and RULES.md documents the same set', async () => {
  const src = (await Promise.all(['lint.mts', 'frontmatter.mts', 'skill.mts', 'adapters/taut.mts', 'guidance.mts'].map((f) => fs.readFile(path.join(REPO, 'lib', f), 'utf8')))).join('\n');
  const emitted = new Set([
    ...[...src.matchAll(/\bd\(a, '([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bd\('([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/code: '([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/diagAt\([^)]*'([a-z0-9-]+)'\)/g)].map((m) => m[1]),
    'frontmatter-syntax',
  ]);
  assert.ok(emitted.size >= 30, `found ${emitted.size} codes`);
  for (const code of emitted) {
    const info = ruleInfo(code);
    assert.ok(info, `${code} has no catalog entry`);
    for (const k of ['title', 'why', 'fix']) assert.ok(info[k] && info[k].length > (k === 'title' ? 3 : 20), `${code}.${k} is empty`);
  }
  const doc = await fs.readFile(path.join(REPO, 'docs', 'RULES.md'), 'utf8');
  const documented = new Set([...doc.matchAll(/^\| `([a-z0-9-]+)`(?: \/ `([a-z0-9-]+)`)?/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean));
  for (const code of Object.keys(RULES)) if (code !== 'load-failed') assert.ok(documented.has(code), `${code} is in the catalog but not in RULES.md`);
  assert.equal(ruleInfo('scan-anything').category, 'scanner', 'scanner findings get a generic entry');
});

test('explain adds title/why/fix/doc; SARIF carries them as rule help', () => {
  const [x] = explain([{ code: 'dead-privilege', severity: 'medium', message: 'm', path: '/p/SKILL.md' }]);
  assert.equal(x.category, 'privileges');
  assert.match(x.fix, /Remove the tool/);
  assert.match(x.doc, /RULES\.md#privileges$/);
  const sarif = toSarif([x], 'test', '/p');
  const rule = sarif.runs[0].tool.driver.rules[0];
  assert.equal(rule.help.text, x.fix);
  assert.equal(rule.helpUri, x.doc);
  assert.equal(rule.fullDescription.text, x.why);
});

test('applyFix list-remove: plain, flow and block lists keep their shape', () => {
  const plain = applyFix(fm(['name: x', 'allowed-tools: Read, WebFetch, Bash(git diff *)']), { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' });
  assert.ok(plain.ok); assert.match(plain.text, /^allowed-tools: Read, Bash\(git diff \*\)$/m);
  const flow = applyFix(fm(['allowed-tools: [Read, "WebFetch", Glob]']), { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' });
  assert.ok(flow.ok); assert.match(flow.text, /^allowed-tools: \[Read, Glob\]$/m);
  const block = applyFix(fm(['allowed-tools:', '  - Read', '  - WebFetch', '  - Glob', 'model: opus']), { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' });
  assert.ok(block.ok); assert.equal(block.text, fm(['allowed-tools:', '  - Read', '  - Glob', 'model: opus']));
});

test('applyFix refuses what it cannot do safely — and never half-applies', () => {
  const src = fm(['allowed-tools: [WebFetch]']);
  const empty = applyFix(src, { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' });
  assert.equal(empty.ok, false); assert.match(empty.reason, /empty/); assert.equal(empty.text, src);
  assert.equal(applyFix(fm(['allowed-tools: "Read, WebFetch"']), { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' }).ok, false, 'a quoted list is not rewritten');
  assert.equal(applyFix(fm(['model: >', '  opus']), { op: 'set', key: 'model', value: 'sonnet', label: '', safety: 'review' }).ok, false, 'a folded value is not clobbered');
  assert.equal(applyFix('# no frontmatter\n', { op: 'set', key: 'x', value: true, label: '', safety: 'safe' }).ok, false);
  assert.match(applyFix(fm(['allowed-tools: [Read]']), { op: 'list-remove', key: 'allowed-tools', item: 'Nope', label: '', safety: 'review' }).reason, /not in/);
});

test('applyFix set / list-add / list-replace; CRLF and marker branches survive', () => {
  const set = applyFix(fm(['name: x', 'disable-model-invocation: false']), { op: 'set', key: 'disable-model-invocation', value: true, label: '', safety: 'review' });
  assert.match(set.text, /^disable-model-invocation: true$/m);
  const ins = applyFix(fm(['name: x']), { op: 'set', key: 'user-invocable', value: true, label: '', safety: 'safe' });
  assert.equal(ins.text, fm(['name: x', 'user-invocable: true']), 'a missing key is added at the end of the block');
  const add = applyFix(fm(['name: x']), { op: 'list-add', key: 'disallowed-tools', items: ['Write', 'Edit'], label: '', safety: 'review' });
  assert.match(add.text, /^disallowed-tools: Write, Edit$/m);
  const merge = applyFix(fm(['disallowed-tools: [Write]']), { op: 'list-add', key: 'disallowed-tools', items: ['Write', 'Edit'], label: '', safety: 'review' });
  assert.match(merge.text, /^disallowed-tools: \[Write, Edit\]$/m, 'only the missing item is added');
  const repl = applyFix(fm(['allowed-tools: Read, MultiEdit']), { op: 'list-replace', key: 'allowed-tools', item: 'MultiEdit', with: 'Edit', label: '', safety: 'safe' });
  assert.match(repl.text, /^allowed-tools: Read, Edit$/m);
  const crlf = applyFix(fm(['name: x', 'allowed-tools: Read, WebFetch']).replaceAll('\n', '\r\n'), { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' });
  assert.ok(crlf.text.includes('\r\n') && !/[^\r]\n/.test(crlf.text), 'line endings kept');
  const branches = fm(['name: x', '# docs:on', 'allowed-tools: [Read, WebFetch, mcp__docs__lookup]', '# docs:off', 'allowed-tools: [Read, WebFetch]', '# docs:end']);
  const both = applyFix(branches, { op: 'list-remove', key: 'allowed-tools', item: 'WebFetch', label: '', safety: 'review' });
  assert.equal(both.text, fm(['name: x', '# docs:on', 'allowed-tools: [Read, mcp__docs__lookup]', '# docs:off', 'allowed-tools: [Read]', '# docs:end']), 'both branches edited, markers untouched');
});

test('lineDiff: removals before additions, numbered, far-apart changes as separate hunks', () => {
  const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const b = [...a]; b[2] = 'X'; b[17] = 'Y';
  const d = lineDiff(a.join('\n'), b.join('\n'), 1);
  const lines = d.split('\n');
  assert.ok(lines.indexOf('-   3  l2') < lines.indexOf('+   3  X'));
  assert.ok(lines.includes('  ...'), 'unchanged middle is elided');
  assert.equal(lineDiff('same', 'same'), '');
});

test('round trip: every autofix the fixture pack proposes removes its finding and keeps the file parseable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-fixrt-'));
  await fs.cp(PACK, root, { recursive: true });
  try {
    const { diagnostics } = await runLint([root], { _: [root], harness: [] });
    const fixable = diagnostics.filter((x) => x.autofix);
    const codes = new Set(fixable.map((x) => x.code));
    for (const c of ['dead-privilege', 'model-invocable-writer', 'supervised-but-auto', 'readonly-not-enforced']) assert.ok(codes.has(c), `the fixture pack exercises ${c}`);
    for (const x of fixable) {
      const text = await fs.readFile(x.path, 'utf8');
      const r = applyFix(text, x.autofix);
      assert.ok(r.ok, `${x.code} ${x.autofix.label}: ${r.reason}`);
      await fs.writeFile(x.path, r.text);
      const after = (await runLint([x.path], { _: [x.path], harness: [] })).diagnostics;
      assert.ok(!after.some((y) => y.code === x.code && JSON.stringify(y.autofix) === JSON.stringify(x.autofix)), `${x.code} still fires after "${x.autofix.label}"`);
      assert.ok(!after.some((y) => y.code === 'frontmatter-syntax'), `${x.autofix.label} broke the frontmatter`);
      await fs.writeFile(x.path, text);                       // one fix at a time, from the original
    }
    assert.ok(fixable.every((x) => x.autofix.safety === 'safe' || x.autofix.safety === 'review'));
    assert.ok(fixable.filter((x) => x.code === 'dead-privilege').every((x) => x.autofix.safety === 'review'), 'a heuristic rule never offers a safe fix');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('CLI: lint prints the advice; --fix previews; --write applies safe fixes, review ones only with --only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-fixcli-'));
  await fs.cp(PACK, root, { recursive: true });
  const dead = path.join(root, 'skills', 'fx-dead', 'SKILL.md');
  const orig = await fs.readFile(dead, 'utf8');
  try {
    const lint = await saut(['lint', path.join(root, 'skills', 'fx-dead')]);
    assert.match(lint.stdout, /→ Remove WebFetch from allowed-tools \(saut lint --fix\)/);
    const preview = await saut(['lint', path.join(root, 'skills', 'fx-dead'), '--fix']);
    assert.match(preview.stdout, /Remove WebFetch from allowed-tools \(review\)/);
    assert.match(preview.stdout, /nothing written/);
    assert.equal(await fs.readFile(dead, 'utf8'), orig, 'a preview writes nothing');
    const noOnly = await saut(['lint', path.join(root, 'skills', 'fx-dead'), '--fix', '--write']);
    assert.match(noOnly.stdout, /review — check the diff, then --only dead-privilege/);
    assert.equal(await fs.readFile(dead, 'utf8'), orig, 'review fixes are not written without --only');
    const withOnly = await saut(['lint', path.join(root, 'skills', 'fx-dead'), '--fix', '--write', '--only', 'dead-privilege', '--json']);
    const j = JSON.parse(withOnly.stdout);
    assert.equal(j.write, true);
    assert.ok(j.files[0].written);
    assert.doesNotMatch(await fs.readFile(dead, 'utf8'), /WebFetch/);
    assert.equal((await saut(['lint', root, '--write'])).code, 2, '--write without --fix is a usage error');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('safe fixes (unreachable, legacy-tool) are written by --fix --write without --only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-fixsafe-'));
  const mk = async (name, lines) => {
    await fs.mkdir(path.join(root, 'skills', name), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', name, 'SKILL.md'), ['---', `name: ${name}`, `description: A test skill. Invoke: ${name}.`, ...lines, '---', `# ${name}`, 'Read the files, then Edit the one that is wrong.', ''].join('\n'));
  };
  await mk('fx-hidden', ['user-invocable: false', 'disable-model-invocation: true', 'allowed-tools: Read, Edit']);
  await mk('fx-legacy', ['disable-model-invocation: true', 'allowed-tools: Read, MultiEdit']);
  try {
    const r = await saut(['lint', root, '--fix', '--write']);
    assert.match(r.stdout, /Set user-invocable: true/);
    assert.match(r.stdout, /Replace MultiEdit with Edit/);
    assert.match(await fs.readFile(path.join(root, 'skills', 'fx-hidden', 'SKILL.md'), 'utf8'), /^user-invocable: true$/m);
    assert.match(await fs.readFile(path.join(root, 'skills', 'fx-legacy', 'SKILL.md'), 'utf8'), /^allowed-tools: Read, Edit$/m);
    const after = await saut(['lint', root, '--json']);
    const codes = JSON.parse(after.stdout).diagnostics.map((x) => x.code);
    assert.ok(!codes.includes('unreachable') && !codes.includes('legacy-tool'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
