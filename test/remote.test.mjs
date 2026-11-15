// Remote targets: a repository URL is fetched read-only into a throwaway directory, scanned,
// and removed. The suite builds its own repository (file://) — it never reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run, saut } from './helpers.mjs';
import { isRemoteTarget, parseRemote } from '../lib/remote.mts';

const SKILL = (name, extra = '') => `---\nname: ${name}\ndescription: Reviews a diff for one thing; use when asked to review.\nallowed-tools: Read, Grep\ndisable-model-invocation: true\n${extra}---\n\nRead the diff and report.\n`;

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-remote-src-'));
  const g = (...a) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...a], { cwd: dir });
  await g('init', '-q');
  await fs.mkdir(path.join(dir, 'skills', 'review'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'review', 'SKILL.md'), SKILL('review'));
  // a secret outside the repository, and a skill that is a symlink to it
  const secret = path.join(dir, '..', path.basename(dir) + '-secret.md');
  await fs.writeFile(secret, SKILL('stolen') + 'TOPSECRET\n');
  await fs.mkdir(path.join(dir, 'skills', 'evil'), { recursive: true });
  await fs.symlink(secret, path.join(dir, 'skills', 'evil', 'SKILL.md'));
  await g('add', '-A');
  await g('commit', '-q', '-m', 'one');
  await g('checkout', '-q', '-b', 'next');
  await fs.mkdir(path.join(dir, 'skills', 'extra'), { recursive: true });
  await fs.writeFile(path.join(dir, 'skills', 'extra', 'SKILL.md'), SKILL('extra'));
  await g('add', '-A');
  await g('commit', '-q', '-m', 'two');
  await g('checkout', '-q', 'main');
  return { dir, url: pathToFileURL(dir).href, cleanup: () => Promise.all([fs.rm(dir, { recursive: true, force: true }), fs.rm(secret, { force: true })]) };
}

async function leftovers() {
  return (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('saut-remote-') && !n.startsWith('saut-remote-src-'));
}

test('repository URLs: forms, refs, sub-paths, browse URLs; local paths are not URLs', () => {
  assert.equal(isRemoteTarget('skills/review'), false);
  assert.equal(isRemoteTarget('./x:y'), false);
  assert.equal(isRemoteTarget('git@github.com:o/r.git'), true);
  assert.deepEqual(parseRemote('https://github.com/o/r.git#v1.2:skills/review'),
    { url: 'https://github.com/o/r.git', ref: 'v1.2', subpath: 'skills/review', label: 'github.com/o/r' });
  assert.deepEqual(parseRemote('https://github.com/o/r/tree/main/skills/review'),
    { url: 'https://github.com/o/r', ref: 'main', subpath: 'skills/review', label: 'github.com/o/r' });
  assert.deepEqual(parseRemote('https://gitlab.example.com/g/sub/r/-/tree/dev/a'),
    { url: 'https://gitlab.example.com/g/sub/r', ref: 'dev', subpath: 'a', label: 'gitlab.example.com/g/sub/r' });
  assert.deepEqual(parseRemote('https://github.com/o/r/blob/main/agents/x.md').subpath, 'agents/x.md', 'a blob URL names the file');
  assert.deepEqual(parseRemote('git@github.com:o/r.git#:skills'), { url: 'git@github.com:o/r.git', ref: null, subpath: 'skills', label: 'github.com/o/r' });
  for (const bad of ['http://github.com/o/r', 'git://github.com/o/r', 'ext::sh -c x', 'https://u:token@github.com/o/r', 'https://ghp_x@github.com/o/r', 'https://github.com/o/r#main:../up', 'https://github.com/o/r#--upload-pack=x', 'https://github.com/o/r?x=1'])
    assert.throws(() => { if (!isRemoteTarget(bad)) throw new Error('not remote'); parseRemote(bad); }, undefined, bad);
});

