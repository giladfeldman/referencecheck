/**
 * Retraction Detection Service
 * Checks whether a paper has been retracted, withdrawn or removed, using
 * Crossref (and, optionally, the OpenRetractions index).
 *
 * ## "Not retracted" and "could not check" are different answers (2026-09-10)
 *
 * `checkRetraction` returned `{ isRetracted: false }` for a Crossref **429 or
 * timeout** as well as for a genuine clean answer, and callers read the boolean
 * bare. So a rate-limit storm printed a clean bibliography over references
 * nobody had successfully looked up — a retraction check that silently passes
 * when it did not run, on a tool whose whole purpose is that check.
 *
 * This is the SAME defect v0.1.2 already fixed one directory away, for
 * Expression of Concern (see expressionOfConcernService.ts). The remedy is the
 * idiom EOC already uses, so the two paths read alike: a per-source outcome, a
 * `checked` flag, and a `checkRetractionDetailed` that names which sources
 * answered. The v0.1.2 CHANGELOG records **81 Crossref 429s in a single real
 * SciMeto run**, so this failure mode is measured, not hypothetical.
 *
 * ## v0.1.3 read a field Crossref does not serve
 *
 * v0.1.3 shipped those coverage flags over detection code that could never
 * fire. It read `message.update`; the field Crossref serves is
 * `message['updated-by']`. Its test hard-coded the fictional field, so the
 * suite was green over dead code. Measured through the compiled library against
 * the live API on 2026-09-12, v0.1.3 got **four of six** test DOIs wrong and
 * reported `complete: true` on every one — two retracted papers called clean,
 * and two healthy works called retracted.
 *
 * The fixtures are now verbatim recorded Crossref bodies
 * (`tests/fixtures/crossref/`). A synthetic fixture cannot tell you the rule is
 * wrong, only that your fixture is.
 *
 * ## What counts as "do not cite this normally"
 *
 * Crossref's `updated-by` carries several update types, and a first pass at
 * v0.1.4 matched only `retraction`. A three-model review then found — and the
 * following was reproduced through the compiled library against live Crossref
 * on 2026-09-12 — that this reports genuinely pulled papers as clean:
 *
 *   | DOI | `updated-by` types | matched `retraction` only |
 *   |---|---|---|
 *   | 10.1002/14651858.cd009522 (Cochrane) | `withdrawal` | reported CLEAN |
 *   | 10.1016/j.crad.2024.02.007 | `withdrawal`, `erratum` | reported CLEAN |
 *   | 10.1016/j.asr.2025.03.045 (Elsevier) | `erratum`, `removal` | reported CLEAN |
 *
 * So detection covers `retraction`, `partial_retraction`, `removal` and
 * `withdrawal`. `isRetracted` means **"this work has been pulled and must not
 * be cited as an ordinary reference"** — one flag, so a consumer that reads only
 * the boolean cannot silently drop a withdrawal.
 *
 * **`retractionType` says which it actually was, and `retractionReason` names it
 * in words.** Reporting a withdrawn preprint as "retracted" is its own false
 * claim about a real paper: `10.31234/osf.io/etvnm_v1` is a PsyArXiv preprint
 * titled simply "WITHDRAWN", and OSF preprints are routinely withdrawn because
 * the work was published elsewhere, not because of misconduct. Anything
 * rendering this to a reader must use `retractionType`, not the word
 * "retracted".
 *
 * Among entries of the selected type the EARLIEST is taken: `10.1007/s11277-021-09072-0`
 * carries two `retraction` entries, a publisher notice dated 2021-09-11 and a
 * Retraction Watch record dated 2022-12-06, and the retraction happened on the
 * earlier date. Selection is by severity, never by array position —
 * `10.33552/ojdoh.2018.01.000503` lists `partial_retraction` before `retraction`,
 * and the first pass reported the weaker one.
 *
 * ## `update-to` points the other way — do not read it as a retraction
 *
 * The LaCour retraction notice (10.1126/science.aac6638) carries `update-to`
 * naming the paper it retracts, and no `updated-by`. So `update-to` on a work
 * means "this work retracts something else". Reading it as evidence about the
 * queried DOI would invert the relation and report every retraction notice as a
 * retracted paper.
 *
 * ## A Crossref 404 is NOT a clean bill of health
 *
 * OpenRetractions is a retraction index: a 404 there means "this DOI is not
 * retracted". Crossref is a bibliographic register: a 404 there means "this is
 * not a Crossref work", which says nothing at all about retraction. Treating
 * both alike reported DataCite/Zenodo DOIs and mistyped DOIs as checked cleans
 * — reproduced on `10.5281/zenodo.3242591` and on LaCour's DOI with one
 * character appended. A Crossref 404 is now `not_indexed`, an unavailable
 * source.
 *
 * ## Why OpenRetractions is off by default
 *
 * `api.openretractions.com` does not resolve. Measured 2026-09-12: `EAI_AGAIN`
 * on both `api.openretractions.com` and `openretractions.com`, while
 * `api.crossref.org` resolved on the same call. Under the strict completeness
 * rule below, leaving it in the default source list would mark **every** lookup
 * incomplete forever — an alarm that fires on every reference tells a reader
 * nothing, and would drown the genuine Crossref failures it exists to surface.
 *
 * Crossref's `updated-by` entries carry `source: "retraction-watch"`, so
 * Crossref relays the same data OpenRetractions was built on. The source is not
 * deleted — pass `sources` to re-enable it if the host returns — and
 * `sourcesChecked` records which sources actually produced each answer, so the
 * substitution is never silent.
 *
 * **Known limit, stated rather than implied:** Crossref detection can only find
 * what a publisher has deposited. On five well-known retractions chosen
 * independently of Crossref's own update filter (Mehra 2020, STAP, Stapel 2011,
 * Séralini 2012, Hwang 2005) `updated-by` carried the retraction 5/5 and a
 * capitalised title marker only 3/5. But `10.1109/icaccs60874.2024.10717184`
 * and `10.3892/ol.2018.7943` are retracted with an EMPTY `updated-by`, caught
 * only by their titles. Coverage is good, not total, and no single signal
 * suffices — which is why the title fallback stays.
 */

