import axios from 'axios';
import type { DOAJResult } from './types.js';
import { normalizeIssn } from '../util/normalize.js';

/**
 * Check DOAJ (Directory of Open Access Journals) via API
 */
export async function checkDOAJ(issn: string): Promise<DOAJResult> {
  // DOAJ matches the hyphenated form only: `issn:19326203` returns nothing for a journal
  // that `issn:1932-6203` finds (measured 2026-11-18). Before 0.3.0 the hyphen was
  // stripped, so every lookup said "not in DOAJ".
  if (typeof issn !== 'string' || !issn.trim()) return { found: false };
  const cleanISSN = normalizeIssn(issn);
  if (!cleanISSN) {
    // Not an ISSN (bad check digit, wrong length): DOAJ was not asked.
    return { found: false, unavailable: true, reason: 'invalid_issn' };
  }

  try {
    const response = await axios.get(
      `https://doaj.org/api/v2/search/journals/issn:${cleanISSN}`,
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Scimeto/1.0 (Predatory Journal Checker)',
        },
      }
    );

    const results = response.data?.results;
    if (!Array.isArray(results)) {
      // A 200 without a result list is not an answer.
      return { found: false, unavailable: true, reason: 'malformed_response' };
    }
    if (results.length > 0) {
      const journal = results[0];
      const bibjson = journal.bibjson || {};

      return {
        found: true,
        journalTitle: bibjson.title,
        publisher: bibjson.publisher?.name,
        issn: bibjson.pissn,
        eissn: bibjson.eissn,
        url: bibjson.ref?.journal,
      };
    }

    return { found: false };
  } catch (error: any) {
    // A timeout, 429 or 5xx is "could not check", never "not listed".
    console.warn(`DOAJ check failed for ISSN ${issn}:`, error.message);
    return { found: false, unavailable: true, reason: error?.response?.status ? `http_${error.response.status}` : (error?.code || 'network') };
  }
}
