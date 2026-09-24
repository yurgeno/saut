// S5: suppressing a finding with a reason in saut.json — marked, not dropped; a stale one is
// reported — and the security view: scanner status, a scan from the Studio, the summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applySuppressions, loadSuppressions, matchFor } from '../lib/suppress.mts';
import { startStudio } from '../lib/studio/server.mts';
import { PACK, saut } from './helpers.mjs';

async function copyPack() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-sup-'));
  await fs.cp(PACK, root, { recursive: true });
  return root;
}

test('loading: a suppression without a reason is ignored and reported; a good one loads', async () => {
  const root = await copyPack();
  try {
    await fs.writeFile(path.join(root, 'saut.json'), JSON.stringify({ budgets: {}, suppress: [
      { rule: 'dead-privilege', artifact: 'fx-dead', match: 'WebFetch', reason: 'fetched by the wrapper script, not by name' },
      { rule: 'dead-privilege', artifact: 'fx-dead', reason: 'short' },
      { artifact: 'fx-dead', reason: 'no rule named here at all' },
    ] }));
    const set = await loadSuppressions(path.join(root, 'skills', 'fx-dead', 'SKILL.md'));
    assert.equal(set.file, path.join(root, 'saut.json'), 'found walking up from the artifact');
    assert.equal(set.list.length, 1);
    assert.equal(set.problems.length, 2);
    assert.ok(set.problems.every((p) => p.code === 'suppression-invalid'));
    assert.match(set.problems[0].message, /needs a reason of at least 8 characters/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('applying: matched findings are marked with the reason; an unused suppression is reported', () => {
  const ds = [
    { code: 'dead-privilege', severity: 'medium', path: '/p/a/SKILL.md', message: '"WebFetch" is granted but the body never mentions it' },
    { code: 'dead-privilege', severity: 'medium', path: '/p/a/SKILL.md', message: '"Grep" is granted but the body never mentions it' },
  ];
  const set = { file: '/p/saut.json', problems: [], list: [
    { rule: 'dead-privilege', artifact: 'a', match: 'WebFetch', reason: 'used by the wrapper' },
    { rule: 'secret-pattern', artifact: 'a', reason: 'it was a test key, long gone' },
  ] };
  const out = applySuppressions(ds, new Map([['/p/a/SKILL.md', 'a']]), set);
  assert.deepEqual(out[0].suppressed, { reason: 'used by the wrapper', file: '/p/saut.json' });
  assert.equal(out[1].suppressed, undefined, 'the match pins it to one finding');
  assert.equal(out.at(-1).code, 'suppression-unused');
  assert.match(out.at(-1).message, /secret-pattern on a matches no finding/);
  assert.equal(matchFor(ds[0]), 'WebFetch');
  assert.equal(matchFor({ message: 'no quoted subject' }), undefined);
});

test('CLI: suppressed findings stay visible, stop counting, carry the reason into SARIF; stale ones are reported', async () => {
  const root = await copyPack();
  try {
    const dir = path.join(root, 'skills', 'fx-only-high');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: fx-only-high\ndescription: Reports on the files. Invoke: fx-only-high.\ndisable-model-invocation: true\n---\n# fx-only-high\nRead the files and report.\n');
    const before = await saut(['lint', dir]);
    assert.equal(before.code, 1, 'no-allowlist is high');
    await fs.writeFile(path.join(root, 'saut.json'), JSON.stringify({ suppress: [
      { rule: 'no-allowlist', artifact: 'fx-only-high', reason: 'runs in a sandbox with a fixed toolset' },
      { rule: 'secret-pattern', artifact: 'fx-only-high', reason: 'left over from an old key, now gone' },
    ] }));
    const after = await saut(['lint', dir]);
    assert.equal(after.code, 0, 'a suppressed high no longer fails the lint');
    assert.match(after.stdout, /suppressed no-allowlist — runs in a sandbox with a fixed toolset/);
    assert.match(after.stdout, /suppression-unused .*saut\.json — the suppression of secret-pattern on fx-only-high matches no finding/);
    const j = JSON.parse((await saut(['lint', dir, '--json'])).stdout);
    const d = j.diagnostics.find((x) => x.code === 'no-allowlist');
    assert.equal(d.suppressed.reason, 'runs in a sandbox with a fixed toolset');
    const sarif = JSON.parse((await saut(['lint', dir, '--sarif'])).stdout);
    const r = sarif.runs[0].results.find((x) => x.ruleId === 'no-allowlist');
    assert.deepEqual(r.suppressions, [{ kind: 'external', justification: 'runs in a sandbox with a fixed toolset' }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Studio: suppress through a diff, see it marked with its reason, lift it; the Overview stops counting it', async () => {
  const root = await copyPack();
  const s = await startStudio(root, { _: [] });
  const base = `http://127.0.0.1:${s.port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-saut-token': s.token }, body: JSON.stringify(body) });
  const get = (p) => fetch(base + p, { headers: { 'x-saut-token': s.token } }).then((r) => r.json());
  try {
    const rel = 'skills/fx-dead/SKILL.md';
    const ov0 = await get('/api/overview');
    const row0 = ov0.rows.find((r) => r.name === 'fx-dead');
    const req = { path: rel, rule: 'dead-privilege', artifact: 'fx-dead', match: 'WebFetch', reason: 'fetched by the wrapper script, not by name' };
    assert.equal((await post('/api/suppress', { ...req, reason: 'short' })).status, 400, 'a reason is required');
    const preview = await (await post('/api/suppress', req)).json();
    assert.equal(preview.file, 'saut.json');
    assert.match(preview.diff, /"reason": "fetched by the wrapper script, not by name"/);
    assert.equal(await fs.stat(path.join(root, 'saut.json')).then(() => true, () => false), false, 'a preview writes nothing');
    assert.equal((await post('/api/suppress', { ...req, base: 'x', apply: true })).status, 400, 'a stale preview is refused');
    await post('/api/suppress', { ...req, base: preview.base, apply: true });
    const pass = await get('/api/artifact?path=' + encodeURIComponent(rel));
    const sup = pass.findings.find((f) => f.code === 'dead-privilege' && /WebFetch/.test(f.message));
    assert.equal(sup.suppressed.reason, 'fetched by the wrapper script, not by name');
    const row1 = (await get('/api/overview')).rows.find((r) => r.name === 'fx-dead');
    assert.equal(row1.medium, row0.medium - 1, 'no longer counted');
    assert.equal(row1.suppressed, 1);
    const lift = await (await post('/api/suppress', { path: rel, rule: 'dead-privilege', artifact: 'fx-dead', match: 'WebFetch', remove: true })).json();
    await post('/api/suppress', { path: rel, rule: 'dead-privilege', artifact: 'fx-dead', match: 'WebFetch', remove: true, base: lift.base, apply: true });
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'saut.json'), 'utf8')).suppress, undefined, 'the last entry gone, the key goes too');
  } finally { await s.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Studio: scanner status is honest; a scan from the Studio joins the passport and the Overview', async () => {
  const root = await copyPack();
  const s = await startStudio(root, { _: [] });
  const base = `http://127.0.0.1:${s.port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-saut-token': s.token }, body: JSON.stringify(body) });
  const get = (p) => fetch(base + p, { headers: { 'x-saut-token': s.token } }).then((r) => r.json());
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-scanbin-'));
  const old = process.env.PATH;
  try {
    process.env.PATH = `/usr/bin:/bin`;                        // no scanner anywhere
    const none = await get('/api/overview');
    assert.deepEqual(none.security.scanners.installed, []);
    assert.ok(none.security.scanners.known.length >= 3, 'names the scanners one could install');
    const noRun = await (await post('/api/scan', {})).json();
    assert.deepEqual(noRun.ran, []);
    assert.match(noRun.note, /no content scanner installed/);

    await fs.writeFile(path.join(bin, 'skillspector'), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ findings: [{ id: 'PROMPT_INJECTION', severity: 'critical', message: 'instruction override phrase', file: 'skills/fx-clean/SKILL.md', line: 3 }] })}\nEOF\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}/usr/bin:/bin`;
    const r = await (await post('/api/scan', {})).json();
    assert.deepEqual(r.ran, ['skillspector']);
    const ov = await get('/api/overview');
    assert.equal(ov.security.scanners.last.findings, 1);
    assert.ok(ov.security.rules.some((x) => x.code === 'scan-prompt_injection' && x.artifacts.includes('fx-clean')));
    const pass = await get('/api/artifact?path=' + encodeURIComponent('skills/fx-clean/SKILL.md'));
    const f = pass.findings.find((x) => x.code === 'scan-prompt_injection');
    assert.equal(f.category, 'scanner');
    assert.equal(f.severity, 'high');
  } finally { process.env.PATH = old; await s.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(bin, { recursive: true, force: true }); }
});
