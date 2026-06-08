import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BeallsList } from './types.js';

// Lazy __dirname resolution to avoid import.meta.url at module level
// (matches the worker's pattern; keeps Jest happy).
let _cachedDirname: string | null = null;
function getDirname(): string {
  if (!_cachedDirname) {
    _cachedDirname = dirname(fileURLToPath(import.meta.url));
  }
  return _cachedDirname;
}

let beallsListCache: BeallsList | null = null;

export function loadBeallsList(): BeallsList {
  if (beallsListCache) {
    return beallsListCache;
  }
  try {
    // Compiled module sits at dist/predatory/beallsList.js; the bundled
    // dataset is copied to dist/data/bealls-list.json by the copy-data
    // build step.
    const beallsPath = join(getDirname(), '..', 'data', 'bealls-list.json');
    const data = readFileSync(beallsPath, 'utf-8');
    beallsListCache = JSON.parse(data);
    return beallsListCache as BeallsList;
  } catch (error) {
    console.error('Error loading Beall\'s List:', error);
    return {
      lastUpdated: '',
      source: '',
      publishers: [],
      indicators: {
        rapid_publication: [],
        guaranteed_acceptance: [],
        excessive_marketing: [],
        suspicious_fees: [],
        poor_quality_signals: [],
      },
      knownLegitimatePublishers: [],
    };
  }
}

/**
 * Tokenize a publisher name into lowercase word tokens, Unicode-aware so that
 * accented / non-Latin publisher names ("Médecine", "北京大学") survive instead of
 * being collapsed to empty (D4). Punctuation and whitespace are separators.
 */
function publisherTokens(name: string): string[] {
  return name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Generic publisher words that must NEVER cause a single-token match on their
 * own — otherwise a legitimate "X Press" / "Open Y Journal" would match any
 * predatory entry sharing one of these words. (The shipped Beall's data has no
 * single-generic-word entries, so this is a future-proof guard, not a current
 * purge.)
 */
const GENERIC_PUBLISHER_TOKENS = new Set([
  'science', 'sciences', 'scientific', 'press', 'media', 'journal', 'journals',
  'publishing', 'publication', 'publications', 'publisher', 'publishers',
  'research', 'international', 'global', 'open', 'academic', 'academy',
  'university', 'group', 'institute', 'institutes', 'inc', 'ltd', 'co',
]);

/** True if `needle`'s tokens appear as a contiguous, order-preserving run inside `hay`'s. */
function tokensContainSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

/**
 * Whole-word, order-preserving publisher-name match in EITHER direction, with a
 * guard against matching on a single generic word.
 *
 * Replaces the old `a.includes(b) || b.includes(a)` raw-substring test, which
 * produced false positives on partial words — e.g. a legitimate publisher
 * "SciTechnology Publications" matched the Beall's entry "SciTechnol" because
 * "scitechnol" is a prefix of "scitechnology", wrongly branding it predatory
 * (D3 — the worst error class for an integrity tool). Whole-word containment
 * keeps the legitimate cases the substring test was reaching for — a distinctive
 * single-word entry ("SciTechnol", "Pubicon") still matches when it appears as a
 * full token, and a short form ("Royal Society" within "Royal Society of
 * Chemistry") still matches — while a partial-word overlap no longer does.
 */
export function publisherNameMatches(a: string, b: string): boolean {
  const ta = publisherTokens(a);
  const tb = publisherTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length === 1 && GENERIC_PUBLISHER_TOKENS.has(short[0])) return false;
  return tokensContainSequence(long, short);
}

/**
 * Check if publisher is in Beall's List
 */
export function checkBeallsList(publisher: string): boolean {
  if (!publisher) return false;
  const beallsList = loadBeallsList();
  return beallsList.publishers.some(predatoryPub =>
    publisherNameMatches(publisher, predatoryPub),
  );
}

/**
 * Check if publisher is known to be legitimate
 */
export function isKnownLegitimate(publisher: string): boolean {
  if (!publisher) return false;
  const beallsList = loadBeallsList();
  return beallsList.knownLegitimatePublishers.some(legitPub =>
    publisherNameMatches(publisher, legitPub),
  );
}
