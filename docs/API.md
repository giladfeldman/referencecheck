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
whether the DOI resolves (`source: 'resolver'`, `score: 50`, no metadata). A Crossref 200
without a work record is `valid: false` with the error `[Crossref API] 200 without a work
record` (the source could not answer), never a crash. Results are cached in memory for 30 minutes.

```ts
interface CrossrefResult {
  found: boolean;
  doi?: string;
  title?: string;
  authors?: string[];        // "Family, Given"
  publishedDate?: string;    // ISO, at the precision Crossref gives: "1998-02", "2019-03-05" (before 0.3.0: "1998-2"). Read the year from the string: new Date("2019-01") is UTC midnight, 2018 west of UTC
  journal?: string;
  score: number;             // 100 from a DOI lookup, 50 from the resolver fallback, Crossref's relevance score from a search
  rawData?: any;             // the Crossref message
  // Set only on a result found by findDOIFromReference / findDOIFromReferenceDetailed (0.3.0):
  authorCheck?: DoiMatchCheck;
  yearCheck?: DoiMatchCheck;
  titleCheck?: DoiMatchCheck;
}

// How one check of a found DOI against the reference went:
//  'matched'        the evidence agrees
//  'mismatched'     the evidence disagrees (the candidate is rejected; never on a returned result)
//  'not_comparable' nothing to compare: no surname or year read from the reference, none in the
//                   Crossref record, names or titles in scripts that cannot be compared (Han vs
//                   Latin), or a title with fewer than two distinctive words. Does not reject.
type DoiMatchCheck = 'matched' | 'mismatched' | 'not_comparable';
```

### `validateMultipleDOIs(dois, creds?)`

`Promise<Map<doi, { valid; data?; error? }>>`, 5 at a time with a 1 s pause between groups.

### `findDOIFromReference(referenceText, creds?)`

Finds the DOI of a free-text reference, or `null`. Tries Crossref's Simple Text Query, then
the bibliographic search (top 5, relevance score of at least 50). Each candidate gets three
checks, each `matched`, `mismatched` or `not_comparable` (`DoiMatchCheck`); a candidate is
rejected if any check is `mismatched`, in this order:

- **year**: within one year of the reference's;
- **author**: at least one surname matches. Surnames are read as `Surname, I.` (a surname may be
  up to three capitalised words, with name particles such as `van der`, `de la`, `Mc`) or
  Vancouver `Surname IJ` / `Surname J-H` (only name particles before it); compared as whole
  words or with spaces removed (`Van Dyke` = `VanDyke`; `de la Cruz` = `Cruz`), so `Li` matches
  neither `Liu` nor `Williams`, and `Smith` not `Goldsmith`; `ü` also matches `ue`. A Cyrillic
  or Greek surname is compared with a Latin one by first letter and consonant skeleton of a
  loose romanisation (`Достоевский` = `Dostoevsky` = `Dostoyevsky`, `Иванов` = `Ivanoff` =
  `Ivanova`; `Иванов` ≠ `Ivashov`, `Ли` ≠ `Lu`). When no surname matches, the check is
  `not_comparable` if more of the Crossref authors cannot be compared with any reference surname
  (Han vs Latin) than can, and `mismatched` otherwise (a record listing `Jones` and `李` against
  a reference by `Smith` is `mismatched`). Given-first lists (`Michael J. LaCour, Donald P.
  Green`, with or without `and`) are read by their last word. A Vancouver list is used alone
  when one is read; one entry of a surname and one initial is not Vancouver when the text after
  it continues a name (`Michael J. LaCour`). No surname is read from a reference that starts
  with its title (also when the title holds `and`: a reference opening with the first three
  words of the record's title counts no title word as a surname) or names a group author (a word such as `Organization`,
  `Institute`, `Group`, `Collaboration`): the check is then `not_comparable`;
