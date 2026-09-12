/**
 * Retraction Detection Service
 * Checks if papers have been retracted using Crossref (and, optionally, the
 * OpenRetractions index).
 *
 * ## "Not retracted" and "could not check" are different answers (2026-09-10)
 *
 * `checkRetraction` returned `{ isRetracted: false }` for a Crossref **429 or
 * timeout** as well as for a genuine clean answer, and callers read the boolean
 * bare. So a rate-limit storm printed a clean bibliography over references
 * nobody had successfully looked up — a retraction check that silently passes
 * when it did not run, on a tool whose whole purpose is that check.
 *
 * This is the SAME defect v0.1.2 already fixed one directory away, for
 * Expression of Concern (see expressionOfConcernService.ts). The remedy is the
 * idiom EOC already uses, so the two paths now read alike: a per-source outcome,
 * a `checked` flag, and a `checkRetractionDetailed` that names which sources
 * answered. The v0.1.2 CHANGELOG records **81 Crossref 429s in a single real
 * SciMeto run**, so this failure mode is measured, not hypothetical.
 *
 * ## The Crossref path was reading a field Crossref does not serve (v0.1.4)
 *
 * v0.1.3 shipped those coverage flags over detection code that could never
 * fire. It read `message.update`; the field Crossref actually serves is
 * `message['updated-by']`. Measured against the live API on 2026-09-12:
 *
 *   | DOI                            | `update`  | `updated-by`                   |
 *   |--------------------------------|-----------|--------------------------------|
 *   | 10.1016/S0140-6736(97)11096-0  | undefined | type:"retraction" (+ correction) |
 *   | 10.1126/science.1256151        | undefined | type:"retraction"              |
 *   | 10.1038/nature12373 (control)  | undefined | undefined                      |
 *
 * The suite was green because the test hard-coded the fictional field. A
 * synthetic fixture cannot tell you the rule is wrong, only that your fixture
 * is; the tests now run on verbatim recorded Crossref bodies (see
 * `tests/fixtures/crossref/`).
 *
 * Three further measurements shaped this file, all taken 2026-09-12:
 *
 * 1. On a 14-work corpus of genuinely retracted papers drawn from Crossref's own
 *    `update-type:retraction` filter, `updated-by` carried a retraction entry on
 *    **14 of 14**, while a capitalised "RETRACTED"/"WITHDRAWN" title prefix
 *    appeared on only **9 of 14**. Title matching is a fallback, never the rule.
 * 2. A Crossref search for meta-science papers ABOUT retraction returned **8 of
 *    8** healthy papers whose titles contain "retract" ("Retracted Publications
 *    in Indian Science", and so on). The old `title.includes('retract')`
 *    substring test reports every one of them as RETRACTED. That is precisely
 *    the literature this library's users cite, so the title test is now a
 *    case-SENSITIVE publisher-marker prefix.
 * 3. `type:retraction` is **not a Crossref work type**: the filter returns HTTP
 *    400 where `type:journal-article` returns 200 over 123M works, and the
 *    `/types` registry contains no such id. The old `message.type ===
 *    'retraction'` branch was therefore dead. It is gone.
 *
 * ## `update-to` points the other way — do not read it as a retraction
 *
 * Also measured 2026-09-12: the LaCour retraction notice
 * (10.1126/science.aac6638) carries `update-to` naming the paper it retracts,
 * and no `updated-by`. So `update-to` on a work means "this work retracts
 * something else". Reading it as evidence about the queried DOI would invert the
 * relation and report every retraction notice as a retracted paper.
 *
 * ## Why OpenRetractions is off by default
 *
 * `api.openretractions.com` does not resolve. Measured 2026-09-12: `EAI_AGAIN`
 * on both `api.openretractions.com` and `openretractions.com`, while
 * `api.crossref.org` resolved on the same call. Under the strict completeness
 * rule below, leaving it in the default source list would mark **every** lookup
 * incomplete forever — an alarm that fires on every reference tells a reader
 * nothing, and would drown the genuine Crossref failures it exists to surface.
 *
 * Dropping it costs no coverage: Crossref's `updated-by` entries carry
 * `source: "retraction-watch"`, so Crossref now relays the same Retraction Watch
 * data OpenRetractions was built on, and it detected 14 of 14 in the corpus
 * above. The source is not deleted — pass `sources` to re-enable it if the host
 * returns — and `sourcesChecked` on every result records which sources actually
 * produced the answer, so the substitution is never silent.
 */

