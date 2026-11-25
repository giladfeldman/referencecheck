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
 * `api.openretractions.com` does not serve its API. Measured 2026-09-12: `EAI_AGAIN`
 * on both `api.openretractions.com` and `openretractions.com`, while
 * `api.crossref.org` resolved on the same call. Re-measured 2026-11-22: the name
 * resolves again (13.248.169.48, 76.223.54.146), but to a parked domain: HTTP 200
 * with an HTML redirect to `/lander`, and HTTPS fails the TLS handshake. Under the strict completeness
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
import { cleanDoiInput, DOI_SHAPE, formatDateParts } from '../util/normalize.js';
import { isShortFormDoi } from '../doi/doiShape.js';
import { DEFAULT_POLITE_EMAIL } from '../http/credentials.js';

export type RetractionUnavailableReason =
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'network'
  /** The source has no record of this DOI at all, so it could not answer. */
  | 'not_indexed'
  /**
   * The DOI given is not DOI-shaped (empty, or not `10.<digits>/<suffix>` /
   * `10/<token>`). Nothing was asked: an empty DOI used to reach Crossref as
   * `/works/`, which answers 200 with a LIST of works, and read as a clean.
   */
  | 'invalid_doi';

/**
 * The three answers a retraction check can give, as one field.
 *
 * - `flagged` — a source reports the work retracted, withdrawn or removed.
 * - `clean` — every source asked actually answered, and none flags it.
 * - `could_not_check` — no flag, and at least one source did not answer (or none
 *   was asked, or the DOI was not DOI-shaped). This is NOT a clean.
 *
 * Derived from `isRetracted` and `checked`, never computed separately, so the
 * three can never disagree with the fields they summarise.
 */
export type RetractionVerdict = 'clean' | 'flagged' | 'could_not_check';

/**
 * When the retraction happened relative to the CITING paper's publication.
 *
 * - `before_citing` — the work was already retracted when the citing paper was
 *   published.
 * - `after_citing` — the citing paper was published before the retraction.
 *
 * This is publication ORDER only. It says nothing about what the citing authors knew: a
 * citation can be written before a retraction and published after it, and a paper can be
 * under an expression of concern before it is retracted.
 * - `unknown` — one of the two dates is missing, unparseable, or the two fall in
 *   the same period at the precision available (see `unknownReason`).
 */
export type RetractionTiming = 'before_citing' | 'after_citing' | 'unknown';

export type RetractionTimingUnknownReason =
  /** The caller supplied neither `citing.publishedDate` nor `citing.doi`. */
  | 'no_citing_date'
  /** The citing DOI was looked up on Crossref and gave no usable date. */
  | 'citing_date_unavailable'
  /** The retraction has no date (e.g. found only by a title marker). */
  | 'no_retraction_date'
  /** The source gave a retraction date this library cannot read. */
  | 'unparseable_retraction_date'
  /**
   * Both dates fall in the same year (or month, or day) at the precision the
   * sources give, so the order cannot be told: `2019` vs `2019-10-08`, or the
   * same day.
   */
  | 'same_period';

/** Where the citing paper's publication date came from. Never a guess. */
export type CitingDateSource = 'caller' | 'crossref';

export interface RetractionTimingInfo {
  timing: RetractionTiming;
  /** The retraction date compared (the same value as `RetractionInfo.retractionDate`). */
  retractionDate?: string;
  /** The citing paper's publication date compared, as given or as Crossref holds it. */
  citingPublishedDate?: string;
  /** `caller` = `citing.publishedDate`; `crossref` = looked up from `citing.doi`. */
  citingDateSource?: CitingDateSource;
  /**
   * Which Crossref field the citing date came from: `published` (Crossref's
   * earliest of print and online), else `issued`.
   */
  citingDateField?: 'published' | 'issued';
  /** Set exactly when `timing` is `unknown`. */
  unknownReason?: RetractionTimingUnknownReason;
  /** For `citing_date_unavailable`: why the citing lookup gave no date. */
  detail?: string;
}

/**
 * Whether a retracted work was replaced by a corrected version ("retract and
 * replace", "retracted and republished").
 *
 * - `replaced` — a source says so (see `evidence`).
 * - `not_recorded` — every replacement lookup answered and none says so.
 *   **This is not "not replaced".** Measured 2026-11-18: Crossref Labs returned
 *   an EMPTY Retraction Watch block for 10.1093/carcin/bgs140, whose own title
 *   reads "RETRACTED AND REPLACED"; and the Crossref `updated-by` entry of every
 *   retract-and-replace case probed is a plain `retraction` with no reason.
 * - `unknown` — no source says so and a lookup failed, returned a body it could
 *   not read, or was turned off (`unknownReason`).
 */
export type RetractionReplacementStatus = 'replaced' | 'not_recorded' | 'unknown';

/** Which recorded field established a replacement. */
export type RetractionReplacementEvidence =
  /** Crossref `relation['is-replaced-by']` naming another DOI. */
  | 'crossref_is_replaced_by'
  /** The work's own Crossref title starts "RETRACTED AND REPLACED" (seen on Oxford University Press records). */
  | 'title_marker'
  /** The retraction notice's Crossref title starts "Retraction and replacement of" (or "Notice of Retraction and Replacement", or "Retraction and Republication"). */
  | 'notice_title'
  /**
   * The Retraction Watch record served by Crossref Labs
   * (`api.labs.crossref.org`, block `cr-labs-updates`) gives the reason
   * "Retract and Replace". Crossref labels that block's keys unstable.
   */
  | 'retraction_watch_reason';