- **title**: of the Crossref title's words of four or more letters, stopwords removed, at least
  60% must occur in the reference text, compared by stem (`organisation` = `organization`,
  `behaviour` = `behavior`, `modelling` = `modeling`, plurals). The main title and the full title
  (with subtitle) are each tried and either may pass, so the subtitle is never required. A
  reference that cuts the title with `...` or `…` is compared on the title words before the
  cut. Fewer than two such words, or a title in another script than the reference, is
  `not_comparable`; so is a one-word main title that occurs in the reference, and a title of
  three such words or fewer that shares at least one word but not 60% when author and year are
  both `matched` (`Neural nets` for `Neural networks`); with no shared word, or without both
  other checks matched, it is `mismatched`. The title is also compared back (0.3.0, review 11):
  in the sentence of the reference that holds the record's title words (after the author
  initials, without bracketed notes such as `[Preprint]`, and without a subtitle written after
  them when the record has none), at least 60% of the distinctive words must be words of the
  record's full title, so `Instrumental Variables Analysis and Mendelian Randomization for
  Causal Inference` is `mismatched` against the record `Commentary: Mendelian Randomization for
  Causal Inference`. A part number written after the title (`Part I`, `II.`) that differs from
  the record's (none, or `Part II`) is `mismatched` whatever the title's length, and so is a
reference that writes no part against a record that names one (`..., Part II`, or a roman
numeral ending the title). A numeral opening the next sentence is a part only after `Part`
(`II Farmaco` is a journal). A reference with
  no punctuation is not compared back;

A `not_comparable` check does not reject; the returned result carries all three checks.
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
  rejected: RejectedDoiCandidate[];   // every candidate the year/author/title check refused
  belowScoreThreshold: number;        // search candidates under relevance 50, dropped unchecked
  errors: string[];                   // per-stage errors, in order
  notComparable: { author: number; year: number; title: number }; // checked candidates (accepted or rejected), per check that was not_comparable
}

interface RejectedDoiCandidate {
  doi: string;
  stage: 'simple_text_query' | 'search';
  reason: string;                     // "Year mismatch: ...", "Author mismatch: ...", "Title mismatch: ...", "DOI did not validate: ..."
  authorCheck?: DoiMatchCheck;        // the three checks; absent for "DOI did not validate"
  yearCheck?: DoiMatchCheck;
  titleCheck?: DoiMatchCheck;
}
```

`lookup_failed` means the search never got an answer: it is not evidence that no DOI exists.

## Shared input readers

Every function that reads a DOI, an author list or a name/title goes through these, so one
input is read the same way everywhere (bound by `tests/parity/`). Years are not read here in
this release: each year reader keeps its 0.2.x rule (`tests/parity/yearRules02.test.ts`).

