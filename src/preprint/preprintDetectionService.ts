/**
 * Preprint Publication Detection Service
 * Detects if references are preprints that have been published elsewhere
 */

import type { ReferenceInput } from '../types.js';
import { referenceDoi } from '../doi/doiShape.js';
import { doiRegistrant, OSF_PREPRINT_SLUGS } from '../doi/registrants.js';
import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';
import { cleanDoiInput, DOI_SHAPE, formatDateParts } from '../util/normalize.js';

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
 * name both ways). A URL pattern is read only when the reference has no full DOI.
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
  // OSF servers' own addresses, each measured 2026-11-20 to redirect to osf.io/preprints/<slug>
  // (socarxiv.org and psyarxiv.com above). Other OSF servers are read from the osf.io address.
  { pattern: /\bedarxiv\.org\b/i, server: 'EdArXiv' },
  { pattern: /\bpaleorxiv\.org\b/i, server: 'PaleorXiv' },
  { pattern: /\bbiohackrxiv\.org\b/i, server: 'BioHackrXiv' },
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
 * Ask Crossref whether a DOI is a preprint. `answered` is false when Crossref could not say:
 * the DOI is not indexed there (404: DataCite, OSF, Zenodo DOIs) or the request failed. A
 * record that is not a preprint is `answered: true, issue: null`.
 */
async function checkPreprintStatus(doi: string): Promise<{ issue: PreprintIssue | null; answered: boolean }> {
  try {
    // Use CrossRef API to check if this is a preprint
    const response = await crossrefGet(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      timeout: 5000,
    });

    const data = response.data?.message || {};

    // Check if this is a preprint
    if (data.type === 'posted-content' || data.subtype === 'preprint') {
      const publishedVersion = data.relation?.['is-preprint-of']?.[0]?.id;
      return { answered: true, issue: {
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
      } };
    }

    // Check if this paper has a preprint version
    // An empty list is not a preprint (v0.3.0 review 3; the replies check had the same bug).
    if (Array.isArray(data.relation?.['has-preprint']) && data.relation['has-preprint'].length > 0) {
      const preprintDOI = data.relation['has-preprint'][0]?.id;
      return { answered: true, issue: {
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
      } };
    }

    return { answered: true, issue: null };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status !== 404) {
      console.warn(`Error checking preprint status for ${doi}:`, error.message);
    }
    return { answered: false, issue: null };
  }
}

/**
 * Check reference for preprint status.
 *
 *   1. A known preprint server's DOI prefix (SSRN, PsyArXiv, bioRxiv, arXiv, OSF servers, …;
 *      several are not typed `posted-content` in Crossref).
 *   2. A full DOI the author wrote or linked: Crossref decides; when Crossref cannot answer,
 *      the reference's own link (`url`) does.
 *   3. Otherwise (none, junk, short, or only a suggested DOI): the link, then the citation
 *      text, then Crossref for the suggested DOI.
 */
export async function checkReferenceForPreprint(reference: ReferenceInput): Promise<PreprintIssue[]> {
  const rawText = (reference as any).raw_text as string | undefined;
  const url = (reference as any).url as string | undefined;

  // The DOI the reference is checked under. With none written, a DOI inside a resolver link
  // (url "https://doi.org/10.2139/ssrn.123") is that reference's DOI (v0.3.0 review 5).
  const urlDoi = cleanDoiInput(url);
  const doi = referenceDoi(reference) || (DOI_SHAPE.test(urlDoi) ? urlDoi : '') || null;
  // A DOI the author wrote (or linked), in full: Crossref can answer for it. A suggested DOI
  // is the tool's guess and does not count (the dedup rule, v0.3.0 review 5); neither does a
  // junk value ("n/a") or an unexpanded short DOI (10/abc).
  const writtenDoi = cleanDoiInput(reference.doi);
  const authorsFullDoi = DOI_SHAPE.test(writtenDoi) || (!writtenDoi && DOI_SHAPE.test(urlDoi));

  const heuristic = (server: string): PreprintIssue[] => [{
    type: 'preprint-status',
    severity: 'warning',
    code: 'IS_PREPRINT',
    description: `This reference appears to be a ${server} preprint, not a peer-reviewed publication. If it was eventually published, it's best to cite the associated publication.`,
    location: doi || url || rawText?.slice(0, 80) || '(reference)',
    suggestion: `Check if a peer-reviewed version has been published since this ${server} preprint`,
    metadata: {
      doi: doi || undefined,
      preprintServer: server,
      source: 'heuristic',
    },
  }];

  // 1. A known preprint server's DOI prefix.
  const doiServer = detectKnownPreprintFromDoi(doi);
  if (doiServer) return heuristic(doiServer);

  if (authorsFullDoi && doi) {
    // 2. A full DOI of the author's goes to Crossref, and Crossref's answer stands: a journal
    // article whose citation mentions ssrn.com or arxiv.org ("earlier version at ...") is
    // not itself a preprint (v0.3.0 review 4). When Crossref cannot answer (not indexed:
    // a DataCite or OSF DOI; or the request failed), the reference's own link decides; the
    // citation text does not (review 5).
    const { issue, answered } = await checkPreprintStatus(doi);
    if (answered) return issue ? [issue] : [];
    const urlServer = detectKnownPreprintFromText(url);
    return urlServer ? heuristic(urlServer) : [];
  }

  // 3. No full DOI of the author's: the link, then the citation text, then Crossref for a
  // suggested DOI.
  const textServer = detectKnownPreprintFromText(url) ?? detectKnownPreprintFromText(rawText);
  if (textServer) return heuristic(textServer);
  if (!doi) return [];
  const { issue } = await checkPreprintStatus(doi);
  return issue ? [issue] : [];
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
