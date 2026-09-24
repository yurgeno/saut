# Changelog

All notable changes to SAUT. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are [semantic](https://semver.org/) and each release is tagged.

## [Unreleased]

### Added

- **Studio, rebuilt as a workbench.** Four views: **Overview** (every skill and agent with its
  high/medium/security counts, guidance A·B·D, fixable findings and token cost, sortable and
  filterable), **Skill** (a form and the raw file in CodeMirror editors, findings re-linted on
  the unsaved text as you type, finding lines tinted in the editor, a sticky save bar),
  **Bench** and **Harnesses** (the registry as reference: allowlist semantics, model catalogs,
  degradations). Target harnesses in the header filter the matrix, the findings and the bench.
- **A compiled workspace opens read-only.** Files sealed by `taut.lock` name the pack source
  and commit they were compiled from and refuse saves and fixes; the copies of one skill for
  different harnesses collapse into one Overview row.

- **Current vendor guidance, dated and sourced.** Model catalogs per harness (Claude Code:
  aliases, ids, effort levels per model; Codex: the same, plus the harness's own catalog on the
  machine, read first) and the current prompting guidance are data with a verification date
  and sources. New rules: `model-unsupported`, `model-unknown`, `model-previous`,
  `effort-unsupported`, `body-over-spec` (class A — outdated), `aggressive-imperative`,
  `incident-fossil`, `reasoning-echo` (class B — change only against a bench; never an
  autofix), `codex-agent-sandbox` (class D — hardening). In a TAUT pack the deployment's
  `modelTiers` ladder is checked too; run against the pack as it was before 2026-09-23 it
  reports the `gpt-5.6` pin that failed every Codex session.
- **`saut guidance`** — how old that data is (stale after 60 days) and where this machine's
  harness CLIs and model catalogs disagree with it; exit 1 if stale or drifting.

- **Every finding says how to fix it.** A rule catalog gives each code a title, why it matters
  and what to do; the CLI prints the advice under the finding, `--json` and the Studio carry
  it, SARIF fills the rule's `fullDescription`, `help` and `helpUri`. Findings about the body
  point at their line, and `injection-heuristic` quotes the line it matched.
- **Mechanical fixes.** Findings that can be fixed by a frontmatter edit carry an `autofix`,
  applied line by line so comments, key order and capability-marker branches survive.
  `saut lint --fix` previews them as a diff; `--write` applies the `safe` ones; `review` ones
  (they change behaviour or rest on a heuristic) are written only for the codes in `--only`.
- **Studio: findings you can act on.** Grouped by category, each with how to fix, why, a link
  to the rule, a jump to its line, and — where there is one — a fix button that previews the
  diff (with the changed part highlighted) before **Apply and save**. A finding without one
  says so and links the line to edit; rules that read prose or patterns are marked heuristic.

### Changed

- **Studio security contour:** the session token rides in a `<meta>`; the page runs no inline
  script (`script-src 'self'`); assets are served by name only; paths cross the API relative
  to the root.
- **Bench results live outside the project.** `saut test` and the Studio write runs to
  `~/.saut/results/<name>--<hash>/<timestamp>/` (`$SAUT_HOME` moves the root; `--out` still
  writes one run anywhere). Traces carry full model transcripts, and a compiled workspace's
  skill directories are sealed by an integrity lock — neither should receive them. One
  directory per artifact, keyed by its real path, so CLI and Studio runs share a history.
  Earlier runs under `<artifact>/evals/results/` are left where they are.

### Fixed

- **Saving from the Studio form dropped what the form does not show** — `disallowed-tools`,
  `hooks`, `paths`, `license`, comments and TAUT capability-marker branches: the frontmatter
  was re-emitted from the form's fields. An existing file is now saved as text: the form's
  edit is applied field by field (`lib/compose.mts`), a field that differs by branch is refused
  rather than flattened, every save shows the diff, and the write is checked against the hash
  the file was opened with.
- **Line numbers in a TAUT pack pointed at the engine-gated text,** not the file: after a
  capability marker every finding line was off by the lines the marker pass removed. Findings
  are now mapped back to file lines.
- **Piped output was cut at 64 KB.** The CLI exited right after writing, before a pipe had
  taken the rest, so `saut lint --json | jq` or `--sarif` into an upload step got a truncated
  document on any tree with more than a screenful of findings. Exit now waits for stdout and
  stderr to drain.
- **Studio lost unsaved edits.** Opening another artifact, starting a new one or reverting
  replaced the form without asking, and only the description and body marked the form as
  edited. Every field now does; an **● unsaved changes** mark sits next to Save, and anything
  that would discard edits asks first.
- **Studio offered no L4.** The bench level list stopped at L3 although the server ran L4; the
  scenario column now shows in the result matrix.
- The docs said the passport updates as you type; it updates on open and on save.
- `saut --help` named the old results directory and the retired `gpt-5.4-mini` bench default.
- `injection-heuristic` flagged prose as a credential read when `echo` and `.env` merely shared a line ("never echo credentials … fill `.taut/local.env`"); the file must now be the command's argument.

## [0.6.4] — 2026-09-23

### Fixed

- **Studio opened empty.** Since 0.6.0 every `/api` route requires the session token, reads
  included, but the page sent it only on POST — so its first `GET /api/context` was refused and
  no artifact or harness loaded. Every request now carries the token. A test drives the served
  page's own `api()` against the server; the existing helpers sent the token themselves and
  could not notice.

## [0.6.3] — 2026-09-23

### Added

- **`description-over-spec` (high).** A skill `description` longer than the 1 024 characters the
  Agent Skills specification allows. Loaders accept it today; a stricter one, or a Skills API
  upload, drops or rejects the skill. Separate from the `description-too-long` budget rule.

### Fixed

- **Bench default model for Codex.** `gpt-5.4-mini` was retired on 2026-08-31; the cheap default
  is now `gpt-6-luna` (Codex CLI 0.156.1 or newer).

## [0.6.2] — 2026-09-04

### Added

- **Harness registry: how a skill is invoked there.** `skillInvocation` records the fact that
  decides where usage can be observed at all — `tool+slash` (Claude Code), `read` (Codex: no
  skill tool and no slash invocation; the model opens `SKILL.md`, so an invocation looks like
  a file read), or `null` for a harness where the question has not been measured. An explicit
  null keeps an unanswered question visible instead of letting an absent field read as an
  oversight. `saut harnesses` prints it; a new `CX-NO-SLASH-EXPANSION` degradation records
  what it was measured against.

## [0.6.1] — 2026-09-04

### Fixed

- **Usage was counting the wrong rows.** A workspace's own integrity self-test invokes the
  gate out of band against the first skill in its manifest; those rows were indistinguishable
  from real invocations, so a routinely checked workspace showed a large invented count on
  one arbitrary skill. They are now excluded and reported as a separate `probes` figure —
  by their explicit marker on current engines, and on older files by the reserved probe name
  and the row the same self-test wrote in the same second.
- **A zero no longer overstates itself.** Telemetry written before the gate labelled each
  invocation path never recorded direct `/slash` invocations — the only path by which a skill
  with `disable-model-invocation: true` can be reached. `saut cost --workspace` now detects
  such files and says the zeros mean "not recorded" rather than "unused". `--json` carries
  `usage.probes` and `usage.pathsRecorded`.

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