export type RetractionReplacementUnknownReason =
  /** `options.checkReplacement` was `false`; no lookup was made. */
  | 'not_requested'
  /** A lookup failed (`detail` names which and why). */
  | 'lookup_failed'
  /** A lookup answered with a body this library cannot read (`detail`). */
  | 'malformed_response';

export interface RetractionReplacementInfo {
  status: RetractionReplacementStatus;
  /**
   * The replacement version's DOI, when a source names one: `is-replaced-by`,
   * or a DOI in the Retraction Watch notes that Crossref confirms is a work.
   */
  replacementDOI?: string;
  /** Every signal that said "replaced" (empty unless `status` is `replaced`). */
  evidence: RetractionReplacementEvidence[];
  /** Set exactly when `status` is `unknown`. */
  unknownReason?: RetractionReplacementUnknownReason;
  detail?: string;
}

/** The citing paper, for the before/after comparison. Both fields are optional. */
export interface CitingPaperInput {
  /**
   * The citing paper's publication date: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`
   * (an ISO date-time is read by its date part). Takes precedence over `doi`.
   * An unreadable value throws a `RangeError` — a caller's typo is not
   * silently turned into "unknown".
   */
  publishedDate?: string;
  /** The citing paper's DOI. Its Crossref record supplies the date. */
  doi?: string;
}

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
  /**
   * The citing paper. When given, every flagged result carries `timing`
   * (`before_citing` / `after_citing` / `unknown`). The citing DOI is looked up
   * only when a reference is actually flagged, and once per batch in
   * {@link checkMultipleRetractions}.
   */
  citing?: CitingPaperInput;
  /**
   * Look up whether a flagged work was retracted AND REPLACED (default true).
   * Costs extra requests for FLAGGED references only: the retraction notice's
   * Crossref record, the Crossref Labs Retraction Watch record and, when its
   * notes name a DOI, that DOI. `false` leaves `replacement.status` as
   * `unknown` / `not_requested`.
   */
  checkReplacement?: boolean;
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
  /**
   * `clean`, `flagged` or `could_not_check` — the one field a renderer should
   * switch on. See {@link RetractionVerdict}.
   */
  verdict: RetractionVerdict;
  retractionDate?: string;
  retractionReason?: string;
  retractionNoticeUrl?: string;
  originalPaperDOI?: string;
  source?: RetractionSourceName;
  /**
   * Before or after the citing paper. Present on every flagged result (as
   * `unknown` / `no_citing_date` when no citing paper was given); absent when
   * not flagged.
   */
  timing?: RetractionTimingInfo;
  /** Retracted and replaced by a new version? Present on every flagged result. */
  replacement?: RetractionReplacementInfo;
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
    // answered: not in this index -- but only when the 404 is the API's own JSON
    // answer; a parked or misrouted host's HTML 404 is no answer (v0.3.0 review 12).
    if (source === 'openretractions') {
      const body = error?.response?.data;
      return body && typeof body === 'object' && !Array.isArray(body)
        ? null
        : { source, reason: 'server_error', detail: '404 without a JSON body' };
    }
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
  // Some deposits carry an unrecognised type with a telling label. A label (or
  // type) containing "retrac" is a retraction unless its type already said
  // otherwise. "retrac", not "retract": a full scan of the 81,667 Crossref
  // retraction notices (2026-11-18) found a publisher deposit typed and
  // labelled "retracion" (10.4048/jbc.2018.21.1.102).
  const label = typeof entry?.label === 'string' ? entry.label.toLowerCase() : '';
  if (label.includes('retrac') || type.includes('retrac')) {
    return label.includes('partial') ? 'partial_retraction' : 'retraction';
  }
  return null;
}

/** Crossref dates the relation with `updated`; older/derived records use `date`. */
/**
 * A relation's date as `YYYY[-MM[-DD]]`, zero-padded like every other date the
 * library returns (before 0.4.0 it was `parts.join('-')`, "2019-10-8"). A date
 * that is not a real calendar date (month 13) is still returned, padded, so the
 * caller sees what was deposited and the timing says it could not be read;
 * date-parts with no year ([[null]]) give undefined.
 */
function relationDate(relation: any): string | undefined {
  const parts =
    relation?.updated?.['date-parts']?.[0] ?? relation?.date?.['date-parts']?.[0];
  if (!Array.isArray(parts)) return undefined;
  return datePartsToString({ 'date-parts': [parts] }) ?? formatDateParts(parts);
}