| Export | Returns |
|---|---|
| `cleanDoiInput(doi)` | the DOI with surrounding whitespace, a resolver URL (`http(s)://`, `dx.`/`www.`, or bare `doi.org/`) or a `doi:` label removed and percent-encoding decoded (unless decoding would add whitespace: `10.1000/a%20b` stays `10.1000/a%20b`, a well-formed DOI); for a DOI or a shortDOI (`10/abc`), also what a citation put after it: anything after a space that is followed by a bracket, `doi`, `PMID`, `PMCID`, `Available`, `Accessed`, `Retrieved`, `Epub`, `Published`, `PDF`, `URL` or a URL (any other space stays, so `10.1371/journal.pone. 0123456` is still malformed), trailing `. , ; :` and quotes, and a closing bracket that closes nothing inside the DOI (`10.1101/x).` → `10.1101/x`; `(20)30183-5` kept); in a resolver link (also inside a `doi:` label), everything from a raw `?` or `#` (the URL's query and fragment; a final `#`, as in Wiley SICI DOIs ending `CO;2-#`, stays, with or without a query after it; an encoded `%23` or `%3F` is decoded and kept); written bare, a raw `key=value` query (`?utm_source=x`), a lone final `?` and trailing slashes; a shortDOI also loses a `#...` (a bare `#...` and a page ending such as `/pdf` are kept: registered DOIs hold them); case kept; `''` for a non-string; any other input returned trimmed |
| `DOI_SHAPE`, `DOI_START` | the one DOI shape every reader uses: `/^10\.\d{3,9}\/\S+$/` (a whole DOI) and `/^10\.\d{3,9}\//` (its start). 3-digit registrant codes exist (10.231, 10.488, 10.978, 10.979) |
| `SHORT_DOI`, `SHORT_DOI_START` | the one shortDOI shape every reader uses: `/^10\/[A-Za-z0-9][A-Za-z0-9._-]*$/` (a whole shortDOI, `10/gt3vmw`) and `/^10\/[A-Za-z0-9]/` (its start). `10/-` is no shortDOI (doi.org answers 400) |
| `referenceDoi(reference)` | the DOI a reference is checked under (replies, expression of concern, open access, preprint, journal metadata): the first of `doi` and `suggested_doi` whose `cleanDoiInput` is a full DOI (`DOI_SHAPE`); else the first short DOI (`10/abc`); else the first written, cleaned; `''` when neither is written. When both are full DOIs, `doi` wins, even if they differ |
| `DOI_REGISTRANTS`, `doiRegistrant(doi)`, type `DoiRegistrant` | the one list of registrants known by name (`src/doi/registrants.ts`): `{ prefix, server?, version? }`. `server` is the preprint server `detectKnownPreprintFromDoi` reports; `version` is the ending of a registrant that mints one DOI per version. Each row was checked on 2026-11-20 against the prefix owner in Crossref and a resolved DOI. `doiRegistrant` returns the first row whose prefix matches, or `undefined` |
| `OSF_PREPRINT_SLUGS` | `{ slug, server }[]`: the `osf.io/preprints/<slug>` address of PsyArXiv and each Center for Open Science server in `DOI_REGISTRANTS` (names and slugs from the OSF preprint-provider API, 2026-11-20; Banglarxiv has no provider record there, so no slug). The preprint URL patterns are built from it |
| `doiWithoutVersion(doi)` | the DOI without its version ending, for a registrant with a `version` rule: bioRxiv/medRxiv/openRxiv `…123v2`, Preprints.org (10.20944) `.v2`, Research Square (10.21203) `/v2`, ChemRxiv (10.26434) `/v2` `.v2` `-v2`, Cambridge Open Engage (10.33774) `-v2`, Authorea (10.22541) `/v2`, TechRxiv (10.36227) `.v2` `/v3`, PsyArXiv and the other Center for Open Science servers `osf.io/x_v2`, figshare `.v1`. Case-insensitive; any other DOI is returned unchanged. Zenodo DOIs carry no version ending and F1000 article versions are kept apart |
| `doiForUrl(doi)` | `encodeURIComponent(cleanDoiInput(doi))`, the only form a DOI takes inside a request URL |
| `foldForMatch(text)` | lower-cased, accents removed (`Müller` → `muller`; also ø ł ß đ ı æ œ þ: `Østergaard` → `ostergaard`), letters and digits of every script kept, everything else one space |
| `splitAuthorList(authors)` | one entry per author from a string or an array (every element split the same way); `;`, `&` and "and" always separate; a trailing `et al.` is dropped; a comma separates, except that initials join the piece before them when that piece has no comma (`Smith, J., Jones, K.` and `LI, X., WU, Y.` → 2 authors), a given part mixing full names and initials joins a bare surname (`Smith, John A.` → 1; `Smith JA, Jones KB` → 2), and a suffix (`Jr`, `Sr`, `II`–`IV`) always joins; a string with one comma and no initials on either side is one name, surname first (`Smith, John` → 1, and so is `Smith, Jones`) |
| `parseName(name)` | `ParsedName` `{ surname, initials, given?, order, raw }`: the one reading of a name that deduplication uses. `surname` folded with `foldForMatch`, particles kept (`van der berg`); `initials` folded (`Smith, J. A.` = `Smith JA` = `J. A. Smith` → `ja`; `Lee J-H` → `jh`); `given` the full given names when written out; suffixes and `et al.` dropped. `order` is `'known'` when the name shows its surname (a comma, Vancouver initials, initials first, a folded `smith j`) and `'unknown'` for full words in no shown order (`John Smith`, `Wang Wei`), where `surname` holds the whole name and deduplication tries every reading |
| `formatDateParts(parts)` | Crossref `date-parts` as ISO at the given precision: `[2019, 3, 5]` → `"2019-03-05"`, `[2019]` → `"2019"`, else `undefined` |
| `normalizeIssn(issn)` | an ISSN as `NNNN-NNNC` with the check digit upper-cased, from any spacing, dash or `ISSN`/`eISSN` label; `null` unless it has eight ISSN characters and a correct mod-11 check digit (`1648-1655` is a page range) |
| `journalKey(name)` | `foldForMatch(name)` with the words "and" and "the" dropped: the key both sides of a journal-name comparison use (`Journal of Personality & Social Psychology` = `Journal of Personality and Social Psychology`) |

## DOI shape and shortDOIs

| Export | Returns |
|---|---|
| `isMalformedDoi(doi)` | `true` unless `cleanDoiInput(doi)` is `10.` + 3–9 digits + `/` + a suffix without spaces, or the shortDOI form `10/<token>` (`SHORT_DOI`: the token starts with a letter or digit, then letters, digits, `.`, `_`, `-`); `true` for a non-string. Shape only: `10.1037/0` returns `false` |
| `isShortFormDoi(doi)` | `true` for `10/<token>` (`SHORT_DOI`, as above), also when written `https://doi.org/10/<token>` or `doi:10/<token>` |
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
  retraction). A reply that is not the source's answer is `server_error`: a Crossref 200
  without a work record (`200 without a work record`), an OpenRetractions 200 without a JSON
  boolean `retracted`, or an OpenRetractions 404 without a JSON body (`404 without a JSON
  body`; only the API's own JSON 404 means "not in this index").

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
notice, `replyCount` the distinct notices other than the work's own DOI, none of them meaning no `HAS_ERRATA`, `replyDate` the earliest notice date as ISO
`YYYY-MM-DD`), and the relations `has-reply` (`HAS_AUTHOR_REPLY`), `has-comment`
(`HAS_COMMENTS`) and `is-reply-to` (`IS_RESPONSE`). Before 0.3.0 `HAS_ERRATA` and
`IS_RESPONSE` read relation types Crossref does not serve and never fired. `[]` for no DOI
and on a network failure: an empty list does not distinguish "none" from "could not check".
Prefer `checkReferenceForRepliesDetailed` wherever the result is shown to a user.

