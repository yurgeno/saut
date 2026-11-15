# SAUT lint rules

The rules cover the whole agent surface of a repository. Skills and subagents are covered by
Privileges, Safety, and Hygiene and cost. Everything else a harness loads or runs is covered by
Agent workspace: hooks and their scripts, MCP servers, settings and permissions, instruction
files, commands and plugins.

Every rule cites its precedent. `S*`, `C*` and `T*` are findings of a 2026-08-24 privilege review
of a production TAUT pack; named sources are external research or harness documentation. The
severity shown is the rule's default, and a rule may lower it when the evidence is weaker.

**How severity is set.** *high*: exploitable as it stands, or broken. Examples are a secret in the
file, code downloaded and run, approvals switched off, an injection-to-write chain (untrusted input
plus a request to change files, with nothing restricting tools), or a skill a strict loader drops.
*medium*: a real risk that needs one more condition, or a feature that silently stops working.
*low*: least-privilege and cost hygiene. *info*: worth knowing, with nothing to fix.

Privilege rules read the text for **evidence**. A missing allowlist on a skill that only reads and
reports is hygiene (low). On a skill whose text asks to edit files or run a mutating command it is
medium, and with untrusted input as well it is high. An explicit "changes nothing" or "report only"
from the author counts as evidence that the skill does not intend to change anything.

**Why this severity.** Whether a key is present is a fact. The severity of a rule that reads prose
is an estimate of intent, and the estimate can be wrong. So each such finding (`no-allowlist`,
`model-invocable-writer`, `untrusted-content-rule`) carries its **evidence**: the quoted line it
took as a request to change things or as outside input, and what it looked for and did not find,
which explains why the severity is not higher. `lint` prints the evidence under high and medium
findings. The report and the Studio show it under every finding (the Studio links each line), JSON
has it as `evidence`, and SARIF as related locations. If the quoted line does not say what the rule
assumed, the severity is wrong and the finding should be suppressed with that reason.

**Copies.** The same skill is often saved in several harness folders (`skills/x`,
`.openclaw/skills/x`), and the same instructions are often saved as `AGENTS.md`, `.clinerules` and
`copilot-instructions.md`. Such copies are reported once with the copies listed, and a finding that
every copy shares is reported once. JSON, SARIF and suppressions still see every file.

SAUT does not compute an overall score. Under each artifact, the `enforcement` line says for each
harness what the declared allowlist is there: `restrict`, `grant`, `prose`, `dropped` or `n/a`.
A read-only promise that only holds as prose is visible in that line.

## Privileges

`no-allowlist` and `model-invocable-writer` are documented here, but they are counted as
**security** findings everywhere: in the Overview's Security column, the Security card, the
Security section of an artifact's panel and the report. The full toolset is what an injection
would act with.