/** Sortable form of a relation's date, for picking the earliest notice. */
function relationSortKey(relation: any): number {
  const ts = relation?.updated?.['date-time'] ?? relation?.date?.['date-time'];
  const parsed = ts ? Date.parse(String(ts)) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  const parts: unknown[] =
    relation?.updated?.['date-parts']?.[0] ?? relation?.date?.['date-parts']?.[0] ?? [];
  const [y, m, d] = parts.map((n) => (typeof n === 'number' ? n : 0));
  // Same unit (epoch ms) as the date-time branch above: mixing the two made an entry with no
  // date-time always sort before one that has it, so the wrong notice could be dated.
  return Date.UTC(y || 9999, (m || 1) - 1, d || 1);
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
): { relation: any; type: RetractionUpdateType; dateUsable: boolean } | null {
  const updatedBy = message?.['updated-by'];
  if (!Array.isArray(updatedBy)) return null;

  const workDate = parsePartialDate(
    datePartsToString(message?.published) ?? datePartsToString(message?.issued)
  );
  const candidates = updatedBy
    .map((entry) => ({
      relation: entry,
      type: entryUpdateType(entry),
      dateUsable: isNoticeDateUsable(entry, workDate),
    }))
    .filter(
      (c): c is { relation: any; type: RetractionUpdateType; dateUsable: boolean } => c.type !== null
    );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const bySeverity =
      UPDATE_TYPES_BY_SEVERITY.indexOf(a.type) - UPDATE_TYPES_BY_SEVERITY.indexOf(b.type);
    if (bySeverity !== 0) return bySeverity;
    if (a.dateUsable !== b.dateUsable) return a.dateUsable ? -1 : 1;
    return relationSortKey(a.relation) - relationSortKey(b.relation);
  });
  return candidates[0];
}

/**
 * Can an `updated-by` entry's date be a notice date? Not when it is on or before the work's own
 * publication date: a publisher that retracts in place can deposit the ARTICLE's date on its
 * entry. Measured: 10.1007/s11277-021-09072-0 (published 2021-09-11, retracted 2022-12-06 per
 * the publisher's page) has a publisher `retraction` entry dated 2021-09-11 and a Retraction
 * Watch entry dated 2022-12-06. A date at a coarser precision than the work's (2022 against
 * 2022-03-01) is kept: it may be later.
 */
function isNoticeDateUsable(relation: any, workDate: PartialDate | null): boolean {
  if (!workDate) return true;
  const own = parsePartialDate(relationDate(relation));
  if (!own) return true;
  const c = comparePartialDates(own, workDate);
  return !(c === -1 || (c === 'same_period' && own.d !== undefined && workDate.d !== undefined));
}

/** The marker a title carries, if any. */
function findTitleMarker(message: any): RetractionUpdateType | null {
  const titles: unknown[] = Array.isArray(message?.title) ? message.title : [];
  for (const title of titles) {
    if (typeof title !== 'string') continue;
    for (const [pattern, type] of TITLE_MARKERS) {
      if (pattern.test(title)) return type;
    }
    // A retracted-and-replaced title is a retraction marker too (same forms the replacement reader takes).
    if (REPLACED_TITLE_MARKERS.some((re) => re.test(title))) return 'retraction';
  }
  return null;
}

// ---------------------------------------------------------------- three verdicts

/** The verdict, derived from the two fields it summarises and nothing else. */
function verdictOf(isRetracted: boolean, checked: boolean): RetractionVerdict {
  if (isRetracted) return 'flagged';
  return checked ? 'clean' : 'could_not_check';
}

/**
 * Is this a Crossref single-work body we can read an answer from?
 *
 * `crossrefResponse.data?.message ?? {}` used to turn an empty 200, an HTML
 * error page, or a LIST response (what `/works/` answers for an empty DOI) into
 * an empty record — no `updated-by`, no title marker — and so into a checked
 * clean. A work record always carries its `DOI` as a string.
 */
function isWorkRecord(message: unknown): message is Record<string, any> {
  return (
    !!message &&
    typeof message === 'object' &&
    !Array.isArray(message) &&
    typeof (message as any).DOI === 'string'
  );
}

/** DOI-shaped: `10.<digits>/<suffix>` or the short form `10/<token>`. */
/** The shared DOI shape (`DOI_SHAPE`) or a shortDOI: one reader for the whole library. */
function isDoiShaped(doi: string): boolean {
  return DOI_SHAPE.test(doi) || isShortFormDoi(doi);
}

// ---------------------------------------------------------------- timing

interface PartialDate {
  y: number;
  m?: number;
  d?: number;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validPartialDate(y: number, m?: number, d?: number): PartialDate | null {
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return null;
  if (m === undefined) return { y };
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (d === undefined) return { y, m };
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = m === 2 && !leap ? 28 : DAYS_IN_MONTH[m - 1];
  if (!Number.isInteger(d) || d < 1 || d > max) return null;
  return { y, m, d };
}

/**
 * Read `YYYY`, `YYYY-MM`, `YYYY-MM-DD` (unpadded parts allowed, as
 * `date-parts.join('-')` produces `2019-10-8`), or an ISO date-time by its date
 * part. Anything else is null — never a best guess.
 */
function parsePartialDate(value: unknown): PartialDate | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\s*$/.exec(
    value
  );
  if (!m) return null;
  return validPartialDate(
    Number(m[1]),
    m[2] === undefined ? undefined : Number(m[2]),
    m[3] === undefined ? undefined : Number(m[3])
  );
}

/** Crossref `date-parts` → `YYYY[-MM[-DD]]`, or null when it is not a real date. */
function datePartsToString(field: any): string | null {
  const parts = field?.['date-parts']?.[0];
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const [y, m, d] = parts;
  const valid = validPartialDate(y, m ?? undefined, m == null ? undefined : d ?? undefined);
  if (!valid) return null;
  return formatPartialDate(valid);
}

/**
 * A source's date string in the one returned form when it can be read
 * ("2019-1-5" -> "2019-01-05"); kept as given when it cannot, so the caller
 * sees what the source said and `timing` says it could not be read.
 */
function sameFormatDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const d = parsePartialDate(value);
  return d ? formatPartialDate(d) : value;
}

