import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BeallsList } from './types.js';

// Lazy __dirname resolution to avoid import.meta.url at module level
// (matches the worker's pattern; keeps Jest happy).
let _cachedDirname: string | null = null;
function getDirname(): string {
  if (!_cachedDirname) {
    _cachedDirname = dirname(fileURLToPath(import.meta.url));
  }
  return _cachedDirname;
}

let beallsListCache: BeallsList | null = null;

export function loadBeallsList(): BeallsList {
  if (beallsListCache) {
    return beallsListCache;
  }
  try {
    // Compiled module sits at dist/predatory/beallsList.js; the bundled
    // dataset is copied to dist/data/bealls-list.json by the copy-data
    // build step.
    const beallsPath = join(getDirname(), '..', 'data', 'bealls-list.json');
    const data = readFileSync(beallsPath, 'utf-8');
    beallsListCache = JSON.parse(data);
    return beallsListCache as BeallsList;
  } catch (error) {
    console.error('Error loading Beall\'s List:', error);
    return {
      lastUpdated: '',
      source: '',
      publishers: [],
      indicators: {
        rapid_publication: [],
        guaranteed_acceptance: [],
        excessive_marketing: [],
        suspicious_fees: [],
        poor_quality_signals: [],
      },
      knownLegitimatePublishers: [],
    };
  }
}

/**
 * Check if publisher is in Beall's List
 */
export function checkBeallsList(publisher: string): boolean {
  if (!publisher) return false;

  const beallsList = loadBeallsList();
  const normalizedPublisher = publisher.toLowerCase().trim();

  // Check for exact or partial match
  return beallsList.publishers.some(predatoryPub => {
    const normalizedPredatory = predatoryPub.toLowerCase().trim();
    // Check if publisher contains predatory name or vice versa
    return (
      normalizedPublisher.includes(normalizedPredatory) ||
      normalizedPredatory.includes(normalizedPublisher)
    );
  });
}

/**
 * Check if publisher is known to be legitimate
 */
export function isKnownLegitimate(publisher: string): boolean {
  if (!publisher) return false;

  const beallsList = loadBeallsList();
  const normalizedPublisher = publisher.toLowerCase().trim();

  return beallsList.knownLegitimatePublishers.some(legitPub => {
    const normalizedLegit = legitPub.toLowerCase().trim();
    return (
      normalizedPublisher.includes(normalizedLegit) ||
      normalizedLegit.includes(normalizedPublisher)
    );
  });
}
