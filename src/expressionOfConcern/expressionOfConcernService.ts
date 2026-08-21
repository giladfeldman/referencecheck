/**
 * Expression of Concern Detection Service
 * Detects papers with formal expressions of concern from journals
 * Expressions of concern are issued when there are concerns about a paper
 * but it hasn't been retracted yet
 *
 * ## "Clean" and "could not check" are different answers (v0.1.2, 2026-08-21)
 *
 * Every source function used to return `ExpressionOfConcernIssue | null`, and
 * `null` meant all of: no expression of concern, DOI not found, rate limited,
 * server error, timeout. A caller could not tell "we asked and there is nothing"
 * from "we never got an answer", so a Crossref rate-limit storm rendered an entire
 * bibliography clean.
 *
 * That is not hypothetical. Measured on the Scimeto platform, 2026-08-21: a single
 * real document run logged **81 Crossref 429s** while the Expression-of-Concern
 * plugin recorded `outcome: completed, issuesFound: 0, referencesChecked: 56`. The
 * user was shown an all-clear over references nobody had successfully looked up.
 *
 * The sources now return a discriminated `EocSourceOutcome`, and
 * `checkReferenceForEOCDetailed` reports which sources answered and which did not.
 * `checkReferenceForEOC` keeps its original signature for existing callers.
 */

import type { ReferenceInput } from '../types.js';
import axios, { AxiosError } from 'axios';
import { crossrefGet } from '../http/crossref.js';

export interface ExpressionOfConcernIssue {
  type: 'expression-of-concern';
  severity: 'warning' | 'error';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  affectedText?: string;
  metadata?: {
    doi?: string;
    journalName?: string;
    dateIssued?: string;
    details?: string;
    source?: string;
  };
}

/** Why a source could not answer. Every value here means "we do not know". */
export type EocUnavailableReason = 'rate_limited' | 'timeout' | 'server_error' | 'network';

/**
 * One source's verdict for one DOI.
 *
 * `clean` is a POSITIVE finding — the source was reached and reports no expression
 * of concern. `unavailable` means the source was never reached, which is a
 * different fact and must never be rendered as `clean`.
 */
export type EocSourceOutcome =
  | { status: 'clean' }
  | { status: 'issue'; issue: ExpressionOfConcernIssue }
  | { status: 'unavailable'; reason: EocUnavailableReason; detail?: string };

/** What one source reported, with its name attached. */
export interface EocSourceReport {
  source: string;
  reason: EocUnavailableReason;
  detail?: string;
}

/** Result of checking one reference across every source. */
export interface EocReferenceResult {
  issues: ExpressionOfConcernIssue[];
  /** Sources that actually answered — the only basis for a "no concerns" claim. */
  sourcesChecked: string[];
  /** Sources that did not answer, and why. */
  sourcesUnavailable: EocSourceReport[];
  /**
   * True only when EVERY source answered. When false, an empty `issues` array
   * means "we did not find out", NOT "there is nothing to find". Callers that
   * report coverage to a user must branch on this.
   */
  complete: boolean;
}

/**
 * Classify a thrown error into a source outcome.
 *
 * The distinction that matters: a 404 is a DEFINITIVE negative — the source was
 * reached and holds no record of an expression of concern for this DOI — while a
 * 429, a 5xx or a timeout means the source never answered at all.
 */
function classifyEocError(error: unknown): EocSourceOutcome {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError;
    const status = err.response?.status;
    if (status === 404) return { status: 'clean' };
    if (status === 429) return { status: 'unavailable', reason: 'rate_limited', detail: '429' };
    if (status !== undefined && status >= 500) {
      return { status: 'unavailable', reason: 'server_error', detail: String(status) };
    }
    if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message ?? '')) {
      return { status: 'unavailable', reason: 'timeout' };
    }
    return { status: 'unavailable', reason: 'network', detail: err.code ?? err.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) return { status: 'unavailable', reason: 'timeout' };
  return { status: 'unavailable', reason: 'network', detail: message };
}

/**
 * Check if a DOI has an expression of concern via CrossRef API
 */
async function checkCrossrefForEOC(doi: string): Promise<EocSourceOutcome> {
  try {
    const response = await crossrefGet(`https://api.crossref.org/works/${doi}`, {
      timeout: 5000,
    });

    const data = response.data?.message || {};

    // Check for relations that indicate expression of concern
    const relations = data.relation || {};

    // Check for 'is-expression-of-concern-for' or 'has-expression-of-concern'
    if (
      relations['is-expression-of-concern-for'] ||
      relations['has-expression-of-concern']
    ) {
      return {
        status: 'issue',
        issue: {
          type: 'expression-of-concern',
          severity: 'warning',
          code: 'EOC_DETECTED',
          description: 'This paper has an expression of concern from the journal',
          location: doi,
          suggestion: 'Review the expression of concern and contact the authors if needed',
          metadata: {
            doi,
            journalName: data['container-title']?.[0],
            dateIssued: data['issued']?.['date-parts']?.[0]?.join('-'),
            source: 'CrossRef',
          },
        },
      };
    }

    // Check for withdrawal or correction notices
    if (data.type === 'journal-article' && data.relationship) {
      const hasWarningRelation = data.relationship.some((rel: any) =>
        ['is-corrected-by', 'is-expression-of-concern-for'].includes(rel.type)
      );

      if (hasWarningRelation) {
        return {
          status: 'issue',
          issue: {
            type: 'expression-of-concern',
            severity: 'warning',
            code: 'CORRECTION_NOTICE',
            description: 'This paper has a correction or concern notice',
            location: doi,
            metadata: {
              doi,
              source: 'CrossRef',
            },
          },
        };
      }
    }

    return { status: 'clean' };
  } catch (error: any) {
    const outcome = classifyEocError(error);
    if (outcome.status === 'unavailable' && outcome.reason === 'server_error') {
      console.warn(`Error checking CrossRef for EOC on ${doi}:`, error?.message ?? error);
    }
    return outcome;
  }
}