/** The one writer of a validated date: the shared `formatDateParts`. */
function formatPartialDate(d: PartialDate): string {
  return formatDateParts([d.y, d.m, d.d].filter((n) => n !== undefined)) as string;
}

/**
 * Order two partial dates at the precision BOTH carry. `2019` vs `2019-10-08`
 * cannot be ordered, and neither can the same day: a retraction notice and a
 * citing paper out on the same date say nothing about which came first.
 */
function comparePartialDates(a: PartialDate, b: PartialDate): -1 | 1 | 'same_period' {
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.m === undefined || b.m === undefined) return 'same_period';
  if (a.m !== b.m) return a.m < b.m ? -1 : 1;
  if (a.d === undefined || b.d === undefined) return 'same_period';
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  return 'same_period';
}

/** The citing paper's date as resolved once, from the caller or from Crossref. */
export interface CitingPublicationDate {
  /** `YYYY[-MM[-DD]]`, or absent when none could be had. */
  date?: string;
  source?: CitingDateSource;
  field?: 'published' | 'issued';
  /** Why there is no date, when there is none. */
  unavailable?: { reason: RetractionUnavailableReason | 'no_date'; detail?: string };
}

/**
 * The citing paper's publication date from its Crossref record: `published`
 * (Crossref's earliest of print and online), else `issued`. Never inferred from
 * anything else — no date in either field is reported as no date.
 */
export async function resolveCitingPublicationDate(
  citingDOI: string,
  creds?: MetadataCredentials
): Promise<CitingPublicationDate> {
  // The same reader as the cited DOI: one input shape, one cleaner.
  const clean = cleanDoiInput(citingDOI);
  if (!isDoiShaped(clean)) {
    return { unavailable: { reason: 'invalid_doi', detail: clean.slice(0, 80) } };
  }
  try {
    const res = await crossrefGet(
      `https://api.crossref.org/works/${encodeURIComponent(clean)}`,
      { timeout: 5000 },
      creds
    );
    const message = res?.data?.message;
    if (res?.status !== 200 || !isWorkRecord(message)) {
      return {
        unavailable: {
          reason: 'server_error',
          detail: res?.status === 200 ? '200 without a work record' : String(res?.status),
        },
      };
    }
    for (const field of ['published', 'issued'] as const) {
      const date = datePartsToString(message[field]);
      if (date) return { date, source: 'crossref', field };
      // `published`, else `issued` means ABSENT, not unreadable: a deposited `published` that is
      // no calendar date (month 13) says nothing about whether `issued` is right.
      if (message[field] !== undefined && message[field] !== null) {
        return { unavailable: { reason: 'no_date', detail: `${field} is not a readable date` } };
      }
    }
    return { unavailable: { reason: 'no_date' } };
  } catch (error: any) {
    const u = classifyRequestFailure('crossref', error);
    return { unavailable: { reason: u?.reason ?? 'network', detail: u?.detail } };
  }
}

/** Validate a caller-supplied citing date, throwing on a value this cannot read. */
function callerCitingDate(publishedDate: string): CitingPublicationDate {
  const parsed = parsePartialDate(publishedDate);
  if (!parsed) {
    throw new RangeError(
      `citing.publishedDate must be YYYY, YYYY-MM or YYYY-MM-DD; got ${JSON.stringify(publishedDate)}`
    );
  }
  // Written in the one returned form ("2012-05", never "2012-5" or a cut
  // date-time), read from the parsed parts, never through `Date`.
  return { date: formatPartialDate(parsed), source: 'caller' };
}

type CitingResolver = () => Promise<CitingPublicationDate | null>;

/**
 * A once-only resolver for the citing date. Validates a caller date eagerly (so
 * a typo throws before any lookup), and looks a citing DOI up only when first
 * asked — i.e. only once something is actually flagged.
 */
function makeCitingResolver(
  citing: CitingPaperInput | undefined,
  creds?: MetadataCredentials
): CitingResolver {
  if (!citing || (citing.publishedDate == null && citing.doi == null)) {
    return async () => null;
  }
  if (citing.publishedDate != null) {
    const fixed = callerCitingDate(citing.publishedDate);
    return async () => fixed;
  }
  let pending: Promise<CitingPublicationDate> | undefined;
  const doi = citing.doi as string;
  return () => (pending ??= resolveCitingPublicationDate(doi, creds));
}

/**
 * Compare a retraction date with the citing paper's date. Exported so a
 * consumer holding a stored result can recompute timing without a lookup.
 */
export function compareRetractionTiming(
  retractionDate: string | undefined,
  citing: CitingPublicationDate | null
): RetractionTimingInfo {
  const base: RetractionTimingInfo = {
    timing: 'unknown',
    retractionDate,
    citingPublishedDate: citing?.date,
    citingDateSource: citing?.source,
    citingDateField: citing?.field,
  };
  if (!citing) return { ...base, unknownReason: 'no_citing_date' };
  if (!citing.date) {
    const u = citing.unavailable;
    return {
      ...base,
      unknownReason: 'citing_date_unavailable',
      detail: u ? [u.reason, u.detail].filter(Boolean).join(': ') : undefined,
    };
  }
  if (!retractionDate) return { ...base, unknownReason: 'no_retraction_date' };
  const r = parsePartialDate(retractionDate);
  if (!r) return { ...base, unknownReason: 'unparseable_retraction_date' };
  const c = parsePartialDate(citing.date);
  if (!c) return { ...base, unknownReason: 'citing_date_unavailable', detail: 'unparseable' };
  const order = comparePartialDates(r, c);
  if (order === 'same_period') return { ...base, unknownReason: 'same_period' };
  return { ...base, timing: order < 0 ? 'before_citing' : 'after_citing' };
}

