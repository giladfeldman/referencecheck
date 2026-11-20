import { distance } from 'fastest-levenshtein';
import type { ReferenceInput } from '../types.js';
import type { DeduplicationConfig } from './types.js';
import { cleanDoiInput, DOI_SHAPE, foldForMatch, parseName, splitAuthorList } from '../util/normalize.js';
import type { ParsedName } from '../util/normalize.js';
import { doiWithoutVersion } from '../doi/doiShape.js';
import {
  crossScript, isParticle, looseInitial, looseSurnameMatch, sameSurname, scriptsComparable, surnameKey,
} from '../util/surnames.js';

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

interface AuthorEntry { folded: string; name: ParsedName }

/** One reading of a name: a surname and the given names as initial letters or full words. */
interface Reading { surname: string; items: string[] }

function itemsOf(name: ParsedName): string[] {
  return name.given ? name.given.split(' ').filter(Boolean) : [...name.initials];
}

/**
 * The readings of a name. A name whose order is known has one. A name whose order is
 * unknown ("wang wei", "John Smith", a folded multi-word surname) has every split into
 * surname and given names, either way round, plus the whole name as a surname.
 */
function readings(name: ParsedName): Reading[] {
  if (name.order === 'known') return [{ surname: name.surname, items: itemsOf(name) }];
  return unknownReadings(name);
}

/**
 * The second reading of a name written surname first with no comma, two words and then
 * initials ("Garcia Marquez G", "Bazhin Alexandr V", "smith john a"): the two words may be a
 * surname of two words, or a surname and a given name. parseName keeps the two-word
 * surname (the Vancouver form); this is the other reading, scored as a name of unknown
 * order (round 11).
 */
function secondReading(name: ParsedName): Reading | null {
  if (name.order !== 'known' || name.given !== undefined || !name.initials || name.raw.includes(',')) return null;
  const w = name.surname.split(' ').filter(Boolean);
  if (w.length !== 2 || isParticle(w[0])) return null;
  return { surname: w[0], items: [w[1], ...name.initials] };
}

function unknownReadings(name: ParsedName): Reading[] {
  const w = name.surname.split(' ').filter(Boolean);
  const out: Reading[] = [{ surname: w.join(' '), items: [] }];
  for (let k = 1; k < w.length; k++) {
    out.push({ surname: w.slice(k).join(' '), items: w.slice(0, k) });
    out.push({ surname: w.slice(0, k).join(' '), items: w.slice(k) });
  }
  return out;
}

type GivenRelation = 'compatible' | 'one_absent' | 'both_absent' | 'conflict';

/**
 * Given names position by position: an initial matches a name with that first letter
 * ("J" / "John" / "JA"), two full names must be equal ("John" / "Jane" conflict), and a
 * shorter list is a prefix of the longer one. Across scripts only first letters are
 * compared, through the loose romanisation.
 */
function compareGiven(a: string[], b: string[], cross: boolean): GivenRelation {
  if (a.length === 0 && b.length === 0) return 'both_absent';
  if (a.length === 0 || b.length === 0) return 'one_absent';
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    const same = cross
      ? looseInitial(x) === looseInitial(y)
      : x.length > 1 && y.length > 1 ? x === y : x[0] === y[0];
    if (!same) return 'conflict';
  }
  return 'compatible';
}

/** The per-name levels (see compareAuthors) for one reading of each name. */
function readingScore(a: Reading, b: Reading): number {
  if (!a.surname || !b.surname || !scriptsComparable(a.surname, b.surname)) return 0;
  const cross = crossScript(a.surname, b.surname);
  const given = compareGiven(a.items, b.items, cross);
  const equal = cross ? looseSurnameMatch(a.surname, b.surname) : sameSurname(a.surname, b.surname);
  if (equal) {
    if (given === 'compatible' || given === 'both_absent') return 1.0;
    return given === 'one_absent' ? 0.75 : 0.5;
  }
  if (!cross && given !== 'conflict') {
    const ka = surnameKey(a.surname);
    const kb = surnameKey(b.surname);
    if (ka.length >= 5 && kb.length >= 5 && ratio(ka, kb) >= 0.85 && !oneTrailingLetter(ka, kb)) return 0.75;
  }
  return 0;
}