import axios from 'axios';
import { crossrefGet } from '../http/crossref.js';
import type { MetadataCredentials } from '../http/credentials.js';

export type RetractionUnavailableReason =
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network'
  /** The source has no record of this DOI at all, so it could not answer. */
  | 'not_indexed';

/** The sources this module knows how to consult. */
export type RetractionSourceName = 'openretractions' | 'crossref';

/**
 * Which kind of withdrawal from the literature this is.
 *
 * All four set `isRetracted`, because all four mean "do not cite this as an
 * ordinary reference". They are NOT interchangeable in prose: a withdrawn
 * preprint is not a retracted paper, and telling an author otherwise is a false
 * claim about their bibliography.
 */
export type RetractionUpdateType =
  | 'retraction'
  | 'partial_retraction'
  | 'removal'
  | 'withdrawal';

/** Most severe first. Selection uses this order, never array position. */
const UPDATE_TYPES_BY_SEVERITY: readonly RetractionUpdateType[] = [
  'retraction',
  'removal',
  'partial_retraction',
  'withdrawal',
];

/** Human wording for each type, used when the record carries no label. */
const UPDATE_TYPE_WORDING: Record<RetractionUpdateType, string> = {
  retraction: 'Retracted',
  removal: 'Removed',
  partial_retraction: 'Partially retracted',
  withdrawal: 'Withdrawn',
};

export interface RetractionSourceUnavailable {
  source: RetractionSourceName;
  reason: RetractionUnavailableReason;
  detail?: string;
}

/**
 * Sources consulted when the caller does not say otherwise.
 *
 * OpenRetractions is deliberately absent — see the note at the top of this file.
 * Pass `{ sources: ['openretractions', 'crossref'] }` to consult it anyway.
 */
