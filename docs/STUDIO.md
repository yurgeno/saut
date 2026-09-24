# The Studio — `saut studio`

```bash
saut studio .                    # a skill folder, a repo, a TAUT pack, or a compiled workspace
saut studio ~/my-pack --port 7391 --deployment myproject
```

A local page over the same library functions the CLI verbs call: nothing here re-implements a
rule, a cost model or a runner. It opens on `127.0.0.1` with an ephemeral port and prints the
URL; `Ctrl-C` stops it.

The header names what the root is — a skills folder, a TAUT pack, or a compiled workspace — and
carries the **target harnesses**: the matrix, the findings and the bench follow that choice
(remembered per browser). Under it, a pill says how old the vendor guidance is (amber after 60
days: run `saut guidance`); in a TAUT pack the deployment's model-ladder findings sit next to it.

## Overview

Where the Studio opens. Totals for the root — high findings, security findings, outdated
settings (guidance class A), prompt hypotheses (class B), mechanical fixes, tokens paid in every
session — and one row per skill or agent: its high/medium/security counts, guidance A·B·D,
fixable findings, always-on and on-invoke tokens, and what its allowlist is on each target
harness. Sort by any column, filter by name, kind or "only with findings"; a row opens the
artifact. New skills and agents start here.

The **Security** card lists every security rule that fires — and the privilege rules that make
an injection dangerous (no allowlist, a model-invocable writer, dynamic context) — with the
artifacts it fires in; a rule filters the table to them. It says which content scanner is
installed (SkillSpector, Snyk Agent Scan, Cisco skill-scanner — rented, never bundled), runs it
on the root, and when none is installed says so and links them, rather than implying a clean
bill. A scan's findings join the Overview and each artifact's Problems until the next scan. The
card also counts the findings suppressed in `saut.json` and shows a stale or invalid entry.

## Skill

**Editor, two views of one file.**

- *Form* — name, description (with a live character count against the listing cap: that text
  is paid in every session), argument hint, invocation flags, model and effort, the tool
  picker (harness registry plus MCP catalog, with a scope box for `Bash(git status *)`), the
  `metadata.taut` wiring in a TAUT pack, and the body in a Markdown editor.
- *Source* — the whole file, exactly as saved: capability-marker branches, comments, keys the
  form does not show.

Edits cross between the two in both directions.

**Saving never loses what the form does not show.** An existing file is saved as *text*: a form
edit is applied to the file field by field (only the fields whose value changed; comments, key
order, quoting, `disallowed-tools`, `hooks`, marker branches and every other key stay as they
are), and a field whose value differs between capability branches is refused with a pointer to
the Source view rather than flattened. Every save shows the diff first; **Save** writes it
against the hash the file was opened with, so an edit made meanwhile in an IDE is refused, not
overwritten. `Ctrl/⌘+S` saves. A new artifact is emitted from the form into the spec layout.

Any edit shows **● unsaved changes**; opening another artifact, starting a new one or reverting
asks first. While you type, the inspector re-lints the *unsaved* text (marked **live —
unsaved**); nothing is written.

**Inspector.**

