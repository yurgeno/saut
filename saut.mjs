#!/usr/bin/env node
// SAUT (Skill Assurance Under Trust) — CLI entry: argv, help, dispatch.
// Zero runtime dependencies, Node >= 24, ESM. This entry stays a thin PLAIN-JS shell;
// the core under lib/ is TypeScript (.mts) executed natively by Node (type stripping —
// no build step); `tsc --noEmit` is the checker (npm test runs it).
//
// Module map (lib/):
//   types.mts        the data model: artifacts, diagnostics, harness caps, tool registry, cost
//   util.mts         fail / fs probes / ANSI
//   frontmatter.mts  YAML-subset frontmatter parser + round-trip emitter
//   skill.mts        discovery + loading of skills and agents, tool-reference parsing
//   caps.mts         harness capability registry loader (lib/harnesses/*.json)
//   tools.mts        tool registry: builtin per harness + MCP catalog + live tools/list
//   lint.mts         the rules (privilege semantics, correctness, hygiene) + SARIF
//   cost.mts         always-on / on-invoke token passport (estimate | --exact)
//   adapters/taut.mts TAUT packs: engine-parsed frontmatter, wiring vs catalog, compile preview
//   bench/*.mts      the test bench: cases, scratch workspaces, runners, obedience, orchestrator
//   commands.mts     lint / cost / passport / preview / test / harnesses / tools
import process from 'node:process';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  process.stderr.write(`saut: Node >= 24 required (this is ${process.versions.node}) — the core is TypeScript executed natively by Node.\n`);
  process.exit(1);
}

const { SautError } = await import('./lib/util.mts');
const { VERSION, cmdCost, cmdHarnesses, cmdLint, cmdPassport, cmdPreview, cmdTest, cmdTools } = await import('./lib/commands.mts');

function parseArgs(argv) {
  const opts = { _: [], harness: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--sarif') opts.sarif = true;
    else if (a === '--harness') opts.harness.push(...argv[++i].split(','));
    else if (a === '--catalog') opts.catalog = argv[++i];
    else if (a === '--live') opts.live = true;
    else if (a === '--exact') opts.exact = true;
    else if (a === '--budget') opts.budget = argv[++i];
    else if (a === '--strict') opts.strict = true;
    else if (a === '--taut') opts.taut = argv[++i];
    else if (a === '--deployment') opts.deployment = argv[++i];
    else if (a === '--no-taut') opts.noTaut = true;
    else if (a === '--level') opts.level = Number(argv[++i]);
    else if (a === '--runs') opts.runs = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--max-cost') opts.maxCost = Number(argv[++i]);
    else if (a === '--landscape') opts.landscape = argv[++i];
    else if (a === '--case') opts.case = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) { process.stderr.write(`saut: unknown option ${a}\n`); process.exit(2); }
    else opts._.push(a);
  }
  return opts;
}

const HELP = `SAUT — Skill Assurance Under Trust — v${VERSION}
Lint, cost and test agent skills and subagents for any harness.

Usage: saut <command> [targets…] [options]

Commands
  lint [paths…]        privilege/correctness findings per artifact + per-harness enforcement
                       (a path = SKILL.md, a skill dir, an agent .md, or a tree to walk)
  cost [paths…]        token passport: always-on (listing) / on-invoke (body + wired agents)
  passport [paths…]    lint + cost + harness matrix as one JSON document
  harnesses            the capability registry (what each harness enforces / degrades)
  tools [dir]          the tool registry: builtin per harness + MCP catalog (+ --live)
  preview <name> [dir] TAUT packs: the compiled bytes of one skill/agent per harness (engine render)
  test <skill|agent>   the bench: L1 compile into a scratch workspace · L2 trigger (does each
                       harness fire the skill — explicit / implicit / control) · L3 obedience
                       (do the runs stay inside the allowlist). Spends money on L2+.

Options
  --harness <ids>      comma-separated subset (default: every registered harness)
  --catalog <file>     MCP catalog (TAUT catalog/mcp.json, .mcp.json, opencode.json); auto-detected
  --live               ask each catalog server for tools/list over stdio (spawns them)
  --exact              cost via the Claude token-counting API (ANTHROPIC_API_KEY)
  --budget <file>      budgets JSON {descriptionChars, alwaysOnTokens, invokeTokens} (else saut.json)
  --json | --sarif     machine output (sarif: lint only)
  --strict             lint exits 1 on medium findings too (default: high only)

TAUT packs (auto-detected: pack.json + skills/ or <project>/deployment.json)
  --taut <dir>         the TAUT engine to import (default: $SAUT_TAUT_ENGINE, ~/taut)
  --deployment <name>  which project of the pack (required when it has several)
  --no-taut            lint a TAUT pack as plain skills
  With an engine: frontmatter is parsed by the engine, metadata.taut is checked against the
  pack catalog, passport/preview carry the compiled bytes + recorded degradations per harness.

Bench (saut test)
  --level 1|2|3        cumulative (default 3) · --runs <n> per case (default 1) · --case <glob>
  --model <id>         harness model (default cheap: claude haiku, codex gpt-5.4-mini)
  --max-cost <usd>     stop when Claude-reported spend reaches this ceiling
  --landscape <dir>    TAUT: a real landscape, COPIED into the scratch (default: stub repos)
  --out <dir>          results (default <artifact>/evals/results/<timestamp>/) · --keep scratch
  --timeout <s>        per run (default 300)
  Isolation: scratch workspace, Claude dontAsk + the artifact's grant minus the shell, Codex
  read-only sandbox, opencode deny-by-default permissions. Cases: <skill>/evals/**/prompt.md
  (Claude Code plugin-eval layout; SAUT reads expect: fire|no-fire and invocation:) or three
  generated ones (explicit / implicit / control).

Exit codes: 0 clean/within budget/bench passed · 1 findings/over budget/bench failed · 2 usage error
`;

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._.shift();
const table = { lint: cmdLint, cost: cmdCost, passport: cmdPassport, preview: cmdPreview, test: cmdTest, harnesses: cmdHarnesses, tools: cmdTools };
if (!cmd || opts.help || cmd === 'help') { process.stdout.write(HELP); process.exit(0); }
if (cmd === 'version' || cmd === '--version') { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (!table[cmd]) { process.stderr.write(`saut: unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
try {
  process.exit(await table[cmd](opts));
} catch (e) {
  process.stderr.write(`saut: ${e instanceof SautError ? e.message : (e && e.stack) || e}\n`);
  process.exit(2);
}
