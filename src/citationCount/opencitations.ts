/**
 * OpenCitations API Service
 * Free, open-source citation database
 * API: https://opencitations.net/index/api/v1
 */

import axios from 'axios';

const OPENCITATIONS_API = 'https://api.opencitations.net/index/v1';

export interface CitationCountResult {
  count: number;
  source: 'opencitations';
  updatedAt: string;
}

export interface CitingWork {
  oci: string;
  citing: string; // DOI of citing work
  cited: string; // DOI of cited work
  creation: string; // Publication date
  timespan?: string;
  journal_sc?: string;
  author_sc?: string;
}

/**
 * Get citation count for a DOI
 * @param doi - The DOI to check (with or without https://doi.org/ prefix)
 * @returns Citation count or null if not found/error
 */
export async function getCitationCount(doi: string): Promise<number | null> {
  try {
    const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
    const url = `${OPENCITATIONS_API}/citation-count/${encodeURIComponent(cleanDOI)}`;

    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 20000, // 20 second timeout (OpenCitations can be slow)
    });

    if (response.status === 200) {
      // OpenCitations API returns count as STRING, not number!
      // Formats observed:
      // 1. Array of objects: [{ "count": "42" }] or [{ "count": 42 }]
      // 2. Array of numbers: [42]
      // 3. Single object: { "count": "42" } or { "count": 42 }
      // 4. Single number: 42
      // 5. Single string: "42"

      let count: number | null = null;

      // Helper function to parse count value (handles both string and number)
      const parseCount = (value: any): number | null => {
        if (value === null || value === undefined) {
          return null;
        }
        if (typeof value === 'number') {
          return value >= 0 ? value : null;
        }
        if (typeof value === 'string') {
          const parsed = parseInt(value, 10);
          return !isNaN(parsed) && parsed >= 0 ? parsed : null;
        }
        return null;
      };

      if (Array.isArray(response.data) && response.data.length > 0) {
        const firstItem = response.data[0];
        if (typeof firstItem === 'number') {
          count = parseCount(firstItem);
        } else if (typeof firstItem === 'string') {
          count = parseCount(firstItem);
        } else if (firstItem && typeof firstItem === 'object') {
          // Check count field (can be string or number)
          if (firstItem.count !== undefined && firstItem.count !== null) {
            count = parseCount(firstItem.count);
          } else if (firstItem.citation_count !== undefined && firstItem.citation_count !== null) {
            count = parseCount(firstItem.citation_count);
          }
        }
      } else if (typeof response.data === 'number') {
        count = parseCount(response.data);
      } else if (typeof response.data === 'string') {
        count = parseCount(response.data);
      } else if (response.data && typeof response.data === 'object') {
        if (response.data.count !== undefined && response.data.count !== null) {
          count = parseCount(response.data.count);
        } else if (response.data.citation_count !== undefined && response.data.citation_count !== null) {
          count = parseCount(response.data.citation_count);
        }
      }

      if (count !== null && count >= 0) {
        return count;
      }
    }

    return null;
  } catch (error: any) {
    // OpenCitations might not have the DOI or network issues
    if (error.response?.status === 404) {
      // DOI not found in OpenCitations - this is normal, not an error
      return null;
    }

    // Handle timeout errors - OpenCitations can be slow sometimes
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      // Timeout is normal for OpenCitations - just return null
      return null;
    }

    // Log unexpected errors (but don't spam for normal 404s/timeouts)
    if (error.response?.status && error.response.status >= 500) {
      console.warn(`OpenCitations API error for ${doi}: ${error.response.status} ${error.response.statusText}`);
    } else if (error.code !== 'ECONNREFUSED' && error.code !== 'ETIMEDOUT') {
      // Only log non-network errors
      console.warn(`OpenCitations error for ${doi}: ${error.message}`);
    }
    return null;
  }
}

/**
 * Get list of citing works for a DOI
 * @param doi - The DOI to check
 * @returns Array of citing works or empty array if not found/error
 */
export async function getCitingWorks(doi: string): Promise<CitingWork[]> {
  try {
    const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();

    const response = await axios.get(`${OPENCITATIONS_API}/citations/${encodeURIComponent(cleanDOI)}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    });

    if (response.status === 200 && Array.isArray(response.data)) {
      return response.data.map((item: any) => ({
        oci: item.oci || '',
        citing: item.citing || '',
        cited: item.cited || '',
        creation: item.creation || '',
        timespan: item.timespan,
        journal_sc: item.journal_sc,
        author_sc: item.author_sc,
      }));
    }

    return [];
  } catch (error: any) {
    if (error.response?.status === 404) {
      return [];
    }
    console.warn(`OpenCitations citing works check failed for ${doi}:`, error.message);
    return [];
  }
}
