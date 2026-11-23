/**
 * Open Access Finder Service
 * Detects if papers are available in open access repositories
 */

import type { ReferenceInput } from '../types.js';
import { referenceDoi } from '../doi/doiShape.js';
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
    /** Unpaywall's `oa_status`; absent when Unpaywall gave none. `closed` is declared, never produced. */
    openAccessStatus?: 'gold' | 'hybrid' | 'bronze' | 'green' | 'closed';
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
    const response = await axios.get(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=admin@scimeto.dev`, {
      timeout: 5000,
    });

    const data = response.data;

    // Check if paper is available
    if (!data.is_oa) {
      return null; // Paper is not open access
    }

    // The OA type is Unpaywall's own `oa_status` (gold, hybrid, bronze, green). Before v0.3.0
    // review 12 it was guessed from journal_is_oa, else "green", so every bronze and hybrid paper
    // was reported as green. No oa_status: the type is not reported, never guessed.
    const OA_TYPES = ['gold', 'hybrid', 'bronze', 'green'] as const;
    const oaType = OA_TYPES.find((t) => t === data.oa_status);

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
      description: oaType ? `This paper is available as ${oaType.toUpperCase()} open access` : 'This paper is available as open access (type not reported)',
      location: doi,
      suggestion: bestUrl ? `Access the paper at: ${bestUrl}` : 'Check institutional repository for access',
      metadata: {
        doi,
        openAccessStatus: oaType,
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
  const doi = referenceDoi(reference);
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
  hybridOA: number;
  greenOA: number;
  bronzeOA: number;
} {
  const statuses = issues
    .map(i => i.metadata?.openAccessStatus)
    .filter(Boolean);

  return {
    openAccessCount: issues.length,
    goldOA: statuses.filter(s => s === 'gold').length,
    hybridOA: statuses.filter(s => s === 'hybrid').length,
    greenOA: statuses.filter(s => s === 'green').length,
    bronzeOA: statuses.filter(s => s === 'bronze').length,
  };
}