import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';
import type { MetadataCredentials } from '../http/credentials.js';

export type RetractionUnavailableReason =
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network';

/** The sources this module knows how to consult. */
export type RetractionSourceName = 'openretractions' | 'crossref';

export interface RetractionSourceUnavailable {
  source: RetractionSourceName;
  reason: RetractionUnavailableReason;
  detail?: string;
}

/**
 * Sources consulted when the caller does not say otherwise.
 *
 * OpenRetractions is deliberately absent — see the note at the top of this file.
 * Pass `{ sources: ['openretractions', 'crossref'] }` to consult it anyway.
 */
export const DEFAULT_RETRACTION_SOURCES: readonly RetractionSourceName[] = ['crossref'];

export interface RetractionCheckOptions {
  /**
   * Crossref polite-pool identity. Without it the shared client falls back to
   * `DEFAULT_POLITE_EMAIL`, so a consumer's own `CROSSREF_EMAIL` never reaches
   * Crossref and the request is attributed to the library rather than to the
   * caller. Mirrors `validateDOI(doi, creds)`.
   */
  creds?: MetadataCredentials;
  /** Which sources to consult. Defaults to {@link DEFAULT_RETRACTION_SOURCES}. */
  sources?: readonly RetractionSourceName[];
}

export interface RetractionInfo {
  isRetracted: boolean;
  /**
   * True only when every source consulted actually answered. **Read this before
   * trusting `isRetracted === false`**: false + `checked: false` means "we never
   * got an answer", which is not the same claim as "this paper is not retracted".
   */
  checked: boolean;
  /**
   * Sources that answered — the only basis for a "not retracted" claim, and the
   * record of which source actually produced this result.
   */
  sourcesChecked: RetractionSourceName[];
  /** Every source that could not be reached, and why. Empty when all answered. */
  sourcesUnavailable: RetractionSourceUnavailable[];
  retractionDate?: string;
  retractionReason?: string;
  retractionNoticeUrl?: string;
  originalPaperDOI?: string;
  source?: RetractionSourceName;
}

/**
 * Classify a thrown request error into "the source answered 'no'" versus
 * "the source never answered". A 404 from either API is a real answer: the DOI
 * is not in that retraction index. A 429, a timeout, a 5xx or a socket error
 * is not an answer at all.
 */
function classifyRequestFailure(
  source: RetractionSourceName,
  error: any
): RetractionSourceUnavailable | null {
  const status = error?.response?.status;
  if (status === 404) return null; // answered: not in this index
  if (status === 429) return { source, reason: 'rate_limited', detail: '429' };
  if (typeof status === 'number' && status >= 500) {
    return { source, reason: 'server_error', detail: String(status) };
  }
  const code = error?.code;
  if (code === 'ECONNABORTED' || /timeout/i.test(String(error?.message ?? ''))) {
    return { source, reason: 'timeout' };
  }
  return { source, reason: 'network', detail: code ?? error?.message };
}

// OpenRetractions API (free, open source). Off by default — see the file header.
const OPEN_RETRACTIONS_API = 'https://api.openretractions.com/doi';

/**
 * A publisher's retraction marker on a title, as an ALL-CAPS prefix:
 * "RETRACTED: …", "RETRACTED ARTICLE: …", "WITHDRAWN: …".
 *
 * Case-SENSITIVE on purpose. The lower-case forms belong to healthy papers
 * about retraction ("Retracted Publications in Indian Science: Reasons and
 * Institutions", a real 2025 article), which the previous substring match
 * reported as retracted. This only ever runs as a fallback after `updated-by`.
 */