/**
 * The longer key is the shorter plus one letter at the end ("obrien" / "obrienz", "wangli" /
 * "wanglin"): a stray initial or a given name one letter longer, not a misspelt surname.
 */
function oneTrailingLetter(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.length === s.length + 1 && l.startsWith(s);
}

function isSurnameEqual(a: Reading, b: Reading): boolean {
  if (!a.surname || !b.surname || !scriptsComparable(a.surname, b.surname)) return false;
  return crossScript(a.surname, b.surname) ? looseSurnameMatch(a.surname, b.surname) : sameSurname(a.surname, b.surname);
}

function authorEntry(name: string): AuthorEntry {
  return { folded: foldForMatch(name), name: parseName(name) };
}

function ratio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 0 : 1 - distance(a, b) / maxLen;
}

/**
 * Two names, by level (not by edit distance over the whole name, which made an initial's
 * weight depend on the surname's length):
 *
 * | comparison | score |
 * |---|---|
 * | written identically after folding | 1.0 |
 * | surname equal, given names compatible (J / JA / John) or absent on both sides | 1.0 |
 * | surname equal, one side has no given name | 0.75 |
 * | order unknown on a side, and one reading is compatible ("Wang Wei" / "Wei, W.") | 0.75 (never more) |
 * | surname equal, a given name or initial conflicts (J / K, John / Jane) | 0.5 |
 * | surname near (edit ratio >= 0.85, both keys >= 5 letters), given names not conflicting | 0.75 |
 * | otherwise, or the two scripts cannot be compared (Han / Latin) | 0 |
 *
 * "Surname equal": same key (folded, spaces/hyphens/apostrophes removed), or equal once
 * leading particles are dropped from one side ("van der berg" / "berg"); across Latin,
 * Cyrillic and Greek, the loose romanisation ("Иванов" / "Ivanova").
 */
function authorSimilarity(a: AuthorEntry, b: AuthorEntry): number {
  if (a.folded === b.folded) return 1.0;
  const score = (ra: Reading[], rb: Reading[]): number => {
    // When some reading of each name has the same surname, the given names decide: a near
    // surname from another reading never outscores them ("Maria Garcia" / "Mario Garcia" is
    // Garcia with conflicting given names, 0.5; not the near whole names "mariagarcia" /
    // "mariogarcia", round 11).
    let bestEqual = -1;
    let best = 0;
    for (const x of ra) {
      for (const y of rb) {
        const s = readingScore(x, y);
        if (isSurnameEqual(x, y)) bestEqual = Math.max(bestEqual, s);
        best = Math.max(best, s);
      }
    }
    return bestEqual >= 0 ? bestEqual : best;
  };
  const first = score(readings(a.name), readings(b.name));
  const sure = a.name.order === 'unknown' || b.name.order === 'unknown' ? Math.min(first, 0.75) : first;
  if (sure >= 0.75) return sure;
  // The other reading of a "Garcia Marquez G" name, at most 0.75 (its order is not shown).
  const altA = secondReading(a.name);
  const altB = secondReading(b.name);
  if (!altA && !altB) return sure;
  const ra = altA ? [...readings(a.name), altA] : readings(a.name);
  const rb = altB ? [...readings(b.name), altB] : readings(b.name);
  return Math.max(sure, Math.min(score(ra, rb), 0.75));
}

/**
 * Average best-match similarity of every name in `from` against the names in
 * `to`. One-directional — see compareAuthors for why both directions are averaged.
 */
