// Where bench runs land. Never inside the project: traces carry full model transcripts, and a
// compiled workspace's skill directories are sealed by an integrity lock. One directory per
// artifact — keyed by its real path — so a run started from the CLI and one started from the
// Studio share a history.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Artifact } from '../types.mts';

// $SAUT_HOME/results, default ~/.saut/results
export function resultsHome(): string {
  return path.join(process.env.SAUT_HOME || path.join(os.homedir(), '.saut'), 'results');
}

export function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// <home>/<name>--<8 hex of the artifact's real path>
export async function artifactResultsRoot(a: Artifact): Promise<string> {
  const real = await fs.realpath(a.path).catch(() => path.resolve(a.path));
  const hash = crypto.createHash('sha256').update(real).digest('hex').slice(0, 8);
  const name = (a.name || 'artifact').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
  return path.join(resultsHome(), `${name}--${hash}`);
}

export async function newResultsDir(a: Artifact): Promise<string> {
  return path.join(await artifactResultsRoot(a), runStamp());
}
