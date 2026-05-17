/**
 * Preprint Publication Detection Service
 * Detects if references are preprints that have been published elsewhere
 */

import type { ReferenceInput } from '../types.js';
import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';

export interface PreprintIssue {
  type: 'preprint-status';
  severity: 'warning' | 'info';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: {
    doi?: string;
    preprintServer?: string;
    preprintDate?: string;
    publishedDOI?: string;
    publishedDate?: string;
    source?: string;
  };
}

/**
 * Heuristic preprint detector — recognises well-known preprint servers from
 * DOI prefix or URL patterns BEFORE we hit CrossRef. CrossRef sometimes does
 * not tag preprints as `type='posted-content'` (e.g. SSRN works via the
 * 10.2139/ssrn. prefix are still 'journal-article' typed in their metadata),
 * so audit found false-negatives where SSRN/PsyArXiv preprints went unflagged.
 *
 * γ' fix: cover the common cases by pattern. Returns the preprint server
 * name if recognised, or null otherwise.
 */
const KNOWN_PREPRINT_DOI_PREFIXES: Array<{ prefix: RegExp; server: string }> = [
  { prefix: /^10\.2139\/ssrn\./i, server: 'SSRN' },
  { prefix: /^10\.31234\//i, server: 'PsyArXiv' },
  { prefix: /^10\.31219\/osf\.io\//i, server: 'OSF Preprints' },
  { prefix: /^10\.1101\//i, server: 'bioRxiv/medRxiv' },
  { prefix: /^10\.48550\/arxiv\./i, server: 'arXiv' },
  { prefix: /^10\.20944\/preprints/i, server: 'Preprints.org' },
  { prefix: /^10\.32942\/osf\.io\//i, server: 'EarthArXiv' },
  { prefix: /^10\.31235\/osf\.io\//i, server: 'SocArXiv' },
  { prefix: /^10\.31222\/osf\.io\//i, server: 'engrXiv' },
  { prefix: /^10\.26434\/chemrxiv/i, server: 'ChemRxiv' },
];

const KNOWN_PREPRINT_URL_PATTERNS: Array<{ pattern: RegExp; server: string }> = [
  { pattern: /\bpsyarxiv\.com\b/i, server: 'PsyArXiv' },
  { pattern: /\barxiv\.org\b/i, server: 'arXiv' },
  { pattern: /\bbiorxiv\.org\b/i, server: 'bioRxiv' },
  { pattern: /\bmedrxiv\.org\b/i, server: 'medRxiv' },
  { pattern: /\bsocarxiv\.org\b/i, server: 'SocArXiv' },
  { pattern: /\bengrxiv\.org\b/i, server: 'engrXiv' },
  { pattern: /\bchemrxiv\.org\b/i, server: 'ChemRxiv' },
  { pattern: /\bearharxiv\.org\b/i, server: 'EarthArXiv' },
  { pattern: /\bpreprints\.org\b/i, server: 'Preprints.org' },
];

export function detectKnownPreprintFromDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  for (const { prefix, server } of KNOWN_PREPRINT_DOI_PREFIXES) {
    if (prefix.test(doi)) return server;
  }
  return null;
}

export function detectKnownPreprintFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { pattern, server } of KNOWN_PREPRINT_URL_PATTERNS) {
    if (pattern.test(text)) return server;
  }
  return null;
}

/**
 * Check if a DOI points to a preprint
 */
async function checkPreprintStatus(doi: string): Promise<PreprintIssue | null> {
  try {
    // Use CrossRef API to check if this is a preprint
    const response = await crossrefGet(`https://api.crossref.org/works/${doi}`, {
      timeout: 5000,
    });

    const data = response.data?.message || {};

    // Check if this is a preprint
    if (data.type === 'posted-content' || data.subtype === 'preprint') {
      const publishedVersion = data.relation?.['is-preprint-of']?.[0]?.id;
      return {
        type: 'preprint-status',
        severity: 'warning',
        code: 'IS_PREPRINT',
        description: 'This reference appears to be a preprint, not a peer-reviewed publication. If it was eventually published, it\'s best to cite the associated publication.',
        location: doi,
        suggestion: publishedVersion
          ? `A published version may be available: https://doi.org/${publishedVersion}`
          : 'Check if a peer-reviewed version has been published since this preprint',
        metadata: {
          doi,
          preprintServer: data.institution?.name || 'Unknown',
          preprintDate: data.posted?.['date-parts']?.[0]?.join('-'),
          publishedDOI: publishedVersion || undefined,
          source: 'CrossRef',
        },
      };
    }

    // Check if this paper has a preprint version
    if (data.relation?.['has-preprint']) {
      const preprintDOI = data.relation['has-preprint'][0]?.id;
      return {
        type: 'preprint-status',
        severity: 'info',
        code: 'HAS_PREPRINT_VERSION',
        description: 'A preprint version of this paper exists',
        location: doi,
        suggestion: `Check the preprint at ${preprintDOI || 'ArXiv or bioRxiv'}`,
        metadata: {
          doi,
          publishedDOI: doi,
          source: 'CrossRef',
        },
      };
    }

    return null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        return null;
      }
      console.warn(`Error checking preprint status for ${doi}:`, error.message);
    }
    return null;
  }
}

/**
 * Check reference for preprint status.
 *
 * Two-stage detection (γ' fix):
 *   1. Fast heuristic against known preprint DOI prefixes / URL patterns.
 *      Catches SSRN, PsyArXiv, bioRxiv, arXiv, OSF preprints, etc. — many
 *      of which CrossRef does not tag as `type='posted-content'`.
 *   2. CrossRef API call as a fallback (only if the heuristic didn't match).
 */
export async function checkReferenceForPreprint(reference: ReferenceInput): Promise<PreprintIssue[]> {
  const issues: PreprintIssue[] = [];

  const doi = reference.doi || reference.suggested_doi || null;
  const rawText = (reference as any).raw_text as string | undefined;
  const url = (reference as any).url as string | undefined;

  // Fast heuristic — DOI prefix or URL pattern.
  const heuristicServer =
    detectKnownPreprintFromDoi(doi) ??
    detectKnownPreprintFromText(url) ??
    detectKnownPreprintFromText(rawText);

  if (heuristicServer) {
    issues.push({
      type: 'preprint-status',
      severity: 'warning',
      code: 'IS_PREPRINT',
      description: `This reference appears to be a ${heuristicServer} preprint, not a peer-reviewed publication. If it was eventually published, it's best to cite the associated publication.`,
      location: doi || url || rawText?.slice(0, 80) || '(reference)',
      suggestion: `Check if a peer-reviewed version has been published since this ${heuristicServer} preprint`,
      metadata: {
        doi: doi || undefined,
        preprintServer: heuristicServer,
        source: 'heuristic',
      },
    });
    return issues;
  }

  // Fall through to CrossRef only if we have a DOI and the heuristic didn't match.
  if (!doi) {
    return issues;
  }

  const result = await checkPreprintStatus(doi);
  if (result) {
    issues.push(result);
  }

  return issues;
}

/**
 * Get summary data
 */
export function getSummaryData(issues: PreprintIssue[]): {
  preprintCount: number;
  activePreprints: number;
  hasPreprints: number;
} {
  return {
    preprintCount: issues.length,
    activePreprints: issues.filter(i => i.code === 'IS_PREPRINT').length,
    hasPreprints: issues.filter(i => i.code === 'HAS_PREPRINT_VERSION').length,
  };
}
