/**
 * Crossref API Integration
 * DOI validation and lookup using Crossref APIs
 */

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { formatError } from '../util/formatError.js';
import type { MetadataCredentials } from './credentials.js';
import { DEFAULT_POLITE_EMAIL } from './credentials.js';
import { cleanDoiInput, foldForMatch, formatDateParts } from '../util/normalize.js';
import {
  NAME_PARTICLES, crossScript, looseSurnameMatch, sameSurname, scriptOf, scriptsComparable,
} from '../util/surnames.js';

export interface CrossrefResult {
  found: boolean;
  doi?: string;
  title?: string;
  authors?: string[];
  publishedDate?: string;
  journal?: string;
  score: number;
  rawData?: any;
  /**
   * Set only on a result of the DOI search (findDOIFromReference / -Detailed): how the
   * accepted candidate compared with the reference. `not_comparable` means the check had
   * nothing to compare and did not reject; it is never reported as `matched`.
   */
  authorCheck?: DoiMatchCheck;
  yearCheck?: DoiMatchCheck;
  titleCheck?: DoiMatchCheck;
}

const CROSSREF_API = 'https://api.crossref.org/works';
const SIMPLE_TEXT_QUERY_API = 'https://doi.crossref.org/simpleTextQuery';

/** In-memory DOI validation cache (SP3). Avoids re-fetching the same DOI across re-uploads/re-processes within one worker session. */
const doiValidationCache = new Map<string, { result: any; timestamp: number }>();
const DOI_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get Crossref email from credentials (for polite pool)
 */
function getCrossrefEmail(creds?: MetadataCredentials): string {
  return creds?.crossrefEmail || DEFAULT_POLITE_EMAIL;
}

/**
 * Polite-pool User-Agent header that Crossref's polite pool requires for
 * higher rate limits. Every Crossref request from the worker MUST go through
 * this header (use the `crossrefGet` helper below — do not call `axios.get`
 * against api.crossref.org directly).
 */
export function getCrossrefUserAgent(creds?: MetadataCredentials): string {
  return `Scimeto/1.0 (mailto:${getCrossrefEmail(creds)})`;
}

/**
 * Shared Crossref GET with polite-pool UA and retry on 429/502/503/504.
 *
 * - 429 honors the Retry-After header (seconds). Falls back to exponential
 *   backoff if absent. Caps the wait per attempt at 30s.
 * - 502/503/504 wait 2s, then 4s, before the next attempt (other 5xx are not retried).
 * - Up to 3 attempts. After exhausting retries, throws the last error so
 *   callers can decide how to surface the failure.
 *
 * Use this for every Crossref request from the worker. The four other call
 * sites (citationRepliesService, preprintDetectionService, expressionOfConcern,
 * retractionChecker) bypassed retries before; routing them through here is
 * what stops Nature/high-traffic-journal stress runs from cascading 429s.
 */
