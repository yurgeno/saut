# The bench — `saut test`

Three cumulative levels. L1 is free; L2 and L3 call real models and cost real money.

| level | question | cost |
|---|---|---|
| **L1 compile** | does the artifact land where each harness looks for it? | free |
| **L2 trigger** | does the harness actually fire this skill — explicitly, implicitly, and *not* on an unrelated prompt? | one model run per case per harness |
| **L3 obedience** | do the runs stay inside the declared allowlist, and what does the harness refuse? | the same runs |

```bash
saut test skills/dev-review                        # L3, 1 run per case, every runnable harness
saut test skills/dev-review --level 1              # free: compile only
saut test skills/dev-review --harness codex --runs 3 --max-cost 1.00
saut test agents/dev-reviewer.md --case implicit   # one case
saut test skills/upe-verify --landscape ~/IdeaProjects --keep
```

## L1 — the scratch workspace

Nothing runs in your workspace. A temporary directory is built per bench:

- **generic**: the skill directory is copied into each harness's primary discovery path
  (`.claude/skills/<n>`, `.agents/skills/<n>`, `.opencode/skills/<n>`), sibling agents into
  each markdown agents directory, an `opencode.json` denies bash/edit/webfetch, and the
  whole thing becomes a git repo (Codex walks up to a git root).
- **taut**: the pack is **compiled by the engine** into `<scratch>/ws` against stub member
  repos — the same recipe as a pack's `tools/validate-pack.sh` — then `taut verify` seals it.
  What the bench runs against is therefore the real installed artifact: markers resolved,
  hooks wired, per-harness paths, the integrity gate live. `--landscape <dir>` replaces the
  stubs with a **copy** of a real landscape; the original is never touched.

L1 fails loudly when the artifact does not land (excluded by the repo-map lint, gated off by
a capability marker, or a compile error) — the later levels are then skipped for that run.

## L2 — trigger

Each case is one headless session. Cases come from `<skill>/evals/**/prompt.md` (the Claude
Code `plugin eval` layout; SAUT additionally reads `expect: fire | no-fire` and
`invocation: explicit | implicit | control`), or three are generated:

| case | prompt | expectation |
|---|---|---|
| `explicit` | the harness's own invocation syntax (`/name`, `$name`, "use the … skill") | fires |
| `implicit` | the task, phrased from the description with the "Invoke:" sentence stripped | fires |
| `control` | an unrelated one-liner | does **not** fire |

How firing is observed: a `Skill` tool call naming the artifact (Claude Code, opencode), the
skill file being read (Codex reads `SKILL.md` when a description matches), or the expansion
of an explicit invocation. Two states matter beyond fired/not:

- **`lost to <other>`** — the run fired a *different* skill. That is the description losing a
  routing contest, the single most actionable trigger finding.
- **`blocked`** — the invocation was made and *refused* (a gate, a permission rule). A finding
  about the workspace, not about the author.

**Caveat, always printed when observable:** the session sees every skill installed for that
user, so an implicit prompt competes with them. The count is reported (`+24 competing`).
Claude Code's config directory cannot be isolated without losing authentication, so the bench
reports the contamination instead of pretending it isn't there.

## L3 — obedience

Every tool call is mapped into the Claude-shaped vocabulary allowlists are written in
(`shell` → `Bash`, `apply_patch` → `Edit`, …) and compared against the artifact's own
`allowed-tools` / `tools`, with Claude Code's scoped-rule semantics: `Bash(git status *)`
matches `git status` and `git status --short` but not `git push`, and a compound command is
allowed only when every part matches some rule.

Three outcomes per call:

- **inside the allowlist** — nothing to report;
- **denied** — the harness refused it (permission mode, sandbox, gate). Not a violation: the
  guardrail worked;
- **outside the allowlist** — it ran, and the declaration did not cover it. On a `grant`
  harness that means the declaration was never a restriction; on a `prose` harness it is the
  recorded degradation, measured.

The bench pre-approves `Skill` (the mechanism under test) and withholds the shell, so a
mutation attempt surfaces as a denial rather than running. Read-only commands still execute
under the harness's own classifier.

## Isolation and cost

- Scratch workspace, deleted unless `--keep`. Codex runs `--sandbox read-only --ephemeral`;
  opencode gets deny-by-default permissions; Claude runs `--permission-mode dontAsk` with the
  grant above and `--setting-sources project`.
- Cheap models by default (`haiku`, `gpt-5.4-mini`); `--model` overrides, `--max-cost <usd>`
  stops the bench when Claude-reported spend reaches the ceiling (Codex and opencode do not
  report cost — token totals are reported instead).
- `--runs n` for a fire *rate* rather than a single sample. One run is a smoke test; three is
  the smallest number that distinguishes "always" from "sometimes".

## Output

`<artifact>/evals/results/<timestamp>/matrix.json` — the full result: every trace with its
tool calls, usage, cost and the path to the raw event stream under `traces/`. `--out` moves
it, `--json` prints it. Exit code 1 when the compile failed, a fire rate is 0, a control
fired, or a call landed outside the allowlist.

Results land next to the artifact by convention (the `plugin eval` layout). In a pack under
version control, add `evals/results/` to `.gitignore` — the cases are source, the runs are not.

## Adding a harness

A harness with a `runner` entry in `lib/harnesses/<id>.json` and a parser in
`lib/bench/runners.mts` joins the matrix. The parser's only job is turning that harness's
event stream into `Trace`; everything else — cases, scratch, obedience, budget — is shared.