export const DEFAULT_RETRACTION_SOURCES: readonly RetractionSourceName[] = ['crossref'];

export interface RetractionCheckOptions {
  /**
   * Crossref polite-pool identity. Without it the shared client falls back to
   * `DEFAULT_POLITE_EMAIL`, so a consumer's own `CROSSREF_EMAIL` never reaches
   * Crossref and the request is attributed to the library rather than to the
   * caller. Mirrors `validateDOI(doi, creds)`.
   */
  creds?: MetadataCredentials;
  /** Which sources to consult. Defaults to {@link DEFAULT_RETRACTION_SOURCES}. */
  sources?: readonly RetractionSourceName[];
}

export interface RetractionInfo {
  /**
   * The work has been pulled from the literature and must not be cited as an
   * ordinary reference. Covers retraction, partial retraction, removal and
   * withdrawal — read {@link RetractionInfo.retractionType} before calling it
   * "retracted" in anything a person reads.
   */
  isRetracted: boolean;
  /** Which kind it was. Undefined when `isRetracted` is false. */
  retractionType?: RetractionUpdateType;
  /**
   * True only when every source consulted actually answered, and at least one
   * did. **Read this before trusting `isRetracted === false`**: false +
   * `checked: false` means "we never got an answer", which is not the same
   * claim as "this paper is not retracted".
   */
  checked: boolean;
  /**
   * Sources that answered — the only basis for a "not retracted" claim, and the
   * record of which source actually produced this result.
   */
  sourcesChecked: RetractionSourceName[];
  /** Every source that could not be reached, and why. Empty when all answered. */
  sourcesUnavailable: RetractionSourceUnavailable[];
  retractionDate?: string;
  retractionReason?: string;
  retractionNoticeUrl?: string;
  originalPaperDOI?: string;
  source?: RetractionSourceName;
}

/**
 * Classify a thrown request error into "the source answered 'no'" versus
 * "the source never answered".
 *
 * **A 404 means different things to the two sources**, which is why this takes
 * the source name. OpenRetractions is a retraction index, so a 404 is a real
 * answer: this DOI is not retracted. Crossref is a bibliographic register, so a
 * 404 only means the DOI is not a Crossref work — a DataCite or Zenodo DOI, or
 * a typo — and carries no information about retraction at all.
 */
function classifyRequestFailure(
  source: RetractionSourceName,
  error: any
): RetractionSourceUnavailable | null {
  const status = error?.response?.status;
  if (status === 404) {
    if (source === 'openretractions') return null; // answered: not in this index
    return { source, reason: 'not_indexed', detail: '404' };
  }
  if (status === 429) return { source, reason: 'rate_limited', detail: '429' };
  if (typeof status === 'number' && status >= 500) {
    return { source, reason: 'server_error', detail: String(status) };
  }
  const code = error?.code;
  if (code === 'ECONNABORTED' || /timeout/i.test(String(error?.message ?? ''))) {
    return { source, reason: 'timeout' };
  }
  return { source, reason: 'network', detail: code ?? error?.message };
}

// OpenRetractions API (free, open source). Off by default — see the file header.
const OPEN_RETRACTIONS_API = 'https://api.openretractions.com/doi';

/**
 * Publisher markers on a title, as the delimited label they actually are.
 *
 * The rule that separates a marker from ordinary words: a marker is either
 * ALL-CAPS, bracketed, or immediately followed by a colon or dash. Plain
 * sentence-case "Retracted" followed by more words is a healthy paper *about*
 * retraction — a Crossref search returned 8 of 8 such papers, including
 * "Retracted Publications in Indian Science: Reasons and Institutions" — and an
 * earlier `title.includes('retract')` flagged every one of them. That is the
 * literature a meta-science bibliography is full of.
 *
 * Measured the other way too: `10.1109/icaccs60874.2024.10717184` ("Retracted:
 * Faux Reality Detector") and `10.3892/ol.2018.7943` ("[Retracted] Pediatric
 * sarcomas (Review)") are genuinely retracted with an EMPTY `updated-by`, so
 * dropping the title-case and bracketed forms loses real retractions.
 */
