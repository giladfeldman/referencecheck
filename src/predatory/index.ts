/**
 * Predatory-journal screening — Beall's List + DOAJ + OpenAlex + heuristics.
 * Extracted verbatim from the Scimeto predatory-journal plugin.
 */
export * from './types.js';
export { loadBeallsList, checkBeallsList, isKnownLegitimate } from './beallsList.js';
export { checkDOAJ } from './doaj.js';
export { getOpenAlexEmail, searchOpenAlexByJournalName, resolveOpenAlexByDOI } from './openAlex.js';
export { checkHeuristics } from './heuristics.js';
export { determineVerdict } from './verdict.js';
export { isValidReference, extractJournalMetadata } from './journalMetadata.js';
