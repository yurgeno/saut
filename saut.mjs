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
//   studio/*         the loopback UI (server.mts + studio.html) over the same library functions
//   commands.mts     lint / cost / passport / preview / test / harnesses / tools
import process from 'node:process';

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  process.stderr.write(`saut: Node >= 24 required (this is ${process.versions.node}) — the core is TypeScript executed natively by Node.\n`);
  process.exit(1);
}

const { SautError } = await import('./lib/util.mts');
const { VERSION, cmdCost, cmdHarnesses, cmdLint, cmdPassport, cmdPreview, cmdStudio, cmdTest, cmdTools } = await import('./lib/commands.mts');

// Flags are declared, not hand-rolled per branch: a missing value, a non-numeric value or a
// number out of range is a USAGE error (exit 2) with a message naming the flag — never an
// undefined that turns into NaN and silently changes behaviour three modules later.
const BOOL_FLAGS = new Set(['--json', '--sarif', '--live', '--exact', '--strict', '--no-taut', '--scan', '--keep']);
const VALUE_FLAGS = {
  '--catalog': 'catalog', '--budget': 'budget', '--taut': 'taut', '--deployment': 'deployment',
  '--scanner': 'scanner', '--workspace': 'workspace', '--since': 'since', '--until': 'until',
  '--model': 'model', '--judge-model': 'judgeModel', '--landscape': 'landscape', '--case': 'case',
  '--out': 'out',
};
const NUMBER_FLAGS = {
  '--level': { key: 'level', min: 1, max: 4, int: true },
  '--runs': { key: 'runs', min: 1, max: 100, int: true },
  '--max-cost': { key: 'maxCost', min: 0, max: 10000 },
  '--timeout': { key: 'timeout', min: 1, max: 86400, int: true },
  '--port': { key: 'port', min: 0, max: 65535, int: true },
};
const BOOL_KEY = {
  '--json': 'json', '--sarif': 'sarif', '--live': 'live', '--exact': 'exact', '--strict': 'strict',
  '--no-taut': 'noTaut', '--scan': 'scan', '--keep': 'keep',
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function usage(msg) {
  process.stderr.write(`saut: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { _: [], harness: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) usage(`${a} needs a value`);
      return v;
    };
    if (BOOL_FLAGS.has(a)) opts[BOOL_KEY[a]] = true;
    else if (a === '--harness') {
      const ids = value().split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length) usage('--harness needs at least one id');
      opts.harness.push(...ids);
    } else if (VALUE_FLAGS[a]) {
      const v = value();
      if ((a === '--since' || a === '--until') && !DAY.test(v)) usage(`${a}: expected YYYY-MM-DD, got "${v}"`);
      opts[VALUE_FLAGS[a]] = v;
    } else if (NUMBER_FLAGS[a]) {
      const { key, min, max, int } = NUMBER_FLAGS[a];
      const raw = value();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n)))
        usage(`${a}: expected ${int ? 'an integer' : 'a number'} in ${min}..${max}, got "${raw}"`);
      opts[key] = n;
    } else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version' || a === '-V') opts.version = true;
    else if (a.startsWith('-') && a !== '-') usage(`unknown option ${a}`);
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
  studio [dir]         the local UI over all of the above: form + editor, passport, bench, publish
  preview <name> [dir] TAUT packs: the compiled bytes of one skill/agent per harness (engine render)
  test <skill|agent>   the bench: L1 compile into a scratch workspace · L2 trigger (does each
                       harness fire the skill — explicit / implicit / control) · L3 obedience
                       (do the runs stay inside the allowlist) · L4 scenario graders. Spends
                       money on L2+.

Options
  --harness <ids>      comma-separated subset (default: every registered harness)
  --catalog <file>     MCP catalog (TAUT catalog/mcp.json, .mcp.json, opencode.json); auto-detected
  --live               ask each catalog server for tools/list over stdio (spawns them)
  --exact              cost via the Claude token-counting API (ANTHROPIC_API_KEY)
  --budget <file>      budgets JSON {descriptionChars, alwaysOnTokens, invokeTokens} (else saut.json)
  --scan [--scanner id] fold an installed content scanner's findings into the lint
                       (skillspector | snyk agent scan | skill-scanner — rented, never bundled)
  --workspace <dir>    a compiled TAUT workspace: adds the USED column from its local telemetry
                       (--since / --until YYYY-MM-DD)
  --json | --sarif     machine output (sarif: lint only)
  -h, --help · -V, --version
  --strict             lint exits 1 on medium findings too (default: high only)

TAUT packs (auto-detected: pack.json + skills/ or <project>/deployment.json)
  --taut <dir>         the TAUT engine to import (default: $SAUT_TAUT_ENGINE, ~/taut)
  --deployment <name>  which project of the pack (required when it has several)
  --no-taut            lint a TAUT pack as plain skills
  With an engine: frontmatter is parsed by the engine, metadata.taut is checked against the
  pack catalog, passport/preview carry the compiled bytes + recorded degradations per harness.

Bench (saut test)
  --level 1|2|3|4      cumulative (default 3; 4 = scenario graders) · --runs <n> (default 1) · --case <glob>
  --model <id>         harness model (default cheap: claude haiku, codex gpt-5.4-mini)
  --judge-model <id>   model for L4 llm/baseline graders (default haiku)
  --max-cost <usd>     stop when Claude-reported spend reaches this ceiling
  --landscape <dir>    TAUT: a real landscape, COPIED into the scratch (default: stub repos)
  --out <dir>          results (default <artifact>/evals/results/<timestamp>/) · --keep scratch
  --timeout <s>        per run (default 300)

Studio
  --port <n>           bind port (default: an ephemeral one); always 127.0.0.1 only
  Isolation: scratch workspace, Claude dontAsk + the artifact's grant minus the shell, Codex
  read-only sandbox, opencode deny-by-default permissions. Cases: <skill>/evals/**/prompt.md
  (Claude Code plugin-eval layout; SAUT reads expect: fire|no-fire and invocation:) or three
  generated ones (explicit / implicit / control).

Exit codes: 0 clean/within budget/bench passed · 1 findings/over budget/bench failed · 2 usage error
`;

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._.shift();
const table = { lint: cmdLint, cost: cmdCost, passport: cmdPassport, preview: cmdPreview, test: cmdTest, studio: cmdStudio, harnesses: cmdHarnesses, tools: cmdTools };
if (opts.version || cmd === 'version') { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (!cmd || opts.help || cmd === 'help') { process.stdout.write(HELP); process.exit(0); }
if (!table[cmd]) { process.stderr.write(`saut: unknown command "${cmd}"\n\n${HELP}`); process.exit(2); }
try {
  process.exit(await table[cmd](opts));
} catch (e) {
  process.stderr.write(`saut: ${e instanceof SautError ? e.message : (e && e.stack) || e}\n`);
  process.exit(2);
}