test('lint a file:// repository: findings name repo@commit, symlinks stay plain files, nothing is left behind', async () => {
  const repo = await makeRepo();
  const before = await leftovers();
  try {
    const r = await saut(['lint', repo.url, '--json']);
    const j = JSON.parse(r.stdout);
    assert.equal(j.sources.length, 1);
    assert.match(j.sources[0].commit, /^[0-9a-f]{40}$/);
    const names = j.artifacts.map((a) => a.name).sort();
    assert.deepEqual(names, ['evil', 'review'], 'the symlinked SKILL.md is checked out as a plain file holding a path');
    assert.ok(!r.stdout.includes('TOPSECRET') && !r.stdout.includes('stolen'));
    assert.ok(j.artifacts.every((a) => a.path.startsWith(`${path.basename(repo.dir)}@${j.sources[0].commit.slice(0, 12)}/`)), j.artifacts[0].path);
    assert.doesNotMatch(r.stdout, /saut-remote-(?!src-)/, 'no throwaway path in the output');
    assert.deepEqual(await leftovers(), before, 'the throwaway directory is removed');
  } finally { await repo.cleanup(); }
});

test('a ref and a sub-path; SARIF records the repository and commit', async () => {
  const repo = await makeRepo();
  try {
    const j = JSON.parse((await saut(['cost', `${repo.url}#next:skills/extra`, '--json'])).stdout);
    assert.deepEqual(j.lines.map((l) => l.artifact), ['extra']);
    assert.equal(j.sources[0].ref, 'next');
    const s = JSON.parse((await saut(['lint', `${repo.url}#next:skills/extra`, '--sarif'])).stdout).runs[0];
    assert.equal(s.versionControlProvenance[0].repositoryUri, repo.url.replace(/\/$/, ''));
    assert.equal(s.versionControlProvenance[0].branch, 'next');
    assert.equal(s.originalUriBaseIds, undefined, 'no file:// base pointing at a deleted directory');
    for (const x of s.results) assert.match(x.locations[0].physicalLocation.artifactLocation.uri, /^skills\/extra\//);
  } finally { await repo.cleanup(); }
});

test('remote targets: refused where content would run or be written; unknown refs and paths fail cleanly', async () => {
  const repo = await makeRepo();
  const before = await leftovers();
  try {
    for (const [args, re] of [
      [['test', repo.url], /local paths only/],
      [['preview', 'x', repo.url], /local paths only/],
      [['lint', repo.url, '--live'], /--live/],
      [['lint', repo.url, '--fix'], /--fix/],
      [['lint', `${repo.url}#nope`], /git fetch failed/],
      [['lint', `${repo.url}#main:skills/missing`], /no "skills\/missing"/],
    ]) {
      const r = await saut(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, re, args.join(' '));
    }
    assert.deepEqual(await leftovers(), before);
  } finally { await repo.cleanup(); }
});

// The Studio: `saut studio` with no argument is the launcher; a URL entered there is fetched and
// served by a read-only Studio of its own; closing the launcher removes the fetched copy.
import { startStudio } from '../lib/studio/server.mts';

async function session(url) {
  const launch = await fetch(url, { redirect: 'manual' });
  const cookie = launch.headers.get('set-cookie').split(';')[0];
  const base = new URL(url).origin;
  const html = await (await fetch(base + '/', { headers: { cookie } })).text();
  const token = html.match(/name="saut-token" content="([0-9a-f]+)"/)[1];
  const h = (ws) => ({ 'x-saut-token': token, ...(ws ? { 'x-saut-ws': ws } : {}) });
  const get = async (p, ws) => (await fetch(base + p, { headers: h(ws) })).json();
  const post = (p, body, ws) => fetch(base + p, { method: 'POST', headers: { ...h(ws), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { cookie, get, post };
}

test('Studio launcher: a repository opens in the same page (relayed, read-only); Close removes it', async () => {
  const repo = await makeRepo();
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-launcher-test-'));
  const before = await leftovers();
  const studio = await startStudio(empty, { _: [], launcher: true });
  try {
    const home = await session(studio.url);
    const ctx = await home.get('/api/context');
    assert.equal(ctx.mode, 'launcher');
    assert.equal(ctx.capabilities.remote, true);
    assert.equal(ctx.capabilities.write, false);
    assert.equal((await home.post('/api/save', { path: 'x/SKILL.md', text: '' })).status, 403, 'the launcher has nothing to write');
    const bad = await home.post('/api/remote', { url: '/etc' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /git repository URL/);

    const opened = await (await home.post('/api/remote', { url: `${repo.url}#main:skills` })).json();
    assert.match(opened.id, /^[0-9a-f]{16}$/);
    assert.equal(opened.url, undefined, 'the page is never sent to another origin');
    const rc = await home.get('/api/context', opened.id);
    assert.equal(rc.remote.commit, opened.commit);
    assert.match(rc.root, /@[0-9a-f]{12}\/skills$/);
    assert.deepEqual(Object.entries(rc.capabilities).filter(([, v]) => v).map(([k]) => k), ['scan']);
    assert.ok(rc.artifacts.some((a) => a.name === 'review'));
    const pass = await home.get('/api/artifact?path=' + encodeURIComponent(rc.artifacts.find((a) => a.name === 'review').path), opened.id);
    assert.match(pass.readOnly, /remote repository/);
    for (const p of ['/api/save', '/api/fix', '/api/test', '/api/suppress', '/api/review', '/api/validate', '/api/case', '/api/check', '/api/remote'])
      assert.equal((await home.post(p, {}, opened.id)).status, 403, p);
    const foreign = await fetch(new URL(studio.url).origin + '/api/save', { method: 'POST', headers: { 'x-saut-token': 'x', 'x-saut-ws': opened.id } });
    assert.equal(foreign.status, 403, 'the relay sits behind this Studio\'s own token');
    assert.equal((await leftovers()).length, before.length + 1, 'one fetched copy while it is open');

    assert.deepEqual(await (await home.post('/api/remote/close', { id: opened.id })).json(), { closed: true });
    const after = await home.get('/api/context', opened.id);
    assert.equal(after.closedRepo, true, 'a closed repository is reported, not served');
    assert.deepEqual(await leftovers(), before, 'Close removes the fetched copy');

    await home.post('/api/remote', { url: repo.url });
  } finally {
    await studio.close();
    await fs.rm(empty, { recursive: true, force: true });
    await repo.cleanup();
  }
  assert.deepEqual(await leftovers(), before, 'stopping the Studio removes what is still open');
});

test('saut report on a repository URL: Markdown, HTML and JSON from one scan; exit as lint', async () => {
  const repo = await makeRepo();
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'saut-report-out-'));
  try {
    const md = await saut(['report', `${repo.url}#next`]);
    assert.equal(md.code, 1, 'the symlink-turned-plain-file skill has high findings — exit as lint');
    assert.match(md.stdout, /^# SAUT report — /);
    assert.match(md.stdout, /commit `[0-9a-f]{40}`/);
    assert.match(md.stdout, /## Security at a glance/);
    assert.match(md.stdout, /### skill review/);
    assert.match(md.stdout, /### skill extra/);
    assert.doesNotMatch(md.stdout, /saut-remote-(?!src-)/, 'no throwaway path');

    const html = path.join(out, 'r.html');
    const h = await saut(['report', repo.url, '--out', html]);
    assert.match(h.stderr, /→ .*r\.html/);
    const page = await fs.readFile(html, 'utf8');
    assert.match(page, /^<!doctype html>/);
    assert.match(page, /prefers-color-scheme: dark/);
    assert.ok(!page.includes('<script'), 'a static page');

    const j = JSON.parse((await saut(['report', repo.url, '--json'])).stdout);
    assert.equal(j.source.kind, 'remote');
    assert.equal(j.verdict.exit, 1);
    assert.match(j.verdict.reason, /high finding/);
    assert.equal(j.totals.skills, j.artifacts.filter((a) => a.kind === 'skill').length);
    assert.ok(j.artifacts.every((a) => Array.isArray(a.enforcement) && a.cost));
    assert.equal((await saut(['report', repo.url, '--format', 'pdf'])).code, 2);
  } finally { await repo.cleanup(); await fs.rm(out, { recursive: true, force: true }); }
});