const TITLE_MARKERS: ReadonlyArray<readonly [RegExp, RetractionUpdateType]> = [
  [/^\s*\[\s*retracted\s*\]/i, 'retraction'],
  [/^\s*retracted(?:\s+article)?\s*[:：\-–—]/i, 'retraction'],
  [/^\s*RETRACTED(?:\s+ARTICLE)?\b/, 'retraction'],
  [/^\s*\[\s*removed\s*\]/i, 'removal'],
  [/^\s*removed\s*[:：\-–—]/i, 'removal'],
  [/^\s*REMOVED\b/, 'removal'],
  [/^\s*\[\s*withdrawn\s*\]/i, 'withdrawal'],
  [/^\s*withdrawn\s*[:：\-–—]/i, 'withdrawal'],
  [/^\s*WITHDRAWN\b/, 'withdrawal'],
];

/** The update type an `updated-by` entry represents, or null if it is not one. */
function entryUpdateType(entry: any): RetractionUpdateType | null {
  const type = typeof entry?.type === 'string' ? entry.type.toLowerCase() : '';
  const match = UPDATE_TYPES_BY_SEVERITY.find((t) => t === type);
  if (match) return match;
  // Some deposits carry an unrecognised type with a telling label. A label
  // containing "retract" is a retraction unless its type already said otherwise.
  const label = typeof entry?.label === 'string' ? entry.label.toLowerCase() : '';
  if (label.includes('retract')) {
    return label.includes('partial') ? 'partial_retraction' : 'retraction';
  }
  return null;
}

/** Crossref dates the relation with `updated`; older/derived records use `date`. */
function relationDate(relation: any): string | undefined {
  const parts =
    relation?.updated?.['date-parts']?.[0] ?? relation?.date?.['date-parts']?.[0];
  return Array.isArray(parts) ? parts.join('-') : undefined;
}

/** Sortable form of a relation's date, for picking the earliest notice. */
function relationSortKey(relation: any): number {
  const ts = relation?.updated?.['date-time'] ?? relation?.date?.['date-time'];
  const parsed = ts ? Date.parse(String(ts)) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const parts: unknown[] =
    relation?.updated?.['date-parts']?.[0] ?? relation?.date?.['date-parts']?.[0] ?? [];
  const [y, m, d] = parts.map((n) => (typeof n === 'number' ? n : 0));
  return (y || 9999) * 10000 + (m || 1) * 100 + (d || 1);
}

/**
 * Pick the notice that decides the verdict from a work's `updated-by` list.
 *
 * A retracted paper commonly carries several notices — Wakefield 1998 has a 2004
 * correction and the 2010 retraction; `10.33552/ojdoh.2018.01.000503` lists
 * twelve including both `partial_retraction` and `retraction`. Taking the first
 * array entry reported whichever the publisher happened to deposit first, which
 * understated the severity. Selection is by severity, then by earliest date.
 */
function findRetractionRelation(
  message: any
): { relation: any; type: RetractionUpdateType } | null {
  const updatedBy = message?.['updated-by'];
  if (!Array.isArray(updatedBy)) return null;

  const candidates = updatedBy
    .map((entry) => ({ relation: entry, type: entryUpdateType(entry) }))
    .filter((c): c is { relation: any; type: RetractionUpdateType } => c.type !== null);
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const bySeverity =
      UPDATE_TYPES_BY_SEVERITY.indexOf(a.type) - UPDATE_TYPES_BY_SEVERITY.indexOf(b.type);
    if (bySeverity !== 0) return bySeverity;
    return relationSortKey(a.relation) - relationSortKey(b.relation);
  });
  return candidates[0];
}

/** The marker a title carries, if any. */
function findTitleMarker(message: any): RetractionUpdateType | null {
  const titles: unknown[] = Array.isArray(message?.title) ? message.title : [];
  for (const title of titles) {
    if (typeof title !== 'string') continue;
    for (const [pattern, type] of TITLE_MARKERS) {
      if (pattern.test(title)) return type;
    }
  }
  return null;
}