/**
 * Check PubMed for expression of concern notices
 */
async function checkPubmedForEOC(doi: string): Promise<EocSourceOutcome> {
  try {
    // Extract PMID from DOI via Europe PubMed Central API
    const response = await axios.get('https://www.ebi.ac.uk/europepmc/webservices/rest/search', {
      params: {
        query: doi,
        format: 'json',
        pageSize: 1,
      },
      timeout: 5000,
    });

    const results = response.data?.resultList?.result || [];

    // Not indexed here is a definitive "this source has no EOC for that DOI".
    if (results.length === 0) {
      return { status: 'clean' };
    }

    const article = results[0];

    // Check for EOC indicator in comments
    if (
      article.commentsCorrectionsList?.some(
        (item: any) => item.type === 'ExpressionOfConcern'
      )
    ) {
      return {
        status: 'issue',
        issue: {
          type: 'expression-of-concern',
          severity: 'warning',
          code: 'EOC_PUBMED',
          description: 'PubMed records an expression of concern for this paper',
          location: article.pmid || doi,
          metadata: {
            doi,
            journalName: article.journalTitle,
            dateIssued: article.pubYear,
            source: 'PubMed',
          },
        },
      };
    }

    return { status: 'clean' };
  } catch (error) {
    const outcome = classifyEocError(error);
    if (outcome.status === 'unavailable' && outcome.reason === 'server_error') {
      console.warn(`Error checking PubMed for EOC on ${doi}:`, (error as Error)?.message ?? error);
    }
    return outcome;
  }
}

/**
 * Check a list of known expression of concern DOIs.
 *
 * Not implemented — there is no maintained list wired up. It reports `clean`
 * rather than `unavailable` because a list that does not exist cannot be
 * unreachable, and marking every reference incomplete over an unimplemented
 * source would make `complete` permanently false and therefore meaningless.
 */
async function checkKnownEOCList(_doi: string): Promise<EocSourceOutcome> {
  return { status: 'clean' };
}

const SOURCES: Array<{ name: string; check: (doi: string) => Promise<EocSourceOutcome> }> = [
  { name: 'CrossRef', check: checkCrossrefForEOC },
  { name: 'PubMed', check: checkPubmedForEOC },
  { name: 'KnownList', check: checkKnownEOCList },
];

/**
 * Comprehensive expression of concern check for a reference, reporting COVERAGE
 * as well as findings.
 *
 * Prefer this over `checkReferenceForEOC` anywhere the result is shown to a user:
 * an empty `issues` array with `complete: false` is not an all-clear, and only
 * this signature can say so.
 */
export async function checkReferenceForEOCDetailed(
  reference: ReferenceInput
): Promise<EocReferenceResult> {
  const doi = reference.doi || reference.suggested_doi;

  // No DOI is not a failure to check — there is nothing to look up. `complete`
  // stays true so a bibliography of DOI-less references is not reported as
  // partially checked; the CALLER decides whether such a reference is in scope.
  if (!doi) {
    return { issues: [], sourcesChecked: [], sourcesUnavailable: [], complete: true };
  }

  const outcomes = await Promise.all(SOURCES.map(async (s) => {
    try {
      return { name: s.name, outcome: await s.check(doi) };
    } catch (error) {
      // A source function should never throw — it classifies its own errors. If
      // one ever does, that is still "we did not get an answer", not "clean".
      return { name: s.name, outcome: classifyEocError(error) };
    }
  }));

  const issues: ExpressionOfConcernIssue[] = [];
  const sourcesChecked: string[] = [];
  const sourcesUnavailable: EocSourceReport[] = [];

  for (const { name, outcome } of outcomes) {
    if (outcome.status === 'unavailable') {
      sourcesUnavailable.push({ source: name, reason: outcome.reason, detail: outcome.detail });
      continue;
    }
    sourcesChecked.push(name);
    if (outcome.status === 'issue') issues.push(outcome.issue);
  }

  return {
    issues,
    sourcesChecked,
    sourcesUnavailable,
    complete: sourcesUnavailable.length === 0,
  };
}

/**
 * Comprehensive expression of concern check for a reference.
 *
 * Back-compatible signature: returns findings only. It CANNOT distinguish "no
 * expression of concern" from "no source answered" — that is the whole reason
 * `checkReferenceForEOCDetailed` exists. Use this only where coverage genuinely
 * does not matter.
 */
export async function checkReferenceForEOC(
  reference: ReferenceInput
): Promise<ExpressionOfConcernIssue[]> {
  return (await checkReferenceForEOCDetailed(reference)).issues;
}

/**
 * Get severity counts for summary
 */
export function getSeverityCounts(issues: ExpressionOfConcernIssue[]): {
  errors: number;
  warnings: number;
} {
  return {
    errors: issues.filter(i => i.severity === 'error').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
  };
}