function authorListDirectionalSimilarity(from: AuthorEntry[], to: AuthorEntry[]): number {
  let total = 0;
  for (const a of from) {
    let best = 0;
    for (const b of to) {
      best = Math.max(best, authorSimilarity(a, b));
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
 *
 * Prefix rule (0.3.0): a list that is a prefix of the other (a reference that names
 * only the first author or two, with or without "et al.") scores the mean of the
 * positional pairs when every positional pair scores at least 0.75; the result is the
 * larger of that and the symmetric average. Still symmetric.
 */
export function compareAuthors(
  authors1: string | readonly string[],
  authors2: string | readonly string[]
): number {
  // Split into individual author names: strings and every array element go through
  // splitAuthorList, which keeps "Smith, J." as ONE author (the old split on every comma
  // made it two, so a list's score depended on how it was written). Each name is then
  // read once by parseName and scored by level (authorSimilarity).
  const authors1List = splitAuthorList(authors1).map(authorEntry).filter(a => a.folded.length > 0);
  const authors2List = splitAuthorList(authors2).map(authorEntry).filter(a => a.folded.length > 0);

  if (authors1List.length === 0 || authors2List.length === 0) {
    // If both are missing, consider it a neutral match (0.5); if only one is, low.
    return authors1List.length === 0 && authors2List.length === 0 ? 0.5 : 0.0;
  }

  // Average both directions so the score is order-independent (commutative).
  const both = (
    authorListDirectionalSimilarity(authors1List, authors2List) +
    authorListDirectionalSimilarity(authors2List, authors1List)
  ) / 2;
  return Math.max(both, prefixListSimilarity(authors1List, authors2List));
}

/**
 * A shorter list that is the start of the longer one ("Smith, J." or "Smith, J., et al."
 * against the full list): the reference listed only its first author(s). Scored as the
 * shorter list against the same positions of the longer one, each name at least 0.75 (the
 * first author must match); 0 otherwise. Owner default, round 11: the first author alone
 * merges with the full list. Symmetric in its arguments.
 */
function prefixListSimilarity(a: AuthorEntry[], b: AuthorEntry[]): number {
  if (a.length === b.length) return 0;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let total = 0;
  for (let i = 0; i < short.length; i++) {
    const s = authorSimilarity(short[i], long[i]);
    if (s < 0.75) return 0;
    total += s;
  }
  return total / short.length;
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
    // Both titles present but made only of symbols ("???", "∑∫"): equal or not, never the
    // neutral 0.5 that two ABSENT titles get (review 2026-11-19).
    if (norm1.length === 0 && norm2.length === 0) return title1.trim() === title2.trim() ? 1.0 : 0.0;
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
  // A DOI counts only when it is one (a junk `doi` such as "n/a" is not).
  if (comparableDoi(ref)) {
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
 * A reference's DOI for comparison: cleaned, lower-cased; '' when it is not a DOI. Round 11
 * (owner default): what a link adds after the DOI is dropped ("/full", "/pdf", "/epdf",
 * "/abstract", a query string or a fragment), and so is a preprint version ("v2" ending under a
 * registrant that mints one DOI per version, `VERSIONED_DOI_REGISTRANTS`): versions of one
 * preprint are one work. A preprint and its published version carry different DOIs and
 * stay different.
 */
function comparableDoi(ref: ReferenceInput): string {
  let d = cleanDoiInput(ref.doi).toLowerCase();
  if (!DOI_SHAPE.test(d)) return '';
  d = d.replace(/[?#].*$/, '');
  d = d.replace(/\/(?:full|pdf|epdf|abstract)\/?$/, '');
  // A version suffix is dropped only for registrants that version that way (the table in
  // doiShape.ts); elsewhere `10.5555/a.v1` and `.v2` are two works.
  d = doiWithoutVersion(d);
  return DOI_SHAPE.test(d) ? d : '';
}

/** `same` / `different` by DOI alone, `null` unless both references carry one. */
function doiIdentity(ref1: ReferenceInput, ref2: ReferenceInput): 'same' | 'different' | null {
  const d1 = comparableDoi(ref1);
  const d2 = comparableDoi(ref2);
  if (!d1 || !d2) return null;
  return d1 === d2 ? 'same' : 'different';
}

/**
 * How two references' DOIs relate (see {@link calculateSimilarity}):
 *  - `same`: both carry the same DOI (after `cleanDoiInput`, case, a link tail and a preprint
 *    version are ignored), and their metadata does not contradict it;
 *  - `same-contradicted`: the same DOI, but the author score AND the title-word share are below
 *    {@link SAME_DOI_CONTRADICTION} (another work's metadata under one DOI: a DOI copied onto
 *    the wrong reference). Not forced to 1; the weighted score decides;
 *  - `different`: both carry a DOI and they differ;
 *  - `null`: at least one carries no well-formed DOI.
 */
export type DoiRelation = 'same' | 'same-contradicted' | 'different' | null;

/**
 * Under this author score AND this title-word share, one DOI on two references is
 * contradicted (owner default, round 11). The author score is `compareAuthors`. The title
 * share is the share of the shorter title's words (3+ letters) found in the other title,
 * not the edit-distance `compareTitle`: two unrelated titles of similar length score 0.3-0.4
 * by edit distance (shared letters), but share no words, while a title shortened to its
 * first words keeps a share of 1. Both sides must have authors and titles in one script;
 * otherwise there is no contradiction to see.
 */
export const SAME_DOI_CONTRADICTION = 0.3;

function titleWordShare(t1: string, t2: string): number {
  const words = (t: string) => new Set(foldForMatch(t).split(' ').filter((w) => [...w].length >= 3));
  const a = words(t1);
  const b = words(t2);
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  if (s.size === 0) return 1;
  let n = 0;
  for (const w of s) if (l.has(w)) n++;
  return n / s.size;
}

function sameDoiContradicted(ref1: ReferenceInput, ref2: ReferenceInput, authorSim: number): boolean {
  const t1 = ref1.normalized_title || '';
  const t2 = ref2.normalized_title || '';
  if (!(ref1.normalized_authors?.length) || !(ref2.normalized_authors?.length) || !t1 || !t2) return false;
  if (!scriptsComparable(foldForMatch(t1), foldForMatch(t2)) || crossScript(foldForMatch(t1), foldForMatch(t2))) return false;
  return authorSim < SAME_DOI_CONTRADICTION && titleWordShare(t1, t2) < SAME_DOI_CONTRADICTION;
}

export function doiRelation(ref1: ReferenceInput, ref2: ReferenceInput): DoiRelation {
  const identity = doiIdentity(ref1, ref2);
  if (identity !== 'same') return identity;
  const authorSim = compareAuthors(ref1.normalized_authors ?? [], ref2.normalized_authors ?? []);
  return sameDoiContradicted(ref1, ref2, authorSim) ? 'same-contradicted' : 'same';
}

/** Fallback merge threshold for the different-DOI cap when the config carries none. */
const DEFAULT_THRESHOLD = 0.85;

/**
 * Calculate similarity between two references.
 *
 * Identifiers first: when both references carry a DOI (`doi`, read with `cleanDoiInput`,
 * case-insensitive, a link tail such as "/full" and a preprint version such as "v2"
 * ignored), the same DOI is the same work (similarity 1.0) and two different DOIs are two
 * works, so the weighted score is capped strictly below `config.threshold` (below 0.85 when
 * the config has no numeric threshold): a preprint and its published version, which carry
 * different DOIs, are not scored as one however alike their metadata. One exception: the
 * same DOI on two references whose authors AND titles both score below
 * {@link SAME_DOI_CONTRADICTION} is not forced to 1 (`doiRelation` says
 * `same-contradicted`); the weighted score decides. Otherwise the weighted
 * author/title/year score.
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

  const dois = doiIdentity(ref1, ref2);

  // Calculate component similarities
  const authorSim = compareAuthors(authors1, authors2);
  const titleSim = compareTitle(title1, title2);
  if (dois === 'same' && !sameDoiContradicted(ref1, ref2, authorSim)) return 1.0;
  const yearSim = compareYear(year1, year2);

  // Calculate year weighting (derived from other weights)
  const yearWeighting = 1.0 - config.authorWeighting - config.titleWeighting;

  // Weighted average
  const similarity =
    authorSim * config.authorWeighting +
    titleSim * config.titleWeighting +
    yearSim * yearWeighting;

  if (dois === 'different') return Math.min(similarity, differentDoiCap(config));
  return similarity;
}

/** Strictly below the merge threshold: two different DOIs never reach it. */
function differentDoiCap(config: DeduplicationConfig): number {
  const t = typeof config?.threshold === 'number' && Number.isFinite(config.threshold) ? config.threshold : DEFAULT_THRESHOLD;
  return Math.max(0, t - 1e-6);
}
