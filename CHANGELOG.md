# Changelog

All notable changes to SAUT. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are [semantic](https://semver.org/) and each release is tagged.

## [0.5.0] — 2026-09-03

First public release.

### Added

- **`lint`** — 25 rules over privileges, safety and hygiene, each citing its precedent, plus
  the per-harness enforcement matrix. `--scan` folds an installed content scanner
  (SkillSpector, Snyk Agent Scan, Cisco skill-scanner) into the same stream; with none
  installed it says so rather than implying a clean bill. `--json`, `--sarif`, `--strict`.
- **`cost`** — the token passport: always-on (the listing entry, paid every session) versus
  on-invoke (the body plus the subagents and files it drags in), against budgets. `--exact`
  counts through the Claude token-counting API; `--workspace` adds a *used* column from a
  compiled workspace's local telemetry.
- **`test`** — the bench. L1 compiles the artifact into a scratch workspace (for a TAUT pack,
  the engine compiles it against stub repos and `taut verify` seals it). L2 measures whether
  each harness fires the skill — explicit, implicit, and a control that must not fire —
  reporting `lost to <other-skill>` when a description loses a routing contest. L3 compares
  every observed tool call against the declared allowlist in Claude Code's scoped-rule
  semantics; a refusal is a denial, not a violation. L4 runs scenario graders (`regex`,
  `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`) in the Claude Code
  `plugin eval` layout, and imports an agentskills `evals.json` suite as cases.
- **`studio`** — a loopback UI over all of it: the form writes frontmatter through the
  emitter, the passport updates as you type, the Compiled tab shows the exact per-harness
  bytes for a TAUT pack, and the bench streams live over SSE.
- **`passport`**, **`preview`**, **`harnesses`**, **`tools`** — the JSON document, the
  compiled bytes of one artifact, the capability registry, and the tool names an allowlist may
  cite (`--live` asks MCP servers over stdio).
- **Harness capability registry** — `lib/harnesses/*.json` for `claude-code`, `codex`,
  `opencode` (with headless runners), `cursor` and `copilot` (registry-only), each carrying
  the documentation URLs it was derived from.
- **TAUT adapter** — with a TAUT engine reachable, skill frontmatter is parsed by the engine
  itself, `metadata.taut` is validated against the pack's real catalog, and compile previews
  come from `taut render`.

[0.5.0]: https://github.com/yurgeno/saut/releases/tag/v0.5.0