/**
 * Check whether a paper has been retracted, withdrawn or removed.
 *
 * @param doi     The DOI to check, with or without a doi.org prefix.
 * @param options Polite-pool credentials and the source list. Optional, so the
 *                published single-argument signature keeps working.
 */
export async function checkRetraction(
  doi: string,
  options: RetractionCheckOptions = {}
): Promise<RetractionInfo> {
  const { creds, sources = DEFAULT_RETRACTION_SOURCES } = options;

  // Clean DOI
  const cleanDOI = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
  const sourcesChecked: RetractionSourceName[] = [];
  const sourcesUnavailable: RetractionSourceUnavailable[] = [];

  /**
   * A result is `checked` only when something actually answered AND nothing
   * failed. The `sourcesChecked.length > 0` half matters: `sources: []`
   * otherwise returned a confident clean having consulted nothing at all.
   */
  const isChecked = () => sourcesUnavailable.length === 0 && sourcesChecked.length > 0;

  // OpenRetractions — only when the caller asked for it (see the file header).
  if (sources.includes('openretractions')) {
    try {
      const response = await axios.get(
        `${OPEN_RETRACTIONS_API}/${encodeURIComponent(cleanDOI)}`,
        {
          headers: {
            Accept: 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          timeout: 5000,
        }
      );

      if (response.status === 200 && response.data) {
        const data = response.data;
        sourcesChecked.push('openretractions');

        if (data.retracted === true) {
          // A dedicated retraction index saying "yes" is definitive, so the
          // cascade stops here and Crossref is not consulted. `sourcesChecked`
          // records that, so a caller can still see the verdict rests on one
          // source.
          return {
            isRetracted: true,
            retractionType: 'retraction',
            checked: true,
            sourcesChecked,
            sourcesUnavailable,
            retractionDate: data.retraction_date,
            retractionReason: data.reason,
            retractionNoticeUrl: data.retraction_notice_url,
            originalPaperDOI: cleanDOI,
            source: 'openretractions',
          };
        }
      } else {
        sourcesUnavailable.push({
          source: 'openretractions',
          reason: 'server_error',
          detail: String(response.status),
        });
      }
    } catch (error: any) {
      // A 404 here is an ANSWER (this DOI is not in the OpenRetractions index);
      // a 429, timeout, 5xx or socket error is not, and must not be allowed to
      // read as one further down.
      const unavailable = classifyRequestFailure('openretractions', error);
      if (unavailable) sourcesUnavailable.push(unavailable);
      else sourcesChecked.push('openretractions');

      // Silently fall back to Crossref (don't log routine network errors).
      if (
        error.code !== 'ECONNABORTED' &&
        error.code !== 'EAI_AGAIN' &&
        error.response?.status !== 404
      ) {
        console.warn('OpenRetractions check failed:', error.message);
      }
    }
  }

  // Crossref — the primary source. Its `updated-by` relations relay Retraction
  // Watch data as well as publisher deposits.
  if (sources.includes('crossref')) {
    try {
      const crossrefResponse = await crossrefGet(
        `https://api.crossref.org/works/${encodeURIComponent(cleanDOI)}`,
        { timeout: 5000 },
        creds
      );

      if (crossrefResponse.status === 200) {
        const message = crossrefResponse.data?.message ?? {};
        sourcesChecked.push('crossref');

        // The real relation key. NOT `update` (which Crossref does not serve)
        // and NOT `update-to` (which names what THIS work retracts).
        const found = findRetractionRelation(message);

        if (found) {
          const { relation, type } = found;
          return {
            isRetracted: true,
            retractionType: type,
            checked: isChecked(),
            sourcesChecked,
            sourcesUnavailable,
            retractionDate: relationDate(relation),
            retractionReason: relation.label || UPDATE_TYPE_WORDING[type],
            retractionNoticeUrl: relation.DOI
              ? `https://doi.org/${relation.DOI}`
              : undefined,
            originalPaperDOI: cleanDOI,
            source: 'crossref',
          };
        }

        // Fallback: the publisher stamped the marker on the title but deposited
        // no update relation. Measured on real records, this is the ONLY signal
        // for some genuine retractions, so it is not redundant.
        const titleMarker = findTitleMarker(message);
        if (titleMarker) {
          return {
            isRetracted: true,
            retractionType: titleMarker,
            checked: isChecked(),
            sourcesChecked,
            sourcesUnavailable,
            // Deliberately absent. There is no notice to date, and this path
            // previously returned the PAPER's publication date in a field
            // called `retractionDate` — a wrong number, straight into a report.
            retractionDate: undefined,
            retractionReason: `${UPDATE_TYPE_WORDING[titleMarker]} (publisher marker on the title; no update relation deposited)`,
            originalPaperDOI: cleanDOI,
            source: 'crossref',
          };
        }
      } else {
        // Unreachable while `crossrefGet` uses axios's default validateStatus,
        // which throws on non-2xx. Recorded anyway: silently counting an
        // unexpected status as neither checked nor unavailable is exactly how a
        // false clean gets back in.
        sourcesUnavailable.push({
          source: 'crossref',
          reason: 'server_error',
          detail: String(crossrefResponse.status),
        });
      }
    } catch (error: any) {
      // A 429 or a timeout used to `return { isRetracted: false }` right here,
      // so "Crossref refused to talk to us" and "Crossref says this paper is
      // fine" produced byte-identical results.
      const unavailable = classifyRequestFailure('crossref', error);
      if (unavailable) sourcesUnavailable.push(unavailable);
      else sourcesChecked.push('crossref');

      // Only log unexpected errors (5xx server errors)
      if (error.response?.status && error.response.status >= 500) {
        console.warn('Crossref retraction check failed:', error.message);
      }
    }
  }

  // No source reported a retraction. Whether that is a clean answer or a
  // silence depends entirely on whether everything we asked actually answered —
  // whichever source fell over, and whether we asked anything at all.
  return {
    isRetracted: false,
    checked: isChecked(),
    sourcesChecked,
    sourcesUnavailable,
    originalPaperDOI: cleanDOI,
    source: sourcesChecked.includes('crossref') ? 'crossref' : undefined,
  };
}

/**
 * The same check, with the coverage question answered explicitly.
 *
 * Prefer this in anything that renders a verdict to a reader. `complete` is
 * false whenever any source failed to answer, and `sourcesUnavailable` says
 * which and why — so a rate-limit storm surfaces as "unchecked" instead of as
 * a clean bibliography. Mirrors `checkReferenceForEOCDetailed`.
 */
export async function checkRetractionDetailed(
  doi: string,
  options: RetractionCheckOptions = {}
): Promise<{
  retraction: RetractionInfo;
  complete: boolean;
  sourcesUnavailable: RetractionSourceUnavailable[];
}> {
  const retraction = await checkRetraction(doi, options);
  return {
    retraction,
    // `complete` means "every source answered, and at least one did". It used
    // to read `isRetracted || checked`, which called a result complete on a
    // positive finding even when another index went unread, and contradicted
    // this function's own docstring. It now tracks `checked` exactly.
    complete: retraction.checked,
    sourcesUnavailable: retraction.sourcesUnavailable,
  };
}

/**
 * Batch check multiple DOIs for retractions
 */
export async function checkMultipleRetractions(
  dois: string[],
  options: RetractionCheckOptions = {}
): Promise<Map<string, RetractionInfo>> {
  const results = new Map<string, RetractionInfo>();

  // Process in batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < dois.length; i += batchSize) {
    const batch = dois.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (doi) => {
        const info = await checkRetraction(doi, options);
        return { doi, info };
      })
    );

    batchResults.forEach(({ doi, info }) => {
      results.set(doi, info);
    });

    // Rate limiting: wait 1 second between batches
    if (i + batchSize < dois.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}
