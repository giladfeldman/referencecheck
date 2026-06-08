import type { ReferenceInput } from '../types.js';
import type { JournalMetadata, OpenAlexResult } from './types.js';
import type { MetadataCredentials } from '../http/credentials.js';
import { searchOpenAlexByJournalName, resolveOpenAlexByDOI } from './openAlex.js';

/**
 * Validate if a reference looks like an actual reference entry
 * Filters out text that was incorrectly parsed as a reference
 */
export function isValidReference(reference: ReferenceInput): boolean {
  if (!reference.raw_text || reference.raw_text.trim().length < 20) {
    return false; // Too short to be a real reference
  }

  const text = reference.raw_text.trim();

  // Skip if it looks like part of the main text (not a reference entry)
  const mainTextIndicators = [
    /^We\s+(extended|replicated|tested|found|hypothesized|analyzed)/i,
    /^In\s+(Study|Experiment|this|our)/i,
    /^For\s+(Study|Experiment|this)/i,
    /^The\s+(target|present|current|following)/i,
    /^This\s+(study|experiment|article|paper|research)/i,
    /^Our\s+(study|experiment|analysis|findings)/i,
    /^Note\./i,
    /^\[/i, // Starts with bracket (likely a confidence interval or note)
    /^Figure\s+\d+/i,
    /^Table\s+\d+/i,
    /^See\s+/i,
    /^Cf\./i,
    /^e\.g\./i,
    /^i\.e\./i,
  ];

  for (const pattern of mainTextIndicators) {
    if (pattern.test(text)) {
      return false; // Looks like main text, not a reference
    }
  }

  // A valid reference should have at least one of:
  // - Authors (parsed_data or raw text pattern)
  // - Year
  // - Title
  // - Source/journal name
  const hasAuthors = (reference.parsed_data?.authors && reference.parsed_data.authors.length > 0) ||
    // Author pattern at start ("Surname, I."). Unicode-aware (\p{Lu}/\p{Ll}) so
    // Cyrillic / Greek / accented-Latin surnames are recognized, not only ASCII +
    // Latin-1 (D6). Cased-script surnames only — CJK references have no
    // "Surname, Initial" analogue and must carry parsed_data.authors.
    /^\p{Lu}[\p{Ll}'-]+,\s*\p{Lu}/u.test(text);

  const hasYear = !!reference.parsed_data?.year ||
    /\((\d{4}[a-z]?|n\.d\.)\)/.test(text);

  const hasTitle = !!reference.parsed_data?.title;

  const hasSource = !!reference.parsed_data?.source ||
    !!reference.doi_crossref_data?.['container-title'];

  // Must have at least 2 of these to be considered a valid reference
  const validIndicators = [hasAuthors, hasYear, hasTitle, hasSource].filter(Boolean).length;

  if (validIndicators < 2) {
    return false; // Doesn't have enough reference-like structure
  }

  // Additional check: if it's very long and doesn't have typical reference structure, skip it
  if (text.length > 500 && !hasYear && !hasSource) {
    return false; // Too long and missing key reference elements
  }

  return true;
}

/**
 * Extract journal metadata from reference
 * Now includes OpenAlex API lookups for better extraction
 */
export async function extractJournalMetadata(reference: ReferenceInput, useOpenAlex: boolean = true, creds?: MetadataCredentials): Promise<JournalMetadata> {
  const metadata: JournalMetadata = {};

  // Priority 1: Extract from DOI Crossref data (most reliable)
  if (reference.doi_crossref_data) {
    const crossrefData = reference.doi_crossref_data;

    // Extract journal title from container-title (can be string or array)
    if (crossrefData['container-title']) {
      const containerTitle = crossrefData['container-title'];
      if (Array.isArray(containerTitle) && containerTitle.length > 0) {
        metadata.journal = containerTitle[0];
      } else if (typeof containerTitle === 'string') {
        metadata.journal = containerTitle;
      }
    }

    // Also check container-title-short
    if (!metadata.journal && crossrefData['container-title-short']) {
      metadata.journal = crossrefData['container-title-short'];
    }

    // Extract ISSN
    if (crossrefData.ISSN && Array.isArray(crossrefData.ISSN) && crossrefData.ISSN.length > 0) {
      metadata.issn = crossrefData.ISSN[0];
    } else if (crossrefData.ISSN && typeof crossrefData.ISSN === 'string') {
      metadata.issn = crossrefData.ISSN;
    }

    // Extract publisher
    if (crossrefData.publisher) {
      metadata.publisher = crossrefData.publisher;
    }
  }

  // Priority 2: Extract from parsed_data
  if (!metadata.journal && reference.parsed_data?.source) {
    metadata.journal = reference.parsed_data.source;
  }

  // Priority 3: Extract ISSN from raw text (format: XXXX-XXXX or XXXX-XXXX-X)
  if (!metadata.issn) {
    const issnMatch = reference.raw_text.match(/\b(\d{4}-\d{3}[\dxX])\b/);
    if (issnMatch) {
      metadata.issn = issnMatch[1];
    }
  }

  // Priority 4: Fallback - try to extract journal name from raw text
  // This is more flexible than the previous regex
  if (!metadata.journal) {
    const rawText = reference.raw_text;

    // Pattern 1: Look for common journal indicators followed by title
    // Matches: "Journal of X", "Review of Y", "Nature", "Science", etc.
    const journalPattern1 = rawText.match(
      /\b(?:Journal|Review|Magazine|Quarterly|Annual|Proceedings|Bulletin|Letters|Transactions|Communications|Reports|Studies|Research|Science|Nature|Cell|Lancet|BMJ|PLOS|PLoS)\s+(?:of\s+)?([A-Z][^.,;]{3,50}?)(?:[.,;]|\s+\d)/i
    );
    if (journalPattern1) {
      const journalName = journalPattern1[0].replace(/[.,;]\s*$/, '').trim();
      if (journalName.length > 3) {
        metadata.journal = journalName;
      }
    }

    // Pattern 2: APA-style - Extract journal name after title
    // Format: "Author (Year). Title. Journal Name, Volume(Issue), Pages"
    // Or: "Author (Year). Title. Journal Name, Volume, Pages"
    if (!metadata.journal) {
      const yearMatch = rawText.match(/\((\d{4}[a-z]?)\)/);

      if (yearMatch && yearMatch.index !== undefined) {
        // Find the title (usually ends with a period after the year)
        const afterYear = rawText.slice(yearMatch.index + yearMatch[0].length);

        // Look for volume pattern: "Journal Name, Volume(Issue)" or "Journal Name, Volume"
        const volumePattern = /,\s*(\d+)(?:\((\d+)\))?/;
        const volumeMatch = afterYear.match(volumePattern);

        if (volumeMatch && volumeMatch.index !== undefined) {
          // Extract text between year and volume (this should contain title + journal)
          const beforeVolume = afterYear.slice(0, volumeMatch.index).trim();

          // Split by periods to separate title from journal
          // Title is usually the first sentence, journal is often the second
          const parts = beforeVolume.split(/\.\s+/);

          if (parts.length >= 2) {
            // Journal is likely the last part before the volume
            const journalCandidate = parts[parts.length - 1]
              .replace(/^[.,;:\s]+/, '')
              .replace(/[.,;:\s]+$/, '')
              .trim();

            // Validate: should be capitalized, reasonable length, not just numbers
            if (journalCandidate.length >= 3 &&
              journalCandidate.length < 100 &&
              !journalCandidate.match(/^\d+$/) &&
              journalCandidate[0] === journalCandidate[0].toUpperCase()) {
              metadata.journal = journalCandidate;
            }
          } else if (parts.length === 1 && beforeVolume.length > 10) {
            // If no period found, try to extract from the end before volume
            // Look for capitalized words at the end
            const words = beforeVolume.split(/\s+/);
            const lastWords = words.slice(-3); // Last 3 words might be journal
            const candidate = lastWords.join(' ').replace(/[.,;:\s]+$/, '').trim();

            if (candidate.length >= 3 && candidate[0] === candidate[0].toUpperCase()) {
              metadata.journal = candidate;
            }
          }
        } else {
          // No volume pattern found - try to extract journal from text after title
          // Look for capitalized words that might be a journal name
          const sentences = afterYear.split(/\.\s+/);
          if (sentences.length >= 2) {
            // Second sentence might be journal name
            const journalCandidate = sentences[1]
              .replace(/^[.,;:\s]+/, '')
              .split(/[.,;]/)[0]
              .trim();

            if (journalCandidate.length >= 3 &&
              journalCandidate.length < 100 &&
              journalCandidate[0] === journalCandidate[0].toUpperCase() &&
              !journalCandidate.match(/^\d+$/)) {
              metadata.journal = journalCandidate;
            }
          }
        }
      }
    }

    // Pattern 3: Look for common journal name patterns in the text
    // Many journals have distinctive capitalization or formatting
    if (!metadata.journal) {
      // Look for text that looks like a journal name (capitalized, reasonable length)
      // Usually appears after the title
      const capitalizedPhrase = rawText.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/);
      if (capitalizedPhrase) {
        const candidate = capitalizedPhrase[1];
        // Check if it's not likely to be an author name (too many words = probably not journal)
        // Check if it contains journal-like words
        if (candidate.split(/\s+/).length <= 4 &&
          (candidate.match(/\b(?:Journal|Review|Science|Nature|Letters|Communications|Behavioral|Psychology|Research)\b/i) ||
            candidate.length >= 5)) {
          metadata.journal = candidate;
        }
      }
    }

    // Pattern 4: Look for italicized text or text in quotes (journals are often formatted)
    if (!metadata.journal) {
      const quotedMatch = rawText.match(/["']([^"']{5,80})["']/);
      if (quotedMatch && !quotedMatch[1].match(/^(http|www)/i)) {
        const candidate = quotedMatch[1];
        if (candidate.match(/\b(?:Journal|Review|Science|Nature|Letters|Communications)\b/i) ||
          (candidate[0] === candidate[0].toUpperCase() && candidate.length > 5)) {
          metadata.journal = candidate;
        }
      }
    }
  }

  // Clean up and validate extracted journal name
  if (metadata.journal) {
    metadata.journal = metadata.journal
      .replace(/^[.,;:\s]+/, '')
      .replace(/[.,;:\s]+$/, '')
      .trim();

    // Remove if it's too short or looks invalid
    if (metadata.journal.length < 2 || metadata.journal.match(/^\d+$/)) {
      metadata.journal = undefined;
    } else {
      // Filter out common false positives
      const lowerJournal = metadata.journal.toLowerCase();

      // Common false positive patterns
      const falsePositives = [
        /^(in|on|at|the|a|an)\s+/i,  // Starts with common words
        /^(study|studies|figure|table|note|see|cf|e\.g|i\.e)/i,  // Common document elements
        /^(r package|package version|computer software|retrieved from)/i,  // Software references
        /^(registered report|stage \d+|manuscript template)/i,  // Report types
        /^(guide to|commentary on|replication of|revisiting)/i,  // Commentary/guide titles
        /^(choice|spending|preference|effort|gain|windfall)/i,  // Common research terms
        /^(delay|deservingness|permanent income|general theory)/i,  // Book/theory titles
        /^(basic functions|language and environment)/i,  // Software descriptions
        /^(are people|more money|the value|the interpretation)/i,  // Question/statement starts
        /^(nature of|key driver|underlying mechanism)/i,  // Descriptive phrases
        /^(studies from|studies by|extended the studies)/i,  // References to studies
        /^(jamovi|r:|version \d+)/i,  // Software names/versions
        /^(pp\.|pages?|chapter|section)/i,  // Page/chapter references
        /^\[.*\]$/,  // Bracketed content (like confidence intervals)
        /^\d+\.\d+/,  // Starts with numbers (like version numbers)
        /^(no\.|number|vol\.|volume)/i,  // Volume/issue references
      ];

      // Check if it matches any false positive pattern
      const isFalsePositive = falsePositives.some(pattern => pattern.test(metadata.journal!));

      // Additional checks: if it's a very long phrase or contains too many common words, it's probably not a journal
      const words = metadata.journal.split(/\s+/);
      const hasTooManyCommonWords = words.filter(w =>
        ['the', 'of', 'and', 'in', 'on', 'at', 'a', 'an', 'to', 'for', 'with', 'from', 'by', 'is', 'was', 'are', 'were'].includes(w.toLowerCase())
      ).length > words.length * 0.4; // More than 40% common words

      // If it's a question or very long, probably not a journal
      const isQuestion = metadata.journal.includes('?');
      const isTooLong = metadata.journal.length > 80;

      // If it contains common non-journal indicators
      const hasNonJournalIndicators = /(preference|scale|choice|measure|test|study|figure|table|note|interval|confidence|interpretation|based on|replicating|extending)/i.test(metadata.journal);

      if (isFalsePositive || hasTooManyCommonWords || isQuestion || isTooLong || hasNonJournalIndicators) {
        metadata.journal = undefined;
      }
    }
  }

  // If we still don't have publisher, try to extract from raw text
  // Look for common publisher patterns
  if (!metadata.publisher && reference.raw_text) {
    // Pattern: "Publisher Name" or "Published by Publisher Name"
    const publisherPatterns = [
      /published\s+by\s+([A-Z][^.,;]{3,50}?)(?:[.,;]|\s+$)/i,
      /publisher[:\s]+([A-Z][^.,;]{3,50}?)(?:[.,;]|\s+$)/i,
      /©\s*(\d{4})\s+([A-Z][^.,;]{3,50}?)(?:[.,;]|\s+$)/i, // Copyright pattern
    ];

    for (const pattern of publisherPatterns) {
      const match = reference.raw_text.match(pattern);
      if (match) {
        const publisher = match[1] || match[2];
        if (publisher && publisher.length > 2 && publisher.length < 100) {
          metadata.publisher = publisher.trim();
          break;
        }
      }
    }
  }

  // Priority 5: Try OpenAlex API lookups if enabled and we're missing data
  if (useOpenAlex) {
    // If we have a DOI but no journal/ISSN/publisher, try OpenAlex DOI lookup
    if (reference.doi && (!metadata.journal || !metadata.issn || !metadata.publisher)) {
      try {
        const openAlexResult = await resolveOpenAlexByDOI(reference.doi, creds);
        if (openAlexResult.found) {
          // Fill in missing fields from OpenAlex
          if (!metadata.journal && openAlexResult.journalTitle) {
            metadata.journal = openAlexResult.journalTitle;
          }
          if (!metadata.issn && openAlexResult.issn) {
            metadata.issn = openAlexResult.issn;
          }
          if (!metadata.publisher && openAlexResult.publisher) {
            metadata.publisher = openAlexResult.publisher;
          }
        }
        // Rate limiting: wait 200ms between OpenAlex API calls (polite pool)
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error: any) {
        console.warn(`OpenAlex DOI lookup failed for ${reference.doi}:`, error.message);
      }
    }

    // If we have a journal name but no ISSN/publisher, try OpenAlex search
    if (metadata.journal && (!metadata.issn || !metadata.publisher)) {
      try {
        const openAlexResult = await searchOpenAlexByJournalName(metadata.journal, creds);
        if (openAlexResult.found) {
          // Fill in missing fields from OpenAlex
          if (!metadata.issn && openAlexResult.issn) {
            metadata.issn = openAlexResult.issn;
          }
          if (!metadata.publisher && openAlexResult.publisher) {
            metadata.publisher = openAlexResult.publisher;
          }
          // Update journal name if OpenAlex has a better/canonical version
          if (openAlexResult.journalTitle &&
            openAlexResult.journalTitle.toLowerCase() !== metadata.journal.toLowerCase()) {
            metadata.journal = openAlexResult.journalTitle;
          }
        }
        // Rate limiting: wait 200ms between OpenAlex API calls (polite pool)
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error: any) {
        console.warn(`OpenAlex journal search failed for "${metadata.journal}":`, error.message);
      }
    }
  }

  return metadata;
}
