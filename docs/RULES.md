# SAUT lint rules

The rules cover the whole agent surface of a repository: skills and subagents (Privileges,
Safety, Hygiene and cost), and everything else a harness loads or runs — hooks and their scripts,
MCP servers, settings and permissions, instruction files, commands and plugins (Agent workspace).

Every rule cites its precedent: `S*` / `C*` / `T*` = findings of a 2026-08-24 privilege review of
a production TAUT pack; named sources = external research or harness documentation. Severity is
the rule's default; a rule may downgrade when the evidence is weaker.

**How severity is set.** *high* — exploitable as it stands, or broken: a secret in the file, code
downloaded and run, approvals switched off, an injection-to-write chain (untrusted input plus a
request to change files, with nothing restricting tools), a skill a strict loader drops.
*medium* — a real risk that needs one more condition, or a feature that silently degrades.
*low* — least-privilege and cost hygiene. *info* — worth knowing, nothing to fix. Privilege rules
read the text for **evidence**: a missing allowlist on a skill that only reads and reports is
hygiene (low); on one whose text asks to edit files or run a mutating command it is medium; add
untrusted input and it is high. An explicit "changes nothing" / "report only" from the author
counts as evidence of no intent to change.

**Why this severity.** The presence of a key is a fact; the severity of a prose-reading rule is
an estimate of intent, and the estimate can be wrong. So each such finding (`no-allowlist`,
`model-invocable-writer`, `untrusted-content-rule`) carries its **evidence**: the line it took as
a request to change things or as outside input, quoted, and what it looked for and did not find
(the reason it is not higher). `lint` prints it under high and medium findings, the report and
Studio under every one (Studio links each line), JSON as `evidence`, SARIF as related locations.
Read the quoted line; if it does not say what the rule thinks, the severity is wrong — suppress
with that reason.

**Copies.** The same skill in several harness folders (`skills/x`, `.openclaw/skills/x`) or the
same instruction text saved as `AGENTS.md`, `.clinerules` and `copilot-instructions.md` is
reported once, with its copies listed; a finding in every copy is one finding. Findings stay on
every file in JSON, SARIF and for suppressions.

There is no score. Findings are findings; the `enforcement` line under each artifact says, per
harness, what the declared allowlist actually is there — `restrict`, `grant`, `prose`,
`dropped` or `n/a` — so a "read-only" that holds on prose alone is visible as such.

## Privileges

`no-allowlist` and `model-invocable-writer` are documented here but counted as **security**
everywhere — the Overview's Security column, the Security card, the Security section of an
artifact's panel and the report: the full toolset is what an injection acts with.

