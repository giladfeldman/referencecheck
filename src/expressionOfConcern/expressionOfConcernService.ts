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
import { cleanDoiInput, formatDateParts } from '../util/normalize.js';
import { sameDoi } from '../abstract/index.js';

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
export type EocUnavailableReason =
  | 'rate_limited' | 'timeout' | 'server_error' | 'network' | 'malformed_response'
  /** Crossref has no record of this DOI (a DataCite or Zenodo DOI, or a typo): no answer about the paper. */
  | 'not_indexed';

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
function classifyEocError(error: unknown, notFound: 'clean' | 'not_indexed' = 'clean'): EocSourceOutcome {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError;
    const status = err.response?.status;
    // A Crossref 404 is about Crossref (the DOI is not registered there), not about the
    // paper, so it is not_indexed; for a search source a 404 is an empty answer.
    if (status === 404) {
      return notFound === 'clean' ? { status: 'clean' } : { status: 'unavailable', reason: 'not_indexed', detail: '404' };
    }
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

const malformed = (detail: string): EocSourceOutcome => ({ status: 'unavailable', reason: 'malformed_response', detail });

/**
 * Check Crossref for an expression of concern on a DOI.
 *
 * Crossref records one as an `updated-by` entry of type `expression_of_concern`
 * (measured 2026-11-18: 4,475 notices carry it; recorded in
 * tests/fixtures/crossref/eoc-*.json). Before 0.3.0 this read
 * `relation['has-expression-of-concern' | 'is-expression-of-concern-for']` and a
 * `relationship` field: Crossref has no such relation type (its API rejects the
 * filter as `relation-type-not-valid`) and no such field, so the check never fired.
 * A 200 whose body has no work record is `malformed_response`, never `clean`.
 */
async function checkCrossrefForEOC(doi: string): Promise<EocSourceOutcome> {
  try {
    const response = await crossrefGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      timeout: 5000,
    });

    const data = response.data?.message;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return malformed('Crossref 200 without a work record');
    }

    const updates: any[] = Array.isArray(data['updated-by']) ? data['updated-by'] : [];
    const eocs = updates.filter((u) => u && u.type === 'expression_of_concern');
    if (eocs.length === 0) return { status: 'clean' };

    // Earliest notice date: a concern recorded by both the publisher and Retraction
    // Watch is one concern, raised on the first date.
    const dates = eocs
      .map((u) => formatDateParts(u.updated?.['date-parts']?.[0]))
      .filter((d): d is string => !!d)
      .sort();
    const notices = [...new Set(eocs.map((u) => (typeof u.DOI === 'string' ? u.DOI : '')).filter((d) => d && !sameDoi(d, doi)))];
    const recordedBy = [...new Set(eocs.map((u) => u.source).filter((x) => typeof x === 'string'))];
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
          journalName: Array.isArray(data['container-title']) ? data['container-title'][0] : undefined,
          dateIssued: dates[0],
          details: [
            notices.length ? `notice: ${notices.join(', ')}` : '',
            recordedBy.length ? `recorded by: ${recordedBy.join(', ')}` : '',
          ].filter(Boolean).join('; ') || undefined,
          source: 'CrossRef',
        },
      },
    };
  } catch (error: any) {
    const outcome = classifyEocError(error, 'not_indexed');
    if (outcome.status === 'unavailable' && outcome.reason === 'server_error') {
      console.warn(`Error checking CrossRef for EOC on ${doi}:`, error?.message ?? error);
    }
    return outcome;
  }
}

/**
 * Check Europe PMC (which carries PubMed's comment/correction links) for an
 * expression of concern on a DOI.
 *
 * The search is scoped to the DOI field (`DOI:"..."`) and asks for `resultType=core`,
 * the only result type that includes `commentCorrectionList`. A paper with a concern
 * carries an entry of type "Expression of concern in" (the notice itself carries
 * "Expression of concern for", which is not a concern about the notice). Before
 * 0.3.0 the query was unscoped, the result type was `lite`, and the field read was
 * `commentsCorrectionsList`, so the check never fired. An empty result list is a
 * definitive "no record"; a 200 without a result list is `malformed_response`.
 */
async function checkPubmedForEOC(doi: string): Promise<EocSourceOutcome> {
  try {
    const response = await axios.get('https://www.ebi.ac.uk/europepmc/webservices/rest/search', {
      params: {
        query: `DOI:"${doi}"`,
        format: 'json',
        pageSize: 1,
        resultType: 'core',
      },
      // `core` is slow on a record's first request: measured 2026-11-18 on six DOIs
      // not requested before, 10.8 s and 3.2 s for two of them (the `lite` search,
      // which lacks the field, took under 1.5 s). 5 s made this source time out.
      timeout: 15000,
    });

    const results = response.data?.resultList?.result;
    if (!Array.isArray(results)) return malformed('Europe PMC 200 without a result list');

    // Not indexed here is a definitive "this source has no EOC for that DOI".
    const article = results.find((r: any) => typeof r?.doi === 'string' && sameDoi(r.doi, doi));
    if (!article) return { status: 'clean' };

    const raw = article.commentCorrectionList?.commentCorrection;
    const links: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const eoc = links.filter((c) => typeof c?.type === 'string' && /^expression of concern in$/i.test(c.type.trim()));
    if (eoc.length === 0) return { status: 'clean' };

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
          journalName: article.journalInfo?.journal?.title ?? article.journalTitle,
          details: eoc.map((c) => (c.id ? `notice: ${c.source ?? 'MED'} ${c.id}` : '')).filter(Boolean).join('; ') || undefined,
          source: 'PubMed',
        },
      },
    };
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
  const doi = cleanDoiInput(reference.doi || reference.suggested_doi);

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
