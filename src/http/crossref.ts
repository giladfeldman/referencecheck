/**
 * Crossref API Integration
 * DOI validation and lookup using Crossref APIs
 */

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { formatError } from '../util/formatError.js';
import type { MetadataCredentials } from './credentials.js';
import { DEFAULT_POLITE_EMAIL } from './credentials.js';

export interface CrossrefResult {
  found: boolean;
  doi?: string;
  title?: string;
  authors?: string[];
  publishedDate?: string;
  journal?: string;
  score: number;
  rawData?: any;
}

const CROSSREF_API = 'https://api.crossref.org/works';
const SIMPLE_TEXT_QUERY_API = 'https://doi.crossref.org/simpleTextQuery';

/** In-memory DOI validation cache (SP3). Avoids re-fetching the same DOI across re-uploads/re-processes within one worker session. */
const doiValidationCache = new Map<string, { result: any; timestamp: number }>();
const DOI_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get Crossref email from credentials (for polite pool)
 */
function getCrossrefEmail(creds?: MetadataCredentials): string {
  return creds?.crossrefEmail || DEFAULT_POLITE_EMAIL;
}

/**
 * Polite-pool User-Agent header that Crossref's polite pool requires for
 * higher rate limits. Every Crossref request from the worker MUST go through
 * this header (use the `crossrefGet` helper below — do not call `axios.get`
 * against api.crossref.org directly).
 */
export function getCrossrefUserAgent(creds?: MetadataCredentials): string {
  return `Scimeto/1.0 (mailto:${getCrossrefEmail(creds)})`;
}

/**
 * Shared Crossref GET with polite-pool UA and retry on 429/502/503/504.
 *
 * - 429 honors the Retry-After header (seconds). Falls back to exponential
 *   backoff if absent. Caps the wait per attempt at 30s.
 * - 5xx uses exponential backoff (2s, 4s, 8s).
 * - Up to 3 attempts. After exhausting retries, throws the last error so
 *   callers can decide how to surface the failure.
 *
 * Use this for every Crossref request from the worker. The four other call
 * sites (citationRepliesService, preprintDetectionService, expressionOfConcern,
 * retractionChecker) bypassed retries before; routing them through here is
 * what stops Nature/high-traffic-journal stress runs from cascading 429s.
 */
