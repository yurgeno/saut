// SAUT (Skill Assurance Under Trust) — the central data model.
//
// Two kinds of artifacts share one passport: SKILLS (SKILL.md per the Agent Skills spec,
// agentskills.io) and AGENTS (subagent definitions: markdown with frontmatter). Everything
// SAUT knows about a harness comes from the HARNESS REGISTRY (lib/harnesses/*.json) —
// data, never prose — so adding a harness never touches the rules.

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Diagnostic {
  code: string;            // stable rule id, kebab-case (e.g. "no-allowlist")
  severity: Severity;
  message: string;
  path: string;            // file the finding is anchored to
  line?: number;           // 1-based, when known
  harness?: string;        // set when the finding is harness-specific
  precedent?: string;      // the review finding this rule operationalizes (S1, C1, …)
}

// A parsed frontmatter block: the YAML subset SAUT understands (see frontmatter.mts).
export interface Frontmatter {
  data: Record<string, unknown>;
  /** every value of every top-level key, in order (duplicates = marker branches) */
  all: Record<string, unknown[]>;
  diagnostics: Diagnostic[];
  /** line number (1-based) of every top-level key, first occurrence */
  lines: Record<string, number>;
  /** keys that appeared more than once — a strong signal of TAUT capability-marker branches */
  duplicates: string[];
  bodyOffset: number;      // line number (1-based) where the body starts
}

// One tool reference as written in an allowlist: `Bash(git diff *)` → base "Bash", spec "git diff *".
export interface ToolRef {
  raw: string;
  base: string;            // "Bash", "mcp__kaut__kaut_lookup", "mcp__context7"
  spec: string | null;     // the parenthesised part, when present
  mcp: { server: string; tool: string | null } | null;
}

export interface SkillArtifact {
  kind: 'skill';
  name: string;
  path: string;            // absolute path to SKILL.md
  dir: string;             // the skill directory
  fm: Frontmatter;
  description: string;
  body: string;
  allowedTools: ToolRef[] | null;     // null = key absent (= the harness's full toolset)
  disallowedTools: ToolRef[] | null;
  modelInvocable: boolean;            // disable-model-invocation !== true
  userInvocable: boolean;             // user-invocable !== false
  model: string | null;
  effort: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AgentArtifact {
  kind: 'agent';
  name: string;
  path: string;
  fm: Frontmatter;
  description: string;
  body: string;
  tools: ToolRef[] | null;            // `tools:` frontmatter; null = inherits everything
  model: string | null;
}

export type Artifact = SkillArtifact | AgentArtifact;

// ---- harness registry ---------------------------------------------------------------

export type AllowlistSemantics = 'grant' | 'restrict' | 'prose' | 'dropped' | 'n/a';

export interface HarnessRunner {
  cmd: string[];           // argv template; {prompt} and {cwd} are substituted
  trace: 'stream-json' | 'jsonl' | 'json';
}

export interface HarnessCaps {
  id: string;
  title: string;
  docs: string[];                       // provenance URLs for the data below
  skillsDirs: string[];                 // where the harness discovers project skills
  agentsDir: string | null;
  agentFormat: 'md-frontmatter' | 'toml' | 'none';
  builtinTools: string[];               // tool names the harness exposes natively
  legacyTools: string[];                // names that existed in older versions (info, not error)
  frontmatterFields: string[];          // SKILL.md keys the harness honours
  toolAllowlist: AllowlistSemantics;    // skills: what `allowed-tools` means here
  agentAllowlist: AllowlistSemantics;   // agents: what `tools:` means here
  denyMechanism: string | null;         // how a RESTRICTION is actually expressed, if at all
  toolScopedSyntax: boolean;            // Tool(spec) rules understood
  modelPin: 'enforced' | 'advisory' | 'none';
  promptGate: 'blocking' | 'banner' | 'none';
  mcpToolNaming: string;                // "mcp__{server}__{tool}" | "{server}_{tool}"
  listing: { budget: string; descCap: number | null; note: string };
  runner: HarnessRunner | null;         // null = registry-only (no headless runner yet)
  degradations: { id: string; text: string }[];
}

// ---- tool registry --------------------------------------------------------------------

export interface ToolCatalogServer {
  serverKey: string;
  role?: string;
  tools: string[];                      // fully qualified: mcp__<serverKey>__<tool>
  source: string;                       // where the list came from (catalog file / live)
  liveFailed?: boolean;                 // --live: this server did not answer tools/list
}

export interface ToolRegistry {
  builtin: Record<string, string[]>;    // harness id → builtin names
  legacy: Record<string, string[]>;
  servers: ToolCatalogServer[];
}

// ---- cost -----------------------------------------------------------------------------

export interface CostLine {
  artifact: string;
  kind: 'skill' | 'agent';
  alwaysOnChars: number;
  alwaysOnTokens: number;
  invokeChars: number;
  invokeTokens: number;
  transitive: { name: string; tokens: number }[];   // agents / referenced files pulled on invoke
  method: 'estimate' | 'exact';
}

export interface Budgets {
  descriptionChars?: number;
  alwaysOnTokens?: number;
  invokeTokens?: number;
}
