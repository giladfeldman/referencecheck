/**
 * No personal email address in a tracked file (2026-09-27).
 *
 * This repository is public, so anything committed is published. The fixture
 * capture scripts used to hardcode a personal address as the Crossref
 * polite-pool `mailto`; they now read `CROSSREF_MAILTO` from the environment
 * and refuse to run without it. This test stops an address from coming back.
 *
 * It scans every file `git ls-files` reports, not a directory walk, because
 * "tracked" is exactly the set that gets published.
 *
 * One address is allowed, in one file only: `DEFAULT_POLITE_EMAIL`, the
 * library's shipped polite-pool fallback in `src/http/credentials.ts`. It is
 * the project's public contact, not a person's, and changing it changes what
 * every consumer sends to Crossref and OpenAlex. The allowance is pinned to
 * that file, so the same address anywhere else still fails.
 *
 * `docs/consults/` is excluded: it is being removed from the repository and its
 * history separately.
 *
 * Two-sided: the scan must find tracked files at all, and the pattern must
 * match a planted address, because a broken `git ls-files` or a broken regex
 * reports zero findings exactly as a clean tree does.
 */
import { describe, it, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Built from parts so this file does not contain the addresses it forbids. */
const at = (user: string, domain: string): string => `${user}${'@'}${domain}`;

const PERSONAL_EMAIL = /[A-Za-z0-9._%+-]+@(?:gmail\.com|hku\.hk)\b/gi;

/** file -> the one address it may contain. */
const ALLOWED: Record<string, string> = {
  'src/http/credentials.ts': at('collaborativeopenscience', 'gmail.com'),
};

const EXCLUDED_PREFIXES = ['docs/consults/'];

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)));
}

function findings(file: string, text: string): string[] {
  return [...text.matchAll(PERSONAL_EMAIL)]
    .map((m) => m[0])
    .filter((addr) => ALLOWED[file]?.toLowerCase() !== addr.toLowerCase())
    .map((addr) => `${file}: ${addr}`);
}

describe('no personal email address in a tracked file', () => {
  const files = trackedFiles();

  it('finds tracked files to scan (control for a broken git ls-files)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('package.json');
  });

  it('matches a planted address (control for a broken pattern)', () => {
    const text = `mailto:${at('someone', 'gmail.com')} and ${at('a', 'HKU.HK')}`;
    expect(findings('x.ts', text)).toEqual([
      `x.ts: ${at('someone', 'gmail.com')}`,
      `x.ts: ${at('a', 'HKU.HK')}`,
    ]);
    // The allowance is per file: the allowed address elsewhere is a finding.
    expect(findings('x.ts', ALLOWED['src/http/credentials.ts'])).toHaveLength(1);
  });

  it('no tracked file carries one', () => {
    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), 'utf8');
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      found.push(...findings(file, text));
    }
    expect(found).toEqual([]);
  });
});