### `checkReferenceForRepliesDetailed(reference)` — preferred

`Promise<RepliesReferenceResult>`: `{ issues: CitationRepliesIssue[]; complete: boolean; unavailable?: { reason: RepliesUnavailableReason; detail? } }`.
`complete: false` means Crossref was not read, so empty `issues` is not an all-clear;
`unavailable.reason` is one of `not_indexed` (Crossref 404), `rate_limited`, `server_error`,
`http_error` (any other status, such as 400 or 403), `timeout`, `network`, `malformed_response`. No DOI gives `{ issues: [], complete: true }`.
The DOI checked is `referenceDoi(reference)` (above).

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

`Promise<PreprintIssue[]>`. The DOIs it reads come from `preprintDois` (below). With a full
DOI of the author's: a known preprint server's prefix decides; else Crossref decides, so a
journal article whose citation mentions ssrn.com is not called a preprint; when Crossref
cannot answer (the DOI is not indexed there, as for DataCite and OSF DOIs; the request failed;
or a 200 came back without a work record), the `url` decides; the citation text does not.
Without one: the `url`, then a preprint link written into the `doi` field, then the citation
text, then the suggested DOI (its prefix, then Crossref). A reported `metadata.doi` is always a
full DOI, the one the decision was made on, and absent when a link or the text decided;
`location` is the evidence (the DOI, the link, or the start of the citation text). Known preprint
servers (`DOI_REGISTRANTS` rows with a `server`: SSRN, PsyArXiv and the other Center for Open
Science servers (OSF Preprints, SocArXiv, MetaArXiv, EdArXiv, …), bioRxiv/medRxiv, arXiv,
Preprints.org, Research Square, ChemRxiv, Cambridge Open Engage, Authorea, TechRxiv, engrXiv,
EarthArXiv, EcoEvoRxiv), which needs no request; otherwise Crossref: `posted-content` or
subtype `preprint` gives `IS_PREPRINT` (with the published version from `is-preprint-of` when
deposited), and a non-empty `has-preprint` relation gives `HAS_PREPRINT_VERSION`.

| Export | Returns |
|---|---|
| `detectKnownPreprintFromDoi(doi)` | server name for a known preprint DOI prefix, or `null` |
| `preprintDois(reference)` | `{ authorDoi, suggestedDoi }`, each a full DOI (cleaned by `cleanDoiInput`, `DOI_SHAPE`) or `''`. `authorDoi`: `doi`, or, when that is not a full DOI (empty, "n/a", an unexpanded short DOI), the DOI in a resolver link in `url`. `suggestedDoi`: `suggested_doi`; the check reads it only when `authorDoi` is empty |
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

