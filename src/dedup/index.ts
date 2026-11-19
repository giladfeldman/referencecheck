/**
 * Reference deduplication — fuzzy author/title/year matching, similarity
 * scoring, transitive-closure duplicate grouping, best-reference selection.
 * Extracted verbatim from the Scimeto deduplication plugin.
 */
export * from './types.js';
export {
  normalizeAuthorName,
  compareAuthors,
  compareTitle,
  compareYear,
  scoreMetadataCompleteness,
  calculateSimilarity,
  doiRelation,
  SAME_DOI_CONTRADICTION,
} from './similarity.js';
export type { DoiRelation } from './similarity.js';
export { findDuplicateGroups, selectBestReference } from './grouping.js';
