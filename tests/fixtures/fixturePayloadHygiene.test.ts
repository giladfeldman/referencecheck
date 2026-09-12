/**
 * Recorded API fixtures must not carry published article prose (2026-09-12).
 *
 * This repository is public and MIT-licensed, so a fixture is redistributed the
 * moment it is committed. Crossref metadata is freely reusable; the `abstract` a
 * publisher deposits alongside it often is not, and a recorded response body is
 * an easy place for it to arrive unnoticed. Three of the Crossref bodies under
 * `crossref/` originally carried the full abstract of the article they
 * described.
 *
 * `capture.mjs` now deletes `abstract` (and the large `reference` array) before
 * writing a fixture, but nothing re-asserted that, so a hand-edited fixture or a
 * future change to the capture script could put the prose back silently:
 * text-scanning tools look at files, not at the string values nested inside
 * JSON, so nothing else in this repository would notice.
 *
 * The assertion is deliberately structural rather than semantic. A recorded
 * metadata body has no legitimate reason to contain a long block of prose, so
 * any string past `MAX_STRING_LEN` is a finding regardless of which key holds
 * it. The longest legitimate string measured across all fixtures on 2026-09-12
 * was a 333-character article title, so the limit leaves real headroom while
 * still catching an abstract (typically 800 to 2500 characters).
 *
 * Two-sided by construction: the test fails if the walk finds no fixtures, or a
 * fixture with no strings at all, because a silently broken walker reports zero
 * findings in exactly the same way as a clean tree.
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));

/** Longest legitimate string measured 2026-09-12: a 333-char article title. */
const MAX_STRING_LEN = 600;

/**
 * Keys that carry published article prose rather than metadata. `abstract` is
 * the body text itself; `reference` is the cited-works array, which is large and
 * no code path under test reads.
 */
const FORBIDDEN_KEYS = ['abstract', 'reference'];

function jsonFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsonFixtures(full));
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

interface Walked {
  strings: number;
  longStrings: { path: string; len: number }[];
  forbiddenKeys: string[];
}

function walk(node: unknown, path: string, acc: Walked): void {
  if (typeof node === 'string') {
    acc.strings += 1;
    if (node.length > MAX_STRING_LEN) acc.longStrings.push({ path, len: node.length });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key)) acc.forbiddenKeys.push(`${path}.${key}`);
    walk(value, `${path}.${key}`, acc);
  }
}

describe('recorded fixtures carry metadata, not published prose', () => {
  const files = jsonFixtures(FIXTURE_ROOT);

  it('finds fixtures to scan at all (control for a broken walk)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(FIXTURE_ROOT, f), f] as const))(
    '%s holds no prose field',
    (_name, file) => {
      const acc: Walked = { strings: 0, longStrings: [], forbiddenKeys: [] };
      walk(JSON.parse(readFileSync(file, 'utf8')), '', acc);

      // Control: a fixture with zero strings means the walk broke, not that the
      // fixture is clean.
      expect(acc.strings).toBeGreaterThan(0);

      expect(acc.forbiddenKeys).toEqual([]);
      expect(acc.longStrings).toEqual([]);
    },
  );
});
