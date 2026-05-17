import type { HeuristicsResult, PluginConfig } from './types.js';
import { loadBeallsList } from './beallsList.js';

/**
 * Check for predatory journal indicators using heuristics
 */
export function checkHeuristics(
  journalName: string,
  config: PluginConfig
): HeuristicsResult {
  const beallsList = loadBeallsList();
  const indicators: string[] = [];
  const details: string[] = [];
  const sensitivity = config.heuristicSensitivity || 'medium';

  if (!journalName) {
    return { isPredatory: false, confidence: 0, indicators: [], details: [] };
  }

  const normalizedJournal = journalName.toLowerCase();

  // Check each category of indicators
  const categories = [
    'rapid_publication',
    'guaranteed_acceptance',
    'excessive_marketing',
    'suspicious_fees',
    'poor_quality_signals',
  ] as const;

  for (const category of categories) {
    const patterns = beallsList.indicators[category];
    const matches = patterns.filter(pattern =>
      normalizedJournal.includes(pattern.toLowerCase())
    );

    if (matches.length > 0) {
      indicators.push(category);
      details.push(`${category}: ${matches.join(', ')}`);
    }
  }

  // Determine if predatory based on sensitivity and indicators found
  let isPredatory = false;
  let confidence = 0;

  if (indicators.length > 0) {
    // Calculate confidence based on number of indicators
    const baseConfidence = Math.min(indicators.length * 0.25, 1.0);

    switch (sensitivity) {
      case 'high':
        // High sensitivity: flag if any indicator found
        isPredatory = indicators.length >= 1;
        confidence = baseConfidence;
        break;
      case 'medium':
        // Medium sensitivity: flag if 2+ indicators or strong indicator
        isPredatory =
          indicators.length >= 2 ||
          indicators.includes('guaranteed_acceptance');
        confidence = isPredatory ? baseConfidence : baseConfidence * 0.5;
        break;
      case 'low':
        // Low sensitivity: flag only if 3+ indicators or guaranteed acceptance
        isPredatory =
          indicators.length >= 3 ||
          indicators.includes('guaranteed_acceptance');
        confidence = isPredatory ? baseConfidence : baseConfidence * 0.3;
        break;
    }
  }

  return { isPredatory, confidence, indicators, details };
}
