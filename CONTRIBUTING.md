# Contributing to SAUT

Thanks for looking under the hood. This file covers the dev setup and the few rules that
keep the tool what it is.

## Dev setup

```bash
git clone https://github.com/yurgeno/saut.git
cd saut
npm install        # dev dependencies only: typescript + @types/node
npm test           # tsc --noEmit && node --test
```

Node ≥ 24 is required: the core is TypeScript executed natively via type stripping, `tsc`
is only the checker. Linux and macOS are the supported platforms. The whole suite runs
**offline** — the bench tests drive fake harness binaries on `PATH` and the judge tests a
fake `claude` — so `npm test` costs nothing and needs no credentials.

## Ground rules

- **Zero runtime dependencies is a feature, not an accident.** A PR that adds one needs an
  exceptional case; "convenient" is not one.
- **A harness is data, not code.** What a harness enforces, degrades or lists lives in
  `lib/harnesses/<id>.json` with the documentation URLs it was derived from. Adding a
  harness is adding a file (plus a runner in `lib/bench/runners.mts` if it can be driven
  headlessly). A rule that special-cases a harness by name in `lib/lint.mts` is a smell.
- **Every rule cites its precedent.** A lint rule states what breaks and where the evidence
  came from — a review finding, a harness doc, published research. A rule nobody can trace
  is a rule nobody will trust.
- **No score.** SAUT reports findings and the per-harness enforcement matrix. It does not
  reduce a skill to a number.
- **Measure, don't assert.** Claims about harness behaviour belong in the registry with a
  source, or in the bench where they are executed. If a fact can be checked by running
  something, the PR should run it.
- **Rent what is commodity.** Distribution, content scanning and the harness runtimes are
  other people's problems, solved well elsewhere. What SAUT owns is the cross-harness
  privilege semantics and the cost passport.
- **Behavior changes come with tests**, and `npm test` stays green.
- **Commit messages in English**, stating the user-visible effect.

## Where things go

| Change | Belongs in |
|---|---|
| Rules and their severities | `lib/lint.mts` + a fixture in `test/fixtures/pack/` + a row in [docs/RULES.md](docs/RULES.md) |
| What a harness enforces or degrades | `lib/harnesses/<id>.json` (with the doc URL it came from) |
| Bench levels, cases, graders, isolation | `lib/bench/` + [docs/BENCH.md](docs/BENCH.md) |
| The TAUT adapter | `lib/adapters/taut.mts` — the engine is imported, never re-implemented |
| The local UI | `lib/studio/` + [docs/STUDIO.md](docs/STUDIO.md); its security contour is documented there |
| Docs | `docs/` — update them in the same PR as the behavior they describe |

## Adding a lint rule

1. A fixture under `test/fixtures/pack/` that triggers it, and ideally one that must *not*.
2. The rule in `lib/lint.mts`, with `precedent` set.
3. A row in `docs/RULES.md` saying when it fires and what the evidence is.
4. `npm test`.

## Reporting

Bugs and feature requests: use the issue templates. Security issues: privately, per
[SECURITY.md](SECURITY.md).