`{ openAccessCount, goldOA, hybridOA, greenOA, bronzeOA, unknownOA }`; `unknownOA` counts open papers
whose type Unpaywall did not report, so the five type counts sum to `openAccessCount`.

```ts
interface OpenAccessIssue {
  type: 'open-access';
  severity: 'info';
  code: string;
  description: string;
  location: string;
  suggestion?: string;
  metadata?: {
    doi?; openAccessStatus?: 'gold' | 'hybrid' | 'bronze' | 'green' | 'closed';
    url?; version?; license?; source?;
  };
}
```

`openAccessStatus` is Unpaywall's own `oa_status` (`gold`, `hybrid`, `bronze`, `green`); when
Unpaywall gives none it is absent and the description says "type not reported" (before v0.3.0
it was guessed: `gold` for an open-access journal, otherwise `green`, so bronze and hybrid papers
were reported as green). `closed` is declared but never produced: a closed paper gives no issue.

## Citation counts

| Export | Returns |
|---|---|
| `getCitationCount(doi)` | `Promise<number \| null>` from OpenCitations; `null` when unknown, on failure (20 s timeout), or when the body is not a whole number (an error page reading "500 ..." is no count) |
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
| `extractJournalMetadata(reference, useOpenAlex?, creds?)` | `JournalMetadata` from, in order: `doi_crossref_data` (the first Crossref ISSN that passes the check digit; failing ones go to `issnRejected`), `parsed_data.source`, the first valid ISSN in `raw_text` (only when Crossref listed none), publisher phrases in `raw_text`, then (when `useOpenAlex`, default `true`) OpenAlex by DOI and by journal name, pausing 200 ms after each OpenAlex call |
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

