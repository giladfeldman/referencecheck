/**
 * Preprint Publication Detection Service
 * Detects if references are preprints that have been published elsewhere
 */

import type { ReferenceInput } from '../types.js';
import { referenceDoi } from '../doi/doiShape.js';
import { doiRegistrant, OSF_PREPRINT_SLUGS } from '../doi/registrants.js';
import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';
import { cleanDoiInput, formatDateParts } from '../util/normalize.js';

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
 * name if recognised, or null otherwise. DOI prefixes live in the one registrant list
 * (src/doi/registrants.ts); a URL pattern names the same server as that list (bioRxiv and
 * medRxiv share one DOI prefix, so the list names them together; a parity test checks every
 * name both ways). A URL pattern is read only when the reference has no DOI.
 */
export const KNOWN_PREPRINT_URL_PATTERNS: ReadonlyArray<{ pattern: RegExp; server: string }> = [
  { pattern: /\bpsyarxiv\.com\b/i, server: 'PsyArXiv' },
  { pattern: /\barxiv\.org\b/i, server: 'arXiv' },
  { pattern: /\bbiorxiv\.org\b/i, server: 'bioRxiv' },
  { pattern: /\bmedrxiv\.org\b/i, server: 'medRxiv' },
  { pattern: /\bsocarxiv\.org\b/i, server: 'SocArXiv' },
  { pattern: /\bengrxiv\.org\b/i, server: 'engrXiv' },
  { pattern: /\bchemrxiv\.org\b/i, server: 'ChemRxiv' },
  { pattern: /\beartharxiv\.org\b/i, server: 'EarthArXiv' },
  { pattern: /\bpreprints\.org\b/i, server: 'Preprints.org' },
  // osf.io/preprints/<slug>, one per OSF server in the registrant list.
  ...OSF_PREPRINT_SLUGS.map(({ slug, server }) => ({ pattern: new RegExp(`\\bosf\\.io\\/preprints\\/${slug}\\b`, 'i'), server })),
  { pattern: /\becoevorxiv\.org\b/i, server: 'EcoEvoRxiv' },
  { pattern: /\bssrn\.com\b/i, server: 'SSRN' },
  { pattern: /\bresearchsquare\.com\b/i, server: 'Research Square' },
  { pattern: /\btechrxiv\.org\b/i, server: 'TechRxiv' },
  { pattern: /\bauthorea\.com\b/i, server: 'Authorea' },
  { pattern: /\bcambridge\.org\/engage\b/i, server: 'Cambridge Open Engage' },
];

export function detectKnownPreprintFromDoi(doi: string | null | undefined): string | null {
  // cleanDoiInput drops what the citation put after the DOI ("...002386).", " [preprint]"),
  // so this test and the Crossref fallback read the same DOI.
  const clean = cleanDoiInput(doi);
  if (!clean) return null;
  // The one registrant list (src/doi/registrants.ts), shared with deduplication's
  // version rule; a registrant without a server name (figshare) is not a preprint.
  return doiRegistrant(clean)?.server ?? null;
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
    const response = await crossrefGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
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
          // Crossref serves `institution` as an array ([{ name: 'bioRxiv' }]); reading it
          // as an object gave 'Unknown' for every preprint before 0.3.0.
          preprintServer:
            (Array.isArray(data.institution) ? data.institution[0]?.name : data.institution?.name) || 'Unknown',
          preprintDate: formatDateParts(data.posted?.['date-parts']?.[0]),
          publishedDOI: publishedVersion || undefined,
          source: 'CrossRef',
        },
      };
    }

    // Check if this paper has a preprint version
    // An empty list is not a preprint (v0.3.0 review 3; the replies check had the same bug).
    if (Array.isArray(data.relation?.['has-preprint']) && data.relation['has-preprint'].length > 0) {
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
 *   1. Fast heuristic against known preprint DOI prefixes, or URL patterns when there is
 *      no DOI.
 *      Catches SSRN, PsyArXiv, bioRxiv, arXiv, OSF preprints, etc. — many
 *      of which CrossRef does not tag as `type='posted-content'`.
 *   2. CrossRef API call as a fallback (only if the heuristic didn't match).
 */
export async function checkReferenceForPreprint(reference: ReferenceInput): Promise<PreprintIssue[]> {
  const issues: PreprintIssue[] = [];

  const doi = referenceDoi(reference) || null;
  const rawText = (reference as any).raw_text as string | undefined;
  const url = (reference as any).url as string | undefined;

  // Fast heuristic — DOI prefix, or a URL pattern when the reference has no DOI. A DOI that
  // is not a known server's goes to Crossref: a journal article whose citation text mentions
  // ssrn.com or arxiv.org ("preprint at ...") is not itself a preprint (v0.3.0 review 4).
  const heuristicServer = doi
    ? detectKnownPreprintFromDoi(doi)
    : detectKnownPreprintFromText(url) ?? detectKnownPreprintFromText(rawText);

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
