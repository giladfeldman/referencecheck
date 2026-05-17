/**
 * DOI-checking surface — re-exports the pure DOI logic that the CitationGuard
 * `doi` plugin composes: Crossref validation/lookup, retraction detection,
 * and DOI-shape heuristics. `processDOIs` itself (the DB/lifecycle batch
 * loop) stays in the consuming app — it is not part of this library.
 */
export { validateDOI, findDOIFromReference, validateMultipleDOIs } from '../http/crossref.js';
export type { CrossrefResult } from '../http/crossref.js';
export { checkRetraction, checkMultipleRetractions } from '../retraction/retractionChecker.js';
export type { RetractionInfo } from '../retraction/retractionChecker.js';
export { isMalformedDoi, isShortFormDoi } from './doiShape.js';
