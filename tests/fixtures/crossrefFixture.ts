/**
 * Load a recorded Crossref response, shaped exactly as `crossrefGet` resolves it.
 *
 * The payloads in `crossref/` are verbatim live API bodies — see that folder's
 * `capture.mjs` for how they were recorded and why they are not hand-built.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'crossref');

export function crossrefFixture(name: string): { status: number; data: any } {
  return { status: 200, data: JSON.parse(readFileSync(join(DIR, name), 'utf8')) };
}
