import axios from 'axios';
import type { DOAJResult } from './types.js';

/**
 * Check DOAJ (Directory of Open Access Journals) via API
 */
export async function checkDOAJ(issn: string): Promise<DOAJResult> {
  if (!issn) {
    return { found: false };
  }

  try {
    // Clean ISSN (remove hyphens for API call)
    const cleanISSN = issn.replace(/-/g, '');

    const response = await axios.get(
      `https://doaj.org/api/v2/search/journals/issn:${cleanISSN}`,
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Scimeto/1.0 (Predatory Journal Checker)',
        },
      }
    );

    if (response.status === 200 && response.data?.results?.length > 0) {
      const journal = response.data.results[0];
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
    console.warn(`DOAJ check failed for ISSN ${issn}:`, error.message);
    return { found: false };
  }
}