export async function crossrefGet<T = any>(
  url: string,
  config: AxiosRequestConfig = {},
  creds?: MetadataCredentials
): Promise<AxiosResponse<T>> {
  const maxAttempts = 3;
  const headers = {
    'User-Agent': getCrossrefUserAgent(creds),
    Accept: 'application/json',
    ...(config.headers ?? {}),
  };

  let lastError: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await axios.get<T>(url, { timeout: 10000, ...config, headers });
    } catch (err: any) {
      lastError = err;
      const status = err?.response?.status;
      const isRateLimit = status === 429;
      const isServerError = status === 502 || status === 503 || status === 504;
      if (!(isRateLimit || isServerError) || attempt === maxAttempts - 1) {
        throw err;
      }

      let delayMs: number;
      if (isRateLimit) {
        const retryAfterRaw = err.response?.headers?.['retry-after'];
        const retryAfterSec = retryAfterRaw ? parseInt(String(retryAfterRaw), 10) : NaN;
        delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 30000)
          : Math.min(2000 * Math.pow(2, attempt), 30000);
        console.warn(
          `Crossref 429 for ${url} — backing off ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
      } else {
        delayMs = 2000 * (attempt + 1);
        console.warn(
          `Crossref ${status} for ${url} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`
        );
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

/**
 * Validate a DOI by checking if it exists in Crossref
 * Falls back to DOI resolver (doi.org) if Crossref doesn't have it
 */
export async function validateDOI(doi: string, creds?: MetadataCredentials): Promise<{
  valid: boolean;
  data?: CrossrefResult;
  error?: string;
  source?: 'crossref' | 'resolver';
}> {
  try {
    // Clean DOI (remove https://doi.org/ prefix if present)
    const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();

    // Check in-memory cache first (SP3)
    const cacheKey = cleanDOI.toLowerCase();
    const cached = doiValidationCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < DOI_CACHE_TTL_MS) {
      return cached.result;
    }

    // First, try Crossref API (retry on 429/502/503/504 via shared helper)
    let crossrefError: any;
    try {
      const response = await crossrefGet(`${CROSSREF_API}/${encodeURIComponent(cleanDOI)}`, {}, creds);
      if (response.status === 200) {
        const data = response.data;
        const message = data.message;

        const validResult = {
          valid: true,
          source: 'crossref' as const,
          data: {
            found: true,
            doi: message.DOI,
            title: message.title?.[0] || message['short-title']?.[0],
            authors: message.author?.map((a: any) =>
              a.family ? `${a.family}${a.given ? `, ${a.given}` : ''}` : ''
            ).filter(Boolean) || [],
            publishedDate: message.published?.['date-parts']?.[0]?.join('-'),
            journal: message['container-title']?.[0] || message['short-container-title']?.[0],
            score: 100,
            rawData: message,
          },
        };
        doiValidationCache.set(cacheKey, { result: validResult, timestamp: Date.now() });
        return validResult;
      }
    } catch (err: any) {
      crossrefError = err;
    }

    try {
      // If Crossref returns 404, try DOI resolver as fallback
      if (crossrefError?.response?.status === 404) {
        console.log(`DOI ${cleanDOI} not found in Crossref, checking DOI resolver...`);

        // Fallback: Check if DOI resolves via doi.org
        try {
          const resolverResponse = await axios.head(`https://doi.org/${encodeURIComponent(cleanDOI)}`, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: (status) => status < 500, // Accept redirects (3xx) and client errors (4xx) as valid responses
          });

          // If we get a redirect (3xx) or success (2xx), the DOI exists
          // If we get 404, the DOI doesn't exist
          if (resolverResponse.status >= 200 && resolverResponse.status < 400) {
            console.log(`DOI ${cleanDOI} resolves via doi.org (status: ${resolverResponse.status})`);
            return {
              valid: true,
              source: 'resolver',
              data: {
                found: true,
                doi: cleanDOI,
                score: 50, // Lower score since we don't have full metadata
              },
            };
          } else {
            return { valid: false, error: 'DOI not found in Crossref and does not resolve via DOI resolver' };
          }
        } catch (resolverError: any) {
          // If resolver also fails, DOI is likely invalid
          console.warn(`DOI resolver check failed for ${cleanDOI}:`, resolverError.message);
          return { valid: false, error: 'DOI not found in Crossref and does not resolve' };
        }
      }

      // For other Crossref errors (including 503 after retries), return the error
      console.error('DOI validation error:', crossrefError?.message ?? crossrefError);
      return { valid: false, error: formatError(crossrefError, 'Crossref API') };
    } catch (_) {
      throw crossrefError;
    }
  } catch (error: any) {
    console.error('Unexpected DOI validation error:', error.message);
    return { valid: false, error: formatError(error, 'Crossref validation') };
  }

  return { valid: false, error: 'DOI validation failed' };
}

/**
 * Check if reference text indicates an unpublishable work that typically doesn't have a DOI
 * (theses, dissertations, unpublished manuscripts, personal communications, etc.)
 */
