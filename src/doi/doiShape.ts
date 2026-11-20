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
 * The DOI a reference is checked under, cleaned (`cleanDoiInput`): the first of `doi` and
 * `suggested_doi` with the full DOI shape (`DOI_SHAPE`); else the first short DOI (`10/abc`);
 * else the first one written, so the lookup still runs and reports what it found; '' when
 * neither is written. When both are full DOIs, `doi` wins, even if they differ: what the
 * author wrote outranks a suggestion.
 *
 * Before 0.3.0 every per-reference service read `reference.doi || reference.suggested_doi`:
 * a junk `doi` ("n/a") hid a valid `suggested_doi`, the junk was looked up, and its 404 read
 * as "nothing found" (final review 2026-11-20).
 */
/**
 * One work's DOI without its version suffix, for registrants that mint one DOI per version
 * of a preprint or dataset. Each form was read in Crossref (2026-11-20; versions linked by
 * `is-version-of`): bioRxiv/medRxiv/openRxiv `...123v2`; Preprints.org
 * `10.20944/preprints202508.1193.v3`; Research Square `10.21203/rs.3.rs-906621/v2`;
 * ChemRxiv `/v2`, `.v2` and `-v2` (its bare DOI names the whole work); figshare and
 * Zenodo `.v1`. Under any other registrant a `v2` ending is part of the DOI:
 * `10.5555/a.v1` and `10.5555/a.v2` are two works. Expects a cleaned, lower-cased DOI.
 */
export const VERSIONED_DOI_REGISTRANTS: ReadonlyArray<{ prefix: RegExp; version: RegExp }> = [
  { prefix: /^10\.(?:1101|64898)\//, version: /(?<=\d)v\d+$/ },
  { prefix: /^10\.20944\//, version: /\.v\d+$/ },
  { prefix: /^10\.21203\//, version: /\/v\d+$/ },
  { prefix: /^10\.26434\//, version: /[./-]v\d+$/ },
  { prefix: /^10\.(?:6084|5281)\/|figshare/, version: /\.v\d+$/ },
];

export function doiWithoutVersion(doi: string): string {
  const row = VERSIONED_DOI_REGISTRANTS.find((r) => r.prefix.test(doi));
  return row ? doi.replace(row.version, '') : doi;
}

export function referenceDoi(reference: Pick<ReferenceInput, 'doi' | 'suggested_doi'>): string {
  const written = [reference?.doi, reference?.suggested_doi].map((d) => cleanDoiInput(d)).filter((d) => d);
  return written.find((d) => DOI_SHAPE.test(d)) ?? written.find((d) => !isMalformedDoi(d)) ?? written[0] ?? '';
}
