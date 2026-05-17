/**
 * Reference deduplication — fuzzy author/title/year matching, similarity
 * scoring, transitive-closure duplicate grouping, best-reference selection.
 * Extracted verbatim from the CitationGuard deduplication plugin.
 */
export * from './types.js';
export {
  normalizeAuthorName,
  compareAuthors,
  compareTitle,
  compareYear,
  scoreMetadataCompleteness,
  calculateSimilarity,
} from './similarity.js';
export { findDuplicateGroups, selectBestReference } from './grouping.js';