/**
 * A date for a sentence a person reads: zero-padded ("2010-02-06"), never the
 * unpadded form ("2010-2-6") a caller-built `RetractionTimingInfo` or an
 * OpenRetractions date may carry. A value it cannot read is shown as given.
 */
function displayDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = parsePartialDate(value);
  return d ? formatPartialDate(d) : value;
}

const TYPE_PARTICIPLE: Record<RetractionUpdateType, string> = {
  retraction: 'retracted',
  partial_retraction: 'partially retracted',
  removal: 'removed',
  withdrawal: 'withdrawn',
};

/**
 * One plain sentence a renderer can show, which never blurs the difference between a paper
 * already retracted when the citing paper was published and one retracted later. It states
 * publication order only, never what the citing authors knew.
 */
export function describeRetractionTiming(
  timing: RetractionTimingInfo,
  retractionType: RetractionUpdateType = 'retraction'
): string {
  const was = TYPE_PARTICIPLE[retractionType] ?? 'retracted';
  const retracted = displayDate(timing.retractionDate);
  const cited = displayDate(timing.citingPublishedDate);
  const on = retracted ? ` on ${retracted}` : '';
  const citing = cited
    ? `the citing paper was published (${cited})`
    : 'the citing paper was published';
  switch (timing.timing) {
    case 'before_citing':
      return `This work was ${was}${on}, before ${citing}: it was already ${was} when the citing paper was published.`;
    case 'after_citing':
      return `This work was ${was}${on}, after ${citing}: when the citing paper was published it had not yet been ${was}.`;
    default: {
      const why: Record<RetractionTimingUnknownReason, string> = {
        no_citing_date: 'no publication date for the citing paper was given',
        citing_date_unavailable: "the citing paper's publication date could not be found",
        no_retraction_date: `no ${was === 'retracted' ? 'retraction' : 'notice'} date is recorded`,
        unparseable_retraction_date: 'the recorded date could not be read',
        same_period: 'the two dates fall in the same period at the precision recorded',
      };
      const reason = timing.unknownReason ? why[timing.unknownReason] : 'a date is missing';
      return `This work was ${was}${on}; whether that was before or after ${citing} is unknown: ${reason}.`;
    }
  }
}

// ---------------------------------------------------------------- replacement

const CROSSREF_LABS_API = 'https://api.labs.crossref.org/works';

/**
 * "RETRACTED AND REPLACED: …" on the work itself (measured on OUP records). The same three
 * forms as TITLE_MARKERS: bracketed, followed by a separator, or in capitals. A sentence-case
 * title that only starts with the words ("Retracted and replaced articles in medicine: a
 * review") is a paper ABOUT retraction, not a marker. "and" or "&"; "replaced" or
 * "republished"; a [bracketed] or (parenthesised) marker; separators : ： - – — and a full stop.
 */
const REPLACED_PHRASE = String.raw`retracted\s+(?:and|&)\s+(?:replaced|republished)`;
const REPLACED_TITLE_MARKERS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`^\s*[[(]\s*${REPLACED_PHRASE}\s*[\])]`, 'i'),
  new RegExp(String.raw`^\s*${REPLACED_PHRASE}\s*[:：.\-–—]`, 'i'),
  /^\s*RETRACTED\s+(?:AND|&)\s+(?:REPLACED|REPUBLISHED)\b/,
];
/**
 * The retraction notice's own title: "Retraction and replacement of: …" (OUP notices), JAMA's
 * "Notice of Retraction and Replacement: …", and NEJM's "Retraction and Republication: …"
 * (10.1056/nejmc1806491, the PREDIMED notice). "and" or "&".
 */
const REPLACEMENT_NOTICE_TITLE =
  /^\s*(?:notice\s+of\s+)?retraction\s+(?:and|&)\s+(?:replacement|republication)\b/i;

const doiKey = (x: string) => x.trim().toLowerCase().replace(/\/{2,}/g, '/');
const sameDoiLoose = (a: string, b: string) => doiKey(a) === doiKey(b);

function titlesOf(message: any): string[] {
  return Array.isArray(message?.title)
    ? message.title.filter((t: unknown): t is string => typeof t === 'string')
    : [];
}

/**
 * Does a Retraction Watch reason say "Retract and Replace"? Matched on the
 * suffix: Crossref Labs serves every reason with its first character cut off
 * ("etract and Replace", "rror in Analyses", measured 2026-11-18), and the
 * Retraction Watch CSV prefixes them with "+".
 */
function isRetractAndReplaceReason(reason: unknown): boolean {
  return typeof reason === 'string' && /etract\s+and\s+replace\s*$/i.test(reason.trim());
}

/**
 * The DOIs in a Retraction Watch note, one group per DOI written in the note: the full match
 * first, then the form without a trailing publisher article id. `cued` says the DOI follows a
 * replacement cue ("see instead", "replaced by", "republished as", ...), skipping a URL prefix.
 */
const REPLACEMENT_CUE =
  /(?:see\s+instead|instead\s+see|replaced\s+(?:by|with)|replacement(?:\s+(?:article|version|paper))?|republished\s+(?:as|in|at)|new\s+version|corrected\s+version)\s*(?:is|at|here)?\s*[:\-–—]?\s*$/i;
