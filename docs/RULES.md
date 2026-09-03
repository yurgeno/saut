# SAUT lint rules

Every rule cites its precedent: `S*` / `C*` / `T*` = findings of a 2026-08-24 privilege review of
a production TAUT pack; named sources = external research or harness documentation. Severity is
the rule's default; a rule may downgrade when the evidence is weaker.

There is no score. Findings are findings; the `enforcement` line under each artifact says, per
harness, what the declared allowlist actually is there — `restrict`, `grant`, `prose`,
`dropped` or `n/a` — so a "read-only" that holds on prose alone is visible as such.

## Privileges

| rule | severity | fires when | precedent |
|---|---|---|---|
| `no-allowlist` | high (skill) / medium (agent) | no `allowed-tools` (skill) or `tools:` (agent) — the full toolset is available | S1 |
| `model-invocable-writer` | high | `disable-model-invocation` is not `true` and the skill has no allowlist, can mutate (Write/Edit/bare Bash/writing MCP tools), or drives an expensive runtime | S2, S10 |
| `supervised-but-auto` | high | the body demands supervision ("SUPERVISED, always", "never unattended") but the model may invoke the skill | S2 |
| `unreachable` | high | `user-invocable: false` and `disable-model-invocation: true` | — |
| `dead-privilege` | medium | a granted tool the body never evidences (an MCP name, the server or the tool's first word; a builtin via prose evidence — shell commands for Bash, "spawn the subagent" for Agent…). Read/Glob/Grep/Skill/AskUserQuestion are ambient and never dead; scoped rules (`Bash(git diff *)`) are deliberate and skipped | S4 |
| `body-tool-not-allowed` | high (MCP) / medium (builtin) | the body cites a tool (`mcp__…`, or a backticked builtin) the allowlist does not carry — the harness will lack it or prompt: silent degradation | C1 |
| `unknown-tool` | high | an allowlist name that is neither a builtin of the harness nor `mcp__…` — a dead name grants nothing | — |
| `legacy-tool` | info | a builtin name from older harness versions (`MultiEdit`, `LS`, …) | — |
| `unknown-mcp-server` / `unknown-mcp-tool` | high | `mcp__server__tool` where the catalog lists no such server / no such tool for it (only when a catalog is present) | C1 |
| `readonly-claim-vs-writes` | medium | the description or body claims read-only, but Write/Edit/writing MCP tools are granted (or nothing is restricted) | C3 |
| `bash-unscoped-readonly` | medium | claims read-only but grants bare `Bash`/`PowerShell` where the harness supports `Tool(spec)` scoping | S7 |
| `readonly-not-enforced` | high / medium | claims read-only; on a *grant* harness (Claude Code) no `disallowed-tools` backs it — `allowed-tools` only pre-approves; on *prose*/*dropped* harnesses the promise is informational | Claude Code docs, S7 |
| `agent-writes-via-bash` | medium | an agent described as writing a file has `Bash` but no `Write`/`Edit` — Bash is a superset of Write | S3 |

## Safety

| rule | severity | fires when | precedent |
|---|---|---|---|
| `dynamic-context` | high (bare Bash) / medium | the body contains `` !`cmd` `` dynamic context — executed before the model sees anything | Reversec "Skill Issues", Datadog 2026 |
| `untrusted-content-rule` | medium | the artifact pulls external content (tracker, web, attachments, docs MCP) and never states that such content is data, not instructions | S5 |
| `injection-heuristic` | medium | "ignore previous instructions", invisible/bidi Unicode, download-and-execute pipelines, credential-file reads | Snyk ToxicSkills |
| `secret-pattern` | high | a secret-shaped value (API keys, PATs, private keys, `password = "…"`) | pack `scan-secrets` |

## Hygiene and cost

| rule | severity | fires when | precedent |
|---|---|---|---|
| `missing-name` / `missing-description` | high | the routing fields are absent | spec |
| `description-too-long` | low / medium | the description exceeds the budget (default: Claude Code's 1 536-char listing cap) — paid in every session | T1 |
| `frontmatter-syntax` / `no-frontmatter` | high | the frontmatter cannot be parsed (unterminated list, anchors, continuation lines…) | — |
| `duplicate-key` | info | a top-level key appears more than once — capability-marker branches; allowlists are read as the union, the first description wins | TAUT markers |

## TAUT wiring (shape checks; the adapter validates against the engine)

| rule | severity | fires when | precedent |
|---|---|---|---|
| `taut-mcp-role-unknown` | medium | `metadata.taut.mcp` names a role no catalog server carries | C2 |
| `taut-mcp-role-unused` | low | the role's tools are never called in the body (delegated to agents?) — the key is documentary in the engine | C2 |
| `taut-agent-missing` | high | `metadata.taut.agents` names an agent not found among the discovered agents (only when agents were in scope) | — |

## Output

`--json` prints `{version, artifacts[], diagnostics[]}`; `--sarif` prints SARIF 2.1.0 with
one rule per code (high → error, medium → warning, low/info → note). Exit code 1 on any high
finding, or on medium under `--strict`.
