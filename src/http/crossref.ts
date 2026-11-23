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
      const message = response.data?.message;
      if (response.status === 200 && (!message || typeof message !== 'object' || Array.isArray(message))) {
        // A 200 without a work record (a captive portal's HTML) is no answer: report the
        // source as unavailable, never as an invalid DOI (v0.3.0 review 12; it was a TypeError).
        return { valid: false, error: '[Crossref API] 200 without a work record' };
      }
      if (response.status === 200) {

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
 * Particles as a regex alternation, with either first-letter case ("van der Berg JH",
 * "Van Dyke, J.", "De la Cruz M", "de la Cruz, M.").
 */
const PARTICLE_ANY_CASE = `(?:${NAME_PARTICLES.map((w) => `[${w[0]}${w[0].toUpperCase()}]${w.slice(1)}`).join('|')})`;

/**
 * Vancouver / NLM author lists ("Hoddy KK, Gibbons C, et al. Title."): a surname, then
 * capital initials with no comma between them. Read from the start of the reference up to
 * the first ". "; empty unless the FIRST entry has that shape. The APA pattern below read
 * "Hoddy KK, Gibbons C" as surname "KK" (d-e977e3). A surname needs a lower-case letter, so
 * initials are never one. Name particles in either case ("van der Berg JH", "Van Dyke J",
 * "De la Cruz M", "Le Roux P") and one further surname word ("Garcia Marquez G") are part of
 * the surname read (round 13: those entries were not read, the list came back empty and the
 * author check was skipped). Every word of the surname needs a lower-case letter, so
 * "Hoddy KK Gibbons C." is not read as surname "Hoddy KK Gibbons". Round 14: up to two
 * further surname words ("Garcia Lopez Marquez G"), dotted initials ("Smith J.A.", "Jones
 * K."), a suffix after the initials ("Smith JA Jr", "Smith JA 3rd"); entries may be joined by
 * ",", ";", "&" or "and" (those lists were not read, the list came back empty and any record
 * with the title was accepted).
 */
const VANCOUVER_ENTRY = new RegExp(`^((?:${PARTICLE_ANY_CASE}\\s+)*\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*(?:\\s+\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*){0,2})\\s+(\\p{Lu}\\.?(?:-?\\p{Lu}\\.?){0,2})(?:\\s+(?:Jr|Sr|II|III|IV|2nd|3rd|4th)\\.?)?$`, 'u');
/** Separators between Vancouver entries ("and others" closes a list, it is not one). */
const VANCOUVER_SEPARATOR = /\s*(?:,|;|&|\band\b(?!\s+others\b))\s*/;
/** "et al", "et al.", "and others" closing a Vancouver entry without a comma before it. */
const ENTRY_ET_AL = /^(.*?)\s+(?:et\.?\s*al\b|and\s+others\b)/i;

/**
 * The Vancouver reading of an author section: its surnames, and, when the text can also be read
 * given-first, the surname of that other reading (`alternative`).
 *
 * One entry ending in ONE initial, cut at its period, then a surname-like run ("Michael J. |
 * LaCour", "Michael J. | van der Berg", "Alex J. | K. Smith", "Michael J. | LaCour Jr"): either
 * a name written given-first ("Michael" a given name) or a one-author Vancouver reference whose
 * title starts with that word ("Hoddy K. | Sleep and memory"). The text cannot tell them apart,
 * so both readings are kept (round 12: round 11 read every such section given-first and
 * rejected the right DOI of one-author Vancouver references). An entry followed by "et al." is
 * a Vancouver list, never a given name.
 */
function vancouverReading(section: string): { surnames: string[]; alternative: string | null } {
  const cut = section.search(/\.\s/);
  const list = cut >= 0 ? section.slice(0, cut) : section;
  const out: string[] = [];
  let lastInitials = '';
  let etAl = false;
  // An entry closed by "et al" / "and others" ends the list ("Hoddy K et al Sleep and ...",
  // with no period after "al", is cut there).
  for (const raw of list.split(VANCOUVER_SEPARATOR).filter(Boolean)) {
    if (/^et al\.?$/i.test(raw)) { etAl = true; continue; }
    const closed = raw.match(ENTRY_ET_AL);
    const m = (closed ? closed[1] : raw).match(VANCOUVER_ENTRY);
    if (!m) break;
    out.push(m[1]);
    lastInitials = m[2].replace(/[^\p{Lu}]/gu, '');
    if (closed) { etAl = true; break; }
  }
  if (out.length !== 1 || lastInitials.length !== 1 || cut < 0 || etAl) return { surnames: out, alternative: null };
  const tail = section.slice(cut + 2).trim().match(GIVEN_FIRST_TAIL);
  return { surnames: out, alternative: tail ? tail[1] : null };
}

/**
 * Given names first: "Michael J. LaCour, Donald P. Green", "J. A. Smith, K. Jones", "Jordan
 * B. Fishman and Eric A. Berg". Each entry is given names (capitalised words) or initials
 * (one capital, a period optional, "J.-P."), then the surname (name particles allowed before
 * it). Read from the start up to the first entry of another shape (a title in quotes, an
 * APA "Smith"), so a title is not read. Two-letter capitals ("KK") are Vancouver initials,
 * never a given part here.
 */
const GIVEN_PART = `(?:\\p{Lu}\\p{Ll}+(?:-\\p{Lu}\\p{Ll}+)?|\\p{Lu}\\.?(?:-\\p{Lu}\\.?)?)`;
const GIVEN_FIRST_ENTRY = new RegExp(`^(?:${GIVEN_PART}\\s+)+((?:${PARTICLE_ANY_CASE}\\s+)*\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*)\\.?$`, 'u');
interface GivenFirstReading {
  names: string[];
  /** Entries with a dotted initial ("Donald P. Long"): two of them make a given-first list. */
  withInitial: number;
  /** A name whose entry was followed by a piece starting in lower case ("Smith J Sleep | and
   *  memory"): the "and" was the title's, so the name may be a title word. */
  runOn: Set<string>;
}
function givenFirstSurnames(section: string): GivenFirstReading {
  const out: GivenFirstReading = { names: [], withInitial: 0, runOn: new Set() };
  const parts = section.split(/(\s*(?:,|;|&|\band\b)\s*)/u);
  const pieces: string[] = [];
  const before: string[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    const p = parts[k].trim();
    if (p) { pieces.push(p); before.push((parts[k - 1] ?? '').trim()); }
  }
  const entries: Array<{ name: string; runOn: boolean }> = [];
  for (const [i, piece] of pieces.entries()) {
    if (/^et\.?\s+al\.?$/i.test(piece)) continue;
    const m = piece.match(GIVEN_FIRST_ENTRY);
    if (!m || CORPORATE_WORD.test(piece)) {
      // The last entry runs on into the title ("..., Donald P. Green. Brown and the ..."): read
      // its surname up to the period (round 13), once an earlier entry was read given-first.
      const last = entries.length > 0 ? piece.match(GIVEN_FIRST_LAST) : null;
      if (last && !CORPORATE_WORD.test(last[0])) {
        entries.push({ name: last[1], runOn: false });
        if (/\p{Lu}\.\s/u.test(last[0])) out.withInitial++;
      } else {
        // The piece after the previous entry is not a name: that entry ran on into the title
        // ("Young K Smith and Jones revisited", "Wang Xiaoming Smith and ...") and its surname
        // may be a title word (round 15). A piece that starts as a given-first entry with a
        // dotted initial still counts towards a given-first list ("Donald P. Long: Title").
        // After a comma the entry ended there ("J. A. Smith, Smith and Jones revisited").
        if (entries.length > 0 && before[i] !== ',') entries[entries.length - 1].runOn = true;
        if (/^\p{Lu}\p{Ll}+\s+\p{Lu}\.\s+\p{Lu}/u.test(piece)) out.withInitial++;
      }
      break;
    }
    if (/\p{Lu}\.\s/u.test(piece)) out.withInitial++;
    entries.push({ name: m[1], runOn: pieces[i + 1] !== undefined && /^\p{Ll}/u.test(pieces[i + 1]) });
  }
  for (const e of entries) if (!out.names.includes(e.name)) out.names.push(e.name);
  // A name is a second reading only when every entry that read it ran on into the title
  // ("Michael J. Young, Donald P. Long Young and ...": the first Young is an author).
  for (const e of entries) if (e.runOn && !entries.some((o) => o.name === e.name && !o.runOn)) out.runOn.add(e.name);
  return out;
}
const GIVEN_FIRST_LAST = new RegExp(`^(?:${GIVEN_PART}\\s+)+((?:${PARTICLE_ANY_CASE}\\s+)*\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*)(?=\\.\\s)`, 'u');

/**
 * "Surname, I." with the surname's particles and further words: "Van Dyke, J." gives
 * "Van Dyke", "de la Cruz, M." gives "de la Cruz", "Garcia Marquez, G." gives "Garcia
 * Marquez" (one word only used to be read, so "Van Dyke" became "Dyke" and failed against
 * Crossref "VanDyke"). Unicode letters (2026-11-18): the ASCII class stopped at the first
 * accent, so "Müller, K." yielded no surname and the author check was silently skipped.
 */
const SURNAME = `(?:${PARTICLE_ANY_CASE}\\s+)*\\p{Lu}[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]*\\p{Ll}[\\p{L}'’-]*){0,2}`;
const APA_AUTHOR = new RegExp(`(?<![\\p{L}'’-])(${SURNAME})(?:\\s*,\\s*\\p{Lu}\\.?)+`, 'gu');
/**
 * A surname alone at the start ("Smith (2019)", "Smith. 2019", "Smith & Jones"): followed by a
 * comma, period, "&", "and", "et al.", a bracket or the end of the author section. A
 * reference that starts with its title ("Retracted: Faux Reality Detector. (2024)",
 * "Mechanisms responsible for ...") has no surname to read (round 11: its first word was read
 * as a surname and rejected the right DOI).
 */
const LEADING_SURNAME = new RegExp(`^(${SURNAME})(?=\\s*(?:[,.;&(]|\\band\\b|\\bet al\\b|$))`, 'u');
/** After a cut middle initial: more initials ("K. "), then a surname with its particles and words. */
const GIVEN_FIRST_TAIL = new RegExp(`^(?:\\p{Lu}\\.\\s*)*(${SURNAME})`, 'u');

/**
 * Surnames read from a reference. `uncertain` holds the ones read by a second reading of an
 * ambiguous author section ("Hoddy K. Sleep and memory": "Sleep" may be a title word): such a
 * surname does not match a record whose title starts with it, so a record by an author named
 * like the title's first word is not taken for the cited work (round 12).
 */
interface ReferenceAuthors { names: string[]; uncertain: Set<string> }

/**
 * Extract author last names from reference text (simplified extraction), as written
 * (not folded: validateDOIMatch needs the script and the digraph spelling).
 *
 * A Vancouver list ("Hoddy KK, Gibbons C.") is read alone. Otherwise the surnames of every
 * other reading are kept: the APA "Surname, I." pattern and the given-first reader
 * ("Michael J. LaCour, Donald P. Green"); a surname from either counts (round 11). When the
 * text reads both as one Vancouver author and given-first ("Hoddy K. Sleep and memory",
 * "Michael J. LaCour. Title"), the surnames of both readings are kept, those of the second
 * reading as `uncertain` (round 12).
 */
function extractAuthorsFromReference(referenceText: string): ReferenceAuthors {
  const read = readAuthors(referenceText);
  // Every surname 0.2.x read is kept (round 15): the readers above add readings, they never
  // take one away, so no author section is read with fewer names than 0.2.x read (rounds 11 to
  // 15 each found a shape the new readers did not recognise, and an empty list skips the
  // author check). A 0.2.x name the new readers did not read is uncertain: it may be a title
  // word (a reference that starts with its title, "Sleep and memory ...", or 0.2.x's comma
  // pattern on "Diabetes, Obesity and ..."), so it does not count for a record whose title has
  // that word. A name both read, where the new readers had it as a second reading only (the
  // family-first first word, "Wang Xiaoming and Li Hua. Wang and ..."), counts. A group author
  // ("Research Group.") reads no person, as before.
  const authorSection = (referenceText.split(/\(\d{4}/)[0] || '').trim();
  if (read.names.length === 0 && CORPORATE_WORD.test(authorSection.split(/[.,;(]/)[0])) return read;
  const legacy = legacySurnames(referenceText);
  // A first word followed by initials ("Smith J: Smith and Jones revisited", "Smith JA Jr ...")
  // is an author even when the title repeats it.
  const withInitials = legacy.firstWord && FIRST_WORD_INITIALS.test(authorSection);
  for (const name of legacy.names) {
    const known = read.names.find((n) => foldForMatch(n) === foldForMatch(name));
    if (known !== undefined) {
      if (legacy.firstWord) read.uncertain.delete(known);
      continue;
    }
    read.names.push(name);
    if (!withInitials) read.uncertain.add(name);
  }
  return read;
}

const FIRST_WORD_INITIALS = /^\p{Lu}[\p{L}'’-]*\p{Ll}[\p{L}'’-]*\s+\p{Lu}(?:\.?-?\p{Lu}){0,2}\.?(?=[\s:,;.]|$)/u;

/**
 * The 0.2.x author reader (33278cf), with Unicode letters: 0.2.x's ASCII classes cut "GARCÍA J"
 * to "GARC", which its loose compare accepted against "García" and the whole-word compare
 * does not (round 16). `firstWord` when it read the first word only.
 */
function legacySurnames(referenceText: string): { names: string[]; firstWord: boolean } {
  const authorSection = (referenceText.split(/\(\d{4}/)[0] || '').trim();
  const lastNames: string[] = [];
  const authorPattern = /(\p{Lu}[\p{L}'’-]+)(?:\s*,\s*\p{Lu}\.?)+/gu;
  let match;
  while ((match = authorPattern.exec(authorSection)) !== null) lastNames.push(match[1]);
  if (lastNames.length === 0) {
    const simpleMatch = authorSection.match(/^(\p{Lu}[\p{L}'’-]+)/u);
    if (simpleMatch) return { names: [simpleMatch[1]], firstWord: true };
  }
  return { names: lastNames, firstWord: false };
}

/**
 * The surnames 0.2.x read, exactly as it read them: ASCII letters only, so "García" was read
 * "Garc" (round 27). Used only to tell which families 0.2.x matched, and whether it read the
 * first word only: "Hernández Núñez, López García" has no ASCII comma pair, so 0.2.x read
 * "Hern" (round 28).
 */
function readAs02(referenceText: string): { names: string[]; firstWord: boolean } {
  const section = (referenceText.split(/\(\d{4}/)[0] || '').trim();
  const names = [...section.matchAll(/([A-Z][a-zA-Z'-]+)(?:\s*,\s*[A-Z]\.?)+/g)].map((m) => m[1]);
  if (names.length > 0) return { names, firstWord: false };
  const first = section.match(/^([A-Z][a-zA-Z'-]+)/);
  // No comma pair: 0.2.x read the first word, or nothing, and then compared no authors at all.
  return { names: first ? [first[1]] : [], firstWord: true };
}

function readAuthors(referenceText: string): ReferenceAuthors {
  // Common patterns for authors at start of reference
  // e.g., "Smith, J. A., & Jones, B. C. (2019)" or "Smith, J.A. (2019)"
  const beforeYear = referenceText.split(/\(\d{4}/)[0] || '';
  const authorSection = beforeYear.trim();
  const vancouver = vancouverReading(authorSection);
  if (vancouver.surnames.length > 0 && vancouver.alternative === null) return { names: vancouver.surnames, uncertain: new Set() };

  const lastNames = [...authorSection.matchAll(APA_AUTHOR)].map((m) => m[1]);
  const apaCount = lastNames.length;
  const givenFirst = givenFirstSurnames(authorSection);
  for (const s of givenFirst.names) if (!lastNames.includes(s)) lastNames.push(s);
  // Two given-first entries with a dotted initial ("Michael J. Young, Donald P. Long") are a
  // given-first list: their surnames are certain even when they are title words (round 14).
  const listIsGivenFirst = givenFirst.withInitial >= 2;
  if (vancouver.alternative !== null) {
    if (!lastNames.includes(vancouver.alternative)) lastNames.push(vancouver.alternative);
    // Only the second reading is uncertain: the Vancouver surname stays (round 13: "Darwin C.
    // Darwin and ..." lost its certain "Darwin" with the uncertain one).
    const uncertain = new Set(lastNames.filter((s) => !vancouver.surnames.includes(s) && (givenFirst.runOn.has(s) || !(listIsGivenFirst && givenFirst.names.includes(s)))));
    // In a given-first list the Vancouver "surname" is the first given name ("Hope A. Nakamura,
    // Will D. Long": Hope), so it is not read (round 15).
    const vancouverNames = listIsGivenFirst ? [] : vancouver.surnames;
    return { names: [...vancouverNames, ...lastNames.filter((s) => !vancouver.surnames.includes(s))], uncertain };
  }
  const uncertain = new Set<string>(givenFirst.runOn);
  // Read given-first only, the first word may still be the surname, written family first
  // ("Wang Xiaoming and Li Hua", "Smith J Sleep and ..."): it is kept as a second, uncertain
  // reading, as 0.2.x read it (round 14).
  if (apaCount === 0 && givenFirst.names.length > 0) {
    const first = authorSection.match(/^\p{Lu}[\p{L}'’-]*\p{Ll}[\p{L}'’-]*/u)?.[0];
    if (first && !lastNames.includes(first) && !CORPORATE_WORD.test(first)) {
      lastNames.push(first);
      uncertain.add(first);
    }
  }
  // Also try simpler pattern for single author or non-standard format
  if (lastNames.length === 0) {
    const simpleMatch = authorSection.match(LEADING_SURNAME);
    if (simpleMatch && !CORPORATE_WORD.test(simpleMatch[1])) lastNames.push(simpleMatch[1]);
  }
  return { names: lastNames, uncertain };
}

/**
 * A group author ("World Health Organization", "Open Science Collaboration", "Research
 * Group") is not a surname: compared with the persons of a Crossref record it says nothing,
 * so the author check is `not_comparable` (round 11).
 */
const CORPORATE_WORD = /\b(?:Organi[sz]ation|Association|Society|Committee|Consortium|Institute|Council|Collaboration|Group|Team|Network|Agency|Department|Ministry|Office|Foundation|Cent(?:er|re)|University|Commission|Board|Panel|Initiative|Project|Bureau|Federation|Union|Alliance|Authority)\b/u;

/** The German digraph spelling ("Müller" -> "Mueller"), so either spelling matches the other. */
const DIGRAPH: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue' };
function spellings(name: string): string[] {
  const digraph = name.normalize('NFC').replace(/[äöüÄÖÜ]/g, (c) => DIGRAPH[c] ?? c);
  return digraph === name ? [name] : [name, digraph];
}

/**
 * A multi-word Crossref surname that is the leading words of a longer reading: "de Vries Jan"
 * (a family-first name read as one surname) and "de Vries" (round 16).
 */
function leadsWith(read: string, family: string): boolean {
  const r = foldForMatch(read).split(' ');
  const f = foldForMatch(family).split(' ');
  return f.length >= 2 && r.length > f.length && f.every((w, i) => r[i] === w);
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
 * "Smith-Jones"), also once initials written on to the reference surname or particles joined
 * to either surname are dropped ("SmithJA" / "Smith", "Jong" / "DeJong"); never a substring
 * ("Li" / "Williams", "Smith" / "Goldsmith"). The German
 * digraph spelling counts as the same name. Latin, Cyrillic and Greek against each other:
 * the loose romanisation ("Иванов" / "Ivanov" / "Ivanova", "Чайковский" / "Tchaikovsky").
 */
/** A surname with its initials written on ("SmithJA", a database export): the surname alone (round 19). */
function withoutGluedInitials(name: string): string[] {
  const out: string[] = [];
  // After any surname ending in a lower-case letter, with capitals inside it too ("McDonaldJA",
  // "Smith-JonesJA", round 22; "XuJ", round 23), unless what remains is a particle ("DeJON"
  // is not "De").
  const after = name.match(/^(\p{Lu}[\p{L}'’-]*\p{Ll})\p{Lu}{1,3}$/u);
  if (after && after[1].replace(/[^\p{L}]/gu, '').length >= 2 && !PARTICLES.has(after[1].toLowerCase())) out.push(after[1]);
  // Before it ("JSmith", round 23), unless the capitals are a particle ("OBrien", "DAngelo").
  const before = name.match(/^(\p{Lu}{1,2})(\p{Lu}\p{Ll}[\p{L}'’-]*)$/u);
  if (before && !PARTICLES.has(before[1].toLowerCase())) out.push(before[2]);
  return out;
}

const PARTICLES = new Set<string>(NAME_PARTICLES);

/** Particles written joined to the surname in some deposits ("DeJong", "VanDerBerg"). Not "Mac",
 *  "Mc", "O" or "D": those belong to the surname ("MacDonald" is not "Donald"). */
const GLUED_PARTICLES = new Set<string>(NAME_PARTICLES.filter((p) => !['mac', 'mc', 'o', 'd'].includes(p)));

/** A surname with its particles joined on ("DeJong", "VanDerBerg"), in the reference or the
 *  Crossref record: the surname after them ("Jong", "Berg"), which 0.2.x matched as a part of
 *  the name (round 19; the reference side, round 21). */
function withoutGluedParticles(name: string): string[] {
  const out: string[] = [];
  let rest = name;
  for (let m = rest.match(/^(\p{Lu}\p{Ll}+)(\p{Lu}[\p{L}'’-]+)$/u); m && GLUED_PARTICLES.has(m[1].toLowerCase()); m = rest.match(/^(\p{Lu}\p{Ll}+)(\p{Lu}[\p{L}'’-]+)$/u)) {
    rest = m[2];
    out.push(rest);
  }
  return out;
}

function surnamesMatch(ref: string, crossref: string): boolean | null {
  if (!scriptsComparable(ref, crossref)) return null;
  if (crossScript(ref, crossref)) return looseSurnameMatch(ref, crossref);
  const bare = [ref, ...withoutGluedInitials(ref)];
  for (const r of [...bare, ...bare.flatMap(withoutGluedParticles)].flatMap(spellings)) {
    // A Crossref family with initials glued on ("SmithJA", a dirty deposit; round 23).
    const plain = [crossref, ...withoutGluedInitials(crossref)];
    for (const c of [...plain, ...plain.flatMap(withoutGluedParticles)].flatMap(spellings)) {
      if (sameSurname(r, c) || isWholeWordOf(r, c) || isWholeWordOf(c, r) || leadsWith(r, c)) return true;
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
 * Since round 11 the share is computed on word stems (-ise/-ize, -our/-or, plurals, -ing),
 * on the main title and on the full title (either may pass), and on the words before an
 * ellipsis when the reference cuts the title short. The 0.6 value itself is unchanged.
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

/** Every word of a title, folded, in order (markup removed). */
function titleSequence(title: string): string[] {
  return foldForMatch(title.replace(/<[^>]+>/g, ' ')).split(' ').filter(Boolean);
}

/** The distinctive words of a title: folded, 4+ letters, no stopwords. */
function distinctive(words: readonly string[]): string[] {
  return [...new Set(words.filter((w) => [...w].length >= 4 && !TITLE_STOPWORDS.has(w)))];
}

/**
 * One stem per spelling of a title word (round 11): UK and US spellings (behaviour /
 * behavior, organisation / organization, modelling / modeling, judgement / judgment) and
 * the plural or -ing form (network / networks, studies / study) compare equal. Applied to
 * both sides alike; a stem is never compared by prefix, so "inform" and "informal" differ.
 */
function titleStem(word: string): string {
  let s = word
    .replace(/isation/g, 'ization')
    .replace(/is(e|es|ed|ing)$/, 'iz$1')
    .replace(/ys(e|es|ed|ing)$/, 'yz$1')
    .replace(/our/g, 'or')
    .replace(/ement(s?)$/, 'ment$1')
    .replace(/ll(ing|ed)$/, 'l$1');
  if (/ies$/.test(s)) s = `${s.slice(0, -3)}y`;
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);
  if (s.length > 6 && /ing$/.test(s)) s = s.slice(0, -3);
  return s;
}

/** The title words written before an ellipsis in the reference ("Mechanisms of the initiation of a fast..."). */
function wordsBeforeEllipsis(referenceText: string, sequence: readonly string[]): string[] | null {
  const at = referenceText.search(/\.\.\.|…/);
  if (at < 0) return null;
  const before = foldForMatch(referenceText.slice(0, at)).split(' ');
  const last = before[before.length - 1];
  if (!last) return null;
  for (let k = sequence.length - 1; k > 0; k--) {
    const w = sequence[k];
    if (w === last || (last.length >= 3 && w.startsWith(last))) {
      // The words before it must be the title's words before it, as written.
      const head = sequence.slice(0, k);
      const tail = before.slice(-1 - head.length, -1);
      if (head.length > 0 && head.join(' ') === tail.join(' ')) return sequence.slice(0, k + (w === last ? 1 : 0));
    }
  }
  return null;
}

function crossrefTitle(item: any): string {
  return [item?.title?.[0], item?.subtitle?.[0]].filter((t): t is string => typeof t === 'string').join(' ');
}

interface TitleEvidence {
  check: DoiMatchCheck;
  /** Distinctive words of the title compared (main title when it decided). */
  words: number;
  /** Share of them found in the reference. */
  share: number;
}

/** Share of `words` whose stem occurs among the reference's word stems. */
function shareIn(words: readonly string[], refStems: ReadonlySet<string>): number {
  return words.length === 0 ? 0 : words.filter((w) => refStems.has(titleStem(w))).length / words.length;
}

/** A word ending a sentence of the reference: not an initial ("J.") or a part number ("II."). */
function endsSentence(token: string): boolean {
  if (/^\(?\d{4}[a-z]?\)?[.,:;]?$/u.test(token)) return true;
  if (/[’”"]$/u.test(token) || /^[‘“"]/u.test(token)) return true;
  if (!/[.?!]["'’”)\]]*$/u.test(token)) return false;
  const bare = token.replace(/[^\p{L}\p{N}]/gu, '');
  return !(/^\p{Lu}$/u.test(bare) || /^(?:I{1,3}|IV|VI{0,3}|IX|X)$/u.test(bare));
}

interface OwnTitle { words: string[]; part: boolean }

const PART_WORD = /^(?:part|pt)$/u;
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const SPELLED: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/** The part number opening `words` ("part ii ...", "ii theoretical ...", "part 2"), or null. A
 *  bare "i", "v", "x" or digit is a part number only after "part". */
function partNumber(words: readonly string[]): number | null {
  const named = PART_WORD.test(words[0] ?? '');
  const w = named ? words[1] ?? '' : words[0] ?? '';
  if (/^\d{1,2}$/u.test(w)) return named ? Number(w) : null;
  if (w in SPELLED) return named ? SPELLED[w] : null;
  if (w in ROMAN) return named || !['i', 'v', 'x'].includes(w) ? ROMAN[w] : null;
  return null;
}

/** The part number written in a record's title ("... Part II", "... relationships: II. ..."). */
function recordPart(words: readonly string[]): number | null {
  for (let i = 1; i < words.length; i++) {
    const n = partNumber(words.slice(i));
    if (n !== null) return n;
  }
  return null;
}

/** The part a record's title names unambiguously: "Part II" / "Pt 2" anywhere, or a roman
 *  numeral (ii to x) as its last word ("... in practice II"). A numeral inside the title ("Type II
 *  diabetes") is not one. Used when the reference writes no part (review 12). */
function recordNamedPart(words: readonly string[]): number | null {
  for (let i = 0; i < words.length; i++) {
    if (PART_WORD.test(words[i])) {
      const n = partNumber(words.slice(i));
      if (n !== null) return n;
    }
  }
  const lastWord = words[words.length - 1] ?? '';
  return words.length > 1 && lastWord in ROMAN && !['i', 'v', 'x'].includes(lastWord) ? ROMAN[lastWord] : null;
}

/** A token that is an author's initials ("J.", "SJ,", "M.-L."). */
const INITIALS_TOKEN = /^\p{Lu}(?:[.-]{0,2}\p{Lu}){0,2}[.,;]*$/u;

/**
 * The reference's own title, compared back with the record's (review 11): the sentence of the
 * reference holding most of the record's title words, from after the author initials written
 * before them; without what is in brackets ("[Preprint]", "(SSRN Scholarly Paper ...)") and,
 * when the record has no subtitle, without a subtitle written after them ("Radiation therapy
 * for soft tissue sarcoma: Indications, timing ..."). `words` are its distinctive words (digits
 * and author surnames left out); `part` is a part number ("II.", "Part 2") written right after
 * the record's title words when the record's title has none. Null when the reference has no
 * punctuation or no sentence holds a word of the record's title.
 */
function ownTitle(referenceText: string, item: any, titleStems: ReadonlySet<string>, authors: readonly string[]): OwnTitle | null {
  // Written without punctuation ("fishman j b berg e a 2019 peptide affinity ..."), the title
  // cannot be told from the journal after it: nothing to compare back.
  if (!/[.,;:?!]/u.test(referenceText)) return null;
  const sentences: string[][] = [];
  let cur: string[] = [];
  let depth = 0;
  for (const token of referenceText.split(/\s+/u).filter(Boolean)) {
    if (/^[‘“"]/u.test(token) && cur.length) { sentences.push(cur); cur = []; }
    const opens = (token.match(/[([]/gu) ?? []).length;
    const closes = (token.match(/[)\]]/gu) ?? []).length;
    if (depth === 0 && opens === 0) cur.push(token);
    else if (depth === 0 && /^[([]/u.test(token) === false) cur.push(token.replace(/[([].*$/u, ''));
    depth = Math.max(0, depth + opens - closes);
    if (endsSentence(token)) { sentences.push(cur); cur = []; depth = 0; }
  }
  if (cur.length) sentences.push(cur);
  const names = new Set(authors.flatMap((n) => foldForMatch(n).split(' ')));
  const main = typeof item?.title?.[0] === 'string' ? item.title[0] : '';
  const hasSubtitle = typeof item?.subtitle?.[0] === 'string' || /\S\s*(?:[:?]|\s[-–—]\s)\s*\S/u.test(main);
  let best: { words: string[]; part: boolean; hits: number } | null = null;
  for (const [si, tokens] of sentences.entries()) {
    const seq: Array<{ w: string; counts: boolean; hit: boolean; tok: string; initials: boolean }> = [];
    for (const tok of tokens) {
      const ws = titleSequence(tok);
      ws.forEach((w, i) => {
        const counts = [...w].length >= 4 && !TITLE_STOPWORDS.has(w) && !/^\d+$/u.test(w) && !names.has(w);
        seq.push({ w, counts, hit: counts && titleStems.has(titleStem(w)), tok: i === ws.length - 1 ? tok : '', initials: INITIALS_TOKEN.test(tok) });
      });
    }
    const hitAt = seq.map((x, i) => (x.hit ? i : -1)).filter((i) => i >= 0);
    if (hitAt.length === 0 || (best && hitAt.length <= best.hits)) continue;
    const first = hitAt[0];
    const last = hitAt[hitAt.length - 1];
    let start = 0;
    for (let i = 0; i < first; i++) if (seq[i].initials) start = i + 1;
    let end = seq.length;
    if (!hasSubtitle) {
      for (let i = last; i < seq.length; i++) if (/[:?]|[-–—]$/u.test(seq[i].tok)) { end = i + 1; break; }
    }
    const words = [...new Set(seq.slice(start, end).filter((x) => x.counts).map((x) => x.w))];
    // The part number written after the record's title words (the next sentence too: "Causal
    // Inference. Part I."), "Part" itself left out when the record's title has it.
    let tail = last;
    while (tail > first && PART_WORD.test(seq[tail].w)) tail -= 1;
    // The next sentence counts only when it opens with "Part": a bare numeral there is the next
    // field ("II Farmaco", a journal), not a part (review 12).
    const next = titleSequence((sentences[si + 1] ?? []).join(' '));
    const after = [...seq.slice(tail + 1).map((x) => x.w), ...(PART_WORD.test(next[0] ?? '') ? next : [])];
    let written = partNumber(after);
    // "Part II: Causal inference ...": a named part among the title words (review 12; "part" is
    // itself a title word when the record's title has it).
    for (let i = start; written === null && i <= last; i++) if (PART_WORD.test(seq[i].w)) written = partNumber(seq.slice(i).map((x) => x.w));
    const recordWords = titleSequence(crossrefTitle(item));
    // A reference that writes no part is not matched to a record of one part (review 12).
    const part = written !== null ? written !== recordPart(recordWords) : recordNamedPart(recordWords) !== null;
    best = { words, part, hits: hitAt.length };
  }
  return best && { words: best.words, part: best.part };
}

/**
 * Title evidence: do the Crossref title's distinctive words occur in the reference text?
 * Fewer than two such words, or a title in another script than the reference (a Russian
 * reference to a record with an English title), is `not_comparable`.
 *
 * Round 11: the subtitle is never required. The main title (`title[0]`) and the full title
 * (with `subtitle[0]`) are each compared; either passing is a match, and a one-word main
 * title found in the reference is `not_comparable`, never `mismatched`. Words compare by
 * stem (see titleStem). A reference that cuts the title with "..." is compared on the title
 * words written before the cut.
 */
function checkTitle(referenceText: string, item: any, authors: readonly string[] = []): TitleEvidence {
  const full = crossrefTitle(item);
  const main = typeof item?.title?.[0] === 'string' ? item.title[0] : '';
  const fullSeq = titleSequence(full);
  if (distinctive(fullSeq).length < 2 && distinctive(titleSequence(main)).length < 2) return { check: 'not_comparable', words: 0, share: 0 };
  if (majorityScript(full) !== majorityScript(referenceText)) return { check: 'not_comparable', words: 0, share: 0 };
  const refStems = new Set(foldForMatch(referenceText).split(' ').filter(Boolean).map(titleStem));
  const fullStems = new Set(distinctive(fullSeq).map(titleStem));
  const own = ownTitle(referenceText, item, fullStems, authors);
  // Another part of a work ("... Part I." against the record of Part II) is another work, also
  // when the title is too short to compare (review 11).
  if (own?.part) return { check: 'mismatched', words: own.words.length, share: 0 };

  const candidates: string[][] = [];
  for (const seq of [titleSequence(main), fullSeq]) {
    const cut = wordsBeforeEllipsis(referenceText, seq);
    candidates.push(distinctive(cut ?? seq));
  }
  let best: TitleEvidence | null = null;
  for (const words of candidates) {
    if (words.length < 2) continue;
    const share = shareIn(words, refStems);
    if (share >= TITLE_MATCH_SHARE) {
      const back = own ? shareIn(own.words, fullStems) : 1;
      // The reference's own title must be the record's too (review 11): "Instrumental Variables
      // Analysis and Mendelian Randomization for Causal Inference" holds every word of the
      // record "Commentary: Mendelian Randomization for Causal Inference" and is another work.
      if (own && back < TITLE_MATCH_SHARE) return { check: 'mismatched', words: own.words.length, share: back };
      return { check: 'matched', words: words.length, share };
    }
    if (!best || share > best.share) best = { check: 'mismatched', words: words.length, share };
  }
  const mainWords = candidates[0];
  if (mainWords.length === 1 && shareIn(mainWords, refStems) === 1) return { check: 'not_comparable', words: 1, share: 1 };
  return best ?? { check: 'not_comparable', words: 0, share: 0 };
}

function crossrefYearOf(item: any): number | null {
  for (const key of ['published', 'published-online', 'published-print']) {
    const y = item?.[key]?.['date-parts']?.[0]?.[0];
    if (y) return y;
  }
  return null;
}

/** Initials of written names: "J. A." and "JA" give j, a; "Jean-Paul" gives j, p. */
function initialsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of text.split(/[\s.,;:'’"()]+/u).filter(Boolean)) {
    const letters = /^\p{Lu}{2,3}$/u.test(token) ? [...token] : token.split('-').filter(Boolean).map((p) => [...p][0]);
    for (const l of letters) {
      const f = foldForMatch(l);
      if (/^\p{L}$/u.test(f)) out.add(f);
    }
  }
  return out;
}

/** Words of an author section with the text between them: "Smith, J. A." gives Smith ", " J ". " A ".". */
interface SectionWord { word: string; after: string }
function sectionWords(section: string): SectionWord[] {
  return [...section.matchAll(/([\p{L}'’-]+)([^\p{L}'’-]*)/gu)].map((m) => ({ word: m[1], after: m[2] }));
}
const IS_INITIAL = /^\p{Lu}(?:-?\p{Lu}){0,2}$/u;

/** Two neighbouring words are one author entry: no separator, a period after an initial ("J.
 *  Smith"), or a comma before initials ("Little, M."); "and" / "et al." and a period after a
 *  written-out word ("Alex E. Parkevich. Diabetes") end the entry. */
function sameEntry(words: readonly SectionWord[], i: number): boolean {
  const next = words[i + 1]?.word;
  if (next === undefined || /^(?:and|et)$/i.test(next) || /^(?:and|et)$/i.test(words[i].word)) return false;
  const sep = words[i].after.trim();
  return sep === '' || (sep === '.' && IS_INITIAL.test(words[i].word)) || (sep === ',' && IS_INITIAL.test(next));
}

/** The other words of one author entry holding a record's family name, or null when the order there is not ambiguous. */
type EntryOthers = { all: string[]; after: string[] } | null;

/**
 * The other words of each author entry that holds a record's family name, where the name order
 * there is ambiguous. A family name whose author entry also holds another written-out capitalised
 * word ("Mark Little", "Little Mark", "Rowe Hope", "Michael J. Young", "Wang Xiaoming", "Hoddy K.
 * Sleep") may be a given name: the entry reads family first or given first, and the text cannot
 * tell which (round 17). One element per occurrence of the family name in the section ("Mark
 * Little and Zoe Mark": two); `null` for an occurrence whose order is not ambiguous ("Smith, J.
 * A.", "Smith JA") or whose entry is longer than four words on a side (the given name may be
 * among the words not looked at, round 18). Empty when the family name is not in the section.
 */
/** Generational suffixes, which are not given names ("Smith Jr", round 19). */
const NAME_SUFFIX = /^(?:jr|sr|jnr|snr)$/i;

function entriesOf(words: readonly SectionWord[], family: string, firstWordRead: boolean, titleAt: number): EntryOthers[] {
  const fam = foldForMatch(family);
  const out: EntryOthers[] = [];
  if (!fam) return out;
  for (let at = 0; at < titleAt; at++) {
    let end = -1;
    for (let j = at; j < Math.min(words.length, at + 4); j++) {
      if (words.slice(at, j + 1).map((w) => foldForMatch(w.word)).join(' ') === fam) { end = j; break; }
    }
    if (end < 0) continue;
    const others: string[] = [];
    let i = end;
    for (; i < words.length - 1 && others.length < 4 && sameEntry(words, i); i++) others.push(words[i + 1].word);
    const cutAfter = i < words.length - 1 && sameEntry(words, i);
    let k = at - 1;
    for (let n = 0; k >= 0 && n < 4 && sameEntry(words, k); k--, n++) others.unshift(words[k].word);
    const cutBefore = k >= 0 && sameEntry(words, k);
    const given = others.filter((w) => !NAME_SUFFIX.test(w));
    const after = others.slice(others.length - (i - end)).filter((w) => !NAME_SUFFIX.test(w));
    const ambiguous = given.some((w) => !IS_INITIAL.test(w) && /^\p{Lu}/u.test(w));
    // The sole author entry, first in a section with no "Surname, I." in it, is read family
    // first, as 0.2.x read it ("Hernandez Ruiz (2014)": a second surname, not a given name;
    // round 19; "et al." / "and others" after it, round 20). An entry with an initial ("Hua H.
    // Li et al.") or a list of entries ("Mark Little and Grace Collins") keeps the check.
    const next = words[i + 1]?.word ?? '';
    // A year after the entry ends it too ("Hernandez Ruiz, 2014, Diabetes", no parentheses;
    // round 24).
    const sole = i === words.length - 1 || /[.:;\d]/.test(words[i].after)
      || (/^et$/i.test(next) && /^al$/i.test(words[i + 2]?.word ?? ''))
      || (/^and$/i.test(next) && /^others$/i.test(words[i + 2]?.word ?? ''));
    const readFirst = firstWordRead && at === 0 && sole && !given.some((w) => IS_INITIAL.test(w));
    out.push(ambiguous && !cutAfter && !cutBefore && !readFirst ? { all: given, after } : null);
  }
  return out;
}

/**
 * Where a record's family name opens an author entry that goes on after it with no initial
 * ("Hernandez" in "Hernandez Ruiz and Lopez Garcia"): the index of its first word, for each.
 */
function entryLeads(words: readonly SectionWord[], family: string, titleAt: number): number[] {
  const fam = foldForMatch(family);
  const out: number[] = [];
  if (!fam) return out;
  for (let at = 0; at < titleAt; at++) {
    if (at > 0 && sameEntry(words, at - 1)) continue;
    for (let j = at; j < Math.min(words.length, at + 4); j++) {
      if (words.slice(at, j + 1).map((w) => foldForMatch(w.word)).join(' ') === fam) {
        // An entry with an initial ("Garcia Lopez, M.") is family first already: the given name
        // is in it and the check applies (round 23).
        let e = j;
        let initial = false;
        for (; e < words.length - 1 && sameEntry(words, e); e++) if (IS_INITIAL.test(words[e + 1].word)) initial = true;
        if (e > j && !initial) out.push(at);
        break;
      }
    }
  }
  return out;
}

/**
 * The index of the first word where the title's opening words (up to three) are written, or the
 * number of words. A family name found from there on is a title word, not an author (round 23);
 * the words themselves stay, so the entry before the title ends where it ends.
 */
function titleStart(words: readonly SectionWord[], title: string): number {
  const head = foldForMatch(title).split(' ').filter(Boolean).slice(0, 3);
  if (head.length === 0) return words.length;
  // The title starts a sentence: after a period, colon, question mark or year, never inside an
  // author entry ("Hope Rowe, Anne Bell (2014). Hope." is not titled at "Hope Rowe"; round 24).
  // A period after an initial starts a title only when the words found are not the end of an
  // author entry: in "Zoe A. Mark, Anna B. Hope (2014). Hope." the "Hope" after "B." is Anna's
  // surname (round 29).
  const endsEntry = (last: number) => last + 1 >= words.length || /[,;&]/.test(words[last].after) || /^(?:and|et)$/i.test(words[last + 1].word);
  for (let k = 1; k + head.length <= words.length; k++) {
    const afterInitial = IS_INITIAL.test(words[k - 1].word) && words[k - 1].after.includes('.');
    const sentence = /[.:?!\d]/.test(words[k - 1].after) && !(afterInitial && endsEntry(k + head.length - 1));
    if ((sentence || (head.length >= 2 && words[k - 1].after.includes(','))) && head.every((h, n) => foldForMatch(words[k + n].word) === h)) return k;
  }
  return words.length;
}

/** Edit distance of two short strings. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Two written-out names that may be one: the same first two letters, or the shorter one's letters in order in the longer, first letter first ("tom" / "thomas"). */
function sameStart(a: string, b: string): boolean {
  if (a.slice(0, 2) === b.slice(0, 2)) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length < 3 || s[0] !== l[0]) return false;
  let k = 0;
  for (const ch of l) if (ch === s[k]) k++;
  return k >= s.length;
}

/**
 * A record's given name that does not fit the words written next to its family name in an
 * entry of ambiguous order: it shares no initial with them, and no word of it is a spelling
 * variant of one of them (two edits or fewer, four letters or more: "Yulia" / "Julia", "George" /
 * "Jorge", round 18; the whole name written as one word, "Hsiao-Ming" / "Xiaoming", round
 * 20). Then the record's author is not that person ("Mark Little" and a record by
 * "Mark, Zoe": "Mark" was a given name). No given name in the record, or one in another script,
 * decides nothing.
 */
function givenConflicts(others: readonly string[], given: string | null, strict: boolean): boolean {
  const cited = initialsOf(others.join(' '));
  if (cited.size === 0 || !given) return false;
  const recorded = initialsOf(given);
  if (recorded.size === 0 || [...recorded].some((l) => !/^[a-z]$/.test(l))) return false;
  if (!strict && [...recorded].some((l) => cited.has(l))) return false;
  // Strict, where only a reading 0.2.x did not make matched the family: a shared initial agrees
  // when one side of it is an initial ("Little" / "L.", "L." / "Larry"); two written-out words
  // agree only when they also share the second letter ("Kate" / "Katherine") or the shorter, of
  // three letters or more, is written in order inside the longer ("Tom" / "Thomas"). "Larry" is
  // not "Little", the cited family of "Mark Little" (round 25); "Louis" is not "Lu" (round 26).
  const citedInitials = initialsOf(others.filter((w) => IS_INITIAL.test(w)).join(' '));
  const recordedInitials = initialsOf(given.split(/[\s.]+/u).filter((w) => IS_INITIAL.test(w) || /^\p{L}$/u.test(w)).join(' '));
  if ([...recorded].some((l) => citedInitials.has(l)) || [...recordedInitials].some((l) => cited.has(l))) return false;
  const full = (text: string) => foldForMatch(text).split(' ').filter((w) => w.length >= 2);
  const citedFull = full(others.filter((w) => !IS_INITIAL.test(w)).join(' '));
  if (full(given).some((g) => citedFull.some((w) => sameStart(g, w)))) return false;
  // Each word, and the name written as one word ("Hsiao-Ming" / "Xiaoming", round 20).
  const long = (text: string) => {
    const parts = foldForMatch(text).split(' ');
    return [...parts, parts.join('')].filter((w) => w.length >= 4);
  };
  const written = long(others.filter((w) => !IS_INITIAL.test(w)).join(' '));
  return !long(given).some((g) => written.some((w) => editDistance(g, w) <= 2));
}

/**
 * The record's author with this family name is vetoed: every entry of the reference holding the
 * family name is of ambiguous order and the record's given name fits none of them (round 18: one
 * occurrence only was looked at, so "Mark Little and Zoe Mark" vetoed Zoe Mark's record).
 */
function givenVetoes(words: readonly SectionWord[], family: string, given: string | null, firstWordRead: boolean, titleAt: number, strict: boolean): boolean {
  const entries = entriesOf(words, family, firstWordRead, titleAt);
  // Strict: a written-out word after the family puts the family in given-name position ("J. Mark
  // Little": the "J." is Little's), so only the words after it may be the given name (round 27).
  const side = (e: { all: string[]; after: string[] }) =>
    strict && e.after.some((w) => !IS_INITIAL.test(w) && /^\p{Lu}/u.test(w)) ? e.after : e.all;
  return entries.length > 0 && entries.every((e) => e !== null && givenConflicts(side(e), given, strict));
}

/**
 * Check a DOI candidate against the reference: year within one, at least one surname in
 * common, and the title's words present. A `mismatched` check rejects the candidate (year
 * first, then author, then title, for the reason given); a `not_comparable` one does not.
 */
/** A list number before the first author: "15. ", "[3] ", "(4) ", "4) " (round 30). */
const LIST_NUMBER = /^\s*(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+(?=\p{Lu})/u;

function validateDOIMatch(rawReferenceText: string, crossrefResult: any): MatchValidation {
  // The list number is not part of the reference: "15. Mansournia MA, Nazemipour M" read with
  // it gave the authors "MA" and "AI" (round 30; a real reference list).
  const referenceText = rawReferenceText.replace(LIST_NUMBER, '');
  const refYear = extractYearFromReference(referenceText);
  const crossrefYear = crossrefYearOf(crossrefResult);
  // Year validation: must match within ±1 year (to account for in-press/early access)
  const yearCheck: DoiMatchCheck = !refYear || !crossrefYear
    ? 'not_comparable'
    : Math.abs(refYear - crossrefYear) > 1 ? 'mismatched' : 'matched';

  const read = extractAuthorsFromReference(referenceText);
  // A surname of the uncertain reading with a word that is a word of this record's title may be
  // that title word, so it says nothing about the author: drop it for this record (round 13:
  // the first title word only was tested, so "Hoddy K. The Sleep and ..." or a reordered title
  // still matched a record by an author named Sleep).
  const titleWords = new Set(foldForMatch(crossrefTitle(crossrefResult)).split(' '));
  // A reference that starts with this record's title ("Instrumental Variables Analysis and
  // Mendelian Randomization ... (2024)") names no author before it: a word of that title read
  // as a surname ("Instrumental", the "and" read as joining two authors) is not one (review 11).
  const head = titleSequence(crossrefTitle(crossrefResult)).slice(0, 3);
  const opening = foldForMatch(referenceText).split(' ');
  const titleFirst = head.length >= 2 && head.every((w, i) => opening[i] === w);
  const refAuthors = read.names.filter((r) => !(read.uncertain.has(r) || titleFirst) || !foldForMatch(r).split(' ').some((w) => titleWords.has(w)));
  // A family of one letter is an initial filed as the family ("R" with given "Shakthi Kiran",
  // a common deposit of names written "Shakthi Kiran R"): the surname is then in `given`, and
  // there is no given name to compare. A given in capitals ("SHAKTHI KIRAN") is a written-out
  // name too (round 18: only one with a lower-case letter was moved).
  const crossrefPeople: Array<{ family: string; given: string | null }> = (crossrefResult.author || [])
    .map((a: any) => (typeof a?.family === 'string' && foldForMatch(a.family).replace(/ /g, '').length === 1 && typeof a?.given === 'string' && /\p{Ll}|\p{Lu}{4,}/u.test(a.given)
      ? { family: a.given, given: null }
      : { family: a?.family, given: typeof a?.given === 'string' ? a.given : null }))
    .filter((p: { family: unknown }) => typeof p.family === 'string' && p.family.trim().length > 0);
  const crossrefAuthors = crossrefPeople.map((p) => p.family);
  const words = sectionWords((referenceText.split(/\(\d{4}/)[0] || '').trim());
  // A family name written inside the record's title is not an author, and a title word next to
  // it is not a given name ("WangL. 2014. Wang Group Studies", round 23).
  const titleAt = titleStart(words, crossrefTitle(crossrefResult));
  // 0.2.x read the first word only, judged by its own ASCII reading: an accent can hide a comma
  // pair from it ("Núñez, L"), and then it read the first word (round 28).
  // 0.2.x read the raw text, list number included.
  const read02 = readAs02(rawReferenceText);
  const firstWordRead = read02.firstWord;
  // A family name 0.2.x matched too (a read name and the family hold one another): a given name
  // sharing an initial with the entry agrees, so a spelling ("Mohamed" / "Muhammad", "Piotr" /
  // "Peter") keeps the right record. A family matched only by a reading 0.2.x did not make
  // ("Mark" in "Mark Little, G.") is held to the strict compare (round 26).
  // 0.2.x read no surname at all ("Núñez ..."): it compared no authors, so none is held strict.
  const legacyMatched = (family: string) => read02.names.length === 0 || read02.names.some((n) => {
    const a = n.toLowerCase();
    const b = family.toLowerCase();
    return a.includes(b) || b.includes(a);
  });
  let authorCheck: DoiMatchCheck = 'not_comparable';
  if (refAuthors.length > 0 && crossrefAuthors.length > 0) {
    // Crossref authors none of the reference's surnames can be compared with (Han against
    // Latin ...), and ones that were compared and differ.
    let incomparable = 0;
    let compared = 0;
    authorCheck = 'mismatched';
    // Two or more of the record's authors each open a different author entry: the reference
    // lists them family name first ("Hernandez Ruiz and Lopez Garcia" and a record by Hernandez
    // and Lopez), so their given names are not in it and decide nothing (round 20). A record by
    // one person named like a cited given name ("Mark Little and Grace Collins" and Zoe Mark)
    // opens one entry only.
    const leads = crossrefPeople.map((p) => entryLeads(words, p.family, titleAt));
    // Only where 0.2.x read the first word too, i.e. no "Surname, I." pair: "Mark Little, Grace
    // Collins" against a record by Zoe Mark and Quinn Grace stays vetoed (0.2.x read Little;
    // round 24).
    const familyFirst = firstWordRead && new Set(leads.flat()).size >= 2 && leads.filter((l) => l.length > 0).length >= 2;
    for (const [n, { family: c, given }] of crossrefPeople.entries()) {
      let comparable = false;
      // A family name read where the order is ambiguous matches only when the record's given
      // name agrees with the words written after it (round 17).
      const vetoed = !(familyFirst && leads[n].length > 0) && givenVetoes(words, c, given, firstWordRead, titleAt, !legacyMatched(c));
      for (const r of refAuthors) {
        const m = surnamesMatch(r, c);
        if (m === true && !vetoed) authorCheck = 'matched';
        if (m !== null) comparable = true;
      }
      if (comparable) compared += 1;
      else incomparable += 1;
    }
    // No surname matched: a mismatch when most of the Crossref authors could be compared
    // (round 11: a record listing "Jones" and "李" against a reference by "Smith" was
    // not_comparable and accepted on the title alone); not_comparable when most could not.
    if (authorCheck !== 'matched' && incomparable > compared) authorCheck = 'not_comparable';
  }

  const title = checkTitle(referenceText, crossrefResult, read.names);
  let titleCheck = title.check;
  // A short title (two or three distinctive words) that shares some but too few words, for
  // a candidate whose author AND year matched: the title cannot decide (one changed word is
  // a third or half of it), so it is `not_comparable`, not a rejection (round 11). A short
  // title sharing no word still rejects.
  if (titleCheck === 'mismatched' && title.words <= 3 && title.share > 0 && authorCheck === 'matched' && yearCheck === 'matched') {
    titleCheck = 'not_comparable';
  }
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

    const items = response.data?.message?.items;
    if (!Array.isArray(items)) {
      // A 200 without a result list is no search answer: lookup_failed, not no_match
      // (v0.3.0 review 12).
      outcome.status = 'lookup_failed';
      outcome.errors.push('search: 200 without a result list');
      return;
    }

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