- *Problems* — findings for the target harnesses, grouped: security, current guidance,
  privileges, hygiene and cost, syntax, TAUT wiring. Each says what it is, how to fix it and
  why it matters, links to its rule, and jumps to its line (a frontmatter line focuses the form
  field, a body line is selected in the editor; lines with high and medium findings are tinted
  in the editors). Vendor-guidance findings show their class — A outdated, B a hypothesis to
  change only against a bench, D hardening — the date the data was verified and its sources.
  A finding with a mechanical fix has a button that opens the diff; **Apply and save** writes
  it and re-lints. The server applies only a fix the linter proposes for the file as it is at
  that moment, and refuses if the file changed since the preview; with unsaved edits, applying
  is disabled. A finding that does not apply here has **Suppress…**: a reason (required), this
  finding only or the whole rule for this artifact, the `saut.json` diff, then the write. A
  suppressed finding stays listed, with its reason, under *Suppressed*, and can be lifted the
  same way (see [RULES.md](RULES.md#suppressing-a-finding)).
- *Harnesses* — what the allowlist is on each target harness, and what that means.
- *Cost* — always-on and on-invoke tokens, with the agents the artifact drags in.
- *Compiled* (TAUT packs) — the exact bytes the installer would write on each harness, with
  that adapter's degradations.

In a TAUT pack, line numbers are the file's: the engine's marker pass removes lines before
parsing, and findings are mapped back to the line you see.

**A compiled workspace** (a root sealed by `taut.lock`) is shown read-only: an edit there is
overwritten by the next `taut update` and makes `taut verify` fail. The banner names the pack
source and commit the file was compiled from; the copies of one skill for different harnesses
collapse into one Overview row. Files not in the lock stay editable.

## Bench

For the artifact open in the Skill view.

- **Run** — level (L1–L4), runs, cost ceiling, one case or all, and per target harness with a
  headless runner whether to run it and on which **model** (the registry's current and previous
  models as suggestions; empty means the cheap default). Before anything runs, the estimate says
  how many model runs that is and — from this artifact's earlier runs — about what it costs;
  L1 is free. The events stream in live; the matrix names the model each harness ran.
- **Measure: saved vs my edit** — with an unsaved edit in the Skill view, the same cases,
  harnesses and models run twice: on the file as saved and on the edit, in a throwaway copy.
  The two land in the history as a *before/after* pair and open side by side. This is how a
  class-B guidance change (prompt style) is meant to be made: one change, measured. A B finding
  links here.
- **Cases** — the cases the bench runs: authored under `evals/<case>/prompt.md`, else three
  generated from the description. Edit one, add one, or write the generated ones as files to
  start a suite.
- **History** — every run of this artifact (kept outside the project, in `~/.saut/results/`),
  newest first, with its label, level and per-harness results; open one, or select two and
  **Compare**: per harness, fire rate, control, calls outside the allowlist, scenario score and
  cost, with ▲/▼ for better and worse.
- **Validate pack** runs the pack's own `tools/validate-pack.sh` (compile + verify + the SAUT
  step) and shows its output verbatim.

Paths in the bench log and in the results the page receives are shown as `<root>`, `<tmp>` and
`~`; the page is not told where anything lives.

## Harnesses

The registry as reference: per harness, what a skill or agent allowlist is there, how to
restrict, the model pin, where skills live, the listing budget, the frontmatter it reads, its
model catalog (status, effort levels, replacement; verified date and sources), the recorded
degradations and the documentation it was derived from.

## Security

A mutating localhost UI, so it mirrors the TAUT panel's contour:

- binds `127.0.0.1` only;
- a per-session token, generated at start, carried in the page's `<meta>` and required in a
  **custom** request header on every `/api` call — which forces a CORS preflight that is never
  answered;
- the page runs no inline script: `script-src 'self'` only; the shell, script, stylesheet and
  the vendored editor are served by name from the Studio directory, never by a path the
  request chooses;
- an `Origin` check on POST and a `Host` check on everything (DNS-rebinding guard);
- no CORS headers are ever sent, so a foreign page can read nothing; the page cannot be framed;
- writes are contained under the root the studio was started with (symlinks resolved), only
  to a `SKILL.md`, an agent `.md`, a case `prompt.md` or `saut.json`, never to a file sealed by
  `taut.lock`;
- paths cross the API relative to the root — the page is never told where the root lives;
- the SSE stream carries the token in its query (EventSource cannot set headers) and is
  read-only.

The page never sees a secret: the tool registry carries names, and `--live` discovery (spawning
catalog MCP servers) stays a CLI action. The editor is CodeMirror 6 (MIT), bundled into
`lib/studio/vendor/codemirror.js`; SAUT still has no runtime dependencies.

## What it does not do

No git. Publishing is writing the file and running the pack's validation; committing and
pushing stay in your hands, where the pack's own rules put them.
