# Security policy

SAUT reads untrusted content and runs other programs: it parses skill files it did not
write, spawns harness CLIs and content scanners, and serves a mutating page on loopback.
Bugs in those boundaries are security bugs.

## Reporting a vulnerability

Report privately through GitHub's **Report a vulnerability** button (Security tab of this
repository) — please do not open a public issue for anything exploitable. Include what you
did, what happened, and the commit you saw it on. Expect an acknowledgement within a few
days; this is a solo-maintained project, so fixes land as fast as one person can verify
them.

## What is in scope

- **Studio** — anything reachable without the per-session token, a non-loopback bind, a
  cross-origin read, or a write that escapes the root the studio was started with or lands
  on a file that is not a `SKILL.md` or an agent `.md`.
- **Bench isolation** — a run that touches anything outside its scratch workspace, or state
  a harness creates outside it that the bench then fails to remove.
- **Injection** — a crafted skill file, MCP catalog, eval case or grader that reaches a
  shell, an argument vector, or a spawned program as anything but inert data.
- **Path traversal** — any user-supplied path (`--catalog`, `--budget`, `--out`,
  `--landscape`, a grader `path`, a studio save) that reads or writes outside its intended
  root.
- **Secret exposure** — any path where a value from the environment, a `local.env`, or an
  MCP configuration reaches stdout, the served page, a results file, or a judge prompt.
  Variable *names* and a filled/empty flag are fine; values are not.
- **Denial of service on inputs** — catastrophic backtracking, unbounded reads or
  unbounded recursion triggered by a skill file, a pack, or an event stream.

## What is not

- A skill instructing an agent to do something harmful. Skills are the *subject* of the
  analysis, not trusted input to it — SAUT's job is to report that, and `lint` has rules
  for exactly this class. Reviewing what you install remains your decision.
- Anything requiring an attacker who can already write to your checkout, your pack, or your
  `PATH`. That is game over by construction.
- The behaviour of the harnesses SAUT drives, or of a content scanner it rents.
- Cost incurred by `saut test`. It calls real models by design; `--max-cost` bounds it, and
  `--level 1` never spends anything.

## Supported versions

The tip of `master` is the supported version. Releases are tagged; each carries its own
notes.