const RETRACTION_TITLE_MARKER = /^\s*(?:RETRACTED|WITHDRAWN)\b/;

/**
 * Find the retraction entry in a Crossref work's `updated-by` relations.
 *
 * `updated-by` is a LIST of every notice that updates this work, and a retracted
 * paper commonly carries corrections alongside the retraction — Wakefield 1998
 * has a 2004 correction at index 0 and the 2010 retraction at index 1 — so this
 * selects by type rather than taking the first entry.
 */
function findRetractionRelation(message: any): any | null {
  const updatedBy = message?.['updated-by'];
  if (!Array.isArray(updatedBy)) return null;
  return (
    updatedBy.find(
      (u: any) =>
        u?.type === 'retraction' ||
        (typeof u?.label === 'string' && u.label.toLowerCase().includes('retract'))
    ) ?? null
  );
}

/** Crossref dates the relation with `updated`; older/derived records use `date`. */
function relationDate(relation: any): string | undefined {
  const parts =
    relation?.updated?.['date-parts']?.[0] ?? relation?.date?.['date-parts']?.[0];
  return Array.isArray(parts) ? parts.join('-') : undefined;
}

/**
 * Check if a paper has been retracted.
 *
 * @param doi     The DOI to check, with or without a doi.org prefix.
 * @param options Polite-pool credentials and the source list. Optional, so the
 *                published single-argument signature keeps working.
 */
export async function checkRetraction(
  doi: string,
  options: RetractionCheckOptions = {}
): Promise<RetractionInfo> {
  const { creds, sources = DEFAULT_RETRACTION_SOURCES } = options;

  // Clean DOI
  const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
  const sourcesChecked: RetractionSourceName[] = [];
  const sourcesUnavailable: RetractionSourceUnavailable[] = [];

  // OpenRetractions — only when the caller asked for it (see the file header).
  if (sources.includes('openretractions')) {
    try {
      const response = await axios.get(
        `${OPEN_RETRACTIONS_API}/${encodeURIComponent(cleanDOI)}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 5000,
        }
      );

      if (response.status === 200 && response.data) {
        const data = response.data;
        sourcesChecked.push('openretractions');

        if (data.retracted === true) {
          return {
            isRetracted: true,
            checked: true,
            sourcesChecked,
            sourcesUnavailable,
            retractionDate: data.retraction_date,
            retractionReason: data.reason,
            retractionNoticeUrl: data.retraction_notice_url,
            originalPaperDOI: cleanDOI,
            source: 'openretractions',
          };
        }
      }
    } catch (error: any) {
      // A 404 here is an ANSWER (this DOI is not in the OpenRetractions index);
      // a 429, timeout, 5xx or socket error is not, and must not be allowed to
      // read as one further down.
      const unavailable = classifyRequestFailure('openretractions', error);
      if (unavailable) sourcesUnavailable.push(unavailable);
      else sourcesChecked.push('openretractions');

      // Silently fall back to Crossref (don't log routine network errors).
      if (
        error.code !== 'ECONNABORTED' &&
        error.code !== 'EAI_AGAIN' &&
        error.response?.status !== 404
      ) {
        console.warn('OpenRetractions check failed:', error.message);
      }
    }
  }

  // Crossref — the primary source. Its `updated-by` relations relay Retraction
  // Watch data.
  if (sources.includes('crossref')) {
    try {
      const crossrefResponse = await crossrefGet(
        `https://api.crossref.org/works/${encodeURIComponent(cleanDOI)}`,
        { timeout: 5000 },
        creds
      );

      if (crossrefResponse.status === 200) {
        const message = crossrefResponse.data?.message ?? {};
        sourcesChecked.push('crossref');

        // The real relation key. NOT `update` (which Crossref does not serve)
        // and NOT `update-to` (which names what THIS work retracts).
        const retractionRelation = findRetractionRelation(message);

        if (retractionRelation) {
          return {
            isRetracted: true,
            checked: sourcesUnavailable.length === 0,
            sourcesChecked,
            sourcesUnavailable,
            retractionDate: relationDate(retractionRelation),
            retractionReason: retractionRelation.label || 'Retracted',
            retractionNoticeUrl: retractionRelation.DOI
              ? `https://doi.org/${retractionRelation.DOI}`
              : undefined,
            originalPaperDOI: cleanDOI,
            source: 'crossref',
          };
        }

        // Fallback: some publishers stamp the marker on the title before the
        // relation propagates. It catches roughly two thirds of retractions on
        // its own, so it supplements the check above and never replaces it.
        const titles: unknown[] = Array.isArray(message.title) ? message.title : [];
        if (
          titles.some((t) => typeof t === 'string' && RETRACTION_TITLE_MARKER.test(t))
        ) {
          return {
            isRetracted: true,
            checked: sourcesUnavailable.length === 0,
            sourcesChecked,
            sourcesUnavailable,
            retractionDate: message.published?.['date-parts']?.[0]?.join('-'),
            retractionReason: 'Title carries a publisher retraction marker',
            originalPaperDOI: cleanDOI,
            source: 'crossref',
          };
        }
      }
    } catch (error: any) {
      // A 429 or a timeout used to `return { isRetracted: false }` right here,
      // so "Crossref refused to talk to us" and "Crossref says this paper is
      // fine" produced byte-identical results.
      const unavailable = classifyRequestFailure('crossref', error);
      if (unavailable) sourcesUnavailable.push(unavailable);
      else sourcesChecked.push('crossref');

      // Only log unexpected errors (5xx server errors)
      if (error.response?.status && error.response.status >= 500) {
        console.warn('Crossref retraction check failed:', error.message);
      }
    }
  }

  // No source reported a retraction. Whether that is a clean answer or a
  // silence depends entirely on whether everything we asked actually answered —
  // whichever source fell over. Anything weaker re-opens the false clean this
  // module exists to prevent.
  return {
    isRetracted: false,
    checked: sourcesUnavailable.length === 0,
    sourcesChecked,
    sourcesUnavailable,
    originalPaperDOI: cleanDOI,
    source: sourcesChecked.includes('crossref') ? 'crossref' : undefined,
  };
}