/** "not replaced by X", "no replacement: X": a cue that says the opposite. */
const NEGATED_CUE =
  /\b(?:not|never|no)\s+(?:been\s+|yet\s+)?(?:replaced|republished|replacement)\b[^.;]*$/i;

function doiCandidatesFromNotes(notes: unknown): Array<{ forms: string[]; cued: boolean }> {
  if (typeof notes !== 'string') return [];
  const out: Array<{ forms: string[]; cued: boolean }> = [];
  // Registrant digits as in the shared DOI_SHAPE (3 to 9); Crossref still confirms each candidate.
  for (const m of notes.matchAll(/\b10\.\d{3,9}\/[^\s"<>,;]+/g)) {
    const full = m[0].replace(/[.)\]]+$/, '');
    const forms = [full];
    // Publisher URLs append an article id: .../doi/10.1093/jeb/voae082/7733482
    const trimmed = full.replace(/\/\d+$/, '');
    if (trimmed !== full) forms.push(trimmed);
    const before = notes.slice(0, m.index ?? 0).replace(/(?:https?:\/\/|www\.)\S*$/i, '');
    out.push({ forms, cued: REPLACEMENT_CUE.test(before) && !NEGATED_CUE.test(before) });
  }
  return out;
}

type LookupFailure = {
  ok: false;
  reason: 'lookup_failed' | 'malformed_response';
  detail: string;
  /** Crossref answered 404: the DOI is not a Crossref work (an answer, not a failure to look). */
  notIndexed?: boolean;
};
type Lookup<T> = { ok: true; value: T } | LookupFailure;

async function getWork(doi: string, creds?: MetadataCredentials): Promise<Lookup<any>> {
  try {
    const res = await crossrefGet(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      { timeout: 5000 },
      creds
    );
    const message = res?.data?.message;
    if (res?.status !== 200 || !isWorkRecord(message)) {
      return { ok: false, reason: 'malformed_response', detail: `crossref ${doi}` };
    }
    return { ok: true, value: message };
  } catch (error: any) {
    const u = classifyRequestFailure('crossref', error);
    return {
      ok: false,
      reason: 'lookup_failed',
      detail: `crossref ${doi}: ${u?.reason ?? 'network'}`,
      ...(u?.reason === 'not_indexed' ? { notIndexed: true } : {}),
    };
  }
}

/**
 * The Retraction Watch records Crossref Labs holds for a DOI. An absent or
 * empty `cr-labs-updates` (Labs serves `{}`) is an answer: no record. Any
 * other shape is `malformed_response`, never "no record".
 */
async function getLabsUpdates(doi: string, creds?: MetadataCredentials): Promise<Lookup<any[]>> {
  const mailto = encodeURIComponent(creds?.crossrefEmail || DEFAULT_POLITE_EMAIL);
  try {
    const res = await crossrefGet(
      `${CROSSREF_LABS_API}/${encodeURIComponent(doi)}?mailto=${mailto}`,
      { timeout: 10000 },
      creds
    );
    const message = res?.data?.message;
    if (res?.status !== 200 || !isWorkRecord(message)) {
      return { ok: false, reason: 'malformed_response', detail: 'crossref-labs' };
    }
    const block = message['cr-labs-updates'];
    if (block === undefined || block === null) return { ok: true, value: [] };
    if (Array.isArray(block)) {
      const readable = block.every(
        (u) =>
          u && typeof u === 'object' && !Array.isArray(u) && Array.isArray(u.reasons) &&
          u.reasons.every((r: unknown) => typeof r === 'string')
      );
      if (readable) return { ok: true, value: block };
      return { ok: false, reason: 'malformed_response', detail: 'crossref-labs: unreadable record' };
    }
    if (typeof block === 'object' && Object.keys(block).length === 0) return { ok: true, value: [] };
    return { ok: false, reason: 'malformed_response', detail: 'crossref-labs: unreadable block' };
  } catch (error: any) {
    const u = classifyRequestFailure('crossref', error);
    return { ok: false, reason: 'lookup_failed', detail: `crossref-labs: ${u?.reason ?? 'network'}` };
  }
}

/**
 * Retracted-and-replaced, from what the sources actually assert.
 *
 * Signals, cheapest first: `relation['is-replaced-by']` and the work's own
 * title (already fetched), the notice's title, the Crossref Labs Retraction
 * Watch reason. Deliberately NOT read: `updated-by` type `new_version` —
 * F1000Research 10.12688/f1000research.8114 v1 lists v2 and v3 as new
 * versions, and both were retracted too.
 */
