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
  is disabled.
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

Pick the level (L1–L4), runs, cost ceiling and harnesses (the targets that have a headless
runner), press Run, and the events stream in live over SSE; the matrix lands underneath, with a
scenario column at L4. Runs are stored outside the project, in `~/.saut/results/` (see
[BENCH.md](BENCH.md#output)). **Validate pack** runs the pack's own `tools/validate-pack.sh`
(compile + verify + the SAUT step) and shows its output verbatim.

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
  to a `SKILL.md` or an agent `.md`, never to a file sealed by `taut.lock`;
- paths cross the API relative to the root — the page is never told where the root lives;
- the SSE stream carries the token in its query (EventSource cannot set headers) and is
  read-only.

The page never sees a secret: the tool registry carries names, and `--live` discovery (spawning
catalog MCP servers) stays a CLI action. The editor is CodeMirror 6 (MIT), bundled into
`lib/studio/vendor/codemirror.js`; SAUT still has no runtime dependencies.

## What it does not do

No git. Publishing is writing the file and running the pack's validation; committing and
pushing stay in your hands, where the pack's own rules put them.
