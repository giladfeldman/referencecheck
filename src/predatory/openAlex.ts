import axios from 'axios';
import type { OpenAlexSource, OpenAlexResult } from './types.js';
import type { MetadataCredentials } from '../http/credentials.js';
import { DEFAULT_POLITE_EMAIL } from '../http/credentials.js';

/**
 * Get OpenAlex email from environment (for polite pool)
 * According to OpenAlex docs: https://docs.openalex.org/how-to-use-the-api/api-overview
 *
 * Set OPENALEX_EMAIL environment variable for better rate limiting.
 * Falls back to CROSSREF_EMAIL or default email.
 */
export function getOpenAlexEmail(creds?: MetadataCredentials): string {
  return creds?.openAlexEmail || DEFAULT_POLITE_EMAIL;
}

/**
 * Search OpenAlex by journal name
 * API docs: https://docs.openalex.org/how-to-use-the-api/api-overview
 */
export async function searchOpenAlexByJournalName(journalName: string, creds?: MetadataCredentials): Promise<OpenAlexResult> {
  if (!journalName || journalName.length < 3) {
    return { found: false };
  }

  try {
    // Clean journal name for search
    const searchQuery = journalName.trim();
    const email = getOpenAlexEmail(creds);

    const response = await axios.get(
      'https://api.openalex.org/sources',
      {
        params: {
          search: searchQuery,
          per_page: 5, // Get top 5 results
          mailto: email, // Join polite pool for better performance
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Scimeto/1.0 (Predatory Journal Checker)',
          'Accept': 'application/json',
        },
      }
    );

    if (response.status === 200 && response.data?.results?.length > 0) {
      const results = response.data.results as OpenAlexSource[];

      // Find best match by comparing journal names
      const normalizedSearch = journalName.toLowerCase().trim();
      let bestMatch: OpenAlexSource | null = null;
      let bestScore = 0;

      for (const source of results) {
        // OpenAlex sources can be journals, repositories, etc. - prefer journals
        if (source.type && source.type !== 'journal') continue;

        const normalizedName = source.display_name.toLowerCase().trim();

        // Exact match gets highest score
        if (normalizedName === normalizedSearch) {
          bestMatch = source;
          bestScore = 100;
          break;
        }

        // Check if search name is contained in result name or vice versa
        if (normalizedName.includes(normalizedSearch) || normalizedSearch.includes(normalizedName)) {
          const score = Math.min(normalizedName.length, normalizedSearch.length) / Math.max(normalizedName.length, normalizedSearch.length) * 80;
          if (score > bestScore) {
            bestMatch = source;
            bestScore = score;
          }
        }
      }

      // Only return if we have a reasonable match (score >= 50)
      if (bestMatch && bestScore >= 50) {
        return {
          found: true,
          journalTitle: bestMatch.display_name,
          publisher: bestMatch.host_organization_name,
          issn: (bestMatch.issn_l || (bestMatch.issn && Array.isArray(bestMatch.issn) && bestMatch.issn[0])) || undefined,
          eissn: bestMatch.issn && Array.isArray(bestMatch.issn)
            ? bestMatch.issn.find(issn => issn !== bestMatch.issn_l)
            : undefined,
          url: bestMatch.homepage_url,
          openalexId: bestMatch.id,
        };
      }
    }

    return { found: false };
  } catch (error: any) {
    console.warn(`OpenAlex search failed for journal "${journalName}":`, error.message);
    return { found: false };
  }
}

/**
 * Resolve journal information from DOI using OpenAlex
 * API docs: https://docs.openalex.org/how-to-use-the-api/api-overview
 */
export async function resolveOpenAlexByDOI(doi: string, creds?: MetadataCredentials): Promise<OpenAlexResult> {
  if (!doi) {
    return { found: false };
  }

  try {
    // Clean DOI (remove https://doi.org/ prefix if present)
    const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
    const email = getOpenAlexEmail(creds);

    // OpenAlex works endpoint - format: https://api.openalex.org/works/DOI:10.1234/example
    const openAlexDOI = `DOI:${cleanDOI}`;

    const response = await axios.get(
      `https://api.openalex.org/works/${encodeURIComponent(openAlexDOI)}`,
      {
        params: {
          mailto: email, // Join polite pool for better performance
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Scimeto/1.0 (Predatory Journal Checker)',
          'Accept': 'application/json',
        },
      }
    );

    if (response.status === 200 && response.data) {
      const work = response.data;
      const primaryLocation = work.primary_location;
      const source = primaryLocation?.source;

      if (source) {
        return {
          found: true,
          journalTitle: source.display_name,
          publisher: source.host_organization_name,
          issn: source.issn_l || (source.issn && Array.isArray(source.issn) && source.issn[0]),
          eissn: source.issn && Array.isArray(source.issn)
            ? source.issn.find((issn: string) => issn !== source.issn_l)
            : undefined,
          url: source.homepage_url || primaryLocation.landing_page_url,
          openalexId: source.id,
        };
      }
    }

    return { found: false };
  } catch (error: any) {
    // 404 is expected if DOI not found, don't log as warning
    if (error.response?.status !== 404) {
      console.warn(`OpenAlex DOI resolution failed for ${doi}:`, error.message);
    }
    return { found: false };
  }
}