async function findReplacement(
  message: any,
  noticeDOI: string | undefined,
  options: RetractionCheckOptions
): Promise<RetractionReplacementInfo> {
  if (options.checkReplacement === false) {
    return { status: 'unknown', evidence: [], unknownReason: 'not_requested' };
  }
  const ownDOI = typeof message?.DOI === 'string' ? message.DOI : '';
  const evidence: RetractionReplacementEvidence[] = [];
  let replacementDOI: string | undefined;
  const failures: LookupFailure[] = [];

  const rel = message?.relation?.['is-replaced-by'];
  if (Array.isArray(rel)) {
    const ids = new Map<string, string>();
    for (const r of rel) {
      const id = typeof r?.id === 'string' ? r.id.trim() : '';
      if (String(r?.['id-type']).toLowerCase() === 'doi' && id && !sameDoiLoose(id, ownDOI)) {
        if (!ids.has(doiKey(id))) ids.set(doiKey(id), id);
      }
    }
    if (ids.size > 0) evidence.push('crossref_is_replaced_by');
    // Several distinct replacements (v2 and v3): which one is "the" replacement is not said.
    if (ids.size === 1) replacementDOI = [...ids.values()][0];
  }
  if (titlesOf(message).some((t) => REPLACED_TITLE_MARKERS.some((re) => re.test(t)))) evidence.push('title_marker');

  if (noticeDOI && !sameDoiLoose(noticeDOI, ownDOI)) {
    const notice = await getWork(noticeDOI, options.creds);
    if (notice.ok) {
      if (titlesOf(notice.value).some((t) => REPLACEMENT_NOTICE_TITLE.test(t))) {
        evidence.push('notice_title');
      }
    } else failures.push(notice);
  }

  const labs = await getLabsUpdates(ownDOI, options.creds);
  if (labs.ok) {
    const rr = labs.value.filter((u) => u.reasons.some(isRetractAndReplaceReason));
    if (rr.length > 0) {
      evidence.push('retraction_watch_reason');
      if (!replacementDOI) {
        // Not a replacement: the work itself, its notices (every `updated-by` DOI), and the
        // notice Retraction Watch names (`target-doi`).
        const exclude = [
          ownDOI,
          noticeDOI ?? '',
          ...(Array.isArray(message?.['updated-by'])
            ? message['updated-by'].map((u: any) => (typeof u?.DOI === 'string' ? u.DOI : ''))
            : []),
          ...rr.map((u) =>
            typeof u['target-doi'] === 'string'
              ? u['target-doi'].replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
              : ''
          ),
        ].filter(Boolean);
        // A DOI in free-text notes is the replacement only when it follows a replacement cue
        // ("see instead", "replaced by", ...), Crossref confirms it is a work (a publisher URL
        // can carry trailing path segments), and it is the ONE such work. A DOI named without a
        // cue (an editorial, a related paper, another notice) is never taken. A cued DOI whose
        // lookup failed (not an answered 404) may be the replacement, so it blocks the choice.
        const confirmed = new Map<string, string>();
        let unresolvedCued = 0;
        for (const group of rr.flatMap((u) => doiCandidatesFromNotes(u.notes))) {
          if (!group.cued) continue;
          const forms = group.forms.filter((c) => !exclude.some((x) => sameDoiLoose(c, x)));
          let resolved = forms.length === 0;
          let networkFailure = false; // a failure other than an answered 404
          for (const c of forms) {
            const w = await getWork(c, options.creds);
            if (w.ok && typeof w.value?.DOI === 'string') {
              resolved = true;
              if (!exclude.some((x) => sameDoiLoose(w.value.DOI, x))) {
                confirmed.set(doiKey(w.value.DOI), w.value.DOI);
              }
              break;
            }
            if (!w.ok && !w.notIndexed) networkFailure = true;
          }
          if (!resolved && networkFailure) unresolvedCued += 1;
        }
        if (confirmed.size === 1 && unresolvedCued === 0) replacementDOI = [...confirmed.values()][0];
      }
    }
  } else failures.push(labs);

  if (evidence.length > 0) {
    return { status: 'replaced', evidence, ...(replacementDOI ? { replacementDOI } : {}) };
  }
  if (failures.length > 0) {
    return {
      status: 'unknown',
      evidence,
      unknownReason: failures.some((f) => f.reason === 'lookup_failed')
        ? 'lookup_failed'
        : 'malformed_response',
      detail: failures.map((f) => f.detail).join('; '),
    };
  }
  return { status: 'not_recorded', evidence };
}

/**
 * Check whether a paper has been retracted, withdrawn or removed.
 *
 * Every result carries `verdict` (`clean` | `flagged` | `could_not_check`).
 * Every flagged result also carries `timing` (before/after the citing paper,
 * when `options.citing` is given) and `replacement`.
 *
 * @param doi     The DOI to check, with or without a doi.org prefix.
 * @param options Polite-pool credentials, the source list and the citing paper.
 *                Optional, so the published single-argument signature keeps working.
 * @throws RangeError when `options.citing.publishedDate` is not a readable date.
 */
export async function checkRetraction(
  doi: string,
  options: RetractionCheckOptions = {}
): Promise<RetractionInfo> {
  return checkWithResolver(doi, options, makeCitingResolver(options.citing, options.creds));
}

async function checkWithResolver(
  doi: string,
  options: RetractionCheckOptions,
  resolveCiting: CitingResolver
): Promise<RetractionInfo> {
  const { info, crossrefMessage } = await lookupRetraction(doi, options);
  const verdict = verdictOf(info.isRetracted, info.checked);
  if (verdict !== 'flagged') return { ...info, verdict };
  return {
    ...info,
    verdict,
    timing: compareRetractionTiming(info.retractionDate, await resolveCiting()),
    replacement: crossrefMessage
      ? await findReplacement(crossrefMessage, noticeDoiOf(info.retractionNoticeUrl), options)
      : options.checkReplacement === false
        ? { status: 'unknown', evidence: [], unknownReason: 'not_requested' }
        : {
            status: 'unknown',
            evidence: [],
            unknownReason: 'lookup_failed',
            detail: 'no Crossref record was read (the answer came from OpenRetractions)',
          },
  };
}

