/**
 * DOI-shape validation helpers — copied verbatim from the Scimeto
 * worker's entityOwnership.ts during the Wave 3 referencecheck extraction.
 * The worker keeps its own copy because entityOwnership.ts also hosts the
 * PP-07 entity-ownership registry that is not reference-checking-only. The
 * two copies are intentionally identical; do not let them diverge.
 */

/**
 * Heuristic: returns true if `doi` looks malformed/truncated. Replication
 * lookup must skip these — the doi plugin owns DOI validity reporting, and
 * passing a partial DOI (e.g. '10.1037/0', '10.1146/annurev') to CrossRef
 * yields meaningless results that contaminate replication output.
 */
export function isMalformedDoi(doi: string): boolean {
  if (typeof doi !== 'string') return true;
  const d = doi.trim();
  if (!d) return true;
  // Standard DOI shape: '10.<registrant>/<suffix>' (suffix at least 1 char).
  if (/^10\.\d{3,9}\/\S+$/.test(d)) return false;
  // Short-DOI form: '10/<token>' (token at least 1 char).
  if (/^10\/[A-Za-z0-9._-]+$/.test(d)) return false;
  return true;
}

/**
 * Returns true for the short-DOI form (`10/<token>`) — a redirect alias
 * issued by shortdoi.org, NOT a canonical DOI. Replication lookup should
 * skip these because (a) the doi plugin owns short-DOI resolution, and
 * (b) OpenAlex citation-graph queries for unresolved short-DOIs return
 * noisy or contaminated candidate sets (audit 2026-04-25 finding #12:
 * 7 distinct short-DOIs all returned the identical 7-study set).
 */
export function isShortFormDoi(doi: string): boolean {
  if (typeof doi !== 'string') return false;
  return /^10\/[A-Za-z0-9._-]+$/.test(doi.trim());
}
