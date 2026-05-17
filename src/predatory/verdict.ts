import type { DOAJResult, HeuristicsResult, VerificationResult } from './types.js';
import { isKnownLegitimate } from './beallsList.js';

/**
 * Determine final verdict from multiple checks
 */
export function determineVerdict(
  beallsResult: boolean,
  doajResult: DOAJResult,
  heuristicsResult: HeuristicsResult,
  publisher?: string
): VerificationResult {
  const sources: string[] = [];
  let status: 'legitimate' | 'predatory' | 'unknown' = 'unknown';
  let source: 'bealls_list' | 'doaj' | 'heuristics' | 'combined' = 'combined';
  let confidence = 0;
  let reasoning = '';

  // Check if publisher is known legitimate first
  if (publisher && isKnownLegitimate(publisher)) {
    return {
      status: 'legitimate',
      source: 'bealls_list',
      confidence: 0.95,
      isPredatory: false,
      reasoning: 'Publisher is on the known legitimate publishers list',
      sources: ['known_legitimate'],
      details: {
        beallsCheck: false,
        doajCheck: doajResult,
        heuristicsCheck: heuristicsResult,
      },
    };
  }

  // Beall's List check (highest priority for predatory)
  if (beallsResult) {
    status = 'predatory';
    source = 'bealls_list';
    confidence = 0.9; // High confidence for Beall's List
    reasoning = 'Publisher is listed on Beall\'s List of predatory publishers';
    sources.push('bealls_list');
  }

  // DOAJ check (high priority for legitimate)
  if (doajResult.found) {
    if (status === 'predatory') {
      // Conflict: in Beall's List but also in DOAJ
      // DOAJ is more current, so trust it more but flag as uncertain
      status = 'unknown';
      source = 'combined';
      confidence = 0.5;
      reasoning =
        'Conflicting information: found in both Beall\'s List (predatory) and DOAJ (legitimate). Manual review recommended.';
      sources.push('doaj');
    } else {
      status = 'legitimate';
      source = 'doaj';
      confidence = 0.85;
      reasoning = 'Journal is indexed in DOAJ (Directory of Open Access Journals)';
      sources.push('doaj');
    }
  }

  // Heuristics check
  if (heuristicsResult.isPredatory) {
    if (status === 'legitimate') {
      // Conflict: DOAJ says legitimate but heuristics say predatory
      confidence = Math.max(confidence * 0.8, 0.6); // Reduce confidence slightly
      reasoning += ' However, some predatory indicators were detected.';
      sources.push('heuristics');
    } else if (status === 'predatory') {
      // Reinforces predatory verdict
      confidence = Math.min(confidence + heuristicsResult.confidence * 0.1, 0.95);
      reasoning += ' Predatory indicators also detected in content.';
      sources.push('heuristics');
    } else {
      // No other verdict, use heuristics
      status = 'predatory';
      source = 'heuristics';
      confidence = heuristicsResult.confidence;
      reasoning = `Predatory indicators detected: ${heuristicsResult.indicators.join(', ')}`;
      sources.push('heuristics');
    }
  }

  // If still unknown, keep it unknown
  if (status === 'unknown' && sources.length === 0) {
    reasoning = 'Insufficient data to determine journal status. Not found in Beall\'s List or DOAJ.';
  }

  return {
    status,
    source,
    confidence,
    isPredatory: status === 'predatory',
    reasoning,
    sources,
    details: {
      beallsCheck: beallsResult,
      doajCheck: doajResult,
      heuristicsCheck: heuristicsResult,
    },
  };
}
