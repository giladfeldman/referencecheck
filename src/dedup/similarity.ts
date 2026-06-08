import { distance } from 'fastest-levenshtein';
import type { ReferenceInput } from '../types.js';
import type { DeduplicationConfig } from './types.js';

/**
 * Normalize author name for comparison
 * "Smith, J." -> "smith j"
 * "Smith, John" -> "smith john"
 */
export function normalizeAuthorName(name: string): string {
  if (!name) return '';

  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // Remove punctuation
    .replace(/\s+/g, ' ')          // Normalize spaces
    .trim();
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
export function compareAuthors(authors1: string, authors2: string): number {
  if (!authors1 || !authors2) {
    // If both are missing, consider it a neutral match (0.5)
    if (!authors1 && !authors2) return 0.5;
    // If only one is missing, low similarity
    return 0.0;
  }

  // Split into individual author names
  const authors1List = authors1.split(/[,;]/).map(normalizeAuthorName).filter(a => a.length > 0);
  const authors2List = authors2.split(/[,;]/).map(normalizeAuthorName).filter(a => a.length > 0);

  if (authors1List.length === 0 || authors2List.length === 0) {
    return 0.0;
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
  const norm1 = title1.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const norm2 = title2.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  if (norm1.length === 0 || norm2.length === 0) {
    return 0.0;
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
export function compareYear(year1: string | null | undefined, year2: string | null | undefined): number {
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
  const authors1 = ref1.normalized_authors?.join(', ') || '';
  const authors2 = ref2.normalized_authors?.join(', ') || '';
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