function isUnpublishableWork(referenceText: string): boolean {
  const lowerText = referenceText.toLowerCase();
  const unpublishablePatterns = [
    /\b(doctoral|master'?s?|phd|honours?|honors?)\s*(dissertation|thesis)\b/i,
    /\bunpublished\s*(manuscript|manual|report|paper|work)\b/i,
    /\b(thesis|dissertation)\b.*\buniversity\b/i,
    /\[unpublished\]/i,
    /\[thesis\]/i,
    /\[dissertation\]/i,
    /\bpersonal\s+communication\b/i,
    /\bin\s+preparation\b/i,
    /\bsubmitted\s+for\s+publication\b/i,
    /\bunder\s+review\b/i,
    /\bmanuscript\s+in\s+preparation\b/i,
  ];

  return unpublishablePatterns.some(pattern => pattern.test(lowerText));
}

/**
 * Extract year from reference text
 */
function extractYearFromReference(referenceText: string): number | null {
  // Common patterns: (2019), 2019., (2019a), etc.
  const yearPatterns = [
    /\((\d{4})[a-z]?\)/,  // (2019) or (2019a)
    /\b(19\d{2}|20\d{2})\b/,  // standalone year
  ];

  for (const pattern of yearPatterns) {
    const match = referenceText.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

/**
 * Extract author last names from reference text (simplified extraction)
 */
function extractAuthorsFromReference(referenceText: string): string[] {
  // Common patterns for authors at start of reference
  // e.g., "Smith, J. A., & Jones, B. C. (2019)" or "Smith, J.A. (2019)"
  const beforeYear = referenceText.split(/\(\d{4}/)[0] || '';

  // Extract last names (capitalized words before commas or &)
  const authorSection = beforeYear.trim();
  const lastNames: string[] = [];

  // Pattern to match "LastName, Initials" format
  const authorPattern = /([A-Z][a-zA-Z'-]+)(?:\s*,\s*[A-Z]\.?)+/g;
  let match;
  while ((match = authorPattern.exec(authorSection)) !== null) {
    lastNames.push(match[1].toLowerCase());
  }

  // Also try simpler pattern for single author or non-standard format
  if (lastNames.length === 0) {
    const simplePattern = /^([A-Z][a-zA-Z'-]+)/;
    const simpleMatch = authorSection.match(simplePattern);
    if (simpleMatch) {
      lastNames.push(simpleMatch[1].toLowerCase());
    }
  }

  return lastNames;
}

/**
 * Check if DOI result matches the reference (author and year validation)
 */
function validateDOIMatch(
  referenceText: string,
  crossrefResult: any
): { isValid: boolean; reason?: string } {
  // Extract year from reference
  const refYear = extractYearFromReference(referenceText);

  // Get year from Crossref result
  let crossrefYear: number | null = null;
  if (crossrefResult.published?.['date-parts']?.[0]?.[0]) {
    crossrefYear = crossrefResult.published['date-parts'][0][0];
  } else if (crossrefResult['published-online']?.['date-parts']?.[0]?.[0]) {
    crossrefYear = crossrefResult['published-online']['date-parts'][0][0];
  } else if (crossrefResult['published-print']?.['date-parts']?.[0]?.[0]) {
    crossrefYear = crossrefResult['published-print']['date-parts'][0][0];
  }

  // Year validation: must match within ±1 year (to account for in-press/early access)
  if (refYear && crossrefYear) {
    if (Math.abs(refYear - crossrefYear) > 1) {
      return {
        isValid: false,
        reason: `Year mismatch: reference has ${refYear}, but DOI result has ${crossrefYear}`,
      };
    }
  }

  // Extract authors from reference
  const refAuthors = extractAuthorsFromReference(referenceText);

  // Get authors from Crossref result
  const crossrefAuthors: string[] = (crossrefResult.author || [])
    .map((a: any) => a.family?.toLowerCase() || '')
    .filter(Boolean);

  // Author validation: at least one author last name must match
  if (refAuthors.length > 0 && crossrefAuthors.length > 0) {
    const hasAuthorMatch = refAuthors.some(refAuthor =>
      crossrefAuthors.some(crAuthor =>
        crAuthor.includes(refAuthor) || refAuthor.includes(crAuthor)
      )
    );

    if (!hasAuthorMatch) {
      return {
        isValid: false,
        reason: `Author mismatch: reference authors [${refAuthors.join(', ')}] don't match DOI authors [${crossrefAuthors.join(', ')}]`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Find DOI from reference text using Crossref Simple Text Query
 * Now with improved validation to prevent false matches
 */
export async function findDOIFromReference(referenceText: string, creds?: MetadataCredentials): Promise<CrossrefResult | null> {
  // Skip DOI lookup for works that typically don't have DOIs
  if (isUnpublishableWork(referenceText)) {
    console.log(`⏭️ Skipping DOI lookup for unpublishable work: ${referenceText.substring(0, 80)}...`);
    return null;
  }

  try {
    // Try Simple Text Query API first (most accurate for full references)
    // Note: simpleTextQuery is a different host (doi.crossref.org) and rarely
    // returns 429 in practice, but we still send the polite-pool UA.
    const response = await axios.post(
      SIMPLE_TEXT_QUERY_API,
      new URLSearchParams({ query: referenceText }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': getCrossrefUserAgent(creds),
        },
        timeout: 15000,
      }
    );

    if (response.status === 200) {
      const text = response.data;

      // Parse pipe-delimited response format
      // Format: DOI|Title|Authors|Year|Journal
      const lines = text.split('\n').filter((line: string) => line.trim());

      if (lines.length > 0) {
        const firstLine = lines[0];
        const parts = firstLine.split('|');

        if (parts.length >= 1 && parts[0].trim().startsWith('10.')) {
          const doi = parts[0].trim();
          // Validate the found DOI
          const validation = await validateDOI(doi, creds);
          if (validation.valid && validation.data && validation.data.rawData) {
            // Additional validation: check if the result actually matches the reference
            const matchValidation = validateDOIMatch(referenceText, validation.data.rawData);
            if (matchValidation.isValid) {
              return validation.data;
            } else {
              console.log(`⚠️ DOI ${doi} rejected: ${matchValidation.reason}`);
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.warn('Simple Text Query failed, trying search API:', error.message);
  }

  // Fallback to search API with improved validation
  return findDOIFromSearchAPI(referenceText, creds);
}

/**
 * Find DOI using Crossref search API with improved validation
 */
async function findDOIFromSearchAPI(referenceText: string, creds?: MetadataCredentials): Promise<CrossrefResult | null> {
  // Skip if unpublishable (double-check in case called directly)
  if (isUnpublishableWork(referenceText)) {
    return null;
  }

  try {
    const response = await crossrefGet(CROSSREF_API, {
      params: {
        'query.bibliographic': referenceText,
        rows: 5, // Get top 5 results to find a valid match
        sort: 'relevance',
      },
      timeout: 15000,
    }, creds);

    if (response.status !== 200) {
      return null;
    }

    const data = response.data;
    const items = data.message?.items || [];

    if (items.length === 0) {
      return null;
    }

    // Try each result until we find a valid match
    for (const item of items) {
      // Require higher minimum score (50 instead of 30) for better accuracy
      if (item.score < 50) {
        continue;
      }

      // Validate the match against the reference
      const matchValidation = validateDOIMatch(referenceText, item);
      if (!matchValidation.isValid) {
        console.log(`⚠️ DOI ${item.DOI} rejected (score: ${item.score}): ${matchValidation.reason}`);
        continue;
      }

      // Found a valid match!
      console.log(`✅ DOI ${item.DOI} accepted (score: ${item.score})`);
      return {
        found: true,
        doi: item.DOI,
        title: item.title?.[0] || item['short-title']?.[0],
        authors: item.author?.map((a: any) =>
          a.family ? `${a.family}${a.given ? `, ${a.given}` : ''}` : ''
        ).filter(Boolean) || [],
        publishedDate: item.published?.['date-parts']?.[0]?.join('-'),
        journal: item['container-title']?.[0] || item['short-container-title']?.[0],
        score: item.score,
        rawData: item,
      };
    }

    // No valid match found among the results
    console.log(`⚠️ No valid DOI match found for: ${referenceText.substring(0, 80)}...`);
    return null;
  } catch (error: any) {
    console.error('Crossref search API error:', error.message);
    return null;
  }
}

/**
 * Batch validate multiple DOIs
 */
export async function validateMultipleDOIs(dois: string[], creds?: MetadataCredentials): Promise<Map<string, {
  valid: boolean;
  data?: CrossrefResult;
  error?: string;
}>> {
  const results = new Map<string, {
    valid: boolean;
    data?: CrossrefResult;
    error?: string;
  }>();

  // Process in batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < dois.length; i += batchSize) {
    const batch = dois.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (doi) => {
        const result = await validateDOI(doi, creds);
        return { doi, result };
      })
    );

    batchResults.forEach(({ doi, result }) => {
      results.set(doi, result);
    });

    // Rate limiting: wait 1 second between batches
    if (i + batchSize < dois.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return results;
}