/**
 * The same check, with the coverage question answered explicitly.
 *
 * Prefer this in anything that renders a verdict to a reader. `complete` is
 * false whenever any source failed to answer, and `sourcesUnavailable` says
 * which and why — so a rate-limit storm surfaces as "unchecked" instead of as
 * a clean bibliography. Mirrors `checkReferenceForEOCDetailed`.
 */
export async function checkRetractionDetailed(
  doi: string,
  options: RetractionCheckOptions = {}
): Promise<{
  retraction: RetractionInfo;
  complete: boolean;
  sourcesUnavailable: RetractionSourceUnavailable[];
}> {
  const retraction = await checkRetraction(doi, options);
  return {
    retraction,
    // `complete` means "every source answered", full stop. It used to read
    // `retraction.isRetracted || retraction.checked`, which called a result
    // complete on a positive finding even when another index had gone unread,
    // and contradicted this function's own docstring. Matches
    // expressionOfConcernService.ts.
    complete: retraction.sourcesUnavailable.length === 0,
    sourcesUnavailable: retraction.sourcesUnavailable,
  };
}

/**
 * Batch check multiple DOIs for retractions
 */
export async function checkMultipleRetractions(
  dois: string[],
  options: RetractionCheckOptions = {}
): Promise<Map<string, RetractionInfo>> {
  const results = new Map<string, RetractionInfo>();

  // Process in batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < dois.length; i += batchSize) {
    const batch = dois.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (doi) => {
        const info = await checkRetraction(doi, options);
        return { doi, info };
      })
    );

    batchResults.forEach(({ doi, info }) => {
      results.set(doi, info);
    });

    // Rate limiting: wait 1 second between batches
    if (i + batchSize < dois.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}
