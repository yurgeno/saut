// SAUT Studio — the page. Four views over one backend: Overview (every artifact and what is
// wrong with it), Skill (edit + inspect one), Bench (run it), Harnesses (the registry).
//
// The page talks to its backend through `backend` only; it never learns where the root lives
// (paths are relative) and it shows or hides features by `ctx.capabilities`, not by guessing
// whether it runs locally. A hosted Studio swaps the backend and keeps this file.
import * as CM from './vendor/codemirror.js';

const TOKEN = document.querySelector('meta[name="saut-token"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// inline `code` in rule text → <code>; everything else escaped
const md = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');

// Every /api route requires the token, reads included — so GETs carry the header too.
async function api(path, body) {
  const r = await fetch(path, body === undefined ? { headers: { 'x-saut-token': TOKEN } } : {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-saut-token': TOKEN }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

const backend = {
  context: () => api('/api/context'),
  overview: () => api('/api/overview'),
  artifact: (p) => api('/api/artifact?path=' + encodeURIComponent(p)),
  check: (payload) => api('/api/check', payload),
  compose: (payload) => api('/api/compose', payload),
  save: (payload) => api('/api/save', payload),
  fix: (payload) => api('/api/fix', payload),
  bench: (payload) => api('/api/test', payload),
  benchEvents: (id) => new EventSource('/api/test/' + id + '/events?token=' + TOKEN),
  validate: () => api('/api/validate', {}),
};

// Per-viewer conveniences only (a remembered target set, the last view) — never state that matters.
const store = {
  get(k, d) { try { const v = localStorage.getItem('saut.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('saut.' + k, JSON.stringify(v)); } catch { /* private window */ } },
};

let ctx = null, ov = null, current = null, dirty = false, selectedTools = [], benchSel = [];
let editMode = 'form', baseText = null, targets = new Set(), sort = { key: 'high', dir: -1 }, codeFilter = null;

function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  t.style.borderColor = bad ? '#6d2f2f' : '#242b36';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 5200);
}

// Every edit marks the form dirty; anything that would replace it asks first.
function setDirty(v) { dirty = v; $('dirtyMark').hidden = !v; if (!v) $('liveBadge').hidden = true; if (ctx) updateMeasure(); }
function confirmDiscard() {
  if (!dirty) return true;
  const what = (current && current.name) || $('f_name').value.trim() || 'this artifact';
  return confirm('Unsaved changes to ' + what + ' will be lost. Discard them?');
}

// ── views ─────────────────────────────────────────────────────────
function show(view) {
  for (const b of document.querySelectorAll('.view-btn')) b.classList.toggle('active', b.dataset.view === view);
  for (const v of ['overview', 'skill', 'bench', 'harnesses']) $('view-' + v).hidden = v !== view;
  if (view === 'bench') drawBenchHead();
  if (view === 'skill' && current) requestAnimationFrame(() => { bodyView.requestMeasure(); sourceView.requestMeasure(); });
  store.set('view', view);
}
for (const b of document.querySelectorAll('.view-btn')) b.onclick = () => {
  if (b.dataset.view === 'skill' && !current) return toast('open a skill or agent from the Overview');
  show(b.dataset.view);
};

// ── editors (CodeMirror) ─────────────────────────────────────────
const theme = CM.EditorView.theme({
  '&': { color: '#dde2ea', backgroundColor: '#10141b', fontSize: '12.5px' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', caretColor: '#dde2ea' },
  '.cm-gutters': { backgroundColor: '#10141b', color: '#566072', border: 'none' },
  '.cm-activeLine': { backgroundColor: '#151b25' }, '.cm-activeLineGutter': { backgroundColor: '#151b25' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#264064' },
  '.cm-cursor': { borderLeftColor: '#dde2ea' },
  '.cm-searchMatch': { backgroundColor: '#3a4a1f' },
  '.cm-panels': { backgroundColor: '#151a22', color: '#dde2ea' },
}, { dark: true });
const hl = CM.HighlightStyle.define([
  { tag: CM.tags.heading, color: '#9fc4ff', fontWeight: '600' },
  { tag: [CM.tags.strong], fontWeight: '700', color: '#e8ecf2' },
  { tag: [CM.tags.emphasis], fontStyle: 'italic' },
  { tag: [CM.tags.monospace, CM.tags.string], color: '#c7a8ff' },
  { tag: [CM.tags.link, CM.tags.url], color: '#6fb6ff' },
  { tag: [CM.tags.propertyName, CM.tags.definition(CM.tags.propertyName)], color: '#e4b45e' },
  { tag: [CM.tags.bool, CM.tags.number, CM.tags.atom], color: '#6fd49a' },
  { tag: [CM.tags.comment, CM.tags.meta, CM.tags.processingInstruction], color: '#6c7688' },
  { tag: CM.tags.list, color: '#dde2ea' },
]);

// Finding lines, tinted by severity.
const setMarks = CM.StateEffect.define();
const markField = CM.StateField.define({
  create: () => CM.Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMarks)) {
      const b = new CM.RangeSetBuilder();
      for (const m of [...e.value].sort((x, y) => x.line - y.line)) {
        if (m.line < 1 || m.line > tr.state.doc.lines) continue;
        b.add(tr.state.doc.line(m.line).from, tr.state.doc.line(m.line).from, CM.Decoration.line({ class: 'find-' + m.severity }));
      }
      deco = b.finish();
    }
    return deco;
  },
  provide: (f) => CM.EditorView.decorations.from(f),
});

let quiet = false;                 // programmatic doc replacement is not an edit
function makeEditor(host, withFrontmatter) {
  const ro = new CM.Compartment();
  const view = new CM.EditorView({
    parent: host,
    state: CM.EditorState.create({ doc: '', extensions: [
      CM.basicSetup, withFrontmatter ? CM.yamlFrontmatter({ content: CM.markdown() }) : CM.markdown(),
      theme, CM.syntaxHighlighting(hl), CM.EditorView.lineWrapping, markField,
      ro.of([CM.EditorState.readOnly.of(false), CM.EditorView.editable.of(true)]),
      CM.EditorView.updateListener.of((u) => { if (u.docChanged && !quiet) onEdit(); }),
    ] }),
  });
  view._ro = ro;
  return view;
}
const bodyView = makeEditor($('bodyEditor'), false);
const sourceView = makeEditor($('sourceEditor'), true);
const textOf = (v) => v.state.doc.toString();
function setDoc(v, text) { quiet = true; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); quiet = false; }
function setReadOnly(v, ro) { v.dispatch({ effects: v._ro.reconfigure([CM.EditorState.readOnly.of(ro), CM.EditorView.editable.of(!ro)]) }); }

// ── context + header ─────────────────────────────────────────────
async function loadContext() {
  ctx = await backend.context();
  const saved = store.get('targets', null);
  targets = new Set((saved && saved.length ? saved : ctx.harnesses.map((h) => h.id)).filter((id) => ctx.harnesses.some((h) => h.id === id)));
  drawHeader(); drawGuidanceBar(); drawToolPicker(); drawHarnessCards(); drawArtifactList();
  $('tautBlock').hidden = !ctx.taut;
  $('validate').hidden = !ctx.capabilities.validate;
  $('runBench').disabled = !ctx.capabilities.bench;
}

function drawHeader() {
  const mode = { taut: 'TAUT pack', compiled: 'compiled workspace', generic: 'skills folder' }[ctx.mode] || ctx.mode;
  $('mode').textContent = mode;
  $('mode').className = 'pill ' + (ctx.mode === 'taut' ? 'on' : ctx.mode === 'compiled' ? 'warn' : '');
  $('rootName').textContent = ctx.root + (ctx.taut ? ' · deployment ' + (ctx.taut.deployment || '—') + (ctx.taut.engineCommit ? ' · engine @' + ctx.taut.engineCommit : '') : '') + (ctx.note ? ' · ' + ctx.note : '');
  $('targets').innerHTML = '<span class="muted">targets</span> ' + ctx.harnesses.map((h) =>
    '<button class="pill ' + (targets.has(h.id) ? 'on' : '') + '" data-h="' + esc(h.id) + '" title="' + esc(h.title) + '">' + esc(h.id) + '</button>').join('');
  for (const b of $('targets').querySelectorAll('button')) b.onclick = () => {
    if (targets.has(b.dataset.h)) { if (targets.size > 1) targets.delete(b.dataset.h); } else targets.add(b.dataset.h);
    store.set('targets', [...targets]);
    drawHeader(); drawOverview(); if (current && current.findings) drawInspector(current); drawBenchHarnesses();
  };
}

function drawGuidanceBar() {
  const g = ctx.guidance;
  if (!g) { $('guidanceBar').innerHTML = ''; return; }
  const age = g.ageDays === 0 ? 'today' : g.ageDays === 1 ? '1 day ago' : g.ageDays + ' days ago';
  const parts = g.parts.map((p) => esc(p.what) + ' ' + esc(p.verifiedAt) + (p.stale ? ' (stale)' : '')).join(' · ');
  let html = '<span class="pill ' + (g.stale ? 'warn' : 'ok') + '" title="' + parts + '">vendor guidance verified ' + esc(g.verifiedAt) + ' · ' + age + '</span>' +
    (g.stale ? ' <span class="warn">older than ' + g.maxAgeDays + ' days — re-verify: <code>saut guidance</code></span>' : '');
  const pf = ctx.packFindings || [];
  if (pf.length) html += '<details><summary class="' + (pf.some((f) => f.severity === 'high') ? 'bad' : 'warn') + '">pack model ladder: ' + pf.length + ' finding' + (pf.length === 1 ? '' : 's') + '</summary>' +
    pf.map((f) => '<div class="packfind"><span class="code">' + esc(f.code) + (f.line ? ' · deployment.json:' + f.line : '') + '</span> — ' + md(f.message) + '</div>').join('') + '</details>';
  $('guidanceBar').innerHTML = html;
}

// ── overview ──────────────────────────────────────────────────────
async function loadOverview() {
  ov = await backend.overview();
  drawOverview();
}

const COLS = [
  { key: 'name', label: 'Artifact' },
  { key: 'high', label: 'High', num: true, title: 'high-severity findings' },
  { key: 'medium', label: 'Medium', num: true },
  { key: 'security', label: 'Security', num: true, title: 'findings in the security category' },
  { key: 'guidance', label: 'Guidance A·B·D', num: true, title: 'vendor guidance: A outdated · B hypothesis · D hardening' },
  { key: 'fixable', label: 'Fixable', num: true, title: 'findings with a mechanical fix' },
  { key: 'alwaysOn', label: 'Always-on', num: true, title: 'tokens paid in every session (name + description)' },
  { key: 'invoke', label: 'On invoke', num: true, title: 'tokens when it runs (body + wired agents)' },
];

function visibleRows() {
  if (!ov) return [];
  const q = $('ovFilter').value.trim().toLowerCase();
  const kind = $('ovKind').value;
  const only = $('ovOnlyFindings').checked;
  const rows = ov.rows.filter((r) => (!kind || r.kind === kind) && (!only || r.high + r.medium > 0) && (!codeFilter || (r.codes || []).includes(codeFilter))
    && (!q || r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)));
  const val = (r) => sort.key === 'guidance' ? r.guidance.A * 100 + r.guidance.B * 10 + r.guidance.D : r[sort.key];
  return rows.sort((a, b) => sort.key === 'name' ? a.name.localeCompare(b.name) * sort.dir : (val(a) - val(b)) * sort.dir || a.name.localeCompare(b.name));
}

function drawOverview() {
  if (!ov) return;
  const t = ov.totals;
  const stat = (n, l, cls) => '<div class="stat"><div class="n ' + (cls || '') + '">' + n + '</div><div class="l">' + l + '</div></div>';
  $('summaryCards').innerHTML =
    stat(t.artifacts, 'skills and agents') +
    stat(t.high, 'high findings', t.high ? 'bad' : 'ok') +
    stat(t.security, 'security findings', t.security ? 'warn' : 'ok') +
    stat(t.outdated, 'outdated settings (A)', t.outdated ? 'bad' : 'ok') +
    stat(t.hypotheses, 'prompt hypotheses (B)', t.hypotheses ? 'warn' : '') +
    stat(t.fixable, 'with a mechanical fix') +
    stat(t.alwaysOn.toLocaleString(), 'tokens in every session');
  drawSecurity();
  $('codeFilterChip').innerHTML = codeFilter ? '<span class="pill on">rule: ' + esc(codeFilter) + ' <button aria-label="clear the rule filter">×</button></span>' : '';
  if (codeFilter) $('codeFilterChip').querySelector('button').onclick = () => { codeFilter = null; drawOverview(); };
  const tgt = ctx.harnesses.filter((h) => targets.has(h.id));
  const head = '<thead><tr>' + COLS.map((c) => '<th class="' + (c.num ? 'num' : '') + '" data-k="' + c.key + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + c.label + (sort.key === c.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : '') + '</th>').join('') +
    tgt.map((h) => '<th title="what the allowlist is on ' + esc(h.title) + '">' + esc(h.id) + '</th>').join('') + '</tr></thead>';
  const n = (v) => v ? String(v) : '<span class="zero">0</span>';
  const rows = visibleRows();
  const body = rows.map((r) => '<tr data-path="' + esc(r.path) + '">' +
    '<td class="name"><span class="k">' + r.kind + '</span><b>' + esc(r.name) + '</b>' +
    (r.compiled ? ' <span class="pill warn" title="compiled from ' + esc(r.compiled.pack || 'the pack') + ': ' + esc(r.compiled.source) + ' — read-only here">compiled' + (r.copies.length > 1 ? ' · ' + r.copies.map((c) => esc(c.harness || '?')).join(', ') : '') + '</span>' : '') +
    '<div class="d">' + esc(r.description) + '</div></td>' +
    '<td class="num ' + (r.high ? 'bad' : '') + '">' + n(r.high) + '</td>' +
    '<td class="num ' + (r.medium ? 'warn' : '') + '">' + n(r.medium) + '</td>' +
    '<td class="num">' + n(r.security) + '</td>' +
    '<td class="num">' + (r.guidance.A + r.guidance.B + r.guidance.D ? '<span class="' + (r.guidance.A ? 'bad' : '') + '">' + r.guidance.A + '</span>·' + r.guidance.B + '·' + r.guidance.D : '<span class="zero">—</span>') + '</td>' +
    '<td class="num">' + n(r.fixable) + '</td>' +
    '<td class="num">' + r.alwaysOn + '</td><td class="num">' + r.invoke + '</td>' +
    tgt.map((h) => { const s = r.enforcement[h.id]; return '<td><span class="pill ' + (s === 'restrict' ? 'ok' : s === 'grant' ? 'warn' : 'bad') + '">' + esc(s) + '</span></td>'; }).join('') +
    '</tr>').join('');
  $('ovTable').innerHTML = head + '<tbody>' + body + '</tbody>';
  for (const th of $('ovTable').querySelectorAll('th[data-k]')) th.onclick = () => {
    sort = { key: th.dataset.k, dir: sort.key === th.dataset.k ? -sort.dir : (th.dataset.k === 'name' ? 1 : -1) };
    drawOverview();
  };
  for (const tr of $('ovTable').querySelectorAll('tbody tr')) tr.onclick = () => { if (confirmDiscard()) openArtifact(tr.dataset.path).catch((e) => toast(e.message, true)); };
  $('ovEmpty').hidden = rows.length > 0;
  $('ovEmpty').textContent = ov.rows.length ? 'Nothing matches the filter.' : 'No skills or agents under ' + ctx.root + ' — SAUT looks for SKILL.md files and agent .md files (agents/, .claude/agents/, …).';
}
for (const id of ['ovFilter', 'ovKind', 'ovOnlyFindings']) $(id).addEventListener('input', drawOverview);

// Security at a glance: each security rule that fires, where; the content scanner's status.
function drawSecurity() {
  const s = ov.security;
  if (!s) { $('securityCard').hidden = true; return; }
  const sc = s.scanners;
  const scanLine = sc.installed.length
    ? 'Content scanner: <b>' + esc(sc.installed.join(', ')) + '</b>' + (sc.last ? ' · last scan ' + esc(new Date(sc.last.at).toLocaleTimeString()) + ' — ' + sc.last.findings + ' finding' + (sc.last.findings === 1 ? '' : 's') + (sc.last.note ? ' · <span class="warn">' + esc(sc.last.note) + '</span>' : '') : ' · not run in this session') +
      ' <button class="btn small" id="runScan">' + (sc.last ? 'Scan again' : 'Run the scan') + '</button>'
    : '<span class="warn">No content scanner installed</span> — SAUT’s own rules ran; a scanner adds content analysis (injection, exfiltration, malware patterns). Install one: ' +
      sc.known.map((k) => '<a href="' + esc(k.home) + '" target="_blank" rel="noopener noreferrer">' + esc(k.id) + '</a>').join(' · ');
  $('securityCard').hidden = false;
  $('securityCard').innerHTML = '<h2>Security <span class="muted">' + (s.rules.length ? s.rules.reduce((n, r) => n + r.artifacts.length, 0) + ' finding sites' : 'nothing fires') + '</span></h2>' +
    s.rules.map((r) => '<div class="secrule"><span class="pill ' + (r.severity === 'high' ? 'bad' : 'warn') + '">' + esc(r.severity) + '</span>' +
      '<button class="linklike" data-code="' + esc(r.code) + '" title="show only the artifacts with this finding">' + esc(r.title) + '</button> <span class="code muted">' + esc(r.code) + '</span>' +
      '<span class="arts" title="' + esc(r.artifacts.join(', ')) + '">' + r.artifacts.length + ' · ' + esc(r.artifacts.join(', ')) + '</span></div>').join('') +
    '<div class="row">' + scanLine + '</div>' +
    (s.suppressed ? '<div class="legend">' + s.suppressed + ' finding' + (s.suppressed === 1 ? '' : 's') + ' suppressed in saut.json — each with its reason, shown on the artifact.</div>' : '') +
    (s.config.length ? s.config.map((x) => '<div class="legend warn">' + esc(x.code) + ' · ' + esc(x.path) + ' — ' + md(x.message) + '</div>').join('') : '');
  for (const b of $('securityCard').querySelectorAll('button.linklike')) b.onclick = () => { codeFilter = b.dataset.code; drawOverview(); };
  const run = $('runScan');
  if (run) run.onclick = async () => {
    run.disabled = true; run.textContent = 'Scanning…';
    try { const r = await api('/api/scan', {}); toast(r.ran.length ? r.ran.join(', ') + ': ' + r.findings + ' finding(s)' : (r.note || 'no scanner ran'), !r.ran.length); await loadOverview(); }
    catch (e) { toast(e.message, true); run.disabled = false; }
  };
}

// ── artifact switcher ────────────────────────────────────────────
function drawArtifactList() {
  $('artifactList').innerHTML = ctx.artifacts.map((a) => '<option value="' + esc(a.path) + '">' + esc(a.kind + ' ' + a.name) + '</option>').join('');
}
$('artifactPick').addEventListener('change', () => {
  const p = $('artifactPick').value.trim();
  const a = ctx.artifacts.find((x) => x.path === p || x.name === p);
  $('artifactPick').value = '';
  if (a && confirmDiscard()) openArtifact(a.path).catch((e) => toast(e.message, true));
});
function step(d) {
  const rows = visibleRows().length ? visibleRows() : (ov ? ov.rows : []);
  if (!current || !rows.length) return;
  const i = rows.findIndex((r) => r.path === current.path || (r.copies || []).some((c) => c.path === current.path));
  const next = rows[(i + d + rows.length) % rows.length];
  if (next && confirmDiscard()) openArtifact(next.path).catch((e) => toast(e.message, true));
}
$('prevArtifact').onclick = () => step(-1);
$('nextArtifact').onclick = () => step(1);
$('backToOverview').onclick = () => show('overview');

// ── skill: open / form ───────────────────────────────────────────
const bodyFrom = (text, bodyOffset) => text.split(/\r?\n/).slice(bodyOffset - 1).join('\n');
const listOf = (v) => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? v.split(/,(?![^(]*\))/).map((x) => x.trim()).filter(Boolean) : [];

async function openArtifact(p) {
  const pass = await backend.artifact(p);
  current = pass;
  baseText = pass.text;
  fillForm(pass.frontmatter || {}, pass.kind);
  setDoc(bodyView, bodyFrom(pass.text, pass.bodyOffset));
  setDoc(sourceView, pass.text);
  const ro = !!pass.readOnly;
  $('readOnlyBanner').hidden = !ro;
  $('readOnlyBanner').textContent = ro ? 'Read-only — ' + pass.readOnly + '.' : '';
  setReadOnly(bodyView, ro); setReadOnly(sourceView, ro);
  for (const el of document.querySelectorAll('#edit-form input, #edit-form textarea, #edit-form select, #addTool')) el.disabled = ro;
  $('save').disabled = ro; $('revert').disabled = ro;
  $('artifactTitle').textContent = pass.kind + ' · ' + pass.name;
  $('savePath').textContent = pass.path;
  for (const b of document.querySelectorAll('.subtab')) b.disabled = false;
  setDirty(false);
  drawInspector(pass);
  drawReviewSetup();
  counts();
  show('skill');
  try { history.replaceState(null, '', '#' + encodeURIComponent(pass.path)); } catch { /* sandboxed */ }
}

function fillForm(fm, kind) {
  $('f_name').value = fm.name || '';
  $('f_desc').value = fm.description || '';
  $('f_hint').value = fm['argument-hint'] || '';
  $('f_userInv').checked = fm['user-invocable'] !== false;
  $('f_noModel').checked = fm['disable-model-invocation'] === true;
  $('f_model').value = fm.model || '';
  $('f_effort').value = fm.effort || '';
  $('lbl_userInv').hidden = $('lbl_noModel').hidden = kind === 'agent';
  $('allowlistNote').innerHTML = kind === 'agent'
    ? '— <code>tools</code>: the agent’s toolset (dropped on Codex)'
    : '— <code>allowed-tools</code>: what the harness pre-approves; a restriction only where the registry says <i>restrict</i>';
  selectedTools = listOf(fm[kind === 'agent' ? 'tools' : 'allowed-tools']);
  const w = (fm.metadata && typeof fm.metadata === 'object' && fm.metadata.taut && typeof fm.metadata.taut === 'object') ? fm.metadata.taut : {};
  $('f_agents').value = listOf(w.agents).join(', ');
  $('f_mcp').value = listOf(w.mcp).join(', ');
  $('f_requires').value = listOf(w.requires).join(', ');
  $('f_repos').value = listOf(w.repos).join(', ');
  $('f_role').value = w.role || '';
  $('tautBlock').hidden = !ctx.taut || kind === 'agent';
  drawTools();
}

// What the form edits — the server applies it to the file text field by field (compose).
function formPayload() {
  const kind = current ? current.kind : 'skill';
  const list = (id) => $(id).value.split(',').map((x) => x.trim()).filter(Boolean);
  const f = { name: $('f_name').value.trim(), description: $('f_desc').value.trim(), 'argument-hint': $('f_hint').value.trim(),
    model: $('f_model').value.trim(), effort: $('f_effort').value.trim(), tools: selectedTools.slice() };
  if (kind === 'skill') { f['user-invocable'] = $('f_userInv').checked; f['disable-model-invocation'] = $('f_noModel').checked; }
  if (ctx.taut && kind === 'skill') {
    const w = {};
    if (list('f_agents').length) w.agents = list('f_agents');
    if (list('f_mcp').length) w.mcp = list('f_mcp');
    if (list('f_requires').length) w.requires = list('f_requires');
    if (list('f_repos').length) w.repos = list('f_repos');
    if ($('f_role').value.trim()) w.role = $('f_role').value.trim();
    f.taut = w;
  }
  return f;
}

// A NEW artifact is emitted whole from the form (there is no file to preserve yet).
function frontmatterFromForm() {
  const f = formPayload();
  const fm = { name: f.name };
  if (f.description) fm.description = f.description.replace(/\s*\n\s*/g, ' ');
  if (f['argument-hint']) fm['argument-hint'] = f['argument-hint'];
  if (current.kind === 'skill') {
    if (!f['user-invocable']) fm['user-invocable'] = false;
    if (f['disable-model-invocation']) fm['disable-model-invocation'] = true;
  }
  if (f.tools.length) fm[current.kind === 'agent' ? 'tools' : 'allowed-tools'] = f.tools;
  if (f.model) fm.model = f.model;
  if (f.effort) fm.effort = f.effort;
  if (f.taut && Object.keys(f.taut).length) fm.metadata = { taut: f.taut };
  return fm;
}

function newArtifact(kind) {
  current = { kind, path: null, name: '', isNew: true, findings: [] };
  baseText = null;
  fillForm({ 'disable-model-invocation': kind === 'skill' }, kind);
  selectedTools = ['Read', 'Glob', 'Grep']; drawTools();
  setDoc(bodyView, '# \n\nThe method.\n');
  setReadOnly(bodyView, false);
  for (const el of document.querySelectorAll('#edit-form input, #edit-form textarea, #edit-form select, #addTool')) el.disabled = false;
  $('save').disabled = false; $('revert').disabled = true;
  $('readOnlyBanner').hidden = true;
  $('artifactTitle').textContent = 'new ' + kind;
  $('savePath').textContent = '(saved into ' + (kind === 'agent' ? 'agents/' : 'skills/<name>/') + ')';
  setEditMode('form');
  for (const b of document.querySelectorAll('.subtab')) b.disabled = b.dataset.edit === 'source';
  $('findings').innerHTML = '<div class="muted">save to lint</div>';
  $('cost').innerHTML = ''; $('matrix').innerHTML = ''; $('compiledList').innerHTML = ''; $('problemCount').textContent = '';
  setDirty(false);
  counts();
  show('skill');
}
$('newSkill').onclick = () => { if (confirmDiscard()) newArtifact('skill'); };
$('newAgent').onclick = () => { if (confirmDiscard()) newArtifact('agent'); };

function counts() {
  const d = $('f_desc').value.length;
  const cap = (ctx.harnesses.find((h) => h.id === 'claude-code') || {}).listing;
  $('descCount').textContent = '— ' + d + ' chars' + (cap && cap.descCap ? ' / ' + cap.descCap : '') + ', paid every session';
  $('descCount').className = cap && cap.descCap && d > cap.descCap ? 'bad' : 'muted';
  $('bodyCount').textContent = '— ' + bodyView.state.doc.length + ' chars, ' + bodyView.state.doc.lines + ' lines, on invoke';
}

// tool picker
function allToolNames() {
  const set = new Set();
  for (const list of Object.values(ctx.tools.builtin)) for (const t of list) if (/^[A-Z]/.test(t)) set.add(t);
  for (const s of ctx.tools.servers) for (const t of s.tools) set.add(t);
  return [...set].sort();
}
function drawToolPicker() { $('toolPick').innerHTML = allToolNames().map((t) => '<option>' + esc(t) + '</option>').join(''); }
function drawTools() {
  const ro = current && current.readOnly;
  $('toolPills').innerHTML = selectedTools.map((t, i) =>
    '<span class="pill on">' + esc(t) + (ro ? '' : '<button data-i="' + i + '" aria-label="remove ' + esc(t) + '">×</button>') + '</span>').join('') ||
    '<span class="muted">none — the skill gets the full toolset</span>';
  for (const b of $('toolPills').querySelectorAll('button')) b.onclick = () => { selectedTools.splice(+b.dataset.i, 1); drawTools(); onEdit(); };
}
$('addTool').onclick = () => {
  const base = $('toolPick').value; const scope = $('toolScope').value.trim();
  const entry = scope ? base + '(' + scope + ')' : base;
  if (!selectedTools.includes(entry)) selectedTools.push(entry);
  $('toolScope').value = ''; drawTools(); onEdit();
};
for (const id of ['f_name', 'f_hint', 'f_desc', 'f_model', 'f_effort', 'f_agents', 'f_mcp', 'f_requires', 'f_repos', 'f_role'])
  $(id).addEventListener('input', () => onEdit());
for (const id of ['f_userInv', 'f_noModel']) $(id).addEventListener('change', () => onEdit());

// ── edits: dirty + a live re-lint of the unsaved text ──────────────
let checkTimer = null, checkSeq = 0;
function onEdit() {
  setDirty(true); counts();
  clearTimeout(checkTimer);
  checkTimer = setTimeout(liveCheck, 500);
}
function editPayload() {
  const p = { path: current.path, kind: current.kind };
  if (editMode === 'source') p.text = textOf(sourceView);
  else { p.form = formPayload(); p.body = textOf(bodyView); if (baseText !== null && baseText !== current.text) p.from = baseText; }
  return p;
}
async function liveCheck() {
  if (!current || !current.path || !ctx.capabilities.check) return;
  const seq = ++checkSeq;
  try {
    const r = await backend.check(editPayload());
    if (seq !== checkSeq) return;                              // a newer edit is already on its way
    if (r.composeError) { $('editHint').textContent = r.composeError; $('editHint').className = 'hint warn'; return; }
    $('editHint').textContent = ''; $('editHint').className = 'muted hint';
    current = { ...current, findings: r.findings, cost: r.cost, matrix: r.matrix, bodyOffset: r.bodyOffset, lines: r.lines };
    drawInspector(current, true);
  } catch (e) { $('editHint').textContent = e.message; $('editHint').className = 'hint warn'; }
}

// Form ⇄ Source: edits cross over, in both directions.
function setEditMode(m) {
  editMode = m;
  for (const b of document.querySelectorAll('.subtab')) b.classList.toggle('active', b.dataset.edit === m);
  $('edit-form').hidden = m !== 'form';
  $('edit-source').hidden = m !== 'source';
  $('editHint').textContent = m === 'source' ? 'the whole file, exactly as saved — capability branches, comments and every key' : '';
  if (current && current.findings) drawInspector(current, !$('liveBadge').hidden);
  requestAnimationFrame(() => (m === 'source' ? sourceView : bodyView).requestMeasure());
}
for (const b of document.querySelectorAll('.subtab')) b.onclick = async () => {
  const to = b.dataset.edit;
  if (to === editMode || !current || current.isNew) return;
  try {
    if (to === 'source' && dirty) {
      const c = await backend.compose({ ...editPayload() });
      if (!c.ok) return toast(c.reason, true);
      setDoc(sourceView, c.text);
    }
    if (to === 'form' && dirty) {
      const text = textOf(sourceView);
      const r = await backend.check({ path: current.path, text });
      baseText = text;
      fillForm(r.frontmatter || {}, current.kind);
      setDoc(bodyView, bodyFrom(text, r.bodyOffset));
      current = { ...current, bodyOffset: r.bodyOffset, lines: r.lines };
    }
    setEditMode(to);
  } catch (e) { toast(e.message, true); }
};

// ── inspector ────────────────────────────────────────────────────
const inTargets = (f) => !f.harness || f.harness.split(',').some((h) => targets.has(h));
function drawInspector(p, live) {
  $('liveBadge').hidden = !live;
  drawFindings(p);
  drawMatrix(p);
  drawCost(p);
  drawCompiled(p);
  // tint the finding lines in the editors
  const marks = (p.findings || []).filter((f) => f.line && inTargets(f) && (f.severity === 'high' || f.severity === 'medium'));
  sourceView.dispatch({ effects: setMarks.of(marks.map((f) => ({ line: f.line, severity: f.severity }))) });
  bodyView.dispatch({ effects: setMarks.of(marks.filter((f) => f.line >= p.bodyOffset).map((f) => ({ line: f.line - p.bodyOffset + 1, severity: f.severity }))) });
}

const ALLOWLIST_MEANS = {
  restrict: 'the allowlist restricts: tools outside it are unavailable',
  grant: 'the allowlist only pre-approves; every other tool is still available',
  prose: 'the allowlist is text for the model; nothing enforces it',
  dropped: 'the allowlist is removed when the artifact is installed',
  'n/a': 'the harness has no allowlist for this kind of artifact',
};
function drawMatrix(p) {
  const rows = (p.matrix || []).filter((m) => targets.has(m.harness));
  $('matrix').innerHTML = '<table class="plain"><tr><th>harness</th><th>allowlist</th><th>means</th></tr>' + rows.map((m) =>
    '<tr><td>' + esc(m.harness) + '</td><td><span class="pill ' + (m.allowlist === 'restrict' ? 'ok' : m.allowlist === 'grant' ? 'warn' : 'bad') + '">' + esc(m.allowlist) + '</span></td><td class="muted">' + esc(ALLOWLIST_MEANS[m.allowlist] || '') + '</td></tr>').join('') + '</table>';
}
function drawCost(p) {
  if (!p.cost) { $('cost').innerHTML = ''; return; }
  const tr = p.cost.transitive || [];
  const inv = p.cost.invokeTokens + tr.reduce((s, t) => s + t.tokens, 0);
  $('cost').innerHTML = '<table class="plain"><tr><th>always-on</th><th>on invoke</th><th>method</th></tr>' +
    '<tr><td>' + p.cost.alwaysOnTokens + ' tok</td><td>' + inv + ' tok' + (tr.length ? ' <span class="muted">(incl. ' + tr.map((t) => esc(t.name)).join(', ') + ')</span>' : '') + '</td><td class="muted">' + esc(p.cost.method) + '</td></tr></table>' +
    '<div class="legend">always-on = name + description, loaded in every session; on invoke = the body and the agents it wires.</div>';
}
function drawCompiled(p) {
  $('secCompiled').hidden = !ctx.taut;
  if (!p.compiled || !p.compiled.length) { $('compiledList').innerHTML = '<div class="muted">' + ($('liveBadge').hidden ? 'compile previews need a TAUT pack and engine' : 'shown for the saved file') + '</div>'; return; }
  $('compiledList').innerHTML = p.compiled.map((c) =>
    '<details><summary><b>' + esc(c.harness) + '</b> → ' + esc(c.id) + ' <span class="muted">' + c.bytes + ' bytes · ' + esc(c.transform) + '</span></summary>' +
    c.degradations.map((d) => '<div class="warn" style="margin:5px 0;font-size:11.5px">' + esc(d.id) + ': ' + esc(d.text) + '</div>').join('') +
    '<pre>' + esc(c.content) + '</pre></details>').join('');
}

const CATEGORIES = [['security', 'Security'], ['guidance', 'Current guidance'], ['privileges', 'Privileges'], ['hygiene', 'Hygiene and cost'],
  ['syntax', 'Syntax'], ['taut', 'TAUT wiring'], ['scanner', 'Content scanner'], ['other', 'Other']];
const CLASS_PILL = {
  A: '<span class="pill bad" title="an outdated setting — fix it">A · outdated</span>',
  B: '<span class="pill warn" title="a prompt-level hypothesis — vendors say to change prompts only against a measurement">B · measure before changing</span>',
  D: '<span class="pill on" title="a hardening the artifact does not use yet">D · hardening</span>',
};
function guidanceMeta(g) {
  const links = (g.sources || []).map((u) => /^https?:\/\//.test(u)
    ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u.replace(/^https?:\/\//, '').split('/')[0]) + '</a>'
    : '<span title="' + esc(u) + '">' + esc(u.split(' ')[0].replace(/:$/, '')) + '</span>').join(' · ');
  return '<div class="gmeta">' + (CLASS_PILL[g.class] || '') + ' verified ' + esc(g.verifiedAt || '?') +
    (g.appliesTo ? ' · for ' + esc(g.appliesTo) : '') + (links ? ' · ' + links : '') +
    (g.class === 'B' ? '<div>Change it with a bench before and after, one change at a time: edit it here, then <button class="btn small measure-link">Measure the change →</button></div>' : '') + '</div>';
}

function drawFindings(p) {
  const all = p.findings || [];
  const fs = all.filter((f) => inTargets(f) && !f.suppressed);
  const sup = all.filter((f) => f.suppressed);
  const hidden = all.filter((f) => !f.suppressed).length - fs.length;
  $('problemCount').textContent = fs.length ? '· ' + fs.length : '';
  const supHtml = sup.length ? '<div class="group"><h3>Suppressed · ' + sup.length + '</h3>' + sup.map((f) =>
    '<div class="find suppressed ' + esc(f.severity) + '"><div><span class="title">' + esc(f.title || f.code) + '</span> <span class="code">' + esc(f.code) + '</span></div>' +
    '<div class="muted">' + md(f.message) + '</div><div class="how"><b>Suppressed:</b> ' + esc(f.suppressed.reason) + '</div>' +
    '<div class="actions"><button class="btn small liftbtn" data-i="' + all.indexOf(f) + '"' + (current && current.readOnly && !ctx.capabilities.suppress ? ' disabled' : '') + '>Lift the suppression</button></div></div>').join('') + '</div>' : '';
  if (!fs.length) { $('findings').innerHTML = '<div class="ok" style="margin-top:8px">no findings' + (hidden ? ' for the target harnesses (' + hidden + ' for others)' : '') + '</div>' + supHtml; wireFindings(all); return; }
  const hi = fs.filter((f) => f.severity === 'high').length;
  const fixable = fs.filter((f) => f.autofix).length;
  let html = '<div class="summary">' + fs.length + ' finding' + (fs.length === 1 ? '' : 's') + ' · ' + hi + ' high · ' + fixable + ' with a fix' + (hidden ? ' · ' + hidden + ' for other harnesses hidden' : '') + '</div>';
  for (const [cat, label] of CATEGORIES) {
    const items = fs.map((f) => [f, all.indexOf(f)]).filter(([f]) => (f.category || 'other') === cat);
    if (!items.length) continue;
    html += '<div class="group"><h3>' + label + ' · ' + items.length + '</h3>' + items.map(([f, i]) => findingCard(f, i)).join('') + '</div>';
  }
  $('findings').innerHTML = html + supHtml;
  wireFindings(all);
}
function wireFindings(all) {
  for (const b of $('findings').querySelectorAll('.loc')) b.onclick = () => goToLine(+b.dataset.line);
  for (const b of $('findings').querySelectorAll('.fixbtn')) b.onclick = () => previewFix(all[+b.dataset.i]);
  for (const b of $('findings').querySelectorAll('.measure-link')) b.onclick = () => show('bench');
  for (const b of $('findings').querySelectorAll('.supbtn')) b.onclick = () => openSuppress(all[+b.dataset.i]);
  for (const b of $('findings').querySelectorAll('.liftbtn')) b.onclick = () => liftSuppression(all[+b.dataset.i]);
}

function findingCard(f, i) {
  const where = f.line ? ' <button class="loc" data-line="' + f.line + '" title="show in the editor">line ' + f.line + '</button>' : '';
  const safety = f.autofix ? (f.autofix.safety === 'review'
    ? '<span class="pill warn" title="changes what the artifact may do, or rests on a heuristic — read the diff">review</span>'
    : '<span class="pill ok" title="mechanical, behaviour-preserving">safe</span>') : '';
  const ro = current && current.readOnly;
  return '<div class="find ' + esc(f.severity) + '">' +
    '<div><span class="title">' + esc(f.title || f.code) + '</span> <span class="code">' + esc(f.code) + (f.harness ? ' [' + esc(f.harness) + ']' : '') + '</span>' + where + '</div>' +
    '<div>' + md(f.message) + '</div>' +
    (f.fix ? '<div class="how"><b>How to fix:</b> ' + md(f.fix) + '</div>' : '') +
    (f.guidance ? guidanceMeta(f.guidance) : '') +
    (f.why ? '<details><summary>why it matters</summary><div>' + md(f.why) + '</div></details>' : '') +
    '<div class="actions">' +
      (f.autofix ? '<button class="btn small fixbtn" data-i="' + i + '"' + (ro ? ' disabled title="read-only"' : '') + '>' + esc(f.autofix.label) + '</button>' + safety
        : '<span class="manual">No automatic fix — ' + (f.line ? 'edit <button class="loc" data-line="' + f.line + '">line ' + f.line + '</button> by hand' : 'edit the artifact by hand') + '.</span>') +
      (f.heuristic ? '<span class="pill" title="this rule reads prose or patterns; read the line before acting">heuristic — can be a false positive</span>' : '') +
      (f.doc ? '<a href="' + esc(f.doc) + '" target="_blank" rel="noopener noreferrer">rule ↗</a>' : '') +
      (ctx.capabilities.suppress && !/^suppression-/.test(f.code) && current && current.path ? '<button class="btn small supbtn" data-i="' + i + '" title="does not apply here? say why — it goes into saut.json">Suppress…</button>' : '') +
    '</div></div>';
}

// ── suppress: a reason, a scope, the saut.json diff, then the write ──
const suppressMatch = (f) => { const q = f.message.match(/"([^"]{3,})"/); return q ? q[1].replace(/…$/, '') : undefined; };
async function openSuppress(f) {
  const match = suppressMatch(f);
  $('scopeMatch').textContent = match ? '"' + (match.length > 50 ? match.slice(0, 50) + '…' : match) + '"' : '(this rule has no subject to pin — the whole rule)';
  $('scopeRule').textContent = f.code;
  document.querySelector('input[name=scope][value=one]').disabled = !match;
  document.querySelector('input[name=scope][value=' + (match ? 'one' : 'all') + ']').checked = true;
  $('modalReason').value = '';
  let preview = null, timer = null;
  const payload = () => ({ path: current.path, rule: f.code, artifact: current.name, reason: $('modalReason').value,
    ...(document.querySelector('input[name=scope]:checked').value === 'one' && match ? { match } : {}) });
  const refresh = async () => {
    preview = null; $('modalApply').disabled = true;
    if ($('modalReason').value.trim().length < 8) { $('modalDiff').innerHTML = '<span class="muted">write the reason (a sentence) to see the change to saut.json</span>'; return; }
    try { preview = await api('/api/suppress', payload()); $('modalDiff').innerHTML = diffHtml(preview.diff); $('modalApply').disabled = false; $('modalNote').textContent = 'Written to ' + preview.file + '. The finding stays visible here, marked suppressed, and no longer counts.'; }
    catch (e) { $('modalDiff').textContent = e.message; }
  };
  $('modalReason').oninput = () => { clearTimeout(timer); timer = setTimeout(refresh, 300); };
  for (const r of document.querySelectorAll('input[name=scope]')) r.onchange = refresh;
  $('modalForm').hidden = false;
  openModal('Suppress ' + f.code, 'Say why this finding does not apply to ' + esc(current.name) + '.', '', async () => {
    if (!preview) throw new Error('write the reason first');
    await api('/api/suppress', { ...payload(), base: preview.base, apply: true });
    await openArtifact(current.path);
    toast('suppressed in ' + preview.file);
    loadOverview().catch(() => {});
  }, 'Suppress', true);
  refresh();
  $('modalReason').focus();
}
async function liftSuppression(f) {
  const entryMatch = suppressMatch(f);
  try {
    // the entry may pin the finding or cover the whole rule — try the pinned one first
    let r = null, match;
    for (const m of [entryMatch, undefined]) {
      try { r = await api('/api/suppress', { path: current.path, rule: f.code, artifact: current.name, remove: true, ...(m ? { match: m } : {}) }); match = m; break; } catch { /* try the next form */ }
    }
    if (!r) return toast('the suppression is not in the saut.json this Studio edits — lift it there by hand', true);
    openModal('Lift the suppression of ' + f.code, 'The finding counts again once this is removed from ' + esc(r.file) + '.', r.diff, async () => {
      await api('/api/suppress', { path: current.path, rule: f.code, artifact: current.name, remove: true, ...(match ? { match } : {}), base: r.base, apply: true });
      await openArtifact(current.path);
      toast('lifted');
      loadOverview().catch(() => {});
    }, 'Lift');
  } catch (e) { toast(e.message, true); }
}

// A finding's line → the form field it belongs to, or the line in the editor.
const FIELD_FOR = { name: 'f_name', description: 'f_desc', 'argument-hint': 'f_hint', 'allowed-tools': 'toolPills', tools: 'toolPills',
  'disallowed-tools': 'toolPills', 'disable-model-invocation': 'lbl_noModel', 'user-invocable': 'lbl_userInv', model: 'f_model',
  effort: 'f_effort', metadata: 'tautBlock' };
function flash(el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
function selectLine(view, n) {
  if (n < 1 || n > view.state.doc.lines) return;
  const l = view.state.doc.line(n);
  view.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true });
  view.focus();
  flash(view.dom);
}
function goToLine(line) {
  if (!current || !current.bodyOffset) return;
  if (editMode === 'source') return selectLine(sourceView, line);
  if (line < current.bodyOffset) {
    const key = Object.entries(current.lines || {}).filter(([, n]) => n <= line).sort((a, b) => b[1] - a[1])[0]?.[0];
    const el = $(FIELD_FOR[key] || 'f_name');
    if (!el || el.offsetParent === null) { setEditMode('source'); return selectLine(sourceView, line); }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (el.focus && el.tagName !== 'DIV' && el.tagName !== 'LABEL') el.focus({ preventScroll: true });
    return flash(el);
  }
  selectLine(bodyView, line - current.bodyOffset + 1);
}

// ── agent review: proposals, checked and re-linted by the server, applied only to the editor ──
function drawReviewSetup() {
  const on = ctx.capabilities.llmReview;
  $('secReview').hidden = false;
  $('runReview').disabled = !on || !(current && current.path);
  const cc = ctx.harnesses.find((h) => h.id === 'claude-code');
  const models = cc && cc.models ? [...Object.keys(cc.models.aliases).filter((a) => cc.models.aliases[a]), ...cc.models.catalog.filter((m) => m.status === 'current').map((m) => m.id)] : [];
  $('reviewModels').innerHTML = models.map((m) => '<option value="' + esc(m) + '">').join('');
  if (!on) $('reviewOut').innerHTML = '<div class="muted">The review runs on Claude Code — the <code>claude</code> CLI is not on this machine’s PATH.</div>';
  else if (!$('reviewOut').dataset.for || $('reviewOut').dataset.for !== (current && current.path)) $('reviewOut').innerHTML = '<div class="legend">One call to Claude with this file, its findings and the guidance SAUT tracks. It proposes changes; nothing is written — you apply a proposal to the editor, then save (A, D) or measure (B).</div>';
}

async function reviewText() {
  if (!dirty) return undefined;
  if (editMode === 'source') return textOf(sourceView);
  const c = await backend.compose(editPayload());
  if (!c.ok) throw new Error(c.reason);
  return c.text;
}

$('runReview').onclick = async () => {
  if (!current || !current.path) return;
  try {
    const text = await reviewText();
    const model = $('reviewModel').value.trim() || undefined;
    const e = await api('/api/review', { path: current.path, model, text, estimate: true });
    openModal('Review ' + current.name + ' with ' + e.model,
      'One call to Claude (<b>' + esc(e.model) + '</b>): about <b>' + e.inputTokens.toLocaleString() + '</b> input tokens — the file, ' + e.findings + ' finding' + (e.findings === 1 ? '' : 's') + ' and the guidance entries. The cost is what Claude Code reports, shown after the call. The file is sent as data; the reviewer has no tools.' + (text !== undefined ? ' <span class="warn">Your unsaved edit is what gets reviewed.</span>' : ''),
      '', async () => { closeModal(); await runReview(model, text); }, 'Run the review');
  } catch (err) { toast(err.message, true); }
};

async function runReview(model, text) {
  $('secReview').open = true;
  $('reviewOut').dataset.for = current.path;
  $('reviewOut').innerHTML = '<div class="muted">Reviewing… one model call, usually under a minute.</div>';
  $('runReview').disabled = true;
  try {
    const r = await api('/api/review', { path: current.path, model, text });
    drawReview(r);
  } catch (e) { $('reviewOut').innerHTML = '<div class="bad">' + esc(e.message) + '</div>'; }
  finally { $('runReview').disabled = !ctx.capabilities.llmReview; }
}

let lastReview = null;
function drawReview(r) {
  lastReview = r;
  const ro = current && current.readOnly;
  const codes = (list, cls) => (list || []).map((c) => '<span class="pill ' + cls + '">' + esc(c) + '</span>').join('');
  $('reviewOut').innerHTML =
    '<div class="legend">' + esc(r.model) + (r.costUsd !== null ? ' · $' + r.costUsd.toFixed(3) : '') + ' · ' + esc(new Date(r.at).toLocaleTimeString()) + '</div>' +
    '<div style="margin:6px 0">' + md(r.summary) + '</div>' +
    (r.changes.length ? r.changes.map((c, i) => '<div class="rchange ' + (c.ok ? '' : 'bad') + '">' +
      '<div>' + (CLASS_PILL[c.class] || '') + ' <b>' + esc(c.title) + '</b> <span class="code">' + esc(c.basis) + '</span></div>' +
      '<div class="muted" style="margin-top:3px">' + md(c.rationale) + '</div>' +
      (c.ok ? '<div class="codes" style="margin-top:4px">' + (c.resolves.length ? 'resolves ' + codes(c.resolves, 'ok') : '<span class="muted">resolves no finding</span>') + (c.introduces.length ? ' · introduces ' + codes(c.introduces, 'bad') : '') + '</div>' +
        '<pre class="diff">' + diffHtml(c.diff) + '</pre>' +
        '<div class="actions"><button class="btn small applyrev" data-i="' + i + '"' + (ro ? ' disabled title="read-only"' : '') + '>Apply to editor</button>' +
        '<span class="muted">' + (c.class === 'B' ? 'then measure it in the Bench before you save' : 'then Save — the diff is shown again') + '</span></div>'
        : '<div class="warn">Not applicable: ' + esc(c.reason) + '</div>') +
      '</div>').join('') : '<div class="ok">No changes proposed.</div>') +
    (r.keep.length ? '<details><summary>left as it is (' + r.keep.length + ')</summary>' + r.keep.map((k) => '<div class="muted">· ' + md(k) + '</div>').join('') + '</details>' : '');
  for (const b of $('reviewOut').querySelectorAll('.applyrev')) b.onclick = () => applyProposal(r.changes[+b.dataset.i], b);
}

// A proposal goes into the Source view as an unsaved edit — the same text check as the server's.
async function applyProposal(c, button) {
  try {
    if (editMode !== 'source') await document.querySelector('.subtab[data-edit=source]').onclick();
    if (editMode !== 'source') return;
    const text = textOf(sourceView);
    const at = text.indexOf(c.search);
    if (at < 0 || text.indexOf(c.search, at + 1) >= 0) return toast('the editor text no longer matches this proposal — run the review again', true);
    setDoc(sourceView, text.slice(0, at) + c.replace + text.slice(at + c.search.length));
    onEdit();
    button.disabled = true; button.textContent = 'applied to the editor';
    toast(c.class === 'B' ? 'applied — measure it in the Bench (Measure: saved vs my edit) before saving' : 'applied — review it and Save');
  } catch (e) { toast(e.message, true); }
}

// ── diff modal: fixes and saves ──────────────────────────────────
let pending = null;
function diffHtml(d) {
  const ls = d.split('\n');
  const out = ls.map((l) => ({ cls: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'muted', html: esc(l) }));
  for (let i = 0; i + 1 < ls.length; i++) {
    if (!ls[i].startsWith('-') || !ls[i + 1].startsWith('+')) continue;
    const gut = (l) => (l.match(/^[-+] *\d+ {2}/) || [''])[0].length;   // the "- NNN  " gutter
    const ga = gut(ls[i]), gb = gut(ls[i + 1]);
    const a = ls[i].slice(ga), b = ls[i + 1].slice(gb);
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0; while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const mark = (line, g, s) => esc(line.slice(0, g + p)) + '<mark>' + esc(s.slice(p, s.length - q)) + '</mark>' + esc(s.slice(s.length - q));
    out[i].html = mark(ls[i], ga, a); out[i + 1].html = mark(ls[i + 1], gb, b);
  }
  return out.map((o) => '<span class="' + o.cls + '">' + o.html + '</span>').join('\n');
}
function openModal(title, note, diff, apply, applyLabel, disabled) {
  pending = apply;
  if (applyLabel !== 'Suppress') $('modalForm').hidden = true;
  $('modalTitle').textContent = title;
  $('modalNote').innerHTML = note;
  $('modalDiff').innerHTML = diffHtml(diff);
  $('modalApply').textContent = applyLabel;
  $('modalApply').disabled = !!disabled;
  $('modal').style.display = 'flex';
  if (!disabled) $('modalApply').focus();
}
function closeModal() { $('modal').style.display = 'none'; pending = null; $('modalForm').hidden = true; }
$('modalCancel').onclick = closeModal;
$('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
$('modalApply').onclick = async () => {
  const run = pending;
  if (!run) return;
  try { await run(); closeModal(); } catch (e) { toast(e.message, true); }
};

async function previewFix(f) {
  if (!current || !current.path || !f.autofix) return;
  try {
    const r = await backend.fix({ path: current.path, autofix: f.autofix });
    if (!r.ok) return toast('cannot apply: ' + r.reason, true);
    const note = (f.autofix.safety === 'review'
      ? '<span class="warn">Review.</span> This changes what the artifact may do, or rests on a heuristic that can be wrong for this artifact — check the body before applying. '
      : 'A mechanical, behaviour-preserving change. ') +
      (dirty ? '<span class="bad">You have unsaved edits — save or revert them first.</span>' : 'Applying writes the file and re-lints it.');
    openModal(f.autofix.label, note, r.diff, async () => {
      const a = await backend.fix({ path: current.path, autofix: f.autofix, base: r.base, apply: true });
      await openArtifact(current.path);        // the form and the passport come back from disk
      toast('applied: ' + a.label);
      loadOverview().catch(() => {});
    }, 'Apply and save', dirty);
  } catch (e) { toast(e.message, true); }
}

// Save: the edit becomes text (composed from the form, or the Source view as is), the diff
// against the file on disk is shown, and only then is it written — against the hash the file
// was opened with, so an edit made meanwhile elsewhere is refused, not overwritten.
async function save() {
  if (!current || current.readOnly) return;
  try {
    if (current.isNew) {
      const r = await backend.save({ kind: current.kind, name: $('f_name').value.trim(), frontmatter: frontmatterFromForm(), body: textOf(bodyView) });
      setDirty(false);
      await loadContext(); loadOverview().catch(() => {});
      await openArtifact(r.path);
      return toast('created ' + r.path);
    }
    const c = await backend.compose(editPayload());
    if (!c.ok) return toast(c.reason, true);
    if (!c.diff) { setDirty(false); return toast('nothing to save — the file already says this'); }
    openModal('Save ' + current.name, 'Changed: ' + esc((c.changed || []).join(', ') || 'text') + '. Everything else in the file stays as it is.', c.diff, async () => {
      const r = await backend.save({ path: current.path, text: c.text, base: current.base });
      setDirty(false);
      await openArtifact(r.path);
      toast('saved ' + r.path);
      loadOverview().catch(() => {});
    }, 'Save');
  } catch (e) { toast(e.message, true); }
}
$('save').onclick = save;
$('revert').onclick = () => { if (current && current.path && confirmDiscard()) openArtifact(current.path).catch((e) => toast(e.message, true)); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modal').style.display === 'flex') return closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !$('view-skill').hidden) { e.preventDefault(); save(); }
});

// ── bench ─────────────────────────────────────────────────────────
// A run, a before/after pair, the cases, the history and a comparison — all for the artifact
// open in the Skill view.
let benchCases = null, benchRuns = [], selectedRuns = [], estimateTimer = null;

async function drawBenchHead() {
  const has = !!(current && current.path);
  $('benchArtifact').textContent = has ? current.kind + ' ' + current.name + ' (' + current.path + ')' : '— open one in the Skill view';
  $('runBench').disabled = !ctx.capabilities.bench || !has;
  drawBenchHarnesses();
  updateMeasure();
  if (!has) { $('caseList').innerHTML = ''; $('runList').innerHTML = ''; $('benchEstimate').textContent = ''; return; }
  await Promise.all([loadCases(), loadRuns()]);
  scheduleEstimate();
}

// Per harness: run it or not, and on which model (the registry's models as suggestions).
function drawBenchHarnesses() {
  const runnable = ctx.harnesses.filter((h) => h.runner);
  benchSel = runnable.map((h) => h.id).filter((id) => targets.has(id));
  const saved = store.get('benchModels', {});
  $('benchHarnessTable').innerHTML = '<tr><th>harness</th><th>model</th><th></th></tr>' + runnable.map((h) => {
    const opts = h.models ? [...Object.keys(h.models.aliases), ...h.models.catalog.filter((m) => m.status === 'current' || m.status === 'previous').map((m) => m.id)] : [];
    return '<tr><td><label class="inline"><input type="checkbox" data-h="' + esc(h.id) + '"' + (benchSel.includes(h.id) ? ' checked' : '') + '> ' + esc(h.id) + '</label></td>' +
      '<td><input type="text" class="bm" data-h="' + esc(h.id) + '" list="bm-' + esc(h.id) + '" value="' + esc(saved[h.id] || '') + '" placeholder="' + esc((ctx.benchDefaults || {})[h.id] || 'the harness default') + '">' +
      '<datalist id="bm-' + esc(h.id) + '">' + opts.map((m) => '<option value="' + esc(m) + '">').join('') + '</datalist></td>' +
      '<td class="muted">' + (h.models ? 'verified ' + esc(h.models.verifiedAt) : '') + '</td></tr>';
  }).join('') + (ctx.harnesses.some((h) => !h.runner) ? '<tr><td colspan="3" class="muted">' + ctx.harnesses.filter((h) => !h.runner).map((h) => h.id).join(', ') + ': no headless runner</td></tr>' : '');
  for (const c of $('benchHarnessTable').querySelectorAll('input[type=checkbox]')) c.onchange = () => {
    benchSel = [...$('benchHarnessTable').querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => x.dataset.h);
    scheduleEstimate();
  };
  for (const i of $('benchHarnessTable').querySelectorAll('input.bm')) i.oninput = () => { store.set('benchModels', benchModels()); scheduleEstimate(); };
}
function benchModels() {
  const out = {};
  for (const i of $('benchHarnessTable').querySelectorAll('input.bm')) if (i.value.trim()) out[i.dataset.h] = i.value.trim();
  return out;
}
function benchPayload(extra) {
  return { path: current.path, level: +$('benchLevel').value, runs: +$('benchRuns').value || 1,
    maxCost: $('benchCost').value.trim() === '' ? null : +$('benchCost').value, harnesses: benchSel, models: benchModels(),
    case: $('benchCase').value || undefined, ...extra };
}
for (const id of ['benchLevel', 'benchRuns', 'benchCost', 'benchCase']) $(id).addEventListener('input', scheduleEstimate);

// What it will cost, before anything runs.
function scheduleEstimate() { clearTimeout(estimateTimer); estimateTimer = setTimeout(drawEstimate, 250); }
async function drawEstimate() {
  if (!current || !current.path) return;
  const level = +$('benchLevel').value;
  if (level < 2) { $('benchEstimate').innerHTML = '<span class="ok">L1 is free</span> — it compiles the artifact into a scratch workspace; no model runs.'; return; }
  try {
    const e = await api('/api/estimate', benchPayload({}));
    const usd = (x) => '$' + x.toFixed(x < 1 ? 3 : 2);
    let html = '<b>' + e.modelRuns + ' model run' + (e.modelRuns === 1 ? '' : 's') + '</b> (' + e.cases + ' case' + (e.cases === 1 ? '' : 's') + ' × ' + benchSel.length + ' harness' + (benchSel.length === 1 ? '' : 'es') + ' × ' + (+$('benchRuns').value || 1) + ')';
    if (e.estimateUsd !== null) html += ' · ≈ ' + usd(e.estimateUsd) + ' <span class="muted">from this artifact’s last runs</span>';
    if (e.unknown.length) html += ' · <span class="muted">' + esc(e.unknown.join(', ')) + ': cost unknown until a first run' + (e.unknown.includes('codex') ? ' (Codex reports tokens, not dollars)' : '') + '</span>';
    html += ' · ' + (e.ceiling !== null ? 'the ceiling <b>' + usd(e.ceiling) + '</b> stops the run' : '<span class="warn">no ceiling</span>');
    $('benchEstimate').innerHTML = html;
  } catch (err) { $('benchEstimate').textContent = err.message; }
}

function updateMeasure() {
  const can = !!(current && current.path && !current.isNew && dirty && ctx.capabilities.bench);
  $('measureBench').disabled = !can;
  $('pairHint').textContent = can
    ? 'Measure runs the same cases twice — on the file as saved and on your unsaved edit (in a throwaway copy) — and compares them.'
    : 'To measure a change: edit the artifact in the Skill view, leave it unsaved, come back and press Measure.';
}

function streamBench(id, onEnd) {
  const es = backend.benchEvents(id);
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    $('benchLog').textContent += e.kind.padEnd(7) + ' ' + e.text + '\n';
    $('benchLog').scrollTop = $('benchLog').scrollHeight;
  };
  es.addEventListener('end', (ev) => { es.close(); onEnd(JSON.parse(ev.data)); });
  es.onerror = () => { es.close(); onEnd({ error: 'the event stream closed' }); };
}
function benchBusy(on) { $('runBench').disabled = on || !ctx.capabilities.bench; $('measureBench').disabled = on; if (!on) updateMeasure(); }

$('runBench').onclick = async () => {
  if (!current || !current.path) return toast('open an artifact first', true);
  $('benchLog').hidden = false; $('benchLog').textContent = ''; $('benchMatrix').innerHTML = '';
  benchBusy(true);
  try {
    const { id } = await backend.bench(benchPayload({}));
    streamBench(id, async ({ result, error }) => {
      benchBusy(false);
      if (error) return toast(error, true);
      if (result) drawBenchMatrix(result);
      await loadRuns(); scheduleEstimate();
    });
  } catch (e) { benchBusy(false); toast(e.message, true); }
};

$('measureBench').onclick = async () => {
  if (!current || !current.path || !dirty) return;
  try {
    const c = await backend.compose(editPayload());
    if (!c.ok) return toast(c.reason, true);
    if (!c.diff) return toast('the edit changes nothing — there is nothing to measure');
    $('benchLog').hidden = false; $('benchLog').textContent = ''; $('benchMatrix').innerHTML = '';
    benchBusy(true);
    const { id } = await backend.bench(benchPayload({ variantText: c.text }));
    streamBench(id, async ({ pair, error }) => {
      benchBusy(false);
      if (error) return toast(error, true);
      await loadRuns(); scheduleEstimate();
      if (pair) showCompare(pair.before, pair.after, 'Your edit, measured');
    });
  } catch (e) { benchBusy(false); toast(e.message, true); }
};

function scenarioCell(sc) {
  if (!sc || sc.score === null) return '<span class="muted">' + (sc && !sc.graded ? 'no graders' : '—') + '</span>';
  return '<span class="' + (sc.score === 1 ? 'ok' : 'bad') + '">' + Math.round(sc.score * 100) + '%</span>' + (sc.failed.length ? ' <span class="muted">(' + esc(sc.failed.join(', ')) + ')</span>' : '');
}
function drawBenchMatrix(r, into) {
  const pct = (x) => x === null ? '—' : Math.round(x * 100) + '%';
  const l4 = r.levels.includes(4);
  let html = '<table class="plain"><tr><th>harness</th><th>model</th><th>trigger</th><th>control</th><th>obedience</th>' + (l4 ? '<th>scenario</th>' : '') + '<th>cost</th></tr>';
  for (const rep of r.reports) {
    const model = (r.models || {})[rep.harness];
    if (!rep.available) { html += '<tr><td>' + esc(rep.harness) + '</td><td colspan="' + (l4 ? 6 : 5) + '" class="muted">' + esc(rep.reason || 'unavailable') + '</td></tr>'; continue; }
    const ob = rep.obedience;
    html += '<tr><td>' + esc(rep.harness) + '</td><td class="mono muted">' + esc(model || 'default') + '</td>' +
      '<td class="' + (rep.trigger.fireRate ? 'ok' : 'bad') + '">' + pct(rep.trigger.fireRate) + (rep.trigger.lostTo.length ? ' <span class="warn">lost to ' + esc(rep.trigger.lostTo.join(', ')) + '</span>' : '') + '</td>' +
      '<td class="' + (rep.trigger.controlClean === false ? 'bad' : 'ok') + '">' + (rep.trigger.controlClean === null ? '—' : rep.trigger.controlClean ? 'clean' : 'FIRED') + '</td>' +
      '<td>' + (ob ? (ob.violations.length ? '<span class="bad">' + ob.violations.length + ' outside</span>' : '<span class="ok">inside</span>') + ' <span class="muted">[' + esc(ob.enforcement) + ']</span>' : '—') + '</td>' +
      (l4 ? '<td>' + scenarioCell(rep.scenario) + '</td>' : '') +
      '<td class="muted">' + (rep.costUsd ? '$' + rep.costUsd.toFixed(3) : rep.tokens ? rep.tokens + ' tok' : '—') + '</td></tr>';
    if (ob && ob.violations.length) html += '<tr><td></td><td colspan="' + (l4 ? 6 : 5) + '" class="warn" style="font-size:11px">' + esc(ob.violations.join(' · ')) + '</td></tr>';
  }
  html += '</table><div class="muted" style="margin-top:6px">L1 ' + (r.compiled.ok ? '<span class="ok">ok</span>' : '<span class="bad">FAIL</span>') + ' ' + esc(r.compiled.detail) + '</div>';
  (into || $('benchMatrix')).innerHTML = html;
}

// ── cases ─────
async function loadCases() {
  benchCases = await api('/api/cases?path=' + encodeURIComponent(current.path));
  const ro = !!current.readOnly;
  $('casesNote').textContent = benchCases.authored ? '· from ' + benchCases.dir : '· generated from the description — none authored yet';
  $('caseList').innerHTML = benchCases.cases.map((c, i) =>
    '<div class="caserow"><b>' + esc(c.name) + '</b><span class="pill">' + esc(c.invocation) + '</span><span class="pill ' + (c.expect === 'fire' ? 'ok' : '') + '">' + esc(c.expect) + '</span>' +
    '<span class="p" title="' + esc(c.prompt) + '">' + esc(c.prompt || '(the explicit invocation alone)') + '</span>' +
    (c.source === 'auto' ? '<span class="muted">generated</span>' : '') +
    '<button class="btn small" data-i="' + i + '"' + (ro ? ' disabled' : '') + '>' + (c.source === 'auto' ? 'Write as file' : 'Edit') + '</button></div>').join('');
  for (const b of $('caseList').querySelectorAll('button')) b.onclick = () => editCase(benchCases.cases[+b.dataset.i]);
  $('writeAuto').hidden = benchCases.authored || ro;
  $('newCase').disabled = ro;
  const sel = $('benchCase').value;
  $('benchCase').innerHTML = '<option value="">all</option>' + benchCases.cases.map((c) => '<option' + (c.name === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
}
function editCase(c) {
  $('caseEditor').hidden = false;
  $('c_name').value = c ? c.name : ''; $('c_invocation').value = c ? c.invocation : 'implicit'; $('c_expect').value = c ? c.expect : 'fire';
  $('c_turns').value = c ? c.maxTurns : 8; $('c_prompt').value = c ? c.prompt : '';
  $('caseFile').textContent = c && c.file ? c.file : benchCases.dir + '/' + (c ? c.name : '<name>') + '/prompt.md';
  $('c_name').focus();
}
$('newCase').onclick = () => editCase(null);
$('cancelCase').onclick = () => { $('caseEditor').hidden = true; };
$('saveCase').onclick = async () => {
  try {
    const r = await api('/api/case', { path: current.path, name: $('c_name').value.trim(), invocation: $('c_invocation').value, expect: $('c_expect').value, maxTurns: +$('c_turns').value, prompt: $('c_prompt').value });
    $('caseEditor').hidden = true; toast('saved ' + r.written.join(', '));
    await loadCases(); scheduleEstimate();
  } catch (e) { toast(e.message, true); }
};
$('writeAuto').onclick = async () => {
  try {
    const r = await api('/api/case', { path: current.path, cases: benchCases.cases.filter((c) => c.source === 'auto') });
    toast('wrote ' + r.written.length + ' case files'); await loadCases();
  } catch (e) { toast(e.message, true); }
};

// ── history + compare ─────
const when = (id) => id.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}).*$/, '$1 $2:$3:$4');
async function loadRuns() {
  benchRuns = (await api('/api/runs?path=' + encodeURIComponent(current.path))).runs;
  selectedRuns = selectedRuns.filter((id) => benchRuns.some((r) => r.id === id));
  const pct = (x) => x === null ? '—' : Math.round(x * 100) + '%';
  $('runList').innerHTML = benchRuns.length ? benchRuns.map((r) =>
    '<div class="runrow" data-id="' + esc(r.id) + '"><input type="checkbox" data-id="' + esc(r.id) + '"' + (selectedRuns.includes(r.id) ? ' checked' : '') + '>' +
    '<div><b>' + esc(when(r.id)) + '</b> ' + (r.label ? '<span class="pill ' + (r.label === 'after' ? 'on' : '') + '">' + esc(r.label) + '</span>' : '') + (r.pair ? '<span class="muted">pair ' + esc(r.pair) + '</span>' : '') +
    ' <span class="muted">L' + Math.max(...r.levels) + '</span>' +
    '<div class="h">' + r.harnesses.map((h) => esc(h.harness) + ': ' + (h.available ? 'fire ' + pct(h.fireRate) + (h.controlClean === false ? ' · control FIRED' : '') + (h.violations ? ' · ' + h.violations + ' outside' : '') + (h.scenario !== null ? ' · scenario ' + pct(h.scenario) : '') : 'unavailable')).join(' · ') + '</div></div>' +
    '<div class="muted">' + (r.costUsd ? '$' + r.costUsd.toFixed(3) : r.tokens ? r.tokens + ' tok' : r.levels.length === 1 ? 'free' : '—') + '</div></div>').join('')
    : '<div class="muted">no runs yet — results are kept outside the project, in ~/.saut/results/</div>';
  for (const row of $('runList').querySelectorAll('.runrow')) row.onclick = (e) => {
    if (e.target.type === 'checkbox') return;
    openRun(row.dataset.id);
  };
  for (const c of $('runList').querySelectorAll('input[type=checkbox]')) c.onchange = () => {
    selectedRuns = c.checked ? [...selectedRuns.filter((x) => x !== c.dataset.id), c.dataset.id].slice(-2) : selectedRuns.filter((x) => x !== c.dataset.id);
    for (const x of $('runList').querySelectorAll('input[type=checkbox]')) x.checked = selectedRuns.includes(x.dataset.id);
    $('compareBtn').disabled = selectedRuns.length !== 2;
  };
  $('compareBtn').disabled = selectedRuns.length !== 2;
}
async function openRun(id) {
  try {
    const r = await api('/api/run?path=' + encodeURIComponent(current.path) + '&id=' + encodeURIComponent(id));
    $('benchLog').hidden = true;
    drawBenchMatrix(r.result);
  } catch (e) { toast(e.message, true); }
}
$('compareBtn').onclick = () => {
  const [a, b] = [...selectedRuns].sort();                    // older first
  showCompare(a, b, 'Compare');
};

