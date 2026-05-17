/**
 * Open Access Finder Service
 * Detects if papers are available in open access repositories
 */

import type { ReferenceInput } from '../types.js';
import axios from 'axios';

export interface OpenAccessIssue {
  type: 'open-access';
  severity: 'info';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: {
    doi?: string;
    openAccessStatus?: 'gold' | 'green' | 'bronze' | 'closed';
    url?: string;
    version?: string;
    license?: string;
    source?: string;
  };
}

/**
 * Check if a DOI has open access availability via CORE API or similar
 */
async function checkOpenAccessStatus(doi: string): Promise<OpenAccessIssue | null> {
  try {
    // Try Unpaywall API (free, no key needed)
    const response = await axios.get(`https://api.unpaywall.org/v2/${doi}?email=admin@scimeto.dev`, {
      timeout: 5000,
    });

    const data = response.data;

    // Check if paper is available
    if (!data.is_oa) {
      return null; // Paper is not open access
    }

    // Determine OA type
    let oaType = 'green'; // Default to green (self-archived)
    if (data.journal_is_oa) {
      oaType = 'gold'; // Published in OA journal
    } else if (data.journal_is_in_doaj) {
      oaType = 'gold'; // In DOAJ
    }

    // Get best OA location
    let bestUrl = null;
    let bestVersion = null;
    if (data.best_oa_location) {
      bestUrl = data.best_oa_location.url;
      bestVersion = data.best_oa_location.version;
    }

    return {
      type: 'open-access',
      severity: 'info',
      code: 'OA_AVAILABLE',
      description: `This paper is available as ${oaType.toUpperCase()} open access`,
      location: doi,
      suggestion: bestUrl ? `Access the paper at: ${bestUrl}` : 'Check institutional repository for access',
      metadata: {
        doi,
        openAccessStatus: oaType as any,
        url: bestUrl || undefined,
        version: bestVersion || undefined,
        license: data.best_oa_location?.license || undefined,
        source: 'Unpaywall',
      },
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        return null; // DOI not found
      }
      console.warn(`Error checking open access for ${doi}:`, error.message);
    }
    return null;
  }
}

/**
 * Check reference for open access availability
 */
export async function checkReferenceForOpenAccess(reference: ReferenceInput): Promise<OpenAccessIssue[]> {
  const issues: OpenAccessIssue[] = [];

  // Only check if we have a DOI
  const doi = reference.doi || reference.suggested_doi;
  if (!doi) {
    return issues;
  }

  const result = await checkOpenAccessStatus(doi);
  if (result) {
    issues.push(result);
  }

  return issues;
}

/**
 * Get summary counts
 */
export function getSummaryData(issues: OpenAccessIssue[]): {
  openAccessCount: number;
  goldOA: number;
  greenOA: number;
  bronzeOA: number;
} {
  const statuses = issues
    .map(i => i.metadata?.openAccessStatus)
    .filter(Boolean);

  return {
    openAccessCount: issues.length,
    goldOA: statuses.filter(s => s === 'gold').length,
    greenOA: statuses.filter(s => s === 'green').length,
    bronzeOA: statuses.filter(s => s === 'bronze').length,
  };
}
