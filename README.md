# SAUT: Surface Assurance Under Trust

[![test](https://github.com/yurgeno/saut/actions/workflows/test.yml/badge.svg)](https://github.com/yurgeno/saut/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/yurgeno/saut)](https://github.com/yurgeno/saut/releases)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white)
![platforms](https://img.shields.io/badge/platforms-linux%20%7C%20macos-informational)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success)

**Lint, cost and test the agent surface of a repository (skills, subagents, MCP servers, hooks,
permissions and instruction files) for any harness, from one source.**

A repository's **agent surface** is everything an AI coding agent loads or runs from it:
[agent skills](https://agentskills.io) and subagents, MCP servers, hooks and the scripts they
call, settings and permissions, always-on instruction files (`CLAUDE.md`, `AGENTS.md`, …),
commands and plugins. Claude Code, Codex, Copilot, Cursor, OpenCode and the rest each read that
surface differently. On Claude Code `allowed-tools` is a *grant*: it pre-approves tools but does
not restrict them. On Codex and OpenCode it is informational prose, and it is dropped when a
subagent is rendered to TOML. The harnesses do not warn the author about this, do not report what
a skill costs in every session, and do not check that the tools a skill uses are the ones it
declared or what a hook runs.

SAUT answers *what can an agent do in this repository, on each harness, and what does it cost*. It works on any repository, folder or git URL; a [TAUT](https://github.com/yurgeno/taut)
data pack is a first-class case, not a requirement.

SAUT is not a malware scanner. A content scanner tries to tell whether something is hostile.
SAUT reports how much an agent could reach if it were, which is a question of least privilege.
Use both: `--scan` calls an installed content scanner in the same run.

```
saut lint  <paths | git url…>   privilege / safety / workspace findings + per-harness enforcement
saut cost  <paths | git url…>   always-on vs on-invoke token passport, budgets, real usage
saut test  <skill or agent>      compile → does it trigger → does it obey → does it do the job
saut studio [dir | url]          the local UI over all of it (no argument: scan a git URL)
saut passport <…>                lint + cost + matrix (+ compiled previews) as one JSON
saut preview <name> [dir]        TAUT packs: the compiled bytes of one artifact per harness
saut harnesses                   what each harness enforces, degrades, and lists
saut guidance                    how old the vendor guidance is; where this machine disagrees
saut tools [dir] [--live]        the tool names an allowlist may cite
```

Zero runtime dependencies, Node ≥ 24 (TypeScript runs natively, so there is no build step).
Apache-2.0. Part of the *Under Trust* family, next to
[KAUT](https://github.com/yurgeno/kaut) (knowledge) and
[TAUT](https://github.com/yurgeno/taut) (toolchain distribution).

## Why

The rules come from a real privilege review of a production pack (13 skills, 7 subagents):
four skills with no allowlist at all, a "read-only" skill with `Write` granted, a body
invoking `mcp__playwright__*` that its allowlist never carried, `WebFetch` granted and never
used, a supervised-only skill the model could invoke on its own, and ~3 000 tokens of
descriptions paid in every session. Every one of those is now a rule
(see [docs/RULES.md](docs/RULES.md)), and every rule cites its precedent.

The output scanners do not give you is the **matrix**: for one artifact, on each harness, is the
declared allowlist a restriction, a pre-approval grant, informational prose, or dropped?

```
skill workspace-check skills/workspace-check/SKILL.md — 9 findings
  high   readonly-not-enforced [claude-code] — on Claude Code `allowed-tools` only PRE-APPROVES; …
  high   model-invocable-writer:2 — model may invoke this skill on its own … and it can mutate (Bash)
  medium readonly-not-enforced [codex,copilot,cursor,opencode] — the tool allowlist is informational …
  medium bash-unscoped-readonly:5 — claims read-only but grants bare `Bash` — narrow it …
  enforcement claude-code=grant · codex=prose · copilot=prose · cursor=prose · opencode=prose
```

## Install

```bash
git clone https://github.com/yurgeno/saut.git ~/saut
node ~/saut/saut.mjs --help          # or: npm link inside the clone → `saut`
```

Node 24 or later is required; Linux and macOS are the supported platforms. There is no build step
and there are no runtime dependencies: `npm install` fetches the typechecker and nothing else.

## Usage

```bash
saut lint .                              # walk a tree: skills, agents and the agent workspace
saut lint skills/dev-review              # one skill
saut lint agents/dev-reviewer.md         # one agent
saut lint . --harness claude-code,codex  # judge for a subset of harnesses
saut lint . --scan                       # + an installed content scanner (rented, not bundled)
saut lint . --json | --sarif             # CI / IDE
saut lint . --strict                     # exit 1 on medium findings too
saut lint . --fix                        # the mechanical fixes as a diff (--write applies the safe ones)
                                         # a finding that does not apply: suppress it with a reason in saut.json
saut lint https://github.com/o/r          # a remote repository: one commit, fetched read-only
saut lint https://github.com/o/r/tree/main/skills/review   # a browse URL: ref + path
saut lint 'git@gitlab.example.com:g/r.git#v1.2:skills'     # <url>#<ref>:<path>

saut report https://github.com/o/r       # one complete report (Markdown) for a dir or URL
saut report https://github.com/o/r --view codex             # the same scan, read for Codex
saut report https://github.com/o/r --out report.html       # self-contained HTML (or .json / --format)

saut cost .                              # estimates (no key, no network)
saut cost . --exact                      # counted by the Claude token-counting API
saut cost . --budget budgets.json        # or a saut.json {"budgets": {...}} up the tree
saut cost . --workspace ~/ws             # + USED: invocations from that workspace's telemetry

saut test skills/dev-review --level 3 --runs 3 --max-cost 1.00
saut test skills/dev-review --model claude-code=sonnet,codex=gpt-6.1-sol   # a model per harness
saut studio .                            # the local UI
saut studio                              # start page: paste a git repository URL, scanned read-only in the same tab
saut tools . --live                      # spawn catalog MCP servers, ask tools/list
```

**Targets** are files or directories: a `SKILL.md`, a skill directory, an agent `.md`, or a
tree to walk (`skills/`, `<project>/skills/`, `agents/`, `.claude/agents/`, … all fall out of
the same walk).

**The agent workspace.** Beyond skills and agents, `lint`, `report`, `passport` and the Studio
read everything else a harness loads or runs from the project: hooks, MCP servers, settings and
permissions, always-on instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Copilot, Cursor,
Cline and Devin rules), commands, plugin manifests (also plugins in subfolders of a marketplace)
and the code those hooks and plugins run. SAUT follows that code from script to script and reads
it without executing it.
Where each harness looks is data in `lib/workspace.json`. `--no-workspace` skips it.

**Severity follows evidence, and copies count once.** A skill without an allowlist that only reads
and reports is hygiene (low); one whose text asks to change files is medium; add untrusted input
and it is high. The same skill in several harness folders, or one instruction text saved for
several harnesses, is reported once with its copies listed. See [docs/RULES.md](docs/RULES.md).

**Remote targets.** `lint`, `cost`, `passport`, `report` and `studio` also take a git repository URL: `https://`,
`ssh://`, `git@host:owner/repo` or `file://`, optionally `#<ref>` (branch, tag or full commit
id) and `:<path>` inside the repository; a GitHub/GitLab `…/tree/<ref>/<path>` or `…/blob/…`
URL works as copied. SAUT fetches that one commit into a temporary directory, scans it, and
removes it (`--keep` keeps it; `--timeout <s>` bounds the fetch, default 180). The content is
treated as untrusted: no submodules, no hooks, no `ext::` transport, symlinks checked out as
plain files, credentials from your git setup but never prompted for; `http://` and `git://`
are refused, and so are `--live` (it would spawn the repository's MCP servers), `--fix`,
`test` and `studio`. Output paths read `host/owner/repo@<commit>/…`; `--json` adds `sources`
(url, ref, commit, path) and `--sarif` records `versionControlProvenance` with URIs relative
to the repository root.

**MCP catalog.** To judge `mcp__server__tool` names SAUT needs a catalog: a TAUT
`catalog/mcp.json` (`servers.<id>.{serverKey, role, tools[]}`), a `.mcp.json` or an
`opencode.json`. It is auto-detected up the tree from the first target; pass `--catalog` to be
explicit. Without a catalog, MCP names are not judged. `--live` spawns each server and asks it
for `tools/list` (values of environment variables never leave your machine).

**Exit codes:** `0` clean / within budget / bench passed · `1` findings (high; medium under
`--strict`), over budget, or a bench failure · `2` usage error.

## What "cost" means

| column | what it is | when it is paid |
|---|---|---|
| always-on | `name` + `description`, the listing entry | every session, whether or not the skill fires |
| on-invoke | the body | each time the skill fires |
| transitive | subagents the skill wires, files the body references by path | on invoke, in the subagent's or the reader's context |
| used | invocations recorded by a compiled workspace's local telemetry (`--workspace`) | not applicable |

Default numbers are **estimates** (a deterministic heuristic, labelled as such). `--exact`
counts through the Claude token-counting API. Budgets (`descriptionChars`, `alwaysOnTokens`,
`invokeTokens`) turn the passport into a gate.

Cost and usage are most useful together: a skill that spends its always-on tokens in every
session and never fires is the one to compress or drop.

A zero in `used` is only evidence when the counting was honest, so SAUT states the limits of
its own measurement. Self-test rows, where a workspace's integrity probe invokes the gate out of
band, are excluded and counted separately rather than credited to whichever skill they
probed. And telemetry written before the workspace's gate recorded each invocation path
cannot see direct `/slash` invocations at all. A skill declaring
`disable-model-invocation: true` can only be reached that way, so SAUT prints a note instead
of a zero that would read as "nobody uses this".

## Harness registry

Everything SAUT knows about a harness is data in `lib/harnesses/<id>.json`: discovery
directories, builtin tool names, honoured frontmatter fields, allowlist semantics for skills
and for subagents, the deny mechanism, the listing budget, the headless runner, the recorded
degradations, and the documentation URLs the entry was derived from. `saut harnesses` prints
it. Adding a harness is adding a file; no rule changes.

Registered today: `claude-code`, `codex`, `opencode` (with headless runners), `cursor` and
`copilot` (registry-only). Inside a TAUT pack the engine's own adapter records take precedence
for the harnesses it ships.

## The bench

`saut test` answers what a lint cannot: does the artifact land where the harness looks (L1),
does the harness fire it, and stay quiet on an unrelated prompt (L2), does the run
stay inside the declared allowlist (L3), and did it do the job (L4, scenario graders).
Everything happens in a scratch workspace; for a TAUT pack the engine compiles it there first,
so the bench runs the real installed artifact with its gate live.

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
*different* skill, so the description lost a routing contest) and **outside allowlist** (a call
ran that the declaration never covered; on Codex and OpenCode that is the recorded
degradation, measured rather than asserted). L4 graders use the Claude Code `plugin eval`
layout (`regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`), and an
agentskills `evals.json` suite imports as cases. Full detail, isolation and cost controls:
[docs/BENCH.md](docs/BENCH.md).

## The Studio

```bash
saut studio .
```

One local page over the same functions. The **Overview** ranks every skill and agent by what is
wrong with it. The **Skill** view edits one artifact with a form and the raw file, a Markdown
editor, and findings that are re-linted as you type, each with how to fix it and a previewable
fix. It saves through a diff, changing only what you changed (comments, unknown keys and capability-marker
branches survive); an **agent review** proposes changes against the findings and the current
guidance, each checked and re-linted before you apply it to the editor. **Bench** runs L1–L4 with
the events streaming live and measures an edit before and after; **Harnesses** is the registry as
reference. A compiled TAUT workspace opens read-only, naming the pack source.

Loopback only, a one-time key in the printed address, a per-session token in a custom header,
no inline scripts, Origin and Host checks, reads and writes limited to skill and agent files
under the root, and atomic saves. This is the same security contour as the TAUT panel. Details:
[docs/STUDIO.md](docs/STUDIO.md).

## TAUT packs

A [TAUT](https://github.com/yurgeno/taut) data pack is detected by shape (`pack.json` +
`skills/` or `<project>/deployment.json`). Without an engine it lints as plain skills:
capability-marker branches (`# kaut:on` … `# kaut:off`) are read as the *union* of allowlists
and the first description. With an engine reachable (`--taut <dir>`, `$SAUT_TAUT_ENGINE`,
`~/taut`; engine v0.7.0 or later, which ships the `render` verb and the harness capability
registry), the adapter switches on:

- skill frontmatter is parsed by the **engine's** parser (the strict subset that decides a
  compile) under the all-gates-ON view; what the engine refuses is a finding, not a crash;
- `metadata.taut` is checked against the pack's real catalog: `agents` must exist, `mcp` roles
  must be carried by a catalog server, `repos` must be in the deployment's repo map,
  `requires` must be a gate the engine knows, `role` one it consumes, and no two skills may
  claim the same role;
- the matrix uses the engine's own adapter records (allowlist semantics, degradations);
- `saut passport` adds `compiled`: for every harness the target path, byte size, token estimate
  and recorded degradations of the exact artifact the installer writes; `saut preview` prints
  those bytes.

```bash
saut lint ~/taut-data-community                      # engine auto-detected
saut preview dev-reviewer ~/taut-data-community --harness codex
saut passport ~/my-pack/myproject/skills/verify --deployment myproject
saut lint ~/my-pack --no-taut                        # plain mode on purpose
```

Pack CI: `tools/validate-pack.sh` in a TAUT pack runs `saut lint` after the compile when
`SAUT` points at a checkout (`SAUT=~/saut tools/validate-pack.sh`); `SAUT_STRICT=1` turns its
findings into a failing step.

## Documentation

| Document | What is in it |
|---|---|
| [docs/RULES.md](docs/RULES.md) | Every lint rule: when it fires, its severity, and the precedent it cites |
| [docs/BENCH.md](docs/BENCH.md) | The four bench levels, cases and graders, isolation, cost controls |
| [docs/STUDIO.md](docs/STUDIO.md) | The local UI and its security contour |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup and the rules that keep the tool what it is |
| [SECURITY.md](SECURITY.md) | What counts as a vulnerability here, and how to report it |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

## Development

```bash
npm install          # dev deps only (typescript, @types/node)
npm test             # tsc --noEmit && node --test
```

`lib/*.mts` is the core (typechecked), `saut.mjs` the plain-JS CLI shell, `test/*.test.mjs`
the behavioural suite over `test/fixtures/pack` (one artifact per rule). The whole suite runs
**offline**: the bench drives fake harness binaries on `PATH` and the judge tests a fake
`claude`, so it costs nothing and needs no credentials.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