export async function crossrefGet<T = any>(
  url: string,
  config: AxiosRequestConfig = {},
  creds?: MetadataCredentials
): Promise<AxiosResponse<T>> {
  const maxAttempts = 3;
  const headers = {
    'User-Agent': getCrossrefUserAgent(creds),
    Accept: 'application/json',
    ...(config.headers ?? {}),
  };

  let lastError: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await axios.get<T>(url, { timeout: 10000, ...config, headers });
    } catch (err: any) {
      lastError = err;
      const status = err?.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status === 502 || status === 503 || status === 504;
      if (!(isRateLimit || isServerError) || attempt === maxAttempts - 1) {
        throw err;
      }

      let delayMs: number;
      if (isRateLimit) {
        const retryAfterRaw = err.response?.headers?.['retry-after'];
        const retryAfterSec = retryAfterRaw ? parseInt(String(retryAfterRaw), 10) : NaN;
        delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 30000)
          : Math.min(2000 * Math.pow(2, attempt), 30000);
        console.warn(
          `Crossref 429 for ${url} — backing off ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
      } else {
        delayMs = 2000 * (attempt + 1);
        console.warn(
          `Crossref ${status} for ${url} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * Validate a DOI by checking if it exists in Crossref
 * Falls back to DOI resolver (doi.org) if Crossref doesn't have it
 */
export async function validateDOI(doi: string, creds?: MetadataCredentials): Promise<{
  valid: boolean;
  data?: CrossrefResult;
  error?: string;
  source?: 'crossref' | 'resolver';
}> {
  try {
    // Clean DOI (remove https://doi.org/ prefix if present)
    const cleanDOI = cleanDoiInput(doi);

    // Check in-memory cache first (SP3)
    const cacheKey = cleanDOI.toLowerCase();
    const cached = doiValidationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < DOI_CACHE_TTL_MS) {
      return cached.result;
    }

    // First, try Crossref API (retry on 429/502/503/504 via shared helper)
    let crossrefError: any;
    try {
      const response = await crossrefGet(`${CROSSREF_API}/${encodeURIComponent(cleanDOI)}`, {}, creds);
      if (response.status === 200) {
        const data = response.data;
        const message = data.message;

        const validResult = {
          valid: true,
          source: 'crossref' as const,
          data: toCrossrefResult(message, 100),
        };
        doiValidationCache.set(cacheKey, { result: validResult, timestamp: Date.now() });
        return validResult;
      }
    } catch (err: any) {
      crossrefError = err;
    }

    try {
      // If Crossref returns 404, try DOI resolver as fallback
      if (crossrefError?.response?.status === 404) {
        console.log(`DOI ${cleanDOI} not found in Crossref, checking DOI resolver...`);

        // Fallback: Check if DOI resolves via doi.org
        try {
          const resolverResponse = await axios.head(`https://doi.org/${encodeURIComponent(cleanDOI)}`, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500, // Accept redirects (3xx) and client errors (4xx) as valid responses
          });

          // If we get a redirect (3xx) or success (2xx), the DOI exists
          // If we get 404, the DOI doesn't exist
          if (resolverResponse.status >= 200 && resolverResponse.status < 400) {
            console.log(`DOI ${cleanDOI} resolves via doi.org (status: ${resolverResponse.status})`);
            return {
              valid: true,
              source: 'resolver',
              data: {
                found: true,
                doi: cleanDOI,
                score: 50, // Lower score since we don't have full metadata
              },
            };
          } else {
            return { valid: false, error: 'DOI not found in Crossref and does not resolve via DOI resolver' };
          }
        } catch (resolverError: any) {
          // If resolver also fails, DOI is likely invalid
          console.warn(`DOI resolver check failed for ${cleanDOI}:`, resolverError.message);
          return { valid: false, error: 'DOI not found in Crossref and does not resolve' };
        }
      }

      // For other Crossref errors (including 503 after retries), return the error
      console.error('DOI validation error:', crossrefError?.message ?? crossrefError);
      return { valid: false, error: formatError(crossrefError, 'Crossref API') };
    } catch (_) {
      throw crossrefError;
    }
  } catch (error: any) {
    console.error('Unexpected DOI validation error:', error.message);
    return { valid: false, error: formatError(error, 'Crossref validation') };
  }

  return { valid: false, error: 'DOI validation failed' };
}

/**
 * Check if reference text indicates an unpublishable work that typically doesn't have a DOI
 * (theses, dissertations, unpublished manuscripts, personal communications, etc.)
 */