| rule | severity | fires when | precedent |
|---|---|---|---|
| `no-allowlist` | high / medium / low | no `allowed-tools` (skill) or `tools:` (agent) — the full toolset is available. high: the text asks to edit files or run a mutating command *and* reads untrusted content; medium: it asks to change things; low: it only reads and reports. When such a skill may also be started by the model, the message says so and the mechanical fix sets `disable-model-invocation: true` — one finding, not two | S1 |
| `model-invocable-writer` | high / medium | `disable-model-invocation` is not `true` and the allowlist grants mutators (Write/Edit/bare Bash/writing MCP tools), or the skill drives an expensive runtime. high when it also reads untrusted content. With no allowlist at all, `no-allowlist` carries this | S2, S10 |
| `supervised-but-auto` | medium | the body demands supervision ("SUPERVISED, always", "never unattended") but the model may invoke the skill | S2 |
| `unreachable` | high | `user-invocable: false` and `disable-model-invocation: true` | — |
| `dead-privilege` | low | a granted tool the body or description never evidences (an MCP name, the server or the tool's first word, a catalog role word such as "the tracker MCP", a templated `mcp__<serverKey>__…` or "the tools listed in the frontmatter"; a builtin via prose evidence — shell commands, or running build/test commands, verification, a suite, a test/build check or gates, for Bash, "spawn the subagent" for Agent…). Read/Glob/Grep/Skill/AskUserQuestion are ambient and never dead; scoped rules (`Bash(git diff *)`) are deliberate and skipped | S4 |
| `body-tool-not-allowed` | medium (MCP) / low (builtin) | the body cites a tool (`mcp__…`, or a backticked builtin that is not banned — "No `AskUserQuestion`", "you do not need to invoke it through `Skill`") the allowlist does not carry — the harness will lack it or prompt: silent degradation | C1 |
| `unknown-tool` | medium | an allowlist name that is neither a builtin of the harness nor `mcp__…` — a dead name grants nothing | — |
| `legacy-tool` | info | a builtin name from older harness versions (`MultiEdit`, `LS`, …) | — |
| `unknown-mcp-server` / `unknown-mcp-tool` | medium | `mcp__server__tool` where the catalog lists no such server / no such tool for it (only when a catalog is present) | C1 |
| `readonly-claim-vs-writes` | medium | the description or body claims read-only, but Write/Edit/writing MCP tools are granted (or nothing is restricted). A claim is about the artifact: a description phrase, a body paragraph or list item that opens with "Read-only", or "this skill/agent never writes" — not a scoped "tracker access is read-only", a mid-sentence parenthetical "(read-only), …", "the read-only state of …" or a hard-wrapped line that starts with the word | C3 |
| `bash-unscoped-readonly` | medium | claims read-only but grants bare `Bash`/`PowerShell` where the harness supports `Tool(spec)` scoping | S7 |
| `readonly-not-enforced` | medium / low | claims read-only; on a *grant* harness (Claude Code) no `disallowed-tools` backs it — `allowed-tools` only pre-approves; on *prose*/*dropped* harnesses the promise is informational | Claude Code docs, S7 |
| `agent-writes-via-bash` | low | an agent described as writing a file has `Bash` but no `Write`/`Edit` — Bash is a superset of Write | S3 |

## Safety

| rule | severity | fires when | precedent |
|---|---|---|---|
| `dynamic-context` | high (bare Bash) / medium | the body contains `` !`cmd` `` dynamic context — executed before the model sees anything | Reversec "Skill Issues", Datadog 2026 |
| `untrusted-content-rule` | medium / low | medium when the artifact can change things, low when it only reads. The artifact pulls external content (tracker, web, attachments, docs MCP, fetched pages — a link shown to the reader does not count) and never states that such content is data, not instructions ("treat as data", "is data, not …", "never instructions", "they never instruct you", "untrusted" all count) | S5 |
| `injection-heuristic` | high / medium | high: invisible/bidi Unicode, download-and-execute pipelines; medium: "ignore previous instructions", credential-file reads. Also in instruction files and commands | Snyk ToxicSkills |
| `secret-pattern` | high | a secret-shaped value (API keys, PATs, private keys, `password = "…"`) — in a skill, an agent, or any workspace file | pack `scan-secrets` |

## Agent workspace

Everything else a harness loads or runs from the project, found by the locations in
`lib/workspace.json` (data, with sources): instruction files (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`, `.clinerules`,
`.devin/rules`, …), commands (`.claude/commands`, `.opencode/commands`, Gemini `*.toml`,
Copilot prompts), settings (`.claude/settings*.json`, `.codex/config.toml`, `.codex/rules`,
`opencode.json`, `.gemini/settings.json`, `.cursor/cli.json`), MCP files (`.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`, `mcp.json`), hook files (Claude, Codex, Copilot, Cursor,
Gemini, Devin shapes), plugin manifests (`.claude-plugin`, `.codex-plugin`, `.github/plugin`,
`plugin.json`, `gemini-extension.json`, `.<vendor>-plugin`) and the code they run. Manifests
are followed to the hook, MCP and module files they wire in; hooks to the scripts they run;
scripts to the local modules they require or spawn. Code is read, never executed. Disable with
`--no-workspace`.

| rule | severity | fires when | precedent |
|---|---|---|---|
| `remote-code` | high | a hook, MCP command or executed script downloads code and runs it (`curl … \| sh`) | supply chain |
| `unpinned-package` | medium | `npx`/`bunx`/`pnpm dlx`/`uvx`/`pipx run` without an exact version, or a docker image without a tag or digest, in a hook, an MCP server or executed code | supply chain |
| `insecure-url` | high | an MCP server or an http hook on plain `http://` (not localhost) | — |
| `exec-network` | medium | code run by a hook, plugin or module can reach the network; the message says when it also receives the prompt or tool input | — |
| `exec-credentials` | medium | that code reads credential files or token-like environment variables | — |
| `exec-dynamic-code` | medium | that code runs `eval` / `new Function` / `vm.run*` on a computed string (a literal is readable and does not count) | — |
| `exec-background` | low | that code starts a detached process that outlives the hook | — |
| `permissions-bypass` | high / medium / low | committed settings that switch approvals off: Codex `danger-full-access` (high) and `approval_policy = "never"`; Claude `defaultMode` `bypassPermissions` (medium — Claude Code 2.1.257+ ignores it in project settings, older clients and importing harnesses do not), `auto`, `acceptEdits`, `sandbox.autoAllowBashIfSandboxed` (low); Gemini `defaultApprovalMode`; OpenCode `permission` allow | vendor docs |
| `permissions-broad-allow` | medium (high for a Codex rule that allows an interpreter) | an allow rule for bare `Bash`/`PowerShell`/`Shell`/`run_shell_command`, OpenCode `permissions` allowing shell/edit/`*`, or a Codex `prefix_rule(…, decision="allow")` | vendor docs |
| `mcp-auto-approve` | medium | `enableAllProjectMcpServers: true`, or a Gemini MCP server with `trust: true` | vendor docs |
| `outbound-option` | low | a plugin `userConfig` option that names an address data is sent to (a webhook URL) | — |
| `missing-file` | medium | a manifest or hook names a file that is not in the repository (install-time placeholders such as `PLUGIN_DIR/hooks/x.js` resolve to the file in the repository) | — |
| `config-syntax` | medium | a settings, hooks, MCP or command file does not parse | — |
| `instructions-over-limit` | medium | `AGENTS.md` over Codex's 32 KiB `project_doc_max_bytes` | Codex docs |
| `instructions-heavy` | low | an always-on instruction file over about 4,000 tokens | — |
| `instructions-import-outside` | low | `CLAUDE.md` imports `@~/…` or `@/…` from outside the repository | — |

`dynamic-context`, `injection-heuristic` and `secret-pattern` also apply to commands and
instruction files (Gemini `!{…}` is dynamic context too).

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
| `effort-unsupported` | A | medium | an effort level the harness does not know, or one the model does not take (Haiku 4.5 takes none; Opus 4.6 has no `xhigh`) | Claude Code model-config; Codex catalog |
| `body-over-spec` | A | medium | a SKILL.md body over 500 lines | Agent Skills best practices |
| `aggressive-imperative` | B | low | an undertrigger-era instruction ("use PROACTIVELY", "unprompted", "if in doubt, use") or ≥ 5 all-caps imperatives at ≥ 3 per 1,000 words of prose (thresholds calibrated on one production pack) | Claude prompting best practices, prompt audit; GPT-6 prompting guide |
| `incident-fossil` | B | low | two or more dated incident/measurement stories in the body | prompt audit |
| `reasoning-echo` | B | low | asks the model to show its reasoning process or chain of thought (a verdict with its justification is fine) | prompting Claude Fable 5.2, Opus 5.5, Sonnet 5.5 |
| `codex-agent-sandbox` | D | info | a read-only agent whose tools list Codex drops; a `sandbox_mode` in the agent file (TAUT: `manifest.agentSandbox`) no longer silences it — Codex agents inherit the parent session's sandbox | Codex subagents, permissions |

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
