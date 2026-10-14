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
Strips a `https://doi.org/` prefix, asks Crossref, and on a Crossref 404 asks doi.org
whether the DOI resolves (`source: 'resolver'`, `score: 50`, no metadata). Results are cached
in memory for 30 minutes.

```ts
interface CrossrefResult {
  found: boolean;
  doi?: string;
  title?: string;
  authors?: string[];        // "Family, Given"
  publishedDate?: string;    // Crossref date-parts joined with "-", not zero-padded: "1998-2"
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
preparation", "submitted" or "under review" are skipped without a request.

## DOI shape and shortDOIs

| Export | Returns |
|---|---|
| `isMalformedDoi(doi)` | `true` unless the trimmed string is `10.` + 3–9 digits + `/` + a suffix without spaces, or the shortDOI form `10/<token>`; `true` for a non-string. Shape only: `10.1037/0` returns `false` |
| `isShortFormDoi(doi)` | `true` for `10/<token>` |
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
type EocUnavailableReason = 'rate_limited' | 'timeout' | 'server_error' | 'network';
type EocSourceOutcome =
  | { status: 'clean' }
  | { status: 'issue'; issue: ExpressionOfConcernIssue }
  | { status: 'unavailable'; reason: EocUnavailableReason; detail?: string };
```

Sources: Crossref relations (`is-expression-of-concern-for`, `has-expression-of-concern`,
`is-corrected-by`) and Europe PMC's corrections list for the first search hit on the DOI
(reported as `PubMed`). `KnownList` is **not implemented**: it always returns `clean`, so it
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
  code: string;             // EOC_DETECTED, CORRECTION_NOTICE, EOC_PUBMED
  description: string;
  location: string;
  suggestion?: string;
  affectedText?: string;
  metadata?: { doi?; journalName?; dateIssued?; details?; source? };
}
```

## Replies and errata

### `checkReferenceForReplies(reference)`

`Promise<CitationRepliesIssue[]>` from the Crossref relations `is-corrected-by`
(`HAS_ERRATA`), `has-reply` (`HAS_AUTHOR_REPLY`), `has-comment` (`HAS_COMMENTS`) and
`is-response-to` (`IS_RESPONSE`). `[]` for no DOI and on a network failure.

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
| `checkDOAJ(issn)` | `Promise<DOAJResult>` from the DOAJ journal search; `{ found: false }` for no ISSN, no hit, or a failure |
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

interface DOAJResult { found: boolean; journalTitle?; publisher?; issn?; eissn?; url? }

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
| `compareAuthors(authors1, authors2)` | 0–1, symmetric; best Levenshtein match per author, averaged both ways; 0.5 when both are empty |
| `compareTitle(title1, title2)` | `1 − Levenshtein distance / longer length`; 0.5 when both are empty |
| `compareYear(year1, year2)` | 1 same year, 0.5 one year apart, 0 otherwise; 0.5 when both are missing |
| `normalizeAuthorName(name)` | `"Smith, J."` → `"smith j"` |
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
- `normalizeAbstractDoi(doi)` — the DOI key used by the cache (prefixes removed, URL-encoding decoded, lower-cased), or `null`.
- `sameDoi(a, b)` — whether two DOI strings name the same work: case-insensitive, and repeated slashes are equivalent (`10.1037//0882-…` is `10.1037/0882-…`). Every source's record must pass it against the requested DOI, or the attempt is an `error`.
- `axiosJsonGet` — the default `JsonGet`.

## Issue codes

| Code | Severity | From | Meaning |
|---|---|---|---|
| `IS_PREPRINT` | warning | `checkReferenceForPreprint` | the cited work is a preprint (known server, or Crossref `posted-content`) |
| `HAS_PREPRINT_VERSION` | info | `checkReferenceForPreprint` | the cited work has a preprint version |
| `OA_AVAILABLE` | info | `checkReferenceForOpenAccess` | Unpaywall lists an open-access copy |
| `EOC_DETECTED` | warning | expression-of-concern checks | Crossref records an expression of concern |
| `CORRECTION_NOTICE` | warning | expression-of-concern checks | Crossref records a correction or concern notice |
| `EOC_PUBMED` | warning | expression-of-concern checks | Europe PMC lists an expression of concern |
| `HAS_ERRATA` | warning | `checkReferenceForReplies` | an erratum or correction exists |
| `HAS_AUTHOR_REPLY` | info | `checkReferenceForReplies` | an author reply exists |
| `HAS_COMMENTS` | info | `checkReferenceForReplies` | published comments exist |
| `IS_RESPONSE` | info | `checkReferenceForReplies` | the cited work is itself a response to another |
