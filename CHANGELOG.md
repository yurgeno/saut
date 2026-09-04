# Changelog

All notable changes to SAUT. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are [semantic](https://semver.org/) and each release is tagged.

## [0.6.0] — 2026-09-04

Hardening release after an external code review. No new surface; every change closes a
defect that was reproduced first.

### Security

- **Studio**: every `/api` route requires the session token — reads carry artifact contents,
  and the same-origin policy stops a foreign page, not another local process scanning
  loopback ports. Containment resolves symlinks (a link under the root used to read and
  write outside it) and writes use `O_NOFOLLOW`. The page is served `X-Frame-Options: DENY`
  with a `frame-ancestors 'none'` policy, the token is compared in constant time, the pack
  script runs without a shell and under a timeout, and the bench-job map is bounded.
- **Spawned MCP servers** see a base environment plus the variable *names* the catalog
  declares — they used to inherit everything, including API keys, from a catalog
  auto-discovered out of repository data.
- **Containment by relative path, not string prefix**: a body referencing
  `<skill>-secrets/creds.json` used to be read, and under `--exact` its contents would have
  been sent to the token-counting API. The same fix applies to grader sources and
  `baseline_file`, which is embedded in a judge prompt.
- **Bounded reads** (8 MB) on every file SAUT did not write, bounded child stdout, and
  timeouts on every spawned program.

### Fixed

- `__proto__` in frontmatter crashed the whole run and could set the prototype of the parsed
  data; every map built from file keys is now null-prototype.
- A 264 KB skill body took 24.7 s of CPU in the reference scan (nested quantifier); it takes
  0.2 s.
- Numbers from an eval spec are range-checked — `timeout_seconds: "5m"` became `NaN` and
  every run reported a timeout while looking like a real bench.
- A regex grader carrying `g` answered two different questions in one evaluation.
- A grader source that cannot be read fails the grader instead of grading the empty string.
- One unreadable artifact no longer aborts a whole tree walk; symlinked skills are visible;
  a non-markdown target is reported instead of dropped.
- `lint` computes one exit code for text, JSON and SARIF alike; SARIF paths are relative.
- `metadata.taut` branches are compared structurally — key order used to decide a verdict.
- The harness registry hands out copies; the TAUT adapter's overlay used to rewrite the
  module cache for every later call in the process.
- CLI flags are declared: a missing value, a non-numeric or out-of-range number and a
  malformed date are usage errors naming the flag. `--version` and `-V` work.
- The suite no longer executes its own fixtures as tests, and no test mutates the shared
  fixture pack (it was an intermittent failure under parallel runs).

### Added

- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `NOTICE`, `CITATION.cff`, this
  changelog, CI on Linux and macOS, issue and pull-request templates.
- Adversarial tests: one per reproduced defect above.

[0.6.0]: https://github.com/yurgeno/saut/releases/tag/v0.6.0

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
