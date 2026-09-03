# The Studio — `saut studio`

```bash
saut studio .                    # a skill folder, a repo, or a TAUT pack
saut studio ~/taut-data --port 7391 --deployment upe
```

A local page over the same library functions the CLI verbs call: nothing here re-implements a
rule, a cost model or a runner. It opens on `127.0.0.1` with an ephemeral port and prints the
URL; `Ctrl-C` stops it.

## What it shows

**Left — artifacts and harnesses.** Every `SKILL.md` and agent under the root, and the harness
registry with the fact that matters per harness: is a declared allowlist a `restrict`, a
`grant`, `prose`, or `dropped`, plus the recorded degradations.

**Middle — the form and the body.** Name, description (with a live character count against the
listing cap, because that text is paid in *every* session), argument hint, invocation flags,
model and effort, the tool picker (built from the harness registry plus the MCP catalog, with a
scope box for `Bash(git status *)`), and — in a TAUT pack — the `metadata.taut` wiring block.
The form emits frontmatter through the emitter, so what it writes is what the parser accepts.
A pasted multi-line description is folded to one line rather than silently breaking the compile.

**Right — three tabs.**

- *Passport*: cost (always-on / on-invoke, with what the artifact drags in transitively), the
  per-harness enforcement matrix, and every lint finding with its rule id and line.
- *Compiled* (TAUT packs): the exact bytes the installer would write on each harness, with that
  adapter's degradations — the compiler in the authoring loop.
- *Bench*: pick the level, runs, cost ceiling and harnesses, press Run, and the events stream in
  live over SSE; the matrix lands underneath. **Validate pack** runs the pack's own
  `tools/validate-pack.sh` (compile + verify + the SAUT step) and shows its output verbatim.

## Security

A mutating localhost UI, so it mirrors the TAUT panel's contour exactly:

- binds `127.0.0.1` only;
- a per-session token, generated at start, embedded in the served page and required in a
  **custom** request header on every POST — which forces a CORS preflight that is never answered;
- an `Origin` check on POST and a `Host` check on everything (DNS-rebinding guard);
- no CORS headers are ever sent, so a foreign page can read nothing;
- writes are contained under the root the studio was started with, and only to a `SKILL.md` or
  an agent `.md` — a path outside, or a non-markdown target, is refused;
- the SSE stream carries the token in its query (EventSource cannot set headers) and is
  read-only.

The page never sees a secret: the tool registry carries names, and `--live` discovery (spawning
catalog MCP servers) stays a CLI action.

## What it does not do

No git. Publishing is writing the file and running the pack's validation; committing and
pushing stay in your hands, where the pack's own rules put them.
