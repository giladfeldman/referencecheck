# referencecheck API reference

Every function, constant and type exported from the package root:

```ts
import { checkRetractionDetailed, validateDOI /* , ... */ } from 'referencecheck';
```

Network functions are `async`. This page is checked against the source by
`npm run docs:check`: a new export, field, parameter, literal value, issue code, environment
variable or script flag that is not named here or in the README fails the build.

- [Shared input: `ReferenceInput`](#shared-input-referenceinput)
- [Credentials and HTTP](#credentials-and-http)
- [DOI validation and lookup](#doi-validation-and-lookup)
- [DOI shape and shortDOIs](#doi-shape-and-shortdois)
- [Retraction](#retraction)
- [Expression of concern](#expression-of-concern)
- [Replies and errata](#replies-and-errata)
- [Preprints](#preprints)
- [Open access](#open-access)
- [Citation counts](#citation-counts)
- [Predatory-journal screening](#predatory-journal-screening)
- [Deduplication](#deduplication)
- [Issue codes](#issue-codes)

## Shared input: `ReferenceInput`

```ts
interface ReferenceInput {
  id: string;                         // your identifier; echoed nowhere by the checks except as you use it
  raw_text: string;                   // the reference as written
  doi?: string;
  suggested_doi?: string;             // used when `doi` is empty
  doi_crossref_data?: any;            // a Crossref `message` object, if you already fetched one
  parsed_data?: ParsedReferenceInput;
  normalized_authors?: string[];      // deduplication input
  normalized_title?: string;          // deduplication input
  normalized_year?: string;           // deduplication input
  url?: string;
  journal_validation_checked_at?: string; // declared; not read by any function
}

interface ParsedReferenceInput {
  authors?: unknown[];
  year?: string;
  title?: string;
  source?: string;                    // journal or book title
  volume?: string;
  pages?: string;
}
```

## Credentials and HTTP

### `MetadataCredentials`

```ts
interface MetadataCredentials {
  crossrefEmail?: string;   // contact address for Crossref's polite pool
  openAlexEmail?: string;
  semanticScholarApiKey?: string; // optional, used by fetchAbstract   // contact address for OpenAlex's polite pool
}
```

When a field is absent the library sends `DEFAULT_POLITE_EMAIL`, a fixed project address.

| Export | Does |
|---|---|
| `DEFAULT_POLITE_EMAIL` | the fallback contact address (a string constant) |
| `getCrossrefUserAgent(creds?)` | the `User-Agent` sent to Crossref, naming `creds.crossrefEmail` or the default |
| `crossrefGet(url, config?, creds?)` | `axios.get` with that User-Agent, a 10 s default timeout, and retries on 429, 502, 503 and 504 (3 attempts; 429 honours `Retry-After`, capped at 30 s). Throws the last error when retries run out |
| `getOpenAlexEmail(creds?)` | `creds.openAlexEmail`, else `DEFAULT_POLITE_EMAIL` |
| `formatError(error, context?)` | one-line description of any thrown value: `[context] message (Name) Caused by: …`; adds `Code`, `Details` and `Hint` for database-style error objects, and the first stack lines when `NODE_ENV` is `development` |

## DOI validation and lookup

### `validateDOI(doi, creds?)`

Returns `Promise<{ valid; data?: CrossrefResult; error?; source?: 'crossref' | 'resolver' }>`.
Reads the DOI through `cleanDoiInput` (resolver URL, `doi:` label, whitespace and percent-encoding removed, like every other DOI reader here), asks Crossref, and on a Crossref 404 asks doi.org
whether the DOI resolves (`source: 'resolver'`, `score: 50`, no metadata). Results are cached
in memory for 30 minutes.

```ts
interface CrossrefResult {
  found: boolean;
  doi?: string;
  title?: string;
  authors?: string[];        // "Family, Given"
  publishedDate?: string;    // ISO, at the precision Crossref gives: "1998-02", "2019-03-05" (before 0.3.0: "1998-2")
  journal?: string;
  score: number;             // 100 from a DOI lookup, 50 from the resolver fallback, Crossref's relevance score from a search
  rawData?: any;             // the Crossref message
}
```

### `validateMultipleDOIs(dois, creds?)`

`Promise<Map<doi, { valid; data?; error? }>>`, 5 at a time with a 1 s pause between groups.

### `findDOIFromReference(referenceText, creds?)`

Finds the DOI of a free-text reference, or `null`. Tries Crossref's Simple Text Query, then
the bibliographic search (top 5, relevance score of at least 50). A candidate is accepted only
if its year is within one year of the reference's and at least one author surname matches.
Theses, dissertations, unpublished manuscripts, personal communications, and works "in
preparation", "submitted" or "under review" are skipped without a request. Surnames are folded
with `foldForMatch` on both sides. The reference's year is the first `(dddd)` or `(dddda)`,
else the first bare 1900–2099 number (the 0.2.x rule).

### `findDOIFromReferenceDetailed(referenceText, creds?)` — preferred

The same search, with its coverage stated. `null` from `findDOIFromReference` covers four
different facts; this returns `Promise<DoiSearchOutcome>`:

```ts
interface DoiSearchOutcome {
  result: CrossrefResult | null;
  status: 'found' | 'no_match' | 'skipped_unpublishable' | 'lookup_failed';
  rejected: RejectedDoiCandidate[];   // every candidate the author/year check refused
  belowScoreThreshold: number;        // search candidates under relevance 50, dropped unchecked
  errors: string[];                   // per-stage errors, in order
}

interface RejectedDoiCandidate {
  doi: string;
  stage: 'simple_text_query' | 'search';
  reason: string;                     // "Author mismatch: ...", "Year mismatch: ...", "DOI did not validate: ..."
}
```

`lookup_failed` means the search never got an answer: it is not evidence that no DOI exists.

## Shared input readers

Every function that reads a DOI, an author list or a name/title goes through these, so one
input is read the same way everywhere (bound by `tests/parity/`). Years are not read here in
this release: each year reader keeps its 0.2.x rule (`tests/parity/yearRules02.test.ts`).

| Export | Returns |
|---|---|
| `cleanDoiInput(doi)` | the DOI with surrounding whitespace, a resolver URL (`http(s)://`, `dx.`/`www.`, or bare `doi.org/`) or a `doi:` label removed and percent-encoding decoded; case kept; `''` for a non-string |
| `doiForUrl(doi)` | `encodeURIComponent(cleanDoiInput(doi))`, the only form a DOI takes inside a request URL |
| `foldForMatch(text)` | lower-cased, accents removed (`Müller` → `muller`; also ø ł ß đ ı æ œ þ: `Østergaard` → `ostergaard`), letters and digits of every script kept, everything else one space |
| `splitAuthorList(authors)` | one entry per author from an array or a string; `;`, `&` and "and" always separate; a comma separates unless what follows is only initials (each capital followed by a period, space, hyphen or the end) or a suffix (`Smith, J., Jones, K.` and `LI, X., WU, Y.` → 2 authors) |
| `formatDateParts(parts)` | Crossref `date-parts` as ISO at the given precision: `[2019, 3, 5]` → `"2019-03-05"`, `[2019]` → `"2019"`, else `undefined` |
| `normalizeIssn(issn)` | an ISSN as `NNNN-NNNC` with the check digit upper-cased, from any spacing, dash or `ISSN`/`eISSN` label; `null` unless it has eight ISSN characters and a correct mod-11 check digit (`1648-1655` is a page range) |
| `journalKey(name)` | `foldForMatch(name)` with the words "and" and "the" dropped: the key both sides of a journal-name comparison use (`Journal of Personality & Social Psychology` = `Journal of Personality and Social Psychology`) |

## DOI shape and shortDOIs

| Export | Returns |
|---|---|
| `isMalformedDoi(doi)` | `true` unless `cleanDoiInput(doi)` is `10.` + 3–9 digits + `/` + a suffix without spaces, or the shortDOI form `10/<token>`; `true` for a non-string. Shape only: `10.1037/0` returns `false` |
| `isShortFormDoi(doi)` | `true` for `10/<token>`, also when written `https://doi.org/10/<token>` or `doi:10/<token>` |
| `expandShortDoi(doi, options?)` | `Promise<ShortDoiExpansion>`: one request to doi.org, reading the redirect. Non-shortDOI input returns `not-short-form` with no request. Cached 24 h |
| `readExpansionTarget(location)` | the pure half: `{ doi }` from a redirect `Location`, or `{ reason }` (`no-redirect`, `off-resolver`, `unexpanded-target`) |
| `clearShortDoiCache()` | empties the expansion cache |

```ts
interface ExpandShortDoiOptions {
  creds?: MetadataCredentials;
  timeoutMs?: number;   // per attempt, default 8000
  noCache?: boolean;    // bypass the cache for this call
}

interface ShortDoiExpansion {
  expanded: boolean;               // true only for reason 'expanded'
  doi?: string;                    // present if and only if expanded
  reason: ShortDoiExpansionReason;
  status?: number;                 // HTTP status from doi.org
  error?: string;                  // cause, for 'network-error'
}
```

`ShortDoiExpansionReason`: `expanded`; `not-short-form` (no request made); `not-registered`
(doi.org 404); `malformed` (doi.org 400); `no-redirect`; `off-resolver` (redirect left
doi.org: a link, not an alias); `unexpanded-target` (redirect path is not a canonical DOI);
`network-error`.

## Retraction

### `checkRetractionDetailed(doi, options?)` — preferred

`Promise<{ retraction: RetractionInfo; complete: boolean; sourcesUnavailable: RetractionSourceUnavailable[] }>`.
`complete` is `false` whenever a source did not answer.

### `checkRetraction(doi, options?)`

`Promise<RetractionInfo>` alone.

### `checkMultipleRetractions(dois, options?)`

`Promise<Map<doi, RetractionInfo>>`, 5 at a time with a 1 s pause. Read each `checked`.

```ts
interface RetractionCheckOptions {
  creds?: MetadataCredentials;
  sources?: readonly RetractionSourceName[];   // default DEFAULT_RETRACTION_SOURCES = ['crossref']
}

interface RetractionInfo {
  isRetracted: boolean;            // pulled from the literature (any RetractionUpdateType)
  retractionType?: RetractionUpdateType;
  checked: boolean;                // every consulted source answered, and at least one did
  sourcesChecked: RetractionSourceName[];
  sourcesUnavailable: RetractionSourceUnavailable[];
  retractionDate?: string;
  retractionReason?: string;       // the notice label, or the type in words
  retractionNoticeUrl?: string;    // doi.org link to the notice
  originalPaperDOI?: string;
  source?: RetractionSourceName;   // the source that produced the answer
}

interface RetractionSourceUnavailable {
  source: RetractionSourceName;
  reason: RetractionUnavailableReason;
  detail?: string;
}
```

- `RetractionSourceName`: `crossref`, `openretractions`.
- `RetractionUpdateType`: `retraction`, `partial_retraction`, `removal`, `withdrawal`. When
  several are deposited the most severe is reported, and among entries of that type the
  earliest date.
- `RetractionUnavailableReason`: `rate_limited`, `timeout`, `server_error`, `network`,
  `not_indexed` (a Crossref 404: the DOI is not a Crossref work, which says nothing about
  retraction).

Detection reads Crossref `updated-by`; `update-to` (which a retraction *notice* carries,
pointing at the paper it retracts) is deliberately not read as a retraction of the queried DOI.
A title beginning with a retraction or withdrawal marker is the fallback when `updated-by` is
empty.

## Expression of concern

### `checkReferenceForEOCDetailed(reference)` — preferred

```ts
interface EocReferenceResult {
  issues: ExpressionOfConcernIssue[];
  sourcesChecked: string[];            // 'CrossRef', 'PubMed', 'KnownList'
  sourcesUnavailable: EocSourceReport[];
  complete: boolean;                   // every source answered
}

interface EocSourceReport { source: string; reason: EocUnavailableReason; detail?: string }
type EocUnavailableReason = 'rate_limited' | 'timeout' | 'server_error' | 'network' | 'malformed_response' | 'not_indexed';
type EocSourceOutcome =
  | { status: 'clean' }
  | { status: 'issue'; issue: ExpressionOfConcernIssue }
  | { status: 'unavailable'; reason: EocUnavailableReason; detail?: string };
```

Sources: Crossref `updated-by` entries of type `expression_of_concern`, and Europe PMC's
`commentCorrectionList` (entries of type "Expression of concern in") for the record whose DOI
matches, from a `DOI:"..."` search with `resultType=core` (reported as `PubMed`). A 200 that
carries no work record (Crossref) or no result list (Europe PMC) is `malformed_response`, not
`clean`. A Crossref 404 (the DOI is not registered at Crossref) is `not_indexed`; a Europe PMC
search with no hit is `clean`. One concern found by both sources gives one issue per source. Before 0.3.0 neither
source could fire (see the CHANGELOG). `KnownList` is **not implemented**: it always returns `clean`, so it
appears in `sourcesChecked` without a lookup. A reference with no DOI returns
`complete: true` with no sources.

### `checkReferenceForEOC(reference)`

The findings only (`ExpressionOfConcernIssue[]`); cannot say whether any source answered.

### `getEocSeverityCounts(issues)`

`{ errors, warnings }`.

```ts
interface ExpressionOfConcernIssue {
  type: 'expression-of-concern';
  severity: 'warning' | 'error';
  code: string;             // EOC_DETECTED (Crossref), EOC_PUBMED (Europe PMC)
  description: string;
  location: string;
  suggestion?: string;
  affectedText?: string;
  metadata?: { doi?; journalName?; dateIssued?; details?; source? };
}
```

`metadata.dateIssued` is the date of the expression-of-concern notice (Crossref: the earliest
`updated-by` date, ISO, e.g. `"2023-01-11"`); Europe PMC gives no notice date, so it is absent
for `EOC_PUBMED`. `metadata.details` names the notice (Crossref: `notice: <doi>; recorded by:
publisher, retraction-watch`; Europe PMC: `notice: MED <PMID of the notice>`). The Europe PMC request waits up to 15 s:
its `core` search, the only one carrying the corrections list, measured up to 10.8 s on a
record's first request.

## Replies and errata

### `checkReferenceForReplies(reference)`

`Promise<CitationRepliesIssue[]>` from one Crossref record: `updated-by` entries of type
`correction`, `erratum` or `corrigendum` (`HAS_ERRATA`; not `addendum`; `replyDOI` is the first
notice, `replyCount` the distinct notices, `replyDate` the earliest notice date as ISO
`YYYY-MM-DD`), and the relations `has-reply` (`HAS_AUTHOR_REPLY`), `has-comment`
(`HAS_COMMENTS`) and `is-reply-to` (`IS_RESPONSE`). Before 0.3.0 `HAS_ERRATA` and
`IS_RESPONSE` read relation types Crossref does not serve and never fired. `[]` for no DOI
and on a network failure: an empty list does not distinguish "none" from "could not check".

### `getRepliesSummary(issues)`

`{ totalIssues, errata, authorReplies, comments, responses }`.

```ts
interface CitationRepliesIssue {
  type: 'citation-replies';
  severity: 'info' | 'warning';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: {
    doi?; replyType?: 'errata' | 'correction' | 'reply' | 'comment' | 'response';
    replyCount?; replyDOI?; replyDate?; source?;
  };
}
```

`replyType: 'correction'` is declared but never produced.

## Preprints

### `checkReferenceForPreprint(reference)`

`Promise<PreprintIssue[]>`. First a local match of the DOI prefix or URL against known preprint
servers (SSRN, PsyArXiv, OSF Preprints, bioRxiv/medRxiv, arXiv, Preprints.org, EarthArXiv,
SocArXiv, engrXiv, ChemRxiv), which needs no request; otherwise Crossref: `posted-content` or
subtype `preprint` gives `IS_PREPRINT` (with the published version from `is-preprint-of` when
deposited), and a `has-preprint` relation gives `HAS_PREPRINT_VERSION`.

| Export | Returns |
|---|---|
| `detectKnownPreprintFromDoi(doi)` | server name for a known preprint DOI prefix, or `null` |
| `detectKnownPreprintFromText(text)` | server name for a known preprint URL in the text, or `null` |
| `getPreprintSummary(issues)` | `{ preprintCount, activePreprints, hasPreprints }` |

```ts
interface PreprintIssue {
  type: 'preprint-status';
  severity: 'info' | 'warning';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: { doi?; preprintServer?; preprintDate?; publishedDOI?; publishedDate?; source? };
}
```

## Open access

### `checkReferenceForOpenAccess(reference)`

`Promise<OpenAccessIssue[]>`: one `OA_AVAILABLE` issue when Unpaywall reports the DOI as open
access, else `[]` (also on a 404 or network failure).

### `getOpenAccessSummary(issues)`

`{ openAccessCount, goldOA, greenOA, bronzeOA }`.

```ts
interface OpenAccessIssue {
  type: 'open-access';
  severity: 'info';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: {
    doi?; openAccessStatus?: 'gold' | 'green' | 'bronze' | 'closed';
    url?; version?; license?; source?;
  };
}
```

`openAccessStatus` is `gold` when the journal is open access or in DOAJ, otherwise `green`;
`bronze` and `closed` are declared but never produced, so `bronzeOA` is always 0.

## Citation counts

| Export | Returns |
|---|---|
| `getCitationCount(doi)` | `Promise<number \| null>` from OpenCitations; `null` when unknown or on failure (20 s timeout) |
| `getCitingWorks(doi)` | `Promise<CitingWork[]>`; `[]` when none or on failure |

```ts
interface CitingWork {
  oci: string;          // Open Citation Identifier of the citation
  citing: string;       // citing work identifiers
  cited: string;        // cited work identifiers
  creation: string;     // date of the citing work
  timespan?: string;    // ISO 8601 duration between the two publications
  journal_sc?: string;  // journal self-citation flag
  author_sc?: string;   // author self-citation flag
}

interface CitationCountResult {   // declared shape; getCitationCount returns the bare number
  count: number;
  source: 'opencitations';
  updatedAt: string;
}
```

## Predatory-journal screening

A typical pipeline:

```ts
if (isValidReference(reference)) {
  const meta = await extractJournalMetadata(reference, true, creds);   // { journal?, issn?, publisher? }
  const bealls = meta.publisher ? checkBeallsList(meta.publisher) : false;
  const doaj = meta.issn ? await checkDOAJ(meta.issn) : { found: false };
  const heuristics = checkHeuristics(meta.journal ?? '', { heuristicSensitivity: 'medium' });
  const verdict = determineVerdict(bealls, doaj, heuristics, meta.publisher);
}
```

| Export | Does |
|---|---|
| `isValidReference(reference)` | `false` for text that is not a reference: under 20 characters, main-text openings (`In Study`, `Table 1`, `See`, `e.g.` …), fewer than 2 of {authors, year, title, source}, or over 500 characters with neither year nor source |
| `extractJournalMetadata(reference, useOpenAlex?, creds?)` | `JournalMetadata` from, in order: `doi_crossref_data`, `parsed_data.source`, an ISSN in `raw_text`, publisher phrases in `raw_text`, then (when `useOpenAlex`, default `true`) OpenAlex by DOI and by journal name, pausing 200 ms after each OpenAlex call |
| `loadBeallsList()` | the bundled `BeallsList` (cached after the first read) |
| `checkBeallsList(publisher)` | `true` when the publisher name matches a listed publisher (word-sequence match, not raw substring; a single generic word does not match) |
| `isKnownLegitimate(publisher)` | `true` for a publisher on the bundled legitimate list |
| `checkDOAJ(issn)` | `Promise<DOAJResult>` from the DOAJ journal search by the hyphenated ISSN (`normalizeIssn`; before 0.3.0 the hyphen was stripped and DOAJ found nothing). `{ found: false }` for an empty ISSN or no hit; `{ found: false, unavailable: true, reason: 'invalid_issn' }` for a non-ISSN (DOAJ not asked); `{ found: false, unavailable: true, reason }` when DOAJ failed or sent no result list, which means "could not check", not "not listed" |
| `searchOpenAlexByJournalName(journalName, creds?)` | best OpenAlex journal source by name (names under 3 characters are not searched) |
| `resolveOpenAlexByDOI(doi, creds?)` | the OpenAlex journal of the work with this DOI |
| `checkHeuristics(journalName, config)` | name keyword indicators from the bundled list, in 5 categories |
| `determineVerdict(beallsResult, doajResult, heuristicsResult, publisher?)` | the combined `VerificationResult` |

`determineVerdict` rules, in order: a known legitimate publisher → `legitimate` (0.95). On
Beall's List → `predatory` (0.9). In DOAJ → `legitimate` (0.85), or `unknown` (0.5) if it is
also on Beall's List. Heuristics flagging → lowers a legitimate verdict's confidence (to at
least 0.6), raises a predatory one (at most 0.95), or on their own give `predatory` with the
heuristic confidence. Otherwise `unknown`.

`checkHeuristics` sensitivity: `high` flags on any indicator; `medium` (default) on 2+ or
`guaranteed_acceptance`; `low` on 3+ or `guaranteed_acceptance`. Confidence is
`0.25 × indicators` (at most 1), scaled down when not flagged.

```ts
interface BeallsList {
  lastUpdated: string;              // '2017-01-15'
  source: string;
  note?: string;
  publishers: string[];
  indicators: {
    rapid_publication: string[];
    guaranteed_acceptance: string[];
    excessive_marketing: string[];
    suspicious_fees: string[];
    poor_quality_signals: string[];
  };
  knownLegitimatePublishers: string[];
}

interface JournalMetadata { journal?: string; issn?: string; publisher?: string }

interface DOAJResult { found: boolean; unavailable?: boolean; reason?: string; journalTitle?; publisher?; issn?; eissn?; url? }

interface OpenAlexResult { found: boolean; journalTitle?; publisher?; issn?; eissn?; url?; openalexId? }

interface OpenAlexSource {        // one raw OpenAlex source record
  id: string; display_name: string; issn_l?; issn?: string[];
  host_organization_name?; homepage_url?; type?; is_oa?; is_in_doaj?;
}

interface HeuristicsResult { isPredatory: boolean; confidence: number; indicators: string[]; details: string[] }

interface VerificationResult {
  status: 'legitimate' | 'predatory' | 'unknown';
  source: 'bealls_list' | 'doaj' | 'heuristics' | 'combined';
  confidence: number;
  isPredatory: boolean;
  reasoning: string;
  sources: string[];               // 'known_legitimate', 'bealls_list', 'doaj', 'heuristics'
  details: { beallsCheck?: boolean; doajCheck?: DOAJResult; heuristicsCheck?: HeuristicsResult };
}

interface PluginConfig {
  heuristicSensitivity?: 'low' | 'medium' | 'high';   // read by checkHeuristics
  useBeallsList?: boolean;   // declared; not read by any function
  useDOAJ?: boolean;         // declared; not read by any function
  useHeuristics?: boolean;   // declared; not read by any function
  useOpenAlex?: boolean;     // declared; not read (extractJournalMetadata takes its own useOpenAlex argument)
  cacheExpiry?: number;      // declared; not read by any function
}
```

## Deduplication

All local; no network.

| Export | Returns |
|---|---|
| `calculateSimilarity(ref1, ref2, config)` | `authorWeighting × authors + titleWeighting × title + (1 − both) × year`, from `normalized_authors`, `normalized_title`, `normalized_year` |
| `compareAuthors(authors1, authors2)` | 0–1, symmetric; each argument a string or a string array, split with `splitAuthorList` and folded with `foldForMatch`; best Levenshtein match per author, averaged both ways; 0.5 when both are empty |
| `compareTitle(title1, title2)` | `1 − Levenshtein distance / longer length` after `foldForMatch` (non-Latin titles compared, not emptied); 0.5 when both are empty |
| `compareYear(year1, year2)` | `parseInt` of each value (the 0.2.x rule): 1 same year, 0.5 one year apart, 0 otherwise; 0.5 when both are empty, 0 when one is or when either does not start with a number (`"(2019)"`, `"in press"`) |
| `normalizeAuthorName(name)` | `foldForMatch(name)`: `"Smith, J."` → `"smith j"`, `"Müller"` → `"muller"` |
| `scoreMetadataCompleteness(ref)` | 0–1 weighted presence of title, authors, year, DOI, source, volume, pages |
| `findDuplicateGroups(pairs)` | `DuplicateGroup[]` by transitive closure (A=B and B=C gives one group) |
| `selectBestReference(refs)` | the most complete reference; throws on an empty array |

```ts
interface DeduplicationConfig {
  threshold: number;        // for the caller: the library does not apply it
  authorWeighting: number;
  titleWeighting: number;
}

interface DuplicatePair { ref1: ReferenceInput; ref2: ReferenceInput; similarity: number }

interface DuplicateGroup { references: ReferenceInput[]; bestReference: ReferenceInput; averageSimilarity: number }

// Report shapes for a caller that builds its own duplicate report; no function returns them.
interface DeduplicationIssue {
  severity: 'warning';
  type: 'duplicate-reference';
  description: string;
  references: { id; title; authors; year: number | null; metadata_completeness: number }[];
  similarity: number;
  suggestion: string;
}

interface DeduplicationResults {
  success: boolean;
  issues: DeduplicationIssue[];
  summary: { totalReferences; duplicatePairs; duplicateGroups; referencesAffected };
  error?: { code: string; message: string };
}
```

## Abstracts

Abstract lookup by DOI, for claim checks that compare a citing sentence with the cited
source's abstract. The library fetches and caches; it never judges.

### `fetchAbstract(doi, options?)`

Tries the sources in `ABSTRACT_SOURCES` order — `crossref` (publisher-deposited JATS),
`openalex` (rebuilt from `abstract_inverted_index` by `invertedIndexToText`),
`semanticscholar`, `europepmc` — and stops at the first that yields at least
`MIN_ABSTRACT_CHARS` (200) characters. Throws only when `doi` is not a DOI after
`normalizeAbstractDoi` (lower-cased, `https://doi.org/` and `doi:` prefixes removed).

`FetchAbstractOptions`:

| Field | Meaning |
|---|---|
| `credentials` | `MetadataCredentials`; `crossrefEmail` / `openAlexEmail` for the polite pools, `semanticScholarApiKey` sent as `x-api-key` |
| `cache` | an `AbstractCache` (`get(doi)`, `set(doi, result)`), keyed by normalised DOI; `MemoryAbstractCache` is the in-process default |
| `sources` | the sources to try, in order (default `ABSTRACT_SOURCES`, with `semanticscholar` skipped unless `semanticScholarApiKey` is set: its keyless pool answers HTTP 429 so often that a miss would read as `error`) |
| `httpGet` | a `JsonGet` — `(url, headers) => Promise<json \| null>`, `null` meaning 404; default `axiosJsonGet` |
| `now` | clock for `retrievedAt` and cache age |
| `notFoundMaxAgeDays` | a cached `not_found` older than this is looked up again (default 30); a cached `found` does not expire |

Returns an `AbstractResult`:

```ts
interface AbstractResult {
  doi: string;                 // normalised
  status: AbstractStatus;      // 'found' | 'not_found' | 'error'
  abstract: string | null;     // markup removed by cleanAbstractMarkup
  source: AbstractSource | null;
  title: string | null;
  year: number | null;
  attempts: AbstractAttempt[]; // one per source tried: { source, outcome, detail? }
  sourcesTried: AbstractSource[]; // the sources this lookup consulted
  shortAbstract: string | null;   // longest text under MIN_ABSTRACT_CHARS seen, when nothing longer was found
  retrievedAt: string;         // ISO timestamp
}
```

`AbstractAttempt.outcome` is `found`, `absent` (the source answered without an abstract;
`detail: 'no record'` when it has no record of the DOI at all), `too_short` (under
`MIN_ABSTRACT_CHARS`; the text is kept as `shortAbstract`) or `error` (the request failed, or the
source answered 200 with an empty body or a body of an unexpected shape, such as an HTML block
page, or a record for ANOTHER DOI). A record is accepted only when it is the requested DOI: Crossref
`message.DOI`, OpenAlex `doi`, Semantic Scholar `externalIds.DOI` and Europe PMC `doi` are each
checked with `sameDoi`. An OpenAlex index with a gap or a reused position is an `error`, never a
reconstructed text. When a field holds several abstracts (translations), the English one, else the
first, is used.

**`not_found` and `error` are different facts.** `not_found` means every source answered and
none had a usable abstract. `error` means none had one *and* at least one source failed, so the
abstract may exist. Only `found` and `not_found` are written to the cache; an `error` is retried
on the next lookup. A cached `not_found` answers only a lookup that asks no more sources than
its `sourcesTried` (a `crossref`-only miss is not reused by a full cascade) and only while it is
younger than `notFoundMaxAgeDays`; a cached `found` answers a lookup that allows its `source`.
`MemoryAbstractCache` copies results in and out, so mutating a returned result changes nothing
cached. An empty `sources` list is refused.

### `fetchAbstracts(dois, options?)`

Sequential lookup of many DOIs (polite to free APIs); each distinct normalised DOI is fetched
once. Returns a `Map` from normalised DOI to `AbstractResult`; an input that is not a DOI is kept
under its original text with status `invalid_doi` (never dropped).

### Helpers

- `cleanAbstractMarkup(raw)` — strips JATS/HTML tags (and a JATS title), decodes entities, drops
  a leading "Abstract"/"Summary" heading.
- `invertedIndexToText(index)` — rebuilds text from an OpenAlex inverted `index`.
- `normalizeAbstractDoi(doi)` — the DOI key used by the cache (`cleanDoiInput`, lower-cased), or `null`.
- `sameDoi(a, b)` — whether two DOI strings name the same work: case-insensitive, and repeated slashes are equivalent (`10.1037//0882-…` is `10.1037/0882-…`). Every source's record must pass it against the requested DOI, or the attempt is an `error`.
- `axiosJsonGet` — the default `JsonGet`.

## Issue codes

| Code | Severity | From | Meaning |
|---|---|---|---|
| `IS_PREPRINT` | warning | `checkReferenceForPreprint` | the cited work is a preprint (known server, or Crossref `posted-content`) |
| `HAS_PREPRINT_VERSION` | info | `checkReferenceForPreprint` | the cited work has a preprint version |
| `OA_AVAILABLE` | info | `checkReferenceForOpenAccess` | Unpaywall lists an open-access copy |
| `EOC_DETECTED` | warning | expression-of-concern checks | Crossref records an expression of concern |
| `EOC_PUBMED` | warning | expression-of-concern checks | Europe PMC lists an expression of concern |
| `HAS_ERRATA` | warning | `checkReferenceForReplies` | an erratum or correction exists |
| `HAS_AUTHOR_REPLY` | info | `checkReferenceForReplies` | an author reply exists |
| `HAS_COMMENTS` | info | `checkReferenceForReplies` | published comments exist |
| `IS_RESPONSE` | info | `checkReferenceForReplies` | the cited work is itself a response to another |
