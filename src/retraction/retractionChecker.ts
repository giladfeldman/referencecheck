/**
 * Retraction Detection Service
 * Checks if papers have been retracted using OpenRetractions API and Crossref
 */

import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';

export interface RetractionInfo {
  isRetracted: boolean;
  retractionDate?: string;
  retractionReason?: string;
  retractionNoticeUrl?: string;
  originalPaperDOI?: string;
  source?: 'openretractions' | 'crossref';
}

// OpenRetractions API (free, open source)
const OPEN_RETRACTIONS_API = 'https://api.openretractions.com/doi';

/**
 * Check if a paper has been retracted
 */
export async function checkRetraction(doi: string): Promise<RetractionInfo> {
  // Clean DOI
  const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();

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
          retractionDate: data.retraction_date,
          retractionReason: data.reason,
          retractionNoticeUrl: data.retraction_notice_url,
          originalPaperDOI: cleanDOI,
          source: 'openretractions',
        };
      }
    }
  } catch (error: any) {


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
          retractionDate: message.published?.['date-parts']?.[0]?.join('-'),
          retractionReason: 'Retraction notice',
          originalPaperDOI: cleanDOI,
          source: 'crossref',
        };
      }
    }
  } catch (error: any) {


    // Don't log expected errors:
    // - 404: DOI not found (expected)
    // - Timeouts: Network issues (expected)
    // - 429: Rate limiting (expected, will retry if needed)
    if (error.response?.status === 404 ||
      error.code === 'ECONNABORTED' ||
      error.response?.status === 429) {
      // Silently handle expected errors
      return {
        isRetracted: false,
        originalPaperDOI: cleanDOI,
      };
    }

    // Only log unexpected errors (5xx server errors)
    if (error.response?.status && error.response.status >= 500) {
      console.warn('Crossref retraction check failed:', error.message);
    }
  }

  // No retraction found
  return {
    isRetracted: false,
    originalPaperDOI: cleanDOI,
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