function noticeDoiOf(url: string | undefined): string | undefined {
  const m = url ? /^https:\/\/doi\.org\/(.+)$/.exec(url) : null;
  return m ? m[1] : undefined;
}

type RawRetractionInfo = Omit<RetractionInfo, 'verdict' | 'timing' | 'replacement'>;

async function lookupRetraction(
  doi: string,
  options: RetractionCheckOptions
): Promise<{ info: RawRetractionInfo; crossrefMessage?: any }> {
  const { creds, sources = DEFAULT_RETRACTION_SOURCES } = options;

  // Clean DOI
  const cleanDOI = cleanDoiInput(doi);
  const sourcesChecked: RetractionSourceName[] = [];
  const sourcesUnavailable: RetractionSourceUnavailable[] = [];

  // Nothing DOI-shaped to ask about. Every requested source is recorded as
  // unavailable, so the result is `could_not_check`, never a clean.
  if (!isDoiShaped(cleanDOI)) {
    for (const source of sources) {
      sourcesUnavailable.push({ source, reason: 'invalid_doi', detail: cleanDOI.slice(0, 80) });
    }
    return {
      info: {
        isRetracted: false,
        checked: false,
        sourcesChecked,
        sourcesUnavailable,
        originalPaperDOI: cleanDOI,
      },
    };
  }

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

      // Only a JSON answer is an answer: a parked domain serves HTML with a 200
      // (measured 2026-11-22), which would otherwise read as "checked, not retracted".
      if (response.status === 200 && response.data && typeof response.data === 'object' && typeof response.data.retracted === 'boolean') {
        const data = response.data;
        sourcesChecked.push('openretractions');

        if (data.retracted === true) {
          // A dedicated retraction index saying "yes" is definitive, so the
          // cascade stops here and Crossref is not consulted. `sourcesChecked`
          // records that, so a caller can still see the verdict rests on one
          // source.
          return {
            info: {
              isRetracted: true,
              retractionType: 'retraction',
              checked: true,
              sourcesChecked,
              sourcesUnavailable,
              retractionDate: sameFormatDate(data.retraction_date),
              retractionReason: data.reason,
              retractionNoticeUrl: data.retraction_notice_url,
              originalPaperDOI: cleanDOI,
              source: 'openretractions',
            },
          };
        }
      } else {
        sourcesUnavailable.push({
          source: 'openretractions',
          reason: 'server_error',
          detail: response.status === 200 ? '200 without a JSON retraction answer' : String(response.status),
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

      const message = crossrefResponse.data?.message;
      if (crossrefResponse.status === 200 && !isWorkRecord(message)) {
        // A 200 whose body is no work record (a captive portal's HTML, an empty
        // body, a list, a record without a DOI) is not Crossref's answer: before,
        // `?? {}` read it as a work with no retraction, so it counted as checked-clean.
        sourcesUnavailable.push({ source: 'crossref', reason: 'server_error', detail: '200 without a work record' });
      } else if (crossrefResponse.status === 200) {
        sourcesChecked.push('crossref');

        // The real relation key. NOT `update` (which Crossref does not serve)
        // and NOT `update-to` (which names what THIS work retracts).
        const found = findRetractionRelation(message);

        if (found) {
          const { relation, type, dateUsable } = found;
          // An entry that names the work's OWN DOI (an in-place publisher retraction, every
          // Retraction Watch entry) gives no notice: linking the paper as its notice is wrong.
          const noticeDoi =
            typeof relation.DOI === 'string' && relation.DOI.trim() &&
            !sameDoiLoose(relation.DOI, cleanDOI) && !sameDoiLoose(relation.DOI, String(message.DOI))
              ? relation.DOI
              : undefined;
          return {
            crossrefMessage: message,
            info: {
            isRetracted: true,
            retractionType: type,
            checked: isChecked(),
            sourcesChecked,
            sourcesUnavailable,
            retractionDate: dateUsable ? relationDate(relation) : undefined,
            retractionReason: relation.label || UPDATE_TYPE_WORDING[type],
            retractionNoticeUrl: noticeDoi ? `https://doi.org/${noticeDoi}` : undefined,
            originalPaperDOI: cleanDOI,
            source: 'crossref',
            },
          };
        }

        // Fallback: the publisher stamped the marker on the title but deposited
        // no update relation. Measured on real records, this is the ONLY signal
        // for some genuine retractions, so it is not redundant.
        const titleMarker = findTitleMarker(message);
        if (titleMarker) {
          return {
            crossrefMessage: message,
            info: {
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
            },
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
    info: {
      isRetracted: false,
      checked: isChecked(),
      sourcesChecked,
      sourcesUnavailable,
      originalPaperDOI: cleanDOI,
      source: sourcesChecked.includes('crossref') ? 'crossref' : undefined,
    },
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
 * Batch check multiple DOIs for retractions.
 *
 * All DOIs share one citing paper (`options.citing`): its Crossref record is
 * fetched at most once for the whole batch, and only if something is flagged.
 */
export async function checkMultipleRetractions(
  dois: string[],
  options: RetractionCheckOptions = {}
): Promise<Map<string, RetractionInfo>> {
  const results = new Map<string, RetractionInfo>();
  const resolveCiting = makeCitingResolver(options.citing, options.creds);

  // Process in batches to avoid rate limiting
  const batchSize = 5;
  for (let i = 0; i < dois.length; i += batchSize) {
    const batch = dois.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (doi) => {
        const info = await checkWithResolver(doi, options, resolveCiting);
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
