/**
 * DOI-shape validation helpers, first copied from the Scimeto worker during the
 * Wave 3 extraction. The worker no longer keeps a copy (2026-11-18: it imports
 * these from referencecheck), so this is the one definition.
 *
 * Both read the DOI through `cleanDoiInput`, like every other DOI reader in the
 * library: before 2026-11-18 `https://doi.org/10.1037/x` was "malformed" here
 * while `validateDOI` accepted it — one input, two readings.
 */
import type { ReferenceInput } from '../types.js';
import { cleanDoiInput, DOI_SHAPE } from '../util/normalize.js';

/**
 * Heuristic: returns true if `doi` looks malformed/truncated. Replication
 * lookup must skip these — the doi plugin owns DOI validity reporting, and
 * passing a partial DOI (e.g. '10.1037/0', '10.1146/annurev') to CrossRef
 * yields meaningless results that contaminate replication output.
 */
export function isMalformedDoi(doi: string): boolean {
  if (typeof doi !== 'string') return true;
  const d = cleanDoiInput(doi);
  if (!d) return true;
  // Standard DOI shape: '10.<registrant>/<suffix>' (suffix at least 1 char).
  if (DOI_SHAPE.test(d)) return false;
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
  return /^10\/[A-Za-z0-9._-]+$/.test(cleanDoiInput(doi));
}

/**
 * The DOI a reference is checked under: the first of `doi` and `suggested_doi` that has the
 * DOI shape, cleaned (`cleanDoiInput`). When neither has it, the first one written, cleaned,
 * so the lookup still runs and reports what it found; '' when neither is written.
 *
 * Before 0.3.0 every per-reference service read `reference.doi || reference.suggested_doi`:
 * a junk `doi` ("n/a") hid a valid `suggested_doi`, the junk was looked up, and its 404 read
 * as "nothing found" (final review 2026-11-20).
 */
export function referenceDoi(reference: Pick<ReferenceInput, 'doi' | 'suggested_doi'>): string {
  const written = [reference?.doi, reference?.suggested_doi].map((d) => cleanDoiInput(d)).filter((d) => d);
  return written.find((d) => !isMalformedDoi(d)) ?? written[0] ?? '';
}
