import { distance } from 'fastest-levenshtein';
import type { ReferenceInput } from '../types.js';
import type { DeduplicationConfig } from './types.js';
import { foldForMatch, splitAuthorList } from '../util/normalize.js';

/**
 * Normalize author name for comparison
 * "Smith, J." -> "smith j"
 * "Müller, K." -> "muller k"   (accents folded, 2026-11-18)
 * "Иванов, И." -> "иванов и"   (non-Latin letters kept, 2026-11-18)
 *
 * The earlier rule deleted every character outside a-z, so "Müller" became "m ller" and a
 * Cyrillic or Chinese name became the empty string — read as "no author" (score 0.0).
 */
export function normalizeAuthorName(name: string): string {
  return foldForMatch(name);
}

/**
 * Average best-match similarity of every name in `from` against the names in
 * `to`. One-directional — see compareAuthors for why both directions are averaged.
 */
function authorListDirectionalSimilarity(from: string[], to: string[]): number {
  let total = 0;
  for (const a of from) {
    let best = 0;
    for (const b of to) {
      const maxLen = Math.max(a.length, b.length);
      if (maxLen === 0) continue;
      best = Math.max(best, 1 - distance(a, b) / maxLen);
    }
    total += best;
  }
  return from.length > 0 ? total / from.length : 0;
}

/**
 * Compare two author lists and return similarity score (0-1).
 *
 * Symmetric: `compareAuthors(a, b) === compareAuthors(b, a)`. The earlier
 * implementation averaged best-matches over list 1 only, so the score depended
 * on argument order whenever the two lists differed in length (D9) — e.g.
 * ["Smith"] vs ["Smith", "Jones"] scored 1.0 one way and ~0.6 the other, making
 * dedup similarity non-deterministic with respect to pair ordering. We now
 * average both directions, which penalizes an unmatched extra author regardless
 * of which argument it sits in.
 */
export function compareAuthors(
  authors1: string | readonly string[],
  authors2: string | readonly string[]
): number {
  // Split into individual author names. An array is already one entry per author; a
  // string goes through splitAuthorList, which keeps "Smith, J." as ONE author (the old
  // split on every comma made it two, so a list's score depended on how it was written).
  const authors1List = splitAuthorList(authors1).map(normalizeAuthorName).filter(a => a.length > 0);
  const authors2List = splitAuthorList(authors2).map(normalizeAuthorName).filter(a => a.length > 0);

  if (authors1List.length === 0 || authors2List.length === 0) {
    // If both are missing, consider it a neutral match (0.5); if only one is, low.
    return authors1List.length === 0 && authors2List.length === 0 ? 0.5 : 0.0;
  }

  // Average both directions so the score is order-independent (commutative).
  return (
    authorListDirectionalSimilarity(authors1List, authors2List) +
    authorListDirectionalSimilarity(authors2List, authors1List)
  ) / 2;
}

/**
 * Compare two titles and return similarity score (0-1)
 * Uses Levenshtein distance normalized by title length
 */
export function compareTitle(title1: string, title2: string): number {
  if (!title1 || !title2) {
    // If both are missing, consider it a neutral match (0.5)
    if (!title1 && !title2) return 0.5;
    // If only one is missing, low similarity
    return 0.0;
  }

  // Normalize titles
  // Unicode-aware fold (2026-11-18): the ASCII-only rule emptied every non-Latin title,
  // so two identical Russian titles scored 0.0.
  const norm1 = foldForMatch(title1);
  const norm2 = foldForMatch(title2);

  if (norm1.length === 0 || norm2.length === 0) {
    return norm1.length === 0 && norm2.length === 0 ? 0.5 : 0.0;
  }

  // Calculate Levenshtein distance
  const maxLen = Math.max(norm1.length, norm2.length);
  const dist = distance(norm1, norm2);

  // Convert to similarity score (1 = identical, 0 = completely different)
  return 1 - (dist / maxLen);
}

/**
 * Compare years and return similarity score (0-1)
 */
export function compareYear(
  year1: string | number | null | undefined,
  year2: string | number | null | undefined
): number {
  // The 0.2.x year rule, kept as it was (2026-11-19): a shared year reader regressed against
  // it in review (e.g. "1781/1998" no longer matched "1781"); the redesign waits for a
  // release of its own.
  if (!year1 || !year2) {
    // If both are missing, neutral match
    if (!year1 && !year2) return 0.5;
    // If only one is missing, low similarity
    return 0.0;
  }

  // Extract year numbers
  const y1 = parseInt(year1.toString(), 10);
  const y2 = parseInt(year2.toString(), 10);

  if (isNaN(y1) || isNaN(y2)) {
    return 0.0;
  }

  // Exact match = 1.0, off by 1 = 0.5, off by 2+ = 0.0
  if (y1 === y2) return 1.0;
  if (Math.abs(y1 - y2) === 1) return 0.5;
  return 0.0;
}

/**
 * Score metadata completeness for a reference (0-1)
 * Higher score = more complete metadata
 */
export function scoreMetadataCompleteness(ref: ReferenceInput): number {
  let score = 0;
  let totalFields = 0;

  // Check critical fields
  if (ref.normalized_title) {
    score += 1;
  }
  totalFields += 1;

  if (ref.normalized_authors && ref.normalized_authors.length > 0) {
    score += 1;
  }
  totalFields += 1;

  if (ref.normalized_year) {
    score += 1;
  }
  totalFields += 1;

  // Check additional fields
  if (ref.doi) {
    score += 0.5;
  }
  totalFields += 0.5;

  if (ref.parsed_data?.source) {
    score += 0.5;
  }
  totalFields += 0.5;

  if (ref.parsed_data?.volume) {
    score += 0.25;
  }
  totalFields += 0.25;

  if (ref.parsed_data?.pages) {
    score += 0.25;
  }
  totalFields += 0.25;

  return totalFields > 0 ? score / totalFields : 0;
}

/**
 * Calculate similarity between two references
 */
export function calculateSimilarity(
  ref1: ReferenceInput,
  ref2: ReferenceInput,
  config: DeduplicationConfig
): number {
  // Get normalized data
  // Passed as arrays: joining with ", " and splitting again read "Smith, J." as two people.
  const authors1 = ref1.normalized_authors ?? [];
  const authors2 = ref2.normalized_authors ?? [];
  const title1 = ref1.normalized_title || '';
  const title2 = ref2.normalized_title || '';
  const year1 = ref1.normalized_year;
  const year2 = ref2.normalized_year;

  // Calculate component similarities
  const authorSim = compareAuthors(authors1, authors2);
  const titleSim = compareTitle(title1, title2);
  const yearSim = compareYear(year1, year2);

  // Calculate year weighting (derived from other weights)
  const yearWeighting = 1.0 - config.authorWeighting - config.titleWeighting;

  // Weighted average
  const similarity =
    authorSim * config.authorWeighting +
    titleSim * config.titleWeighting +
    yearSim * yearWeighting;

  return similarity;
}
