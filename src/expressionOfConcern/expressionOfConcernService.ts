/**
 * Expression of Concern Detection Service
 * Detects papers with formal expressions of concern from journals
 * Expressions of concern are issued when there are concerns about a paper
 * but it hasn't been retracted yet
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

/**
 * Check if a DOI has an expression of concern via CrossRef API
 * Handles rate limiting (429) with retry logic
 */
async function checkCrossrefForEOC(doi: string): Promise<ExpressionOfConcernIssue | null> {
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
      };
    }

    // Check for withdrawal or correction notices
    if (data.type === 'journal-article' && data.relationship) {
      const hasWarningRelation = data.relationship.some((rel: any) =>
        ['is-corrected-by', 'is-expression-of-concern-for'].includes(rel.type)
      );

      if (hasWarningRelation) {
        return {
          type: 'expression-of-concern',
          severity: 'warning',
          code: 'CORRECTION_NOTICE',
          description: 'This paper has a correction or concern notice',
          location: doi,
          metadata: {
            doi,
            source: 'CrossRef',
          },
        };
      }
    }

    return null;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      // 404 is expected - DOI not found, not an error
      if (error.response?.status === 404) return null;
      // 429 / 5xx after retries - silently fail (rate limit is temporary)
      if (error.response?.status === 429) return null;
      if (error.response?.status && error.response.status >= 500) {
        console.warn(`Error checking CrossRef for EOC on ${doi}:`, error.message);
      }
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes('timeout')) {
        console.warn(`Unexpected error checking CrossRef for EOC on ${doi}:`, error);
      }
    }
    return null;
  }
}

/**
 * Check PubMed for expression of concern notices
 */
async function checkPubmedForEOC(doi: string): Promise<ExpressionOfConcernIssue | null> {
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

    if (results.length === 0) {
      return null;
    }

    const article = results[0];

    // Check for EOC indicator in comments
    if (
      article.commentsCorrectionsList?.some(
        (item: any) => item.type === 'ExpressionOfConcern'
      )
    ) {
      return {
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
      };
    }

    return null;
  } catch (error) {
    // PubMed API failure is not critical
    // Don't log expected errors (404, timeouts, rate limits)
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404 ||
          error.code === 'ECONNABORTED' ||
          error.response?.status === 429) {
        // Silently handle expected errors
        return null;
      }
      // Only log unexpected errors (5xx server errors)
      if (error.response?.status && error.response.status >= 500) {
        console.warn(`Error checking PubMed for EOC on ${doi}:`, error.message);
      }
    }
    return null;
  }
}

/**
 * Check a list of known expression of concern DOIs
 * This would be populated from a maintained database of known EOCs
 */
async function checkKnownEOCList(doi: string): Promise<ExpressionOfConcernIssue | null> {
  // This would be populated from an external source or database
  // For now, we'll skip this check - it could be added later with a known EOC list
  return null;
}

/**
 * Comprehensive expression of concern check for a reference
 */
export async function checkReferenceForEOC(
  reference: ReferenceInput
): Promise<ExpressionOfConcernIssue[]> {
  const issues: ExpressionOfConcernIssue[] = [];

  // Only check if we have a DOI
  if (!reference.doi && !reference.suggested_doi) {
    return issues;
  }

  const doi = reference.doi || reference.suggested_doi;
  if (!doi) {
    return issues;
  }

  // Check multiple sources
  const [crossrefResult, pubmedResult, knownListResult] = await Promise.all([
    checkCrossrefForEOC(doi),
    checkPubmedForEOC(doi),
    checkKnownEOCList(doi),
  ]);

  if (crossrefResult) {
    issues.push(crossrefResult);
  }
  if (pubmedResult) {
    issues.push(pubmedResult);
  }
  if (knownListResult) {
    issues.push(knownListResult);
  }

  return issues;
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