// Two runs side by side, per harness: what moved, and which way.
async function showCompare(aId, bId, title) {
  try {
    const [A, B] = await Promise.all([aId, bId].map((id) => api('/api/run?path=' + encodeURIComponent(current.path) + '&id=' + encodeURIComponent(id))));
    const hs = [...new Set([...A.summary.harnesses, ...B.summary.harnesses].map((h) => h.harness))];
    const pct = (x) => x === null || x === undefined ? '—' : Math.round(x * 100) + '%';
    const delta = (a, b, higherIsBetter) => {
      if (a === null || b === null || a === undefined || b === undefined || a === b) return '<span class="delta same">=</span>';
      const up = b > a;
      return '<span class="delta ' + (up === higherIsBetter ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + '</span>';
    };
    let html = '<div class="legend">' + esc(when(aId)) + (A.summary.label ? ' (' + esc(A.summary.label) + ')' : '') + ' → ' + esc(when(bId)) + (B.summary.label ? ' (' + esc(B.summary.label) + ')' : '') + '</div>';
    html += '<table class="plain"><tr><th>harness</th><th>metric</th><th>' + esc(A.summary.label || 'older') + '</th><th>' + esc(B.summary.label || 'newer') + '</th><th></th></tr>';
    for (const h of hs) {
      const a = A.summary.harnesses.find((x) => x.harness === h) || {}, b = B.summary.harnesses.find((x) => x.harness === h) || {};
      const rows = [
        ['model', A.summary.models[h] || 'default', B.summary.models[h] || 'default', ''],
        ['trigger (fire rate)', pct(a.fireRate), pct(b.fireRate), delta(a.fireRate, b.fireRate, true)],
        ['control', a.controlClean === null ? '—' : a.controlClean ? 'clean' : 'FIRED', b.controlClean === null ? '—' : b.controlClean ? 'clean' : 'FIRED', delta(a.controlClean ? 1 : 0, b.controlClean ? 1 : 0, true)],
        ['outside the allowlist', a.violations ?? '—', b.violations ?? '—', delta(a.violations, b.violations, false)],
        ['scenario', pct(a.scenario), pct(b.scenario), delta(a.scenario, b.scenario, true)],
        ['cost', a.costUsd ? '$' + a.costUsd.toFixed(3) : (a.tokens ? a.tokens + ' tok' : '—'), b.costUsd ? '$' + b.costUsd.toFixed(3) : (b.tokens ? b.tokens + ' tok' : '—'), delta(a.costUsd || a.tokens, b.costUsd || b.tokens, false)],
      ];
      html += rows.map((r, i) => '<tr>' + (i === 0 ? '<td rowspan="' + rows.length + '"><b>' + esc(h) + '</b></td>' : '') + '<td class="muted">' + r[0] + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + r[3] + '</td></tr>').join('');
    }
    html += '</table><div class="legend">▲ better · ▼ worse. One run per case is a smoke test; use 3 runs to tell "always" from "sometimes".</div>';
    $('compareTitle').textContent = title;
    $('compareBody').innerHTML = html;
    $('compareCard').hidden = false;
    $('compareCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) { toast(e.message, true); }
}

$('validate').onclick = async () => {
  $('validate').disabled = true; $('benchLog').hidden = false; $('benchLog').textContent = 'running…';
  try {
    const r = await backend.validate();
    $('benchLog').textContent = r.command + '\n\n' + r.output;
    toast(r.command + (r.ok ? ' — green' : ' — FAILED'), !r.ok);
  } catch (e) { toast(e.message, true); } finally { $('validate').disabled = false; }
};

// ── harnesses (the registry, as reference) ────────────────────────
function drawHarnessCards() {
  $('harnessCards').innerHTML = ctx.harnesses.map((h) => {
    const sem = (s) => '<span class="pill ' + (s === 'restrict' ? 'ok' : s === 'grant' ? 'warn' : 'bad') + '">' + esc(s) + '</span> <span class="muted">' + esc(ALLOWLIST_MEANS[s] || '') + '</span>';
    const m = h.models;
    const models = m ? '<details><summary>models · verified ' + esc(m.verifiedAt) + '</summary><table class="plain"><tr><th>model</th><th>status</th><th>effort</th><th>instead</th></tr>' +
      m.catalog.map((x) => '<tr><td class="mono">' + esc(x.id) + '</td><td class="' + (x.status === 'current' ? 'ok' : x.status === 'unsupported' || x.status === 'retired' ? 'bad' : 'warn') + '">' + esc(x.status) + '</td><td class="muted">' + esc(x.efforts.join(', ') || 'none') + '</td><td>' + esc(x.replacement || '') + '</td></tr>').join('') +
      '</table>' + (Object.keys(m.aliases).length ? '<div class="legend">aliases: ' + Object.entries(m.aliases).map(([k, v]) => esc(k) + (v ? ' → ' + esc(v) : ' (run time)')).join(' · ') + '</div>' : '') +
      '<div class="legend">sources: ' + m.sources.map((s) => /^https?:/.test(s) ? '<a href="' + esc(s) + '" target="_blank" rel="noopener noreferrer">' + esc(s.replace(/^https?:\/\//, '')) + '</a>' : esc(s)).join(' · ') + '</div></details>' : '';
    return '<div class="card"><h3>' + esc(h.title) + ' <span class="muted mono">' + esc(h.id) + '</span> ' + (h.runner ? '<span class="pill ok">bench runner</span>' : '<span class="pill">no runner</span>') + '</h3>' +
      '<dl><dt>skill allowlist</dt><dd>' + sem(h.toolAllowlist) + '</dd><dt>agent allowlist</dt><dd>' + sem(h.agentAllowlist) + '</dd>' +
      '<dt>to restrict</dt><dd>' + esc(h.denyMechanism || '—') + '</dd><dt>model pin</dt><dd>' + esc(h.modelPin) + '</dd>' +
      '<dt>skills live in</dt><dd class="mono">' + esc(h.skillsDirs.join(', ')) + '</dd><dt>listing</dt><dd>' + esc(h.listing.budget) + (h.listing.descCap ? ' · description cap ' + h.listing.descCap : '') + '</dd>' +
      '<dt>frontmatter read</dt><dd class="mono muted">' + esc(h.frontmatterFields.join(', ')) + '</dd></dl>' +
      models +
      (h.degradations.length ? '<details><summary>' + h.degradations.length + ' recorded degradation(s)</summary>' + h.degradations.map((d) => '<div class="muted" style="margin:4px 0"><b>' + esc(d.id) + '</b>: ' + esc(d.text) + '</div>').join('') + '</details>' : '') +
      '<div class="legend">' + (h.docs || []).map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u.replace(/^https?:\/\//, '').split('/').slice(0, 3).join('/')) + '</a>').join(' · ') + '</div></div>';
  }).join('');
}

// ── start ─────────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
(async () => {
  try {
    await loadContext();
    await loadOverview();
    const hash = decodeURIComponent(location.hash.slice(1));
    if (hash && ctx.artifacts.some((a) => a.path === hash)) await openArtifact(hash);
    else show(store.get('view', 'overview') === 'harnesses' ? 'harnesses' : 'overview');
  } catch (e) { toast(e.message, true); }
})();
