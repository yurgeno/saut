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
| `description-over-spec` | high | a skill `description` longer than the 1 024 characters the Agent Skills specification allows — loaders accept it today, a strict one (or a Skills API upload) drops or rejects the skill | agentskills.io/specification |
| `description-too-long` | low / medium | the description exceeds the budget (default: Claude Code's 1 536-char listing cap) — paid in every session | T1 |
| `frontmatter-syntax` / `no-frontmatter` | high | the frontmatter cannot be parsed (unterminated list, anchors, continuation lines…) | — |
| `suppression-invalid` | medium | a `suppress` entry in saut.json without a rule, an artifact or a reason of at least 8 characters — ignored until fixed | — |
| `suppression-unused` | low | a suppression that matches no finding — fixed, or drifted; remove it | — |
| `duplicate-key` | info | a top-level key appears more than once — capability-marker branches; allowlists are read as the union, the first description wins | TAUT markers |

## Current guidance (harness and model)

What the vendors recommend moves faster than a linter release, so this layer is **data with a
date and a source**: the model catalogs sit in `lib/harnesses/<id>.json` under `models`
(aliases, ids, status, effort levels per model, replacements), the prompting guidance in
`lib/guidance.json`. Every finding carries its class, the date the data was verified and the
sources; `saut guidance` says how old the data is (stale after 60 days) and where this machine
disagrees with it. Where a harness keeps its own catalog locally — Codex:
`$CODEX_HOME/models_cache.json` — that fresher evidence is consulted first.

Classes: **A** outdated (fix it) · **B** a prompt-level hypothesis — both vendors say to change
prompts only against a measurement, so B never carries an autofix; change it with a bench
before and after · **D** a hardening the artifact does not use yet.

| rule | class | severity | fires when | source |
|---|---|---|---|---|
| `model-unsupported` | A | high | the model is marked unsupported or retired — runs pinned to it fail | harness catalog; measured 2026-09-23 (`gpt-5.6` → HTTP 400) |
| `model-unknown` | A | medium | neither the registry nor the local catalog knows the model — a typo, or newer than the registry | harness catalog |
| `model-previous` | A | low | a pinned previous or legacy model; names the current one (review autofix: set `model`) | harness catalog |
| `effort-unsupported` | A | medium | an effort level the harness does not know, or one the model does not take (Haiku takes none; Opus 4.6 has no `xhigh`) | Claude Code model-config; Codex catalog |
| `body-over-spec` | A | medium | a SKILL.md body over 500 lines | Agent Skills best practices |
| `aggressive-imperative` | B | low | an undertrigger-era instruction ("use PROACTIVELY", "unprompted", "if in doubt, use") or ≥ 5 all-caps imperatives at ≥ 3 per 1,000 words of prose (thresholds calibrated on one production pack) | Claude prompting best practices, prompt audit; GPT-6 prompting guide |
| `incident-fossil` | B | low | two or more dated incident/measurement stories in the body | prompt audit |
| `reasoning-echo` | B | low | asks the model to show its reasoning process or chain of thought (a verdict with its justification is fine) | prompting Claude Opus 5.5 |
| `codex-agent-sandbox` | D | info | a read-only agent whose tools list Codex drops, with no read-only sandbox declared (TAUT: `manifest.agentSandbox`) | Codex subagents, permissions |

In a TAUT pack the deployment's `modelTiers` ladder is checked too, anchored to the line in
`deployment.json`. Fenced code is not prose: commands and examples do not count toward the
prompt-style rules.

## TAUT wiring

Plain mode (no engine) checks the shape against whatever catalog and agents were discovered;
with an engine the adapter judges against the pack's real catalog and the shape rules are replaced.

| rule | severity | fires when | precedent |
|---|---|---|---|
| `taut-mcp-role-unknown` | medium | `metadata.taut.mcp` names a role no catalog server carries | C2 |
| `taut-mcp-role-unused` | low | (plain mode) the role's tools are never called in the body (delegated to agents?) — the key is documentary in the engine | C2 |
| `taut-agent-missing` | high | `metadata.taut.agents` names an agent not in the catalog (plain mode: not among discovered agents, only when agents were in scope) — the engine fails setup | — |
| `taut-requires-unknown` | high | (engine) `metadata.taut.requires` names a gate the engine does not know (`kaut`) | — |
| `taut-repo-unknown` | high | (engine) `metadata.taut.repos` names a repo outside the deployment's repo map — the compile fails | — |
| `taut-role-unknown` | info | (engine) `metadata.taut.role` is not a role the engine consumes (`stack-engine`, `spa-mock`, `init`, `knowledge`) | — |
| `taut-wiring-unknown-key` | medium | (engine) a `metadata.taut` key the engine never reads | C2 |
| `taut-compile` | high | (engine) the marker pass or the engine's frontmatter parser refuses the source, `metadata.taut` varies by branch, legacy `metadata.federation`, name ≠ directory — the pack will not compile | PACK.md §10 |
| `taut-empty-wiring` | info | (engine) `metadata.taut: {}` — the engine reads `{}` as a string; omit the key | — |
| `taut-role-collision` | high | (engine) two skills in the pack declare the same `metadata.taut.role` — the engine resolves a role to ONE skill, so which one the compiled instructions name depends on catalog order | found by the Studio gate, 2026-09-03 |

## Rented: content scanning

`saut lint --scan` runs whichever content scanner is installed — [SkillSpector](https://github.com/nvidia/skillspector),
[Snyk Agent Scan](https://github.com/snyk/agent-scan), [Cisco skill-scanner](https://github.com/cisco-ai-defense/skill-scanner) —
and folds its findings into the same stream under `scan-*` codes (severities normalized, JSON
and SARIF both parsed). Nothing is bundled or downloaded: with no scanner installed the flag
says so plainly and SAUT's own rules still run. What SAUT owns is the part no scanner
produces — the per-harness privilege semantics.

## Advice and fixes

Every finding carries the rule's **title**, **why** it matters and **how to fix** it, from one
catalog (`lib/rules.mts`) — the CLI prints the advice under the finding, `--json` and the
Studio carry the fields, SARIF puts them in the rule's `fullDescription` / `help` / `helpUri`.
A finding about the body points at its line.

Some findings also carry an **autofix**: a frontmatter edit applied to the file text line by
line, so comments, key order, quoting and capability-marker branches survive. A fix that
cannot be applied safely (a quoted or folded value, a list it would empty) is refused, never
half-applied. Each fix is classed:

| class | meaning | rules |
|---|---|---|
| `safe` | mechanical, behaviour-preserving | `legacy-tool` (rename), `unreachable` (`user-invocable: true`) |
| `review` | changes what the artifact may do, or rests on a heuristic that can be wrong for this artifact | `dead-privilege` (remove the tool), `model-invocable-writer` / `supervised-but-auto` (`disable-model-invocation: true`), `readonly-not-enforced` on Claude Code (`disallowed-tools: Write, Edit`) |

```bash
saut lint <path> --fix                            # preview every fix as a diff; writes nothing
saut lint <path> --fix --write                    # apply the safe ones, re-lint
saut lint <path> --fix --write --only dead-privilege,model-invocable-writer   # + these review ones
```

A finding without an autofix needs a hand edit; the Studio says so and links the line. Rules
that read prose or patterns (`dead-privilege`, `injection-heuristic`, `untrusted-content-rule`,
the read-only claims, `supervised-but-auto`, `agent-writes-via-bash`, builtin
`body-tool-not-allowed`) are marked `heuristic` — they can be wrong about a given artifact.

A `review` fix deserves the diff: `dead-privilege`, for one, reads the body for mentions of the
tool, and a skill that calls "every allowed MCP server" without naming the tools is flagged
although it uses them. In the Studio each fix is previewed and applied one at a time.

## Suppressing a finding

A finding that does not apply to a particular artifact is suppressed **with a reason**, in
`saut.json` next to the pack or skills folder (the nearest one up the tree — the same file that
carries cost budgets), never in the artifact itself:

```json
{
  "suppress": [
    { "rule": "dead-privilege", "artifact": "env-check", "match": "mcp__playwright__browser_navigate",
      "reason": "env-check calls the cheapest read-only tool of every allowed MCP server without naming it" }
  ]
}
```

`rule` and `artifact` (its name) are required; `match` pins the entry to findings whose message
contains that text (the Studio writes the finding's quoted subject — a tool name, a matched line —
so the entry survives the file moving around); without it the entry covers every finding of
that rule in that artifact. `line` pins a line, but lines move. The `reason` — at least 8
characters — is required: an entry without one is ignored and reported as
`suppression-invalid`.

A suppressed finding is not dropped. It stays in every output marked `suppressed` with its
reason — the text report lists it, `--json` carries `suppressed: {reason, file}`, SARIF sets the
result's `suppressions` — and it no longer counts toward the totals or the exit code, and
`--fix` leaves it alone. An entry that matches no finding is reported as `suppression-unused`:
the finding was fixed, or the entry drifted, and a stale exemption would quietly cover the next
real one. In the Studio every finding has **Suppress…** (a reason, a scope, the saut.json diff)
and every suppressed one **Lift the suppression**.

## Output

`--json` prints `{version, artifacts[], diagnostics[]}` (each diagnostic with `category`,
`title`, `why`, `fix`, `doc` and, when there is one, `autofix`); `--fix --json` prints the
per-file fixes, diffs and what was written. `--sarif` prints SARIF 2.1.0 with one rule per code
(high → error, medium → warning, low/info → note). Exit code 1 on any high finding, or on
medium under `--strict`.