| rule | severity | fires when | precedent |
|---|---|---|---|
| `no-allowlist` | high / medium / low | there is no `allowed-tools` (skill) or `tools:` (agent), so the full toolset is available. high: the text asks to edit files or run a mutating command *and* reads untrusted content; medium: it asks to change things; low: it only reads and reports. When the model may also start such a skill, the message says so and the mechanical fix sets `disable-model-invocation: true`, so this is reported as a single finding | S1 |
| `model-invocable-writer` | high / medium | `disable-model-invocation` is not `true` and the allowlist grants mutators (Write/Edit/bare Bash/writing MCP tools), or the skill drives an expensive runtime. high when it also reads untrusted content. With no allowlist at all, `no-allowlist` covers this | S2, S10 |
| `supervised-but-auto` | medium | the body demands supervision ("SUPERVISED, always", "never unattended") but the model may invoke the skill | S2 |
| `unreachable` | high | `user-invocable: false` and `disable-model-invocation: true` | none |
| `dead-privilege` | low | a granted tool that the body or description never evidences. Evidence for an MCP tool is its name, the server or the tool's first word, a catalog role word such as "the tracker MCP", a templated `mcp__<serverKey>__…`, or "the tools listed in the frontmatter". Evidence for a builtin is prose: shell commands, or running build/test commands, verification, a suite, a test/build check or gates, for Bash; "spawn the subagent" for Agent, and so on. Read/Glob/Grep/Skill/AskUserQuestion are ambient and never dead; scoped rules (`Bash(git diff *)`) are deliberate and skipped | S4 |
| `body-tool-not-allowed` | medium (MCP) / low (builtin) | the body cites a tool that the allowlist does not carry: an `mcp__…` name, or a backticked builtin that is not mentioned as banned ("No `AskUserQuestion`", "you do not need to invoke it through `Skill`" do not count). The harness will lack the tool or prompt for it, and nothing reports the degradation | C1 |
| `unknown-tool` | medium | an allowlist name that is neither a builtin of the harness nor `mcp__…`. A name the harness does not know grants nothing | none |
| `legacy-tool` | info | a builtin name from older harness versions (`MultiEdit`, `LS`, …) | none |
| `unknown-mcp-server` / `unknown-mcp-tool` | medium | `mcp__server__tool` where the catalog lists no such server, or no such tool for it (only when a catalog is present) | C1 |
| `readonly-claim-vs-writes` | medium | the description or body claims read-only, but Write/Edit/writing MCP tools are granted (or nothing is restricted). The claim must be about the artifact: a description phrase, a body paragraph or list item that opens with "Read-only", or "this skill/agent never writes". These do not count: a scoped "tracker access is read-only", a mid-sentence parenthetical "(read-only), …", "the read-only state of …", or a hard-wrapped line that happens to start with the word | C3 |
| `bash-unscoped-readonly` | medium | claims read-only but grants bare `Bash`/`PowerShell` where the harness supports `Tool(spec)` scoping | S7 |
| `readonly-not-enforced` | medium / low | claims read-only, but nothing enforces it. On a *grant* harness (Claude Code) no `disallowed-tools` backs the claim, because `allowed-tools` only pre-approves. On *prose* and *dropped* harnesses the promise is informational | Claude Code docs, S7 |
| `agent-writes-via-bash` | low | an agent described as writing a file has `Bash` but no `Write`/`Edit`. Bash can do everything Write can | S3 |

## Safety

| rule | severity | fires when | precedent |
|---|---|---|---|
| `dynamic-context` | high (bare Bash) / medium | the body contains `` !`cmd` `` dynamic context, which runs before the model sees anything | Reversec "Skill Issues", Datadog 2026 |
| `untrusted-content-rule` | medium / low | the artifact pulls external content (tracker, web, attachments, docs MCP, fetched pages; a link shown to the reader does not count) and never states that such content is data rather than instructions ("treat as data", "is data, not …", "never instructions", "they never instruct you" and "untrusted" all count). medium when the artifact can change things, low when it only reads | S5 |
| `injection-heuristic` | high / medium | high: invisible or bidi Unicode, download-and-execute pipelines; medium: "ignore previous instructions", reads of credential files. Also applies to instruction files and commands | Snyk ToxicSkills |
| `secret-pattern` | high | a value shaped like a secret (API keys, PATs, private keys, `password = "…"`) in a skill, an agent or any workspace file | pack `scan-secrets` |

## Agent workspace

This covers everything else a harness loads or runs from the project. The locations are data with
sources, in `lib/workspace.json`:

- instruction files: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`,
  `.cursor/rules/*.mdc`, `.clinerules`, `.devin/rules`, …;
- commands: `.claude/commands`, `.opencode/commands`, Gemini `*.toml`, Copilot prompts;
- settings: `.claude/settings*.json`, `.codex/config.toml`, `.codex/rules`, `opencode.json`,
  `.gemini/settings.json`, `.cursor/cli.json`;
- MCP files: `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `mcp.json`;
- hook files in the Claude, Codex, Copilot, Cursor, Gemini and Devin formats;
- plugin manifests: `.claude-plugin`, `.codex-plugin`, `.github/plugin`, `plugin.json`,
  `gemini-extension.json`, `.<vendor>-plugin`, and the code they run.

SAUT follows manifests to the hook, MCP and module files they wire in, hooks to the scripts they
run, and scripts to the local modules they require or spawn. Code is read and never executed.
`--no-workspace` turns this part off.

| rule | severity | fires when | precedent |
|---|---|---|---|
| `remote-code` | high | a hook, MCP command or executed script downloads code and runs it (`curl … \| sh`) | supply chain |
| `unpinned-package` | medium | `npx`/`bunx`/`pnpm dlx`/`uvx`/`pipx run` without an exact version, or a docker image without a tag or digest, in a hook, an MCP server or executed code | supply chain |
| `insecure-url` | high | an MCP server or an http hook on plain `http://` (not localhost) | none |
| `exec-network` | medium | code run by a hook, plugin or module can reach the network; the message says when it also receives the prompt or tool input | none |
| `exec-credentials` | medium | that code reads credential files or environment variables that look like tokens | none |
| `exec-dynamic-code` | medium | that code runs `eval`, `new Function` or `vm.run*` on a computed string (a literal string can be read and does not count) | none |
| `exec-background` | low | that code starts a detached process that outlives the hook | none |
| `permissions-bypass` | high / medium / low | committed settings that switch approvals off: Codex `danger-full-access` (high) and `approval_policy = "never"`; Claude `defaultMode` `bypassPermissions` (medium: Claude Code 2.1.257 and later ignore it in project settings, but older clients and harnesses that import the file do not), `auto`, `acceptEdits`, `sandbox.autoAllowBashIfSandboxed` (low); Gemini `defaultApprovalMode`; OpenCode `permission` allow | vendor docs |
| `permissions-broad-allow` | medium (high for a Codex rule that allows an interpreter) | an allow rule for bare `Bash`/`PowerShell`/`Shell`/`run_shell_command`, OpenCode `permissions` allowing shell/edit/`*`, or a Codex `prefix_rule(…, decision="allow")` | vendor docs |
| `mcp-auto-approve` | medium | `enableAllProjectMcpServers: true`, or a Gemini MCP server with `trust: true` | vendor docs |
| `outbound-option` | low | a plugin `userConfig` option that names an address data is sent to (a webhook URL) | none |
| `missing-file` | medium | a manifest or hook names a file that is not in the repository (install-time placeholders such as `PLUGIN_DIR/hooks/x.js` resolve to the file in the repository) | none |
| `config-syntax` | medium | a settings, hooks, MCP or command file does not parse | none |
| `instructions-over-limit` | medium | `AGENTS.md` over Codex's 32 KiB `project_doc_max_bytes` | Codex docs |
| `instructions-heavy` | low | an always-on instruction file over about 4,000 tokens | none |
| `instructions-import-outside` | low | `CLAUDE.md` imports `@~/…` or `@/…` from outside the repository | none |

`dynamic-context`, `injection-heuristic` and `secret-pattern` also apply to commands and
instruction files (Gemini `!{…}` is dynamic context too).

## Hygiene and cost

| rule | severity | fires when | precedent |
|---|---|---|---|
| `missing-name` / `missing-description` | high | the routing fields are absent | spec |
| `description-over-spec` | high | a skill `description` longer than the 1 024 characters the Agent Skills specification allows. Loaders accept it today, but a strict loader or a Skills API upload drops or rejects the skill | agentskills.io/specification |
| `description-too-long` | low / medium | the description exceeds the budget (default: Claude Code's 1 536-character listing cap). The description is paid for in every session | T1 |
| `frontmatter-syntax` / `no-frontmatter` | high | the frontmatter cannot be parsed (unterminated list, anchors, continuation lines…) | none |
| `suppression-invalid` | medium | a `suppress` entry in saut.json without a rule, an artifact or a reason of at least 8 characters. It is ignored until fixed | none |
| `suppression-unused` | low | a suppression that matches no finding, because the finding was fixed or the entry drifted. Remove it | none |
| `duplicate-key` | info | a top-level key appears more than once (capability-marker branches). Allowlists are read as the union, and the first description wins | TAUT markers |

## Current guidance (harness and model)

Vendor recommendations change faster than linter releases, so this layer is **data with a date and
a source**. The model catalogs sit in `lib/harnesses/<id>.json` under `models` (aliases, ids,
status, effort levels per model, replacements), and the prompting guidance in `lib/guidance.json`.
Every finding carries its class, the date the data was verified and the sources. `saut guidance`
says how old the data is (it is considered stale after 60 days) and where this machine disagrees
with it. Where a harness keeps its own catalog locally (Codex: `$CODEX_HOME/models_cache.json`),
SAUT consults that newer data first.

Classes:

- **A**: outdated. Fix it.
- **B**: a prompt-level hypothesis. Both vendors advise changing prompts only against a
  measurement, so class B findings never carry an autofix. Measure with the bench before and after
  the change.
- **D**: a hardening option the artifact does not use yet.

| rule | class | severity | fires when | source |
|---|---|---|---|---|
| `model-unsupported` | A | high | the model is marked unsupported or retired, so runs pinned to it fail | harness catalog; measured 2026-09-23 (`gpt-5.6` → HTTP 400) |
| `model-unknown` | A | medium | neither the registry nor the local catalog knows the model: a typo, or a model newer than the registry | harness catalog |
| `model-previous` | A | low | a pinned previous or legacy model; the message names the current one (review autofix: set `model`) | harness catalog |
| `effort-unsupported` | A | medium | an effort level the harness does not know, or one the model does not accept (Haiku 4.5 takes none; Opus 4.6 has no `xhigh`) | Claude Code model-config; Codex catalog |
| `body-over-spec` | A | medium | a SKILL.md body over 500 lines | Agent Skills best practices |
| `aggressive-imperative` | B | low | an instruction from the era of skills that triggered too rarely ("use PROACTIVELY", "unprompted", "if in doubt, use"), or ≥ 5 all-caps imperatives at ≥ 3 per 1,000 words of prose (thresholds calibrated on one production pack) | Claude prompting best practices, prompt audit; GPT-6 prompting guide |
| `incident-fossil` | B | low | two or more dated incident or measurement stories in the body | prompt audit |
| `reasoning-echo` | B | low | asks the model to show its reasoning process or chain of thought (a verdict with its justification is fine) | prompting Claude Fable 5.2, Opus 5.5, Sonnet 5.5 |
| `codex-agent-sandbox` | D | info | a read-only agent whose tools list Codex drops. A `sandbox_mode` in the agent file (TAUT: `manifest.agentSandbox`) no longer silences it, because Codex agents inherit the parent session's sandbox | Codex subagents, permissions |

In a TAUT pack the deployment's `modelTiers` ladder is checked too, anchored to the line in
`deployment.json`. Fenced code is not prose: commands and examples do not count toward the
prompt-style rules.

## TAUT wiring

Plain mode (no engine) checks the shape against whatever catalog and agents were discovered. With
an engine, the adapter judges against the pack's real catalog and replaces the shape rules.

| rule | severity | fires when | precedent |
|---|---|---|---|
| `taut-mcp-role-unknown` | medium | `metadata.taut.mcp` names a role no catalog server carries | C2 |
| `taut-mcp-role-unused` | low | (plain mode) the role's tools are never called in the body (perhaps delegated to agents). In the engine the key is documentary | C2 |
| `taut-agent-missing` | high | `metadata.taut.agents` names an agent not in the catalog (plain mode: not among the discovered agents, checked only when agents were in scope). The engine fails setup | none |
| `taut-requires-unknown` | high | (engine) `metadata.taut.requires` names a gate the engine does not know (`kaut`) | none |
| `taut-repo-unknown` | high | (engine) `metadata.taut.repos` names a repo outside the deployment's repo map, so the compile fails | none |
| `taut-role-unknown` | info | (engine) `metadata.taut.role` is not a role the engine consumes (`stack-engine`, `spa-mock`, `init`, `knowledge`) | none |
| `taut-wiring-unknown-key` | medium | (engine) a `metadata.taut` key the engine never reads | C2 |
| `taut-compile` | high | (engine) the pack will not compile: the marker pass or the engine's frontmatter parser refuses the source, `metadata.taut` varies by branch, legacy `metadata.federation` is used, or the name differs from the directory | PACK.md §10 |
| `taut-empty-wiring` | info | (engine) `metadata.taut: {}`. The engine reads `{}` as a string; omit the key | none |
| `taut-role-collision` | high | (engine) two skills in the pack declare the same `metadata.taut.role`. The engine resolves a role to one skill, so which skill the compiled instructions name depends on catalog order | found by the Studio gate, 2026-09-03 |

## Rented: content scanning

`saut lint --scan` runs whichever content scanner is installed
([SkillSpector](https://github.com/nvidia/skillspector),
[Snyk Agent Scan](https://github.com/snyk/agent-scan) or
[Cisco skill-scanner](https://github.com/cisco-ai-defense/skill-scanner)) and adds its findings to
the same output under `scan-*` codes, with severities normalized and both JSON and SARIF parsed.
Nothing is bundled or downloaded. If no scanner is installed, the flag reports that and SAUT's own
rules still run. Content scanners do not report per-harness privilege semantics; that part comes
from SAUT.

## Advice and fixes

Every finding carries the rule's **title**, **why** it matters and **how to fix** it, from one
catalog (`lib/rules.mts`). The CLI prints the advice under the finding, `--json` and the Studio
carry the fields, and SARIF puts them in the rule's `fullDescription`, `help` and `helpUri`. A
finding about the body points at its line.

Some findings also carry an **autofix**: a frontmatter edit applied to the file text line by line,
so comments, key order, quoting and capability-marker branches are kept. If a fix cannot be applied
safely (a quoted or folded value, or a list it would empty), it is refused rather than applied in
part. Each fix has a class:

| class | meaning | rules |
|---|---|---|
| `safe` | mechanical, keeps behaviour the same | `legacy-tool` (rename), `unreachable` (`user-invocable: true`) |
| `review` | changes what the artifact may do, or rests on a heuristic that can be wrong for this artifact | `dead-privilege` (remove the tool), `model-invocable-writer` / `supervised-but-auto` (`disable-model-invocation: true`), `readonly-not-enforced` on Claude Code (`disallowed-tools: Write, Edit`) |

```bash
saut lint <path> --fix                            # preview every fix as a diff; writes nothing
saut lint <path> --fix --write                    # apply the safe ones, re-lint
saut lint <path> --fix --write --only dead-privilege,model-invocable-writer   # + these review ones
```

A finding without an autofix needs a manual edit; the Studio says so and links the line. Rules that
read prose or patterns (`dead-privilege`, `injection-heuristic`, `untrusted-content-rule`, the
read-only claims, `supervised-but-auto`, `agent-writes-via-bash`, builtin `body-tool-not-allowed`)
are marked `heuristic` because they can be wrong about a given artifact.

Read the diff before applying a `review` fix. `dead-privilege`, for example, looks for mentions of
the tool in the body, so a skill that calls "every allowed MCP server" without naming the tools is
flagged even though it uses them. In the Studio each fix is previewed and applied one at a time.

## Suppressing a finding

A finding that does not apply to a particular artifact is suppressed **with a reason** in
`saut.json`, next to the pack or skills folder (the nearest one up the tree, which is the same file
that holds cost budgets). Suppressions never go in the artifact itself:

```json
{
  "suppress": [
    { "rule": "dead-privilege", "artifact": "env-check", "match": "mcp__playwright__browser_navigate",
      "reason": "env-check calls the cheapest read-only tool of every allowed MCP server without naming it" }
  ]
}
```

`rule` and `artifact` (its name) are required. `match` limits the entry to findings whose message
contains that text; the Studio writes the finding's quoted subject (a tool name or a matched line)
so the entry still applies after the file changes. Without `match`, the entry covers every finding
of that rule in that artifact. `line` pins a line, but lines move. The `reason` must be at least 8
characters long; an entry without one is ignored and reported as `suppression-invalid`.

A suppressed finding is not dropped. It stays in every output, marked `suppressed` with its reason:
the text report lists it, `--json` carries `suppressed: {reason, file}`, and SARIF sets the
result's `suppressions`. It no longer counts toward the totals or the exit code, and `--fix` leaves
it alone. An entry that matches no finding is reported as `suppression-unused`: either the finding
was fixed or the entry drifted, and a stale exemption could hide the next real finding. In the
Studio every finding has **Suppress…** (a reason, a scope and the saut.json diff), and every
suppressed one has **Lift the suppression**.

## Output

`--json` prints `{version, artifacts[], diagnostics[]}`, where each diagnostic has `category`,
`title`, `why`, `fix`, `doc` and, when there is one, `autofix`. `--fix --json` prints the per-file
fixes, diffs and what was written. `--sarif` prints SARIF 2.1.0 with one rule per code (high →
error, medium → warning, low/info → note). The exit code is 1 on any high finding, or on any medium
finding under `--strict`.
