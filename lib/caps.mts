// Harness capability registry loader. One JSON per harness under lib/harnesses/ — data,
// with provenance URLs, never prose in code. Adding a harness = adding a file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessCaps } from './types.mts';
import { fail } from './util.mts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'harnesses');

const REQUIRED: (keyof HarnessCaps)[] = [
  'id', 'title', 'docs', 'skillsDirs', 'agentFormat', 'builtinTools', 'legacyTools', 'frontmatterFields',
  'toolAllowlist', 'agentAllowlist', 'toolScopedSyntax', 'modelPin', 'promptGate', 'mcpToolNaming', 'listing', 'degradations',
];

let cache: Map<string, HarnessCaps> | null = null;

export async function loadHarnesses(): Promise<Map<string, HarnessCaps>> {
  if (cache) return cache;
  const m = new Map<string, HarnessCaps>();
  for (const f of (await fs.readdir(DIR)).filter((x) => x.endsWith('.json')).sort()) {
    const h = JSON.parse(await fs.readFile(path.join(DIR, f), 'utf8')) as HarnessCaps;
    for (const k of REQUIRED) if (h[k] === undefined) fail(`harness registry ${f}: missing "${k}"`);
    if (h.id !== path.basename(f, '.json')) fail(`harness registry ${f}: id "${h.id}" != file name`);
    m.set(h.id, h);
  }
  cache = m;
  return m;
}

export async function harness(id: string): Promise<HarnessCaps> {
  const m = await loadHarnesses();
  return m.get(id) ?? fail(`unknown harness "${id}" (known: ${[...m.keys()].join(', ')})`);
}

// Harnesses with a headless runner = the ones SAUT can test against today.
export async function runnableHarnesses(): Promise<HarnessCaps[]> {
  return [...(await loadHarnesses()).values()].filter((h) => h.runner);
}