function isUnpublishableWork(referenceText: string): boolean {
  const lowerText = referenceText.toLowerCase();
  const unpublishablePatterns = [
    /\b(doctoral|master'?s?|phd|honours?|honors?)\s*(dissertation|thesis)\b/i,
    /\bunpublished\s*(manuscript|manual|report|paper|work)\b/i,
    /\b(thesis|dissertation)\b.*\buniversity\b/i,
    /\[unpublished\]/i,
    /\[thesis\]/i,
    /\[dissertation\]/i,
    /\bpersonal\s+communication\b/i,
    /\bin\s+preparation\b/i,
    /\bsubmitted\s+for\s+publication\b/i,
    /\bunder\s+review\b/i,
    /\bmanuscript\s+in\s+preparation\b/i,
  ];

  return unpublishablePatterns.some(pattern => pattern.test(lowerText));
}

/**
 * Extract year from reference text
 */
function extractYearFromReference(referenceText: string): number | null {
  // The 0.2.x rule, kept as it was (2026-11-19). A new shared reader was tried in this
  // release and read a wrong year where this rule read the right one (dates with a later
  // access year, numbers glued to letters, dated parentheticals in titles), and a wrong
  // year rejects the right DOI. The redesign waits for a release of its own.
  // Common patterns: (2019), 2019., (2019a), etc.
  const yearPatterns = [
    /\((\d{4})[a-z]?\)/,  // (2019) or (2019a)
    /\b(19\d{2}|20\d{2})\b/,  // standalone year
  ];

  for (const pattern of yearPatterns) {
    const match = referenceText.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Particles as a regex alternation: lower-case only (Vancouver lists write "van der Berg JH")
 * or with either first-letter case (APA writes "Van Dyke, J." and "de la Cruz, M.").
 */
const PARTICLE = `(?:${NAME_PARTICLES.join('|')})`;
const PARTICLE_ANY_CASE = `(?:${NAME_PARTICLES.map((w) => `[${w[0]}${w[0].toUpperCase()}]${w.slice(1)}`).join('|')})`;

/**
 * Vancouver / NLM author lists ("Hoddy KK, Gibbons C, et al. Title."): a surname, then
 * capital initials with no comma between them. Read from the start of the reference up to
 * the first ". "; empty unless the FIRST entry has that shape. The APA pattern below read
 * "Hoddy KK, Gibbons C" as surname "KK" (d-e977e3). A surname needs a lower-case letter, so
 * initials are never one. Only lower-case name particles ("van der Berg JH") may stand
 * before it, and they are part of the surname read: any word allowed there read
 * "Hoddy KK Gibbons C." as surname "Gibbons".
 */
const VANCOUVER_ENTRY = new RegExp(`^((?:${PARTICLE}\\s+)*\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*)\\s+\\p{Lu}(?:-?\\p{Lu}){0,2}$`, 'u');
function vancouverSurnames(section: string): string[] {
  const list = section.split(/\.\s/)[0];
  const out: string[] = [];
  for (const piece of list.split(/\s*,\s*/).filter(Boolean)) {
    if (/^et al\.?$/i.test(piece)) continue;
    const m = piece.match(VANCOUVER_ENTRY);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

/**
 * "Surname, I." with the surname's particles and further words: "Van Dyke, J." gives
 * "Van Dyke", "de la Cruz, M." gives "de la Cruz", "Garcia Marquez, G." gives "Garcia
 * Marquez" (one word only used to be read, so "Van Dyke" became "Dyke" and failed against
 * Crossref "VanDyke"). Unicode letters (2026-11-18): the ASCII class stopped at the first
 * accent, so "Müller, K." yielded no surname and the author check was silently skipped.
 */
const SURNAME = `(?:${PARTICLE_ANY_CASE}\\s+)*\\p{Lu}[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*){0,2}`;
const APA_AUTHOR = new RegExp(`(?<![\\p{L}'’-])(${SURNAME})(?:\\s*,\\s*\\p{Lu}\\.?)+`, 'gu');
const LEADING_SURNAME = new RegExp(`^(${SURNAME})`, 'u');

/**
 * Extract author last names from reference text (simplified extraction), as written
 * (not folded: validateDOIMatch needs the script and the digraph spelling).
 */
function extractAuthorsFromReference(referenceText: string): string[] {
  // Common patterns for authors at start of reference
  // e.g., "Smith, J. A., & Jones, B. C. (2019)" or "Smith, J.A. (2019)"
  const beforeYear = referenceText.split(/\(\d{4}/)[0] || '';
  const authorSection = beforeYear.trim();
  const vancouver = vancouverSurnames(authorSection);
  if (vancouver.length > 0) return vancouver;

  const lastNames = [...authorSection.matchAll(APA_AUTHOR)].map((m) => m[1]);
  // Also try simpler pattern for single author or non-standard format
  if (lastNames.length === 0) {
    const simpleMatch = authorSection.match(LEADING_SURNAME);
    if (simpleMatch) lastNames.push(simpleMatch[1]);
  }
  return lastNames;
}

/** The German digraph spelling ("Müller" -> "Mueller"), so either spelling matches the other. */
const DIGRAPH: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue' };
function spellings(name: string): string[] {
  const digraph = name.normalize('NFC').replace(/[äöüÄÖÜ]/g, (c) => DIGRAPH[c] ?? c);
  return digraph === name ? [name] : [name, digraph];
}

/** "smith" is a whole word of "smith jones"; "li" is not a word of "williams". */
function isWholeWordOf(single: string, multi: string): boolean {
  const s = foldForMatch(single);
  return s.length > 0 && !s.includes(' ') && foldForMatch(multi).split(' ').includes(s);
}

/**
 * One reference surname against one Crossref surname: `true` (same surname), `false`
 * (different), or `null` when the two scripts cannot be compared (Han, Arabic ... against
 * Latin). Same script: equal keys (folded; spaces, hyphens and apostrophes removed, so
 * "Van Dyke" = "VanDyke", "O'Brien" = "OBrien"), equal once one side's leading particles
 * are dropped ("van der Berg" / "Berg"), or one is a whole word of the other ("Smith" /
 * "Smith-Jones"); never a substring ("Li" / "Williams", "Smith" / "Goldsmith"). The German
 * digraph spelling counts as the same name. Latin, Cyrillic and Greek against each other:
 * the loose romanisation ("Иванов" / "Ivanov" / "Ivanova", "Чайковский" / "Tchaikovsky").
 */
function surnamesMatch(ref: string, crossref: string): boolean | null {
  if (!scriptsComparable(ref, crossref)) return null;
  if (crossScript(ref, crossref)) return looseSurnameMatch(ref, crossref);
  for (const r of spellings(ref)) {
    for (const c of spellings(crossref)) {
      if (sameSurname(r, c) || isWholeWordOf(r, c) || isWholeWordOf(c, r)) return true;
    }
  }
  return false;
}

/**
 * The outcome of one check of a DOI candidate against the reference:
 *  - `matched`: the evidence agrees;
 *  - `mismatched`: the evidence disagrees (the candidate is rejected);
 *  - `not_comparable`: there was nothing to compare (no surname or year read from the
 *    reference, none in the Crossref record, or names or titles in scripts that cannot be
 *    compared). The candidate is not rejected for it, and the result says so.
 */
export type DoiMatchCheck = 'matched' | 'mismatched' | 'not_comparable';

interface MatchValidation {
  isValid: boolean;
  reason?: string;
  authorCheck: DoiMatchCheck;
  yearCheck: DoiMatchCheck;
  titleCheck: DoiMatchCheck;
}

/** Words that say nothing about which work a title names. */
const TITLE_STOPWORDS = new Set([
  'about', 'after', 'against', 'also', 'among', 'and', 'around', 'been', 'before', 'being', 'between',
  'both', 'does', 'down', 'during', 'each', 'for', 'from', 'have', 'into', 'more', 'most', 'much',
  'only', 'other', 'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'toward', 'towards', 'under', 'upon', 'versus', 'very',
  'what', 'when', 'where', 'which', 'while', 'with', 'within', 'without', 'your',
]);

/**
 * Share of the Crossref title's words that must occur in the reference text. Measured
 * 2026-11-19 on the labelled set (`tests/labelled/`): all 129 right pairs (the recorded
 * Crossref records rendered as references in ten shapes) share 1.0; the confusers with a
 * different title share 0.00-0.25, except one at 0.67 whose title words also occur in the
 * journal name ("Data Science"). 0.6 leaves room for a reference that drops a subtitle.
 */
const TITLE_MATCH_SHARE = 0.6;

/** The script most of a text's letters are written in. */
function majorityScript(text: string): string {
  const counts = new Map<string, number>();
  for (const c of text.match(/\p{L}/gu) ?? []) {
    const s = scriptOf(c);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  let best = 'none';
  let n = 0;
  for (const [s, k] of counts) if (k > n) { best = s; n = k; }
  return best;
}

/** The distinctive words of a Crossref title (title plus subtitle): folded, 4+ letters, no stopwords. */
function titleWords(title: string): string[] {
  const words = foldForMatch(title.replace(/<[^>]+>/g, ' ')).split(' ');
  return [...new Set(words.filter((w) => [...w].length >= 4 && !TITLE_STOPWORDS.has(w)))];
}

function crossrefTitle(item: any): string {
  return [item?.title?.[0], item?.subtitle?.[0]].filter((t): t is string => typeof t === 'string').join(' ');
}

/**
 * Title evidence: do the Crossref title's distinctive words occur in the reference text?
 * Fewer than two such words, or a title in another script than the reference (a Russian
 * reference to a record with an English title), is `not_comparable`.
 */
function checkTitle(referenceText: string, item: any): DoiMatchCheck {
  const title = crossrefTitle(item);
  const words = titleWords(title);
  if (words.length < 2) return 'not_comparable';
  if (majorityScript(title) !== majorityScript(referenceText)) return 'not_comparable';
  const refWords = new Set(foldForMatch(referenceText).split(' '));
  const share = words.filter((w) => refWords.has(w)).length / words.length;
  return share >= TITLE_MATCH_SHARE ? 'matched' : 'mismatched';
}

function crossrefYearOf(item: any): number | null {
  for (const key of ['published', 'published-online', 'published-print']) {
    const y = item?.[key]?.['date-parts']?.[0]?.[0];
    if (y) return y;
  }
  return null;
}

/**
 * Check a DOI candidate against the reference: year within one, at least one surname in
 * common, and the title's words present. A `mismatched` check rejects the candidate (year
 * first, then author, then title, for the reason given); a `not_comparable` one does not.
 */
function validateDOIMatch(referenceText: string, crossrefResult: any): MatchValidation {
  const refYear = extractYearFromReference(referenceText);
  const crossrefYear = crossrefYearOf(crossrefResult);
  // Year validation: must match within ±1 year (to account for in-press/early access)
  const yearCheck: DoiMatchCheck = !refYear || !crossrefYear
    ? 'not_comparable'
    : Math.abs(refYear - crossrefYear) > 1 ? 'mismatched' : 'matched';

  const refAuthors = extractAuthorsFromReference(referenceText);
  const crossrefAuthors: string[] = (crossrefResult.author || [])
    .map((a: any) => a?.family)
    .filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0);
  let authorCheck: DoiMatchCheck = 'not_comparable';
  if (refAuthors.length > 0 && crossrefAuthors.length > 0) {
    let incomparable = false;
    authorCheck = 'mismatched';
    for (const r of refAuthors) {
      for (const c of crossrefAuthors) {
        const m = surnamesMatch(r, c);
        if (m === true) authorCheck = 'matched';
        else if (m === null) incomparable = true;
      }
    }
    if (authorCheck !== 'matched' && incomparable) authorCheck = 'not_comparable';
  }

  const titleCheck = checkTitle(referenceText, crossrefResult);
  const checks = { authorCheck, yearCheck, titleCheck };

  if (yearCheck === 'mismatched') {
    return { isValid: false, reason: `Year mismatch: reference has ${refYear}, but DOI result has ${crossrefYear}`, ...checks };
  }
  if (authorCheck === 'mismatched') {
    return {
      isValid: false,
      reason: `Author mismatch: reference authors [${refAuthors.map(foldForMatch).join(', ')}] don't match DOI authors [${crossrefAuthors.map(foldForMatch).join(', ')}]`,
      ...checks,
    };
  }
  if (titleCheck === 'mismatched') {
    return { isValid: false, reason: `Title mismatch: the reference does not contain the words of "${crossrefTitle(crossrefResult)}"`, ...checks };
  }
  return { isValid: true, ...checks };
}

/** Why a Crossref candidate was not accepted as a reference's DOI. */
export interface RejectedDoiCandidate {
  doi: string;
  stage: 'simple_text_query' | 'search';
  reason: string;
  /** The three checks, when the candidate was checked (absent for "DOI did not validate"). */
  authorCheck?: DoiMatchCheck;
  yearCheck?: DoiMatchCheck;
  titleCheck?: DoiMatchCheck;
}

/**
 * The DOI search with its coverage stated (2026-11-18).
 *
 * `findDOIFromReference` returns `null` for four different things: no candidate matched,
 * the reference is a thesis or similar and was skipped, every candidate was rejected by the
 * author/year check, and Crossref could not be reached. A caller reporting "no DOI found"
 * could not tell them apart, and rejected candidates were only logged: a reject path with
 * no count. This variant says which it was and lists every rejected candidate.
 *
 * `status`:
 *  - `found`: `result` is the accepted match.
 *  - `no_match`: the search answered and nothing passed; see `rejected` and `belowScoreThreshold`.
 *  - `skipped_unpublishable`: not looked up (thesis, unpublished, in preparation, ...).
 *  - `lookup_failed`: the search stage never got an answer. NOT evidence that no DOI exists.
 */
export interface DoiSearchOutcome {
  result: CrossrefResult | null;
  status: 'found' | 'no_match' | 'skipped_unpublishable' | 'lookup_failed';
  rejected: RejectedDoiCandidate[];
  /** Search candidates dropped for a relevance score under 50, before any author/year check. */
  belowScoreThreshold: number;
  /** Errors from either stage, in order. The simple-text stage failing alone is not `lookup_failed`. */
  errors: string[];
  /**
   * Candidates (accepted and rejected) whose author, year or title check was
   * `not_comparable`: evidence the search could not use, counted so it is not silent.
   */
  notComparable: { author: number; year: number; title: number };
}

function countNotComparable(outcome: DoiSearchOutcome, v: MatchValidation): void {
  if (v.authorCheck === 'not_comparable') outcome.notComparable.author += 1;
  if (v.yearCheck === 'not_comparable') outcome.notComparable.year += 1;
  if (v.titleCheck === 'not_comparable') outcome.notComparable.title += 1;
}

function checksOf(v: MatchValidation): Pick<MatchValidation, 'authorCheck' | 'yearCheck' | 'titleCheck'> {
  return { authorCheck: v.authorCheck, yearCheck: v.yearCheck, titleCheck: v.titleCheck };
}

/** One Crossref work record as a CrossrefResult. Shared by validateDOI and the search (was two copies). */
function toCrossrefResult(message: any, score: number): CrossrefResult {
  return {
    found: true,
    doi: message.DOI,
    title: message.title?.[0] || message['short-title']?.[0],
    authors: message.author?.map((a: any) =>
      a.family ? `${a.family}${a.given ? `, ${a.given}` : ''}` : ''
    ).filter(Boolean) || [],
    publishedDate: formatDateParts(message.published?.['date-parts']?.[0]),
    journal: message['container-title']?.[0] || message['short-container-title']?.[0],
    score,
    rawData: message,
  };
}

/**
 * Find DOI from reference text using Crossref Simple Text Query
 * Now with improved validation to prevent false matches.
 * Returns null for every kind of miss; use {@link findDOIFromReferenceDetailed} to tell
 * "no DOI matched" from "could not search".
 */
export async function findDOIFromReference(referenceText: string, creds?: MetadataCredentials): Promise<CrossrefResult | null> {
  return (await findDOIFromReferenceDetailed(referenceText, creds)).result;
}

export async function findDOIFromReferenceDetailed(
  referenceText: string,
  creds?: MetadataCredentials
): Promise<DoiSearchOutcome> {
  const outcome: DoiSearchOutcome = {
    result: null,
    status: 'no_match',
    rejected: [],
    belowScoreThreshold: 0,
    errors: [],
    notComparable: { author: 0, year: 0, title: 0 },
  };

  // Skip DOI lookup for works that typically don't have DOIs
  if (isUnpublishableWork(referenceText)) {
    console.log(`Skipping DOI lookup for unpublishable work: ${referenceText.substring(0, 80)}...`);
    outcome.status = 'skipped_unpublishable';
    return outcome;
  }

  try {
    // Try Simple Text Query API first (most accurate for full references)
    // Note: simpleTextQuery is a different host (doi.crossref.org) and rarely
    // returns 429 in practice, but we still send the polite-pool UA.
    const response = await axios.post(
      SIMPLE_TEXT_QUERY_API,
      new URLSearchParams({ query: referenceText }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getCrossrefUserAgent(creds),
        },
        timeout: 15000,
      }
    );

    if (response.status === 200) {
      // Parse pipe-delimited response format
      // Format: DOI|Title|Authors|Year|Journal
      const lines = String(response.data ?? '').split('\n').filter((line: string) => line.trim());

      if (lines.length > 0) {
        const parts = lines[0].split('|');

        if (parts.length >= 1 && parts[0].trim().startsWith('10.')) {
          const doi = parts[0].trim();
          // Validate the found DOI
          const validation = await validateDOI(doi, creds);
          if (validation.valid && validation.data && validation.data.rawData) {
            // Additional validation: check if the result actually matches the reference
            const matchValidation = validateDOIMatch(referenceText, validation.data.rawData);
            countNotComparable(outcome, matchValidation);
            if (matchValidation.isValid) {
              outcome.result = { ...validation.data, ...checksOf(matchValidation) };
              outcome.status = 'found';
              return outcome;
            }
            console.log(`DOI ${doi} rejected: ${matchValidation.reason}`);
            outcome.rejected.push({
              doi, stage: 'simple_text_query', reason: matchValidation.reason ?? 'mismatch', ...checksOf(matchValidation),
            });
          } else {
            outcome.rejected.push({
              doi,
              stage: 'simple_text_query',
              reason: `DOI did not validate: ${validation.error ?? 'no Crossref metadata'}`,
            });
          }
        }
      }
    }
  } catch (error: any) {
    console.warn('Simple Text Query failed, trying search API:', error?.message);
    outcome.errors.push(`simple_text_query: ${error?.message ?? String(error)}`);
  }

  // Fallback to search API with improved validation
  await findDOIFromSearchAPI(referenceText, creds, outcome);
  return outcome;
}

/**
 * Find DOI using Crossref search API with improved validation. Writes into `outcome`.
 */
async function findDOIFromSearchAPI(
  referenceText: string,
  creds: MetadataCredentials | undefined,
  outcome: DoiSearchOutcome
): Promise<void> {
  try {
    const response = await crossrefGet(CROSSREF_API, {
      params: {
        'query.bibliographic': referenceText,
        rows: 5, // Get top 5 results to find a valid match
        sort: 'relevance',
      },
      timeout: 15000,
    }, creds);

    if (response.status !== 200) {
      outcome.status = 'lookup_failed';
      outcome.errors.push(`search: HTTP ${response.status}`);
      return;
    }

    const items = response.data?.message?.items || [];

    // Try each result until we find a valid match
    for (const item of items) {
      // Require higher minimum score (50 instead of 30) for better accuracy
      if (!(item.score >= 50)) {
        outcome.belowScoreThreshold += 1;
        continue;
      }

      // Validate the match against the reference
      const matchValidation = validateDOIMatch(referenceText, item);
      countNotComparable(outcome, matchValidation);
      if (!matchValidation.isValid) {
        console.log(`DOI ${item.DOI} rejected (score: ${item.score}): ${matchValidation.reason}`);
        outcome.rejected.push({ doi: item.DOI, stage: 'search', reason: matchValidation.reason ?? 'mismatch', ...checksOf(matchValidation) });
        continue;
      }

      // Found a valid match!
      console.log(`DOI ${item.DOI} accepted (score: ${item.score})`);
      outcome.result = { ...toCrossrefResult(item, item.score), ...checksOf(matchValidation) };
      outcome.status = 'found';
      return;
    }

    // No valid match found among the results
    console.log(`No valid DOI match found for: ${referenceText.substring(0, 80)}...`);
    outcome.status = 'no_match';
  } catch (error: any) {
    console.error('Crossref search API error:', error?.message);
    outcome.status = 'lookup_failed';
    outcome.errors.push(`search: ${error?.message ?? String(error)}`);
  }
}

/**
 * Batch validate multiple DOIs
 */
export async function validateMultipleDOIs(dois: string[], creds?: MetadataCredentials): Promise<Map<string, {
  valid: boolean;
  data?: CrossrefResult;
  error?: string;
}>> {
  const results = new Map<string, {
    valid: boolean;
    data?: CrossrefResult;
    error?: string;
  }>();

  // Process in batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < dois.length; i += batchSize) {
    const batch = dois.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (doi) => {
        const result = await validateDOI(doi, creds);
        return { doi, result };
      })
    );

    batchResults.forEach(({ doi, result }) => {
      results.set(doi, result);
    });

    // Rate limiting: wait 1 second between batches
    if (i + batchSize < dois.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}