interface JournalMetadata { journal?: string; issn?: string; issnRejected?: string[]; publisher?: string }

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
| `calculateSimilarity(ref1, ref2, config)` | 1 when both references carry the same well-formed DOI (`doiRelation` is `'same'`); otherwise `authorWeighting × authors + titleWeighting × title + (1 − both) × year`, from `normalized_authors`, `normalized_title`, `normalized_year`, capped just under `config.threshold` (0.85 when not set) when both carry different well-formed DOIs (`'different'`), so the pair alone does not merge a preprint and its published version, or Part I and Part II with their own DOIs. A caller that compares with a lower threshold than the config's, or transitive closure in `findDuplicateGroups` through a third reference, can still join them. DOIs compare after `cleanDoiInput`, lower-cased, without a query or fragment, a link tail (`/full`, `/pdf`, `/epdf`, `/abstract`), or a version ending under a registrant with a `version` rule in `DOI_REGISTRANTS` (`doiWithoutVersion`; under any other prefix `.v1` and `.v2` are two works). Only `doi` is compared, never `suggested_doi`: a suggestion is a DOI the tool proposed, and a wrong one must not force two references into one. **Owner decision (round 11): versions of one preprint are one work**; a preprint and its published version (different DOIs) stay two. **Owner decision (round 11): the same DOI on contradicting metadata is not forced to 1** (`'same-contradicted'`, below): the weighted score decides |
| `compareAuthors(authors1, authors2)` | 0–1, symmetric; each argument a string or a string array, split with `splitAuthorList`, each name read by `parseName`; the best-scoring match per author, averaged both ways; 0.5 when both are empty, 0 when one is. Two names score by level: **1** identical after folding, or the same surname with compatible given names (initials agreeing with each other or with full names: `Smith, J. A.` = `J. A. Smith` = `Smith JA` = `Smith, John A.`) or none on either side; **0.75** the same surname with a given name on one side only (`Smith` vs `Smith, K.`), a name in no shown order of which one reading is compatible (`Wang Wei` vs `Wei, W.`; `John Smith` vs `Smith, J.`), or a near surname (both at least five letters, similarity at least 0.85, given names not conflicting: `Papadopoulos`/`Papadopoulou`); **0.5** the same surname with conflicting given names (`Smith, J.` vs `Smith, K.`; `John Smith` vs `Jane Smith`), never merged at the README weights; **0** otherwise (`Li` vs `Lu`). Surnames compare with spaces removed and also without leading particles (`van der Berg` = `Berg`); a Cyrillic or Greek surname and a Latin one compare by loose romanisation, a feminine ending not counted (`Иванов` = `Ivanova`). Two keys that differ only by one letter added at the end (`obrien` / `obrienz`, `wangli` / `wanglin`) are not near surnames, and a reading with equal surnames wins over a near-surname reading, so given names one letter apart (`Maria Garcia` / `Mario Garcia`, `Wang Li` / `Wang Lin`, `John Smith` / `Jon Smith`) are the same surname with conflicting given names, 0.5. Name particles include `d`, so `d angelo n` is surname `d angelo` (an apostrophe folded to a space). `Smith John A.` (capitalised given words before period-marked initials) is surname Smith, initials JA. A known two-word surname with initials and no comma (`Garcia Marquez G`) also has a reading with the first word as surname, scored at most 0.75. **Owner decision (round 11): a list that names only the first author or authors merges with the full list.** When one list is a prefix of the other (after dropping `et al.`) and every positional pair scores at least 0.75, the score is the mean of those pairs, and `compareAuthors` returns the larger of that and the symmetric average (`["Parkevich, E. V.", "et al."]` vs the three-author list: 1; `["Medvedev, M. A."]`, the third author alone: 0.67) |
| `compareTitle(title1, title2)` | `1 − Levenshtein distance / longer length` after `foldForMatch` (non-Latin titles compared, not emptied); 0.5 when both are empty; two titles made only of symbols (`???`) score 1 when identical, else 0 |
| `compareYear(year1, year2)` | `parseInt` of each value (the 0.2.x rule): 1 same year, 0.5 one year apart, 0 otherwise; 0.5 when both are empty, 0 when one is or when either does not start with a number (`"(2019)"`, `"in press"`) |
| `normalizeAuthorName(name)` | `foldForMatch(name)`: `"Smith, J."` → `"smith j"`, `"Müller"` → `"muller"` |
| `scoreMetadataCompleteness(ref)` | 0–1 weighted presence of title, authors, year, DOI, source, volume, pages |
| `findDuplicateGroups(pairs, diagnostics?)` | `DuplicateGroup[]` by transitive closure (A=B and B=C gives one group); a pair whose references carry two different well-formed DOIs (`doiRelation` `'different'`) is dropped first, and when a `DuplicateGroupingDiagnostics` object is passed its `droppedDifferentDoi` is set to the number dropped. Two such references can still end in one group through a third reference, without a DOI, that is close to both |
| `doiRelation(ref1, ref2)` | `DoiRelation`: `'same'` both carry the same DOI (compared as in `calculateSimilarity`) and their metadata does not contradict it; `'same-contradicted'` the same DOI, both references carry authors and titles in one script, and the author score (`compareAuthors`) and the title-word share (the share of the shorter title's words of three or more letters found in the other title) are both below `SAME_DOI_CONTRADICTION`; `'different'` both carry a DOI and they differ; `null` at least one carries no well-formed DOI. The title side is the word share, not `compareTitle`: on the labelled set two unrelated titles scored 0.31 and 0.37 by edit distance. A same-DOI pair with another title but matching authors stays `'same'` |
| `SAME_DOI_CONTRADICTION` | 0.3, the cut-off `doiRelation` uses (owner default, round 11) |
| `selectBestReference(refs)` | the most complete reference; throws on an empty array |

```ts
interface DeduplicationConfig {
  threshold: number;        // the caller's merge cut-off; calculateSimilarity also caps different-DOI pairs just under it
  authorWeighting: number;
  titleWeighting: number;
}

interface DuplicatePair { ref1: ReferenceInput; ref2: ReferenceInput; similarity: number }

interface DuplicateGroup { references: ReferenceInput[]; bestReference: ReferenceInput; averageSimilarity: number }

interface DuplicateGroupingDiagnostics { droppedDifferentDoi: number } // filled by findDuplicateGroups

type DoiRelation = 'same' | 'same-contradicted' | 'different' | null;

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
- `normalizeAbstractDoi(doi)` — the DOI key used by the cache (`cleanDoiInput`, lower-cased), or `null` when it is not `DOI_SHAPE` (`10.` + 3–9 digits + `/` + suffix).
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
