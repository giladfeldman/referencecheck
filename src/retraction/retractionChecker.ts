/**
 * Retraction Detection Service
 * Checks if papers have been retracted using OpenRetractions API and Crossref
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
 * Expression of Concern (see expressionOfConcernService.ts). That fix was not
 * carried across to the retraction path, and the retraction path had **zero**
 * test files against Expression of Concern's 19 test references — a two-sided
 * control that says the gap was in coverage, not in the search for it. The
 * v0.1.2 CHANGELOG records **81 Crossref 429s in a single real SciMeto run**,
 * so this failure mode is measured, not hypothetical.
 *
 * The remedy is the idiom EOC already uses, so the two paths now read alike:
 * a discriminated per-source outcome, a `checked` flag on the result, and a
 * `checkRetractionDetailed` that names which sources answered. `checkRetraction`
 * keeps its published signature — this library is consumed by SciMeto through
 * the barrel, so the shape may be ADDED to but not broken — while gaining the
 * fields that make a silent false clean impossible to read as a clean.
 */

import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';

export type RetractionUnavailableReason =
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network';

export interface RetractionSourceUnavailable {
  source: 'openretractions' | 'crossref';
  reason: RetractionUnavailableReason;
  detail?: string;
}

export interface RetractionInfo {
  isRetracted: boolean;
  /**
   * True only when a source actually answered. **Read this before trusting
   * `isRetracted === false`**: false + `checked: false` means "we never got an
   * answer", which is not the same claim as "this paper is not retracted".
   */
  checked: boolean;
  /** Every source that could not be reached, and why. Empty when all answered. */
  sourcesUnavailable: RetractionSourceUnavailable[];
  retractionDate?: string;
  retractionReason?: string;
  retractionNoticeUrl?: string;
  originalPaperDOI?: string;
  source?: 'openretractions' | 'crossref';
}

/**
 * Classify a thrown request error into "the source answered 'no'" versus
 * "the source never answered". A 404 from either API is a real answer: the DOI
 * is not in that retraction index. A 429, a timeout, a 5xx or a socket error
 * is not an answer at all.
 */
function classifyRequestFailure(
  source: 'openretractions' | 'crossref',
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

// OpenRetractions API (free, open source)
const OPEN_RETRACTIONS_API = 'https://api.openretractions.com/doi';

/**
 * Check if a paper has been retracted
 */
export async function checkRetraction(doi: string): Promise<RetractionInfo> {
  // Clean DOI
  const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
  const sourcesUnavailable: RetractionSourceUnavailable[] = [];

  // Try OpenRetractions first (free, open)
  try {


    const response = await axios.get(`${OPEN_RETRACTIONS_API}/${encodeURIComponent(cleanDOI)}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 5000, // Reduced timeout to 5 seconds
    });



    if (response.status === 200 && response.data) {
      const data = response.data;

      if (data.retracted === true) {
        return {
          isRetracted: true,
          checked: true,
          sourcesUnavailable: [],
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

    // OpenRetractions might not have the DOI or network issues
    // Silently fall back to Crossref (don't log network errors as warnings)
    if (error.code !== 'ECONNABORTED' && error.code !== 'EAI_AGAIN' && error.response?.status !== 404) {
      console.warn('OpenRetractions check failed:', error.message);
    }
  }

  // Fallback: Check Crossref for retraction notices
  try {


    const crossrefResponse = await crossrefGet(
      `https://api.crossref.org/works/${encodeURIComponent(cleanDOI)}`,
      { timeout: 5000 }
    );



    if (crossrefResponse.status === 200) {
      const data = crossrefResponse.data;
      const message = data.message;

      // Check for retraction updates
      const updates = message.update || [];
      const retractionUpdate = updates.find((u: any) =>
        u.type === 'retraction' ||
        (u.label && u.label.toLowerCase().includes('retract'))
      );

      if (retractionUpdate) {
        return {
          isRetracted: true,
          checked: true,
          sourcesUnavailable,
          retractionDate: retractionUpdate.date?.['date-parts']?.[0]?.join('-'),
          retractionReason: retractionUpdate.label || 'Retracted',
          retractionNoticeUrl: retractionUpdate.DOI ? `https://doi.org/${retractionUpdate.DOI}` : undefined,
          originalPaperDOI: cleanDOI,
          source: 'crossref',
        };
      }

      // Check if the work itself is a retraction notice
      if (message.type === 'retraction' ||
        (message.title && message.title.some((t: string) =>
          t.toLowerCase().includes('retraction') ||
          t.toLowerCase().includes('retract')
        ))) {
        return {
          isRetracted: true,
          checked: true,
          sourcesUnavailable,
          retractionDate: message.published?.['date-parts']?.[0]?.join('-'),
          retractionReason: 'Retraction notice',
          originalPaperDOI: cleanDOI,
          source: 'crossref',
        };
      }
      // Crossref answered and named no retraction. This is the ONE definitive
      // negative in the function.
      return {
        isRetracted: false,
        checked: true,
        sourcesUnavailable,
        originalPaperDOI: cleanDOI,
        source: 'crossref',
      };
    }
  } catch (error: any) {
    // THIS WAS THE DEFECT. A 429 or a timeout used to `return { isRetracted:
    // false }` right here, so "Crossref refused to talk to us" and "Crossref
    // says this paper is fine" produced byte-identical results, and the caller
    // read the boolean bare.
    const unavailable = classifyRequestFailure('crossref', error);
    if (unavailable) sourcesUnavailable.push(unavailable);

    // Only log unexpected errors (5xx server errors)
    if (error.response?.status && error.response.status >= 500) {
      console.warn('Crossref retraction check failed:', error.message);
    }
  }

  // Neither source reported a retraction. Whether that is a clean answer or a
  // silence depends entirely on whether anything actually answered.
  return {
    isRetracted: false,
    checked: sourcesUnavailable.length === 0,
    sourcesUnavailable,
    originalPaperDOI: cleanDOI,
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
export async function checkRetractionDetailed(doi: string): Promise<{
  retraction: RetractionInfo;
  complete: boolean;
  sourcesUnavailable: RetractionSourceUnavailable[];
}> {
  const retraction = await checkRetraction(doi);
  return {
    retraction,
    complete: retraction.isRetracted || retraction.checked,
    sourcesUnavailable: retraction.sourcesUnavailable,
  };
}

/**
 * Batch check multiple DOIs for retractions
 */
export async function checkMultipleRetractions(
  dois: string[]
): Promise<Map<string, RetractionInfo>> {
  const results = new Map<string, RetractionInfo>();

  // Process in batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < dois.length; i += batchSize) {
    const batch = dois.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (doi) => {
        const info = await checkRetraction(doi);
        return { doi, info };
      })
    );

    batchResults.forEach(({ doi, info }) => {
      results.set(doi, info);
    });

    // Rate limiting: wait 1 second between batches
    if (i + batchSize < dois.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}
