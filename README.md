# SAUT — Skill Assurance Under Trust

**Lint, cost and test agent skills and subagents — for any harness, from one source.**

Agent skills (`SKILL.md`, the [Agent Skills](https://agentskills.io) format) are read by
Claude Code, Codex, OpenCode, Cursor, Copilot and more — and each harness treats the same
frontmatter differently. `allowed-tools` is a *grant* on Claude Code, prose on Codex and
OpenCode, and dropped outright when a subagent is rendered to TOML. Nothing tells the author.
Nothing counts what a skill costs in every session. Nothing checks that the body's tools match
its allowlist.

SAUT does. It is the third member of the *Under Trust* family — next to
[KAUT](https://github.com/yurgeno/kaut) (knowledge) and [TAUT](https://github.com/yurgeno/taut)
(toolchain distribution) — and works on any skill folder; a TAUT data pack is a first-class
case, not a requirement.

```
saut lint  <skills or agents…>   privilege / correctness findings + per-harness enforcement
saut cost  <skills or agents…>   always-on vs on-invoke token passport, budgets
saut passport <…>                lint + cost + harness matrix (+ compiled previews) as one JSON
saut preview <name> [dir]        TAUT packs: the compiled bytes of one artifact per harness
saut test  <skill or agent>      the bench: compile → does it trigger → does it obey the allowlist
saut studio [dir]               the local UI over all of it: form + body, passport, bench, validate
saut harnesses                   what each harness enforces, degrades, and lists
saut tools [dir] [--live]        the tool names an allowlist may cite (builtin + MCP catalog)
```

Zero runtime dependencies, Node ≥ 24 (TypeScript executed natively). Apache-2.0.

## Why

The rules come from a real review of a production pack (13 skills, 7 agents): four skills
with no allowlist at all, a "read-only" skill with `Write` granted, a body invoking
`mcp__playwright__*` that its allowlist never carried, `WebFetch` granted and never used,
a supervised-only skill the model could invoke on its own, ~3 000 tokens of descriptions paid
in every session. Every one of those is now a rule (see [docs/RULES.md](docs/RULES.md)),
and every rule cites its precedent.

The part no scanner gives you is the **matrix**: for one artifact, on each harness, is the
declared allowlist a restriction, a pre-approval grant, informational prose, or dropped?

```
skill workspace-check skills/workspace-check/SKILL.md — 9 findings
  high   readonly-not-enforced [claude-code] — on Claude Code `allowed-tools` only PRE-APPROVES; …
  high   model-invocable-writer:2 — model may invoke this skill on its own … and it can mutate (Bash) (S2)
  medium readonly-not-enforced [codex,copilot,cursor,opencode] — the tool allowlist is informational …
  medium bash-unscoped-readonly:5 — claims read-only but grants bare `Bash` — narrow it … (S7)
  enforcement claude-code=grant · codex=prose · copilot=prose · cursor=prose · opencode=prose
```

## Install

```bash
git clone https://github.com/yurgeno/saut.git ~/saut
node ~/saut/saut.mjs --help          # or: npm link inside the clone → `saut`
```

## Usage

```bash
saut lint .                              # walk a tree: every SKILL.md + agents/*.md
saut lint skills/dev-review              # one skill
saut lint agents/dev-reviewer.md         # one agent
saut lint . --harness claude-code,codex  # judge for a subset of harnesses
saut lint . --json | --sarif             # CI / IDE
saut lint . --strict                     # exit 1 on medium findings too

saut cost .                              # estimates (no key, no network)
saut cost . --exact                      # Claude token-counting API (ANTHROPIC_API_KEY)
saut cost . --budget budgets.json        # or a saut.json {"budgets": {...}} up the tree

saut tools . --live                      # spawn catalog MCP servers, ask tools/list
```

**Targets** are files or directories: a `SKILL.md`, a skill directory, an agent `.md`, or a
tree to walk (`skills/`, `<project>/skills/`, `agents/`, `.claude/agents/`, … all fall out of
the same walk).

**MCP catalog.** To judge `mcp__server__tool` names SAUT needs a catalog: a TAUT
`catalog/mcp.json` (`servers.<id>.{serverKey, role, tools[]}`), a `.mcp.json` or an
`opencode.json`. It is auto-detected up the tree from the first target; pass `--catalog` to
be explicit. Without a catalog, MCP names are not judged. `--live` spawns each server and
asks it for `tools/list` (values of env variables never leave your machine).

**Exit codes:** 0 clean / within budget · 1 findings (high; medium under `--strict`) or over
budget · 2 usage error.

## What "cost" means

| column | what it is | when it is paid |
|---|---|---|
| always-on | `name` + `description` (the listing entry) | every session, whether or not the skill fires |
| on-invoke | the body | each time the skill fires |
| transitive | subagents the skill wires (`metadata.taut.agents`, `agent:`), files the body references by path | on invoke, in the subagent's or the reader's context |

Default numbers are **estimates** (a deterministic heuristic, labelled as such — like
`claude plugin details`). `--exact` counts through the Claude token-counting API. Budgets
(`descriptionChars`, `alwaysOnTokens`, `invokeTokens`) turn the passport into a gate.

## Harness registry

Everything SAUT knows about a harness is data: `lib/harnesses/<id>.json` — discovery
directories, builtin tool names, honoured frontmatter fields, allowlist semantics for skills
and agents, the deny mechanism, listing budget, headless runner, recorded degradations, and
the documentation URLs the entry was derived from. `saut harnesses` prints it. Adding a
harness is adding a file; no rule changes.

Registered today: `claude-code`, `codex`, `opencode` (with headless runners — the test
bench lands next), `cursor`, `copilot` (registry-only). In a TAUT pack the engine's own
adapter records take precedence for the harnesses it ships.

## TAUT packs

A [TAUT](https://github.com/yurgeno/taut) data pack is detected by shape (`pack.json` +
`skills/` or `<project>/deployment.json`). Without an engine it lints as plain skills —
capability-marker branches (`# kaut:on` … `# kaut:off`) are read as the *union* of
allowlists and the first description. With an engine reachable (`--taut <dir>`,
`$SAUT_TAUT_ENGINE`, `~/taut`; engine commit `3e00050` or later, which
ships the `render` verb and the harness capability registry), the adapter switches on:

- skill frontmatter is parsed by the **engine's** parser — the strict subset that decides
  a compile — under the all-gates-ON view; what the engine refuses is a `taut-compile`
  finding, not a crash;
- `metadata.taut` is checked against the pack's real catalog: `agents` must exist,
  `mcp` roles must be carried by a catalog server, `repos` must be in the deployment's
  repo map, `requires` must be a gate the engine knows, `role` one it consumes;
- the matrix uses the engine's own adapter records (allowlist semantics, degradations);
- `saut passport` adds `compiled`: for every harness the target path, byte size, token
  estimate and recorded degradations of the exact artifact the installer writes;
  `saut preview <name> [dir] --harness <id>` prints those bytes.

```bash
saut lint ~/taut-data-community                      # engine auto-detected
saut preview dev-reviewer ~/taut-data-community --harness codex
saut passport ~/taut-data/upe/skills/upe-verify --deployment upe
saut lint ~/taut-data --no-taut                      # plain mode on purpose
```

Pack CI: `tools/validate-pack.sh` in the TAUT packs runs `saut lint` after the compile when
`SAUT` points at a checkout (`SAUT=~/saut tools/validate-pack.sh`); `SAUT_STRICT=1` turns
its findings into a failing step.

## The bench

`saut test` answers the three questions a lint cannot: does the artifact land where the
harness looks (L1), does the harness actually fire it — and not fire on an unrelated prompt
(L2), and does the run stay inside the declared allowlist (L3). Everything happens in a
scratch workspace; for a TAUT pack the engine compiles it there first, so the bench runs the
real installed artifact with its gate live.

```
matrix skill dev-review · taut · L3
  L1 compile   ok compiled by taut @21df2ff (claude-code+codex, 1 stub repos)
  claude-code  trigger 100% · control clean · obedience inside allowlist · 2 denied [grant]
    explicit   ok      fired=expansion tools=Read,Bash,Bash,Bash
    implicit   ok      fired=tool      tools=Skill,Read,Glob
    control    ok      fired=none      tools=—
    caveat: 24 other skills were installed for this session — implicit triggering competes with them
  codex        trigger 100% · control clean · obedience inside allowlist [prose]
```

Two states carry most of the value: **`lost to <skill>`** (the implicit prompt fired a
*different* skill — the description lost a routing contest) and **outside allowlist** (a call
ran that the declaration never covered; on Codex and opencode that is the recorded
degradation, measured rather than asserted). Full detail, isolation and cost controls:
[docs/BENCH.md](docs/BENCH.md).

## The Studio

```bash
saut studio .
```

One local page over the same functions: the form writes frontmatter through the emitter (so it
compiles), the passport shows cost, the enforcement matrix and every finding as you type, the
Compiled tab shows the exact per-harness bytes for a TAUT pack, and the Bench tab runs L1–L3
with the events streaming live. **Validate pack** runs the pack's own `tools/validate-pack.sh`.

Loopback only, per-session token in a custom header, Origin and Host checks, writes contained
under the root — the TAUT panel's contour. Details: [docs/STUDIO.md](docs/STUDIO.md).

## Roadmap

- **P0** ✓ — core: parser + emitter, harness registry, tool registry (+ live), `lint`, `cost`,
  `passport`.
- **P1** ✓ — TAUT adapter: engine-parsed frontmatter, wiring checked against the catalog,
  compile preview + degradations from the engine (`taut render`), `saut lint` in pack CI.
- **P2** ✓ — the bench: `saut test` L1 compile · L2 trigger (explicit / implicit / control,
  with the lost-to diagnostic) · L3 obedience, across Claude Code, Codex and opencode.
- **P3** ✓ — Studio: the loopback UI over the same verbs — form + body, passport, compiled
  previews, the bench with live SSE, pack validation.
- **P4** — scenario graders (Claude Code `plugin eval` case format + agentskills `evals.json`),
  `--scan` via an installed security scanner, usage from TAUT telemetry.

## Development

```bash
npm install          # dev deps only (typescript, @types/node)
npm test             # tsc --noEmit && node --test
```

`lib/*.mts` is the core (typechecked), `saut.mjs` the plain-JS shell, `test/*.test.mjs` the
behavioral suite over `test/fixtures/pack` (one artifact per rule). The bench suite runs
offline against fake harness binaries (`test/fixtures/fake-harness.mjs`) — no model calls, no
cost; live runs are exercised by hand.

## License

Apache-2.0 — see [LICENSE](LICENSE).
