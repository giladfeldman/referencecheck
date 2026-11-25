# Changelog

## 0.4.0 — 2026-11-23

### Added
- **Three verdicts.** Every `RetractionInfo` carries `verdict`: `flagged`, `clean` or
  `could_not_check`, derived from `isRetracted` and `checked` so it can never disagree with them.
- **Retraction timing.** `options.citing` (`{ publishedDate }` or `{ doi }`) gives every flagged
  result `timing.timing`: `before_citing` (already retracted when the citing paper was published),
  `after_citing` (retracted after the citing paper was published) or `unknown`
  with `unknownReason` (`no_citing_date`, `citing_date_unavailable`, `no_retraction_date`,
  `unparseable_retraction_date`, `same_period`). The citing date comes only from the caller or
  from the citing DOI's Crossref `published` (else `issued`) field, and dates are compared at the
  precision both carry (`2019` against `2019-10-08` is `same_period`, never a guess). The citing
  DOI is looked up only when something is flagged, and once per `checkMultipleRetractions` batch.
  A caller date that cannot be read throws `RangeError`. New helpers:
  `resolveCitingPublicationDate`, `compareRetractionTiming`, `describeRetractionTiming`.
- **Retracted and replaced.** Every flagged result carries `replacement`: `replaced`,
  `not_recorded` or `unknown`, with every signal that said so in `evidence`:
  `crossref_is_replaced_by`, `title_marker` (the work's title starts "RETRACTED AND REPLACED" ("RETRACTED AND REPUBLISHED", "&" too) in capitals, bracketed, or followed by a separator: a sentence-case title about retraction is not a marker),
  `notice_title` (the notice's title starts "Retraction and replacement of", JAMA's "Notice of Retraction and Replacement", or NEJM's "Retraction and Republication"), and
  `retraction_watch_reason` (the Retraction Watch reason "Retract and Replace", read from Crossref
  Labs). `replacementDOI` comes from `is-replaced-by` or from a DOI in the Retraction Watch notes
  that Crossref confirms is a work (10.1093/infdis/jiae178 -> 10.1093/infdis/jiae357). A notes
  DOI is taken only when it follows a replacement cue ("see instead", "replaced by",
  "republished", "replacement"; not a negated one), is not the work, one of its notices or the notice Retraction Watch
  names, and is the ONE such work; a cued DOI whose lookup failed blocks the choice. An editorial
  or related paper named in the note is never reported as the replacement, and several
  `is-replaced-by` DOIs give no single `replacementDOI`. Measured
  2026-11-18: Crossref's own `updated-by` entry is a plain `retraction` on every
  retract-and-replace case probed; Crossref Labs serves an EMPTY block for 10.1093/carcin/bgs140,
  whose own title says "RETRACTED AND REPLACED"; Labs answered 503 on 2 of 8 probes. So
  `not_recorded` never means "not replaced", and a failed or unreadable lookup is `unknown`.
  `updated-by` `new_version` is deliberately not read as a replacement: F1000Research
  10.12688/f1000research.8114 v1 lists v2 and v3 as new versions, and both were retracted too.
  The lookups run for flagged references only; `checkReplacement: false` turns them off.

### Fixed — results that read as clean without an answer
- A Crossref 200 whose body is not one work's record (empty, HTML, a work list, a record with no
  `DOI`) was read as an empty record and so a checked clean. It is now `could_not_check` with
  reason `server_error`, detail `200 without a work record` (0.3.0 already did this for a body
  that is not an object; 0.4.0 adds a record with no `DOI`).
- A DOI that is not DOI-shaped (an empty string reached Crossref as `/works/`, which answers 200
  with a list) read as a clean. Nothing is asked now, and the result is `could_not_check` with
  reason `invalid_doi`.
- An `updated-by` entry typed and labelled `retracion` (a real publisher deposit, found by a full
  scan of Crossref's retraction notices) was not recognised as a retraction.
- A record whose only signal is a title marker "Retracted and Replaced: …" ("retracted and
  republished", bracketed or followed by a separator) read as clean: the retraction title reader
  did not take the forms the replacement reader takes. It is now flagged.
- With several notices, one dated only by `date-parts` always sorted before one that carries a
  `date-time` (the two were compared in different units), so the wrong notice could give
  `retractionDate` and, now, `timing`. Both are compared as UTC dates. Every recorded Crossref
  notice carries a `date-time`, so this was not seen on real data.
- A notice date on or before the work's own publication date is not taken as the retraction
  date. 10.1007/s11277-021-09072-0 (published 2021-09-11) has a publisher `retraction` entry
  dated 2021-09-11 and a Retraction Watch entry dated 2022-12-06; the publisher's page says it
  was retracted on 6 December 2022. Earlier versions reported `2021-09-11`, and so a paper cited
  in 2022 read as cited after the retraction. It now reports `2022-12-06`; when the only date is
  such a date, `retractionDate` is absent and `timing` is `unknown` / `no_retraction_date`.
- `retractionNoticeUrl` linked the paper itself when the entry names the work's own DOI (every
  Retraction Watch entry, in-place publisher retractions such as F1000Research). It is now
  absent in that case: no notice was identified.
- A citing paper's Crossref `published` that is present but not a calendar date no longer falls
  back to `issued`; `timing` is `unknown` / `citing_date_unavailable`.
- A Crossref Labs record whose reasons are not strings is unreadable (`replacement` `unknown`),
  not "no Retract and Replace reason". An OpenRetractions-only result with
  `checkReplacement: false` says `not_requested`.

### Not verified
- No independent answer key exists for `timing` and `replacement`: the tests check them against
  recorded Crossref and Retraction Watch answers, the same sources the code reads.
- There is no table of which notice, title and reason forms occur in real data and how often;
  the readers are tested on the forms listed above.
- The live comparison with 0.3.0 used a 1-in-40 sample (335 DOIs) of a reference corpus: no
  retracted paper was gained or lost, and the only differences were zero-padded dates. The full
  corpus was not run live.

### Changed
- **`retractionDate` is zero-padded** (`2019-10-08`, was `2019-10-8`), like
  `CrossrefResult.publishedDate` (padded since 0.3.0) and the citing date in `timing`. A deposited date that is not
  a calendar date (month 13) is still returned, padded, and its `timing` is
  `unknown` / `unparseable_retraction_date`; date-parts with no year give no date.
- **One date form per result.** The OpenRetractions `retraction_date` and a caller's
  `citing.publishedDate` are written the same way (`2019-01-05`); an unreadable source date is
  kept as given. A caller date with a time (`2019-1-5T23:30:00-08:00`) was cut to its first ten
  characters (`2019-1-5T2`); it now gives the date as written (`2019-01-05`).
- **One DOI reader.** The citing DOI is cleaned by `cleanDoiInput`, like the cited DOI (a
  `doi:` label or a percent-encoded DOI was rejected as invalid, so its timing was `unknown`), and
  both are checked against the shared `DOI_SHAPE` (or the shortDOI form): `10.12/x` and a
  10-digit registrant are `invalid_doi` and never sent to Crossref; `10.231/x` is accepted. A replacement DOI named in the Retraction Watch notes is found with the same 3-to-9-digit registrant rule (it needed 4 to 9).
- **Timing never depends on the machine's time zone.** Dates are compared as year, month and day
  numbers, never through `Date` (which reads `2019-01` as UTC midnight, still 2018 in Los
  Angeles). `tests/retraction/timezone.test.ts` re-runs the comparisons in a fresh Node under
  `America/Los_Angeles`, `Pacific/Kiritimati` and `UTC`, each with a control proving its zone is
  live.

### Consumer action
- `retractionDate` is now zero-padded; a stored value from an earlier version may be unpadded,
  so compare dates after parsing, never as strings.
- Switch renderers on `verdict`, and show `could_not_check` as unchecked, never in the clean count.
- Handle the new `RetractionUnavailableReason` value `invalid_doi`; a Crossref record with no `DOI` now arrives as `server_error`.
- Pass the manuscript's publication date (or DOI) as `citing` and render `timing` with
  `describeRetractionTiming`, so "already retracted when the citing paper was published" and
  "retracted after it was published" never read the same. `timing` is publication order only:
  do not present it as what the authors knew (a citation can be written before a retraction and
  published after it).
- `retractionNoticeUrl` can now be absent for a retracted work (the entry named the work
  itself), and `retractionDate` can differ from 0.3.0 where 0.3.0 reported the work's own
  publication date.
- Render `replacement.status: not_recorded` as "no replacement recorded", never "not replaced",
  and `unknown` as "could not check for a replacement".

## 0.3.0 — 2026-11-23

A sweep for one defect class across the whole library: **the same input read differently in
different code paths**. Each input shape now has one reader (`src/util/normalize.ts`), and
`tests/parity/` holds a variant matrix per reader family that was watched failing on 0.2.0.
The same sweep found a second class, **a check that reads a field its source does not serve,
so it can never fire and reports clean**: the expression-of-concern check, below.

### Fixed
- **Review 13 (2026-11-23).** A reference part is compared with the part the record names
  ("..., Part I", a final "II"), not with any numeral of its title: "Phase III trial ..., Part I"
  cited as "Part III" is rejected (round 2 had accepted it). `getOpenAccessSummary` adds
  `unknownOA`, the open papers whose type Unpaywall did not report, so the type counts sum to
  `openAccessCount`.
- **Review 12 round 2 (2026-11-23), class "a field is defaulted or guessed instead of read from
  the reply".** The open-access type was never read from Unpaywall: every open paper was `gold`
  (an open-access journal) or else `green`, so bronze and hybrid papers were reported as GREEN.
  `openAccessStatus` is now Unpaywall's `oa_status` (`hybrid` added to the type, `hybridOA` to
  `getOpenAccessSummary`); with none the type is not reported. In the simple-text stage, a
  candidate Crossref could not validate (5xx, 429, a 200 without a work record) is now also a
  stage error in `errors`, so a `no_match` with that error is not read as fully checked. The part
  rule's own regressions fixed: a record title ending in a numeral the reference also writes
  ("World War II", "Rocky III") is accepted (the numeral after a short word was not seen, and
  "III." did not end the title, so journal words were read as title words); a reference part is
  compared with every numeral of the record title ("Henry VIII and Pope Pius IX").
- **Review 12 (2026-11-23), class "an HTTP reply is taken as the source's answer without
  checking that its body is one".** Every reader of an external reply was listed and checked.
  Fixed: a Crossref 200 without a work record is an unavailable retraction source
  (`server_error`, "200 without a work record"), no longer checked-clean; an OpenRetractions 404
  counts as "not in this index" only with a JSON body; `validateDOI` reports a Crossref 200
  without a work record as a source error, not a TypeError; the Crossref search reports a 200
  without a result list as `lookup_failed`, not `no_match`; `getCitationCount` reads only a
  whole number (an error page "500 Internal Server Error" was 500 citations); the preprint check
  treats a 200 whose record is an array as no answer. Already guarded: expression of concern,
  replies, DOAJ, abstracts. `scripts/openretractions-probe.mjs` no longer passes on a timeout or
  5xx (exit 2, could not verify) and counts a JSON 404 as the API served. The title part rule:
  a reference that writes no part is rejected for a record naming one (`..., Part II`); a part
  written before the title (`Part II: ...`) is read; a numeral opening the next sentence counts
  only after `Part` (`II Farmaco` was read as part 2, rejecting the right DOI). Corpus unchanged
  (905 of 905 right DOIs kept, 1 wrong accepted); the last labelled Part I/II row now rejected.
  Parity test `review12Answers`.
- **QA 16 (2026-11-22), same class ("clean" vs "could not check"): an OpenRetractions 200
  that is not an answer.** `api.openretractions.com` resolves again, to a parked domain (HTTP
  200 with an HTML redirect to `/lander`; HTTPS fails the TLS handshake). The opt-in
  OpenRetractions source counted any non-empty 200 as checked and not retracted; it now needs
  a JSON answer with a boolean `retracted`, else the source is unavailable (`server_error`,
  "200 without a JSON retraction answer"). `scripts/openretractions-probe.mjs` asks whether the
  host serves the API, not only whether it resolves. The default stays `['crossref']`.
- **Review 11 (2026-11-22), the DOI title check read in one direction only.** A candidate was
  accepted when the record's title words occurred in the reference; the reference's own title
  was never compared back. So a reference to "Instrumental Variables Analysis and Mendelian
  Randomization for Causal Inference" (a replacement article) was accepted for the retracted
  "Commentary: Mendelian Randomization for Causal Inference", which could report a retraction
  the cited work does not have. Members of the class, each fixed and tested
  (`tests/parity/review11Title.test.ts`): words written before the record's title ("The temporal
  pattern to the experience of regret" for "The experience of regret"), a longer title around it
  (a reference title that adds most of its words), and another part of a work ("Part I" for a
  Part II record, "II." for a record without a part, also when the title is short). Measured on
  the 1,849 labelled DOI pairs: the 905 right DOIs still accepted, 4 of the 5 wrong DOIs accepted
  before now rejected; on the labelled set the journal-name confuser (`has-reply.json`) and 18
  of 19 Part I/Part II rows now get their label. A reference that starts with its title and
  holds "and" ("Instrumental Variables Analysis and Mendelian ...") no longer reads title words
  as two authors and rejects the right DOI.
- **Final review (2026-11-20), same class, five more members:**
  - *Replies: "none" and "could not check" were one answer.* A Crossref 404, 429, 5xx, timeout
    or network error returned `[]`, like a paper with no replies. New
    `checkReferenceForRepliesDetailed(reference)` returns `{ issues, complete, unavailable? }`
    (`unavailable.reason`: `not_indexed`, `rate_limited`, `server_error`, `http_error` (any
    other 4xx), `timeout`, `network`, `malformed_response`). `checkReferenceForReplies` is
    unchanged in shape. An empty relation list (`has-reply: []`) is no longer reported as a
    reply.
  - *The expression-of-concern update type was read case-sensitively*, unlike the correction and
    retraction readers: `Expression_Of_Concern` was missed.
  - *A junk `doi` hid a valid `suggested_doi`* in the replies, expression-of-concern,
    open-access, preprint and journal-metadata (OpenAlex) checks (`doi || suggested_doi` took
    "n/a"). New `referenceDoi(reference)`: the first full DOI of the two, else the first short
    DOI (`10/abc`), else the first written; when both are full DOIs, `doi` wins. A junk `doi`
    no longer counts toward deduplication's metadata-completeness score.
  - *The DOI shape rule had two copies*: two readers allowed 3-digit registrant codes, two
    required 4. 3-digit registrants exist (10.231, 10.488, 10.978, 10.979, checked against the
    DOI handle server); `cleanDoiInput` now cuts a citation tail after them too
    (`10.231/x.` -> `10.231/x`). One exported `DOI_SHAPE`.
  - *Deduplication merged `.v1` and `.v2` under every DOI prefix.* A version ending is now
    dropped only for registrants that mint one DOI per version, each form read in Crossref
    `is-version-of` relations (figshare: DataCite): bioRxiv/medRxiv/openRxiv (`…123v2`),
    Preprints.org (`.v2`), Research Square (`/v2`), ChemRxiv (`/v2`, `.v2`, `-v2`), Cambridge
    Open Engage (`-v2`), Authorea (`/v2`), TechRxiv (`.v2`, `/v3`), PsyArXiv and the other
    Center for Open Science servers (`osf.io/x_v2`), figshare (`.v1`). `10.5555/a.v1` and
    `10.5555/a.v2` are two works. Zenodo is not in the list: its DOIs carry no version ending
    (each version has its own number), so a `zenodo.123.v1` cell in the 0.3.0 tests was a form
    that does not exist. F1000/Open Research article versions (`.1`, `.2`) are kept apart.
  - *Preprint server names came from a second, drifted table.* 10.31222 (MetaArXiv) was
    reported as engrXiv; engrXiv (10.31224) and EarthArXiv (10.31223) were not recognised; the
    EarthArXiv row (`10.32942/osf.io/`) matched no real DOI (10.32942 is EcoEvoRxiv). Preprint
    detection and deduplication now read one list, `DOI_REGISTRANTS` (`src/doi/registrants.ts`),
    each row checked against the prefix owner in Crossref and a resolved DOI. Newly recognised:
    MetaArXiv, engrXiv, EarthArXiv, EcoEvoRxiv, Research Square, Cambridge Open Engage, Authorea,
    TechRxiv and the other Center for Open Science servers (EdArXiv, LawArXiv, MarXiv, …), by DOI,
    and by URL where the server has its own address. An empty `has-preprint` list is no longer
    reported as a preprint version.
  - *A URL or a mention in the citation text overrode the DOI.* A journal article whose
    citation said "earlier version at ssrn.com" (or arxiv.org, or any preprint address) was
    reported as a preprint without asking Crossref (since 0.2.x; the 0.3.0 URL list widened it).
    Now a full DOI the author wrote (or linked through doi.org) is asked of Crossref, and
    Crossref's answer stands; when Crossref cannot answer (a DataCite or OSF DOI, or a failed
    request) the reference's link decides, never the citation text. With no full DOI of the
    author's (none, "n/a", an unexpanded short DOI, or only a tool-suggested DOI) the link and
    the text decide as before. A DOI inside a doi.org link is now read when the DOI field is
    empty, or when the DOI field holds a junk value. A tool-suggested DOI is read only after
    the link and the text, and a reported DOI is always the full DOI the decision was made on
    (never "n/a"). A Crossref 200 without a work record now counts as "could not answer".
    One rule names the DOIs the check reads (`preprintDois`), and a 210-combination test
    checks every mix of DOI, suggested DOI, link and text against that rule (it fails 67 of
    them on the previous fix). EdArXiv, PaleorXiv and BioHackrXiv are recognised at their own addresses (each
    measured to redirect to OSF). The URL patterns name
    each server exactly as the DOI list does (bioRxiv and medRxiv, which share one prefix, are
    the one refinement), and the OSF addresses (`osf.io/preprints/<slug>`) are built from the
    same list (`OSF_PREPRINT_SLUGS`). AfricArXiv is spelled as OSF spells it. A bioRxiv link's
    page ending (`v1.full`, `.full.pdf+html`, `.full-text`, `.abstract`, any `.word` after the
    identifier) no longer
    makes two works of one preprint.
    A preprint link written into the DOI field (`arxiv.org/abs/...`) is now read like the
    link field, and a server read from a link or the text no longer reports a DOI beside it
    (a Zenodo DOI was reported next to an arXiv link's verdict).
  - **A DOI copied with a link's tail was looked up as written.** In a resolver link
    (`https://doi.org/...`, `doi.org/...`) a raw `?` or `#` starts the URL's query or fragment,
    and `cleanDoiInput` now cuts it there, for every reader; a DOI written bare loses only a
    `key=value` query (`?utm_source=x`), a lone final `?` and trailing slashes. Before, only
    deduplication dropped these, so the preprint, retraction, Crossref, OpenAlex and
    citation-count lookups asked for `10.x/y?utm_source=x`, a preprint known only to Crossref
    read as clean, and a prefix-table preprint was reported with the tail in its DOI. A `#`
    or a page ending written bare is kept: registered DOIs hold them (28,387 DataCite DOIs
    contain `#`, such as `10.15475/dhz/kfn/1918/12/28#page-1`; `10.58079/pdf` and
    `10.82364/144/ssu/ref/meta/full` are DOIs), and a final `#` in a link stays (Wiley SICI
    DOIs end in `CO;2-#`). Deduplication no longer treats two DOIs that differ after a `#` as
    one work (they were merged since 0.2.x); a DOI with a fragment beside the same DOI without
    one, and a page ending (`/full`, `/pdf`), are still one work, except where dropping the
    ending would leave no DOI (`10.58079/pdf` is a DOI; it had lost its DOI identity and could
    merge with a work of another DOI). A link inside a `doi:` label is read as a link, and a
    `?` decoded from `%3F` is part of the DOI.
  - The DOAJ and OpenAlex requests now identify as `referencecheck`, with the polite-pool
    contact address.
- **Expressions of concern were never detected.** Both sources read fields their APIs do not
  serve, so every paper was reported clean. Crossref: the check read
  `relation['has-expression-of-concern' | 'is-expression-of-concern-for']` (not a Crossref
  relation type) and `relationship` (not a Crossref field); Crossref records a concern as an
  `updated-by` entry of type `expression_of_concern`, which is now read. Europe PMC: the check
  read `commentsCorrectionsList` from a `lite` search; the field is `commentCorrectionList`, it
  is served only with `resultType=core`, and the entry type is "Expression of concern in". The
  query is now scoped to the DOI field and the hit must carry the DOI. Proven on recorded
  responses (`tests/fixtures/crossref/eoc-*.json`, `tests/fixtures/europepmc/`); the two old
  tests used hand-built bodies with the same wrong fields.
- **A 200 with no record was "clean".** Crossref `message || {}` and Europe PMC `result || []`
  turned an empty, HTML or list body into a clean answer. It is now `unavailable` with the new
  reason `malformed_response`, and `complete` is false.
- **`metadata.dateIssued`** held the paper's own issue date, unpadded (`2013-7-31`). It is now
  the date of the concern notice, ISO; absent for Europe PMC, which gives none.
- **DOIs.** A DOI was cleaned in eleven places with four rules. `doi:10.x/y`, `DOI: 10.x/y`,
  `https://www.doi.org/…`, `doi.org/…`, a leading space before a resolver URL, or a
  percent-encoded DOI were read differently by different checks: the retraction check reported
  `originalPaperDOI: "doi:10.x/y"`, the preprint prefix detector missed every URL-form DOI,
  `isMalformedDoi("https://doi.org/10.1037/x")` returned `true` while `validateDOI` accepted it,
  and the expression-of-concern, preprint, replies and open-access checks put the raw string
  into the request URL without encoding (a `#` in a DOI cut the request short). Every DOI
  reader now uses `cleanDoiInput`, and every request URL encodes the DOI. Matrix: 9 consumers
  × 49 written forms, plus the pure readers.
- **Years keep their 0.2.x rules.** A shared year reader was built for this release and
  withdrawn before it shipped: six review rounds each found reference shapes that 0.2.x read
  correctly and the new reader did not (an ISO date followed by a later access year, a number
  glued to letters such as `NCI-H1975`, a dated parenthetical in a title, `1781/1998` in
  deduplication), and a wrong year rejects the right DOI. The DOI matcher, deduplication's
  `compareYear`, journal metadata and `isValidReference` read years exactly as in 0.2.x;
  `tests/parity/yearRules02.test.ts` pins them to the 0.2.x rules. Known 0.2.x gaps
  (`compareYear("(2019)", "2019")` is 0, two `"in press"` values score 0) stay until a
  redesign ships on its own.
- **Author lists.** `calculateSimilarity` joined `normalized_authors` with ", " and
  `compareAuthors` split on every comma, so `["Smith, J.", "Jones, K."]` was compared as four
  people while `["J. Smith", "K. Jones"]` was two. Arrays are now passed through; strings go
  through `splitAuthorList`, which keeps "Surname, Initials" together.
- **Names and titles.** The ASCII-only fold turned "Müller" into "m ller" and emptied every
  Cyrillic, Greek or Chinese name and title, which then scored 0.0 as if absent, so two
  identical non-Latin titles were "different". The DOI matcher's surname pattern found no
  surname in "Müller, K." (the author check was silently skipped) and rejected Crossref
  "Müller" against a reference "Muller". All now use the Unicode-aware `foldForMatch`.
- **Journal names.** OpenAlex journal matching compared lower-cased text only, so "Revista de
  Psicologia" did not match "Revista de Psicología", nor "&" match "and". Fixed (`journalKey`).
- **Preprints.** The EarthArXiv URL pattern was misspelled (`earharxiv.org`) and never matched.
- **Errata and responses were never detected.** `checkReferenceForReplies` read the relations
  `is-corrected-by` (HAS_ERRATA) and `is-response-to` (IS_RESPONSE); Crossref serves neither
  (both are rejected as relation types). Corrections are now read from `updated-by` (types
  `correction`, `erratum`, `corrigendum`; not `addendum`, which corrects nothing), with the notice DOI and its date in
  `replyDOI` and `replyDate`; responses from `is-reply-to`. Proven on recorded responses.
- **Preprint server was always "Unknown".** Crossref serves `institution` as an array; it was
  read as an object. `preprintDate` is now ISO (`2020-03-22`, was `2020-3-22`).
- **Cold Spring Harbor journal articles were flagged as bioRxiv preprints.** The 10.1101
  prefix also carries Cold Spring Harbor Laboratory Press journals (`10.1101/pdb.prot099176`
  is a journal article); the prefix rule now matches only the bioRxiv/medRxiv suffix forms
  (with `v2`, `.v1`, `.full` or a trailing period), and the new openRxiv prefix `10.64898`
  (all 453,106 of its Crossref works are posted content) is recognised.
- **DOAJ never found a journal.** The ISSN was sent without its hyphen, and DOAJ finds
  nothing for `issn:19326203` while `issn:1932-6203` finds PLOS ONE (both recorded), so every
  journal was reported "not in DOAJ". The ISSN is now read once (`normalizeIssn`) and sent
  hyphenated, and only when its check digit is right (a page range such as `1648-1655` has
  the ISSN shape); a non-ISSN gives `reason: 'invalid_issn'` without asking DOAJ. A DOAJ failure or a 200 without a result list is now
  `{ found: false, unavailable: true, reason }`, and `determineVerdict` says DOAJ could not be
  checked instead of "not found in DOAJ".
- **Expression of concern: a Crossref 404 was "clean".** A DOI Crossref does not hold (a
  DataCite or Zenodo DOI, or a typo) is now `unavailable` with the new reason `not_indexed`.
- **Journal metadata** read `container-title-short`, which Crossref does not serve; it now
  reads `short-container-title[0]`.
- **Names:** `foldForMatch` also folds ø, ł, ß, đ, ı, æ, œ, þ (`Østergaard` = `Ostergaard`),
  which Unicode decomposition leaves alone.
- **Expression of concern, Europe PMC:** the hit is matched with the shared DOI comparer, so a
  record writing `10.1371//journal…` is this paper.

- **Review 2026-11-19: shapes this release first read worse than 0.2.x.** A DOI followed by
  citation text (`...002386)`, `... [preprint]`, `...v1.full.pdf`, `... (PMID: 1)`) lost its
  bioRxiv preprint flag: `cleanDoiInput` now drops that tail for every DOI reader, keeping
  brackets that belong to the DOI (`(20)30183-5`, SICI `<...>`). It cuts at a space only when
  a bracket or a citation word (`doi`, `PMID`, `Accessed`, `Retrieved`, a URL...) follows, so
  a DOI broken by a space (`10.1371/journal.pone. 0123456`) stays whole and is still reported
  malformed, as in 0.2.x; a percent-encoded space (`10.1000/a%20b`) is kept encoded, so that
  DOI stays well-formed. Journal metadata took a page range from the text when Crossref's
  first ISSN failed the check digit: it now takes the first valid Crossref ISSN, never reads
  the text when Crossref listed any, and lists failed ones in `issnRejected`. Two symbol-only
  titles score 0, not 0.5. `HAS_ERRATA` counts one correction once whatever its DOI's case,
  never the work's own DOI, and does not fire when that is the only notice.
- **Review 2026-11-19: names are read once, by one parser, and decided on evidence.** Eight
  review rounds each fixed a name shape and broke another, because deduplication, the author
  splitter and the DOI matcher each had their own reading of a name. They now share one parser
  (`parseName`), and the release is gated on a labelled set of 1,263 decisions built from the
  Crossref fixtures (`tests/labelled/`: 565 deduplication pairs, 698 DOI candidates, labels by
  construction), per shape class, against the same set scored on 0.2.x: no class has more
  errors, and the total falls from 529 to 75. Each row also carries a fixed half (`fit` /
  `gate`); no threshold was fitted on the rows that gate it, and the errors fall on both
  halves alike (fit 255 to 43, gate 274 to 32).
  - *Deduplication* scores each pair of names by level instead of a share of letters: same
    surname with compatible given names 1; given name on one side only, a name in no shown
    order (`Wang Wei`) of which one reading fits, or a near surname (`Papadopoulos` /
    `Papadopoulou`), 0.75; same surname with a conflicting initial or given name, or with given
    names one letter apart (`Maria` / `Mario`), 0.5 (0.2.x scored `Smith, J.` / `Smith, K.` high
    enough to merge); otherwise 0 (0.2.x gave `smith j` / `jones j` 2/7). Vancouver,
    given-first and folded forms of one name, Cyrillic and Latin spellings of one name
    (`Иванов` = `Ivanova`), names with particles, and two references with the same DOI and a
    short title, which 0.2.x missed, now merge. Two references with different well-formed DOIs
    score just under the caller's threshold (a preprint and its published version, Part I and
    Part II), so the pair alone does not merge them; they can still end in one group through
    transitive closure (a third reference without a DOI close to both), and a caller comparing
    with a lower threshold than the one in the config merges them. The same DOI scores 1,
    unless the metadata contradicts it (below).
  - *The DOI matcher* reports each check (author, year, title) as `matched`, `mismatched` or
    `not_comparable`, and rejects on `mismatched` only. It now also checks the title: at least
    60% of the Crossref title's distinctive words must occur in the reference (measured on the
    first 231 candidates of the labelled set: every right candidate shares 100%; wrong
    candidates by other authors or of another year 0-25%, one 67%; Part II, correction notices
    and preprints 76-100%, which the title cannot separate).
    Cyrillic and Greek surnames are compared with Latin ones by a loose romanisation
    (`Достоевский` = `Dostoevsky` = `Dostoyevsky`, `Иванов` ≠ `Ivashov`); a name in a script
    that cannot be compared (Han, Arabic, ...) no longer rejects the right DOI: the author
    check is `not_comparable` when more of the record's authors cannot be compared than can,
    and is decided on the comparable ones otherwise. Surnames match as whole words or with
    spaces removed (`Van Dyke` = `VanDyke`), so `Li` matches neither `Liu` nor `Williams`. A
    Vancouver list (`Hoddy KK`, `Lee J-H`) is read as surnames; only name particles may stand
    before the surname.
  - Still wrong, and listed in the labelled test: Part I vs Part II and correction notices
    without DOIs merge; the matcher accepts Part II, a correction notice or a preprint for the
    published work (it does not read the record type), a one-word title (`Editorial`) when
    author and year fit, and a candidate whose title words occur in the journal name;
    one-letter surnames (`R SK`, `S. R.`) are not read, so the matcher accepts another work
    with the same title by such authors; a Vancouver list in capitals (`IWAMOTO J`) is not
    read as surnames.
- **Review 2026-11-19, round 11: reference shapes a reader meets in the wild.** The labelled
  set grew by the shapes below; at a53764f these classes were worse than 0.2.x, and all are
  now no worse.
  - *DOI matcher, authors.* A reference whose author list is given-first with full names
    (`Michael J. LaCour, Donald P. Green`, with or without `and`), a string `et al.`, no
    authors, or a corporate author (`World Health Organization`, `... Research Group`) is read
    without inventing a surname from the title or from the corporate name: the author check is
    `not_comparable` when no surname is read, so the title and year decide. A single entry
    of one surname and one initial followed by a surname-like run (`Michael J. LaCour`,
    `Michael J. van der Berg`, `Maria J. Garcia Marquez`, `Alex J. K. Smith`, `Michael J.
    LaCour Jr`, `Hoddy K. Sleep and memory ...`) can be read either as one Vancouver author or
    as a given-first name; both readings' surnames are kept and either may match the record.
    A surname of the second reading does not match a record whose title starts with that word,
    so a record by an author named like the title (`Sleep`) is not taken for `Hoddy K. Sleep
    and memory`. After `et al.` the section is a Vancouver list only. (Rounds 12 and 13: round
    11 dropped the Vancouver reading and rejected the right DOI of one-author Vancouver
    references whose title starts like a name, and read `Michael` for given-first names with a
    particle or two-word surname, both of which 0.2.x accepted.)
  - *DOI matcher, authors (round 14).* Vancouver entries with a capitalised particle or a
    two-word surname (`Van Dyke J`, `De la Cruz M`, `Le Roux P`, `Garcia Marquez G`) and
    entries closed by `et al` or `and others` without a comma are read; they used to give no
    surname, the author check was skipped and any record with the title was accepted. The
    Vancouver surname of an ambiguous section is never dropped with the other reading's
    (`Darwin C. Darwin and ...`); the other reading's surname is dropped for a record when any
    of its words is a word of that record's title (not only the first). The last given-first
    entry before the title is read (`..., Donald P. Green. Title`). A Crossref family of one
    letter with a written-out given name (`R`, `Shakthi Kiran`) is read as an initial filed
    in the wrong field: the given name is compared as the surname.
  - *DOI matcher, authors (round 15).* Vancouver entries with dotted initials (`Smith J.A.`,
    `Jones K.`), a suffix (`Smith JA Jr`, `Smith JA 3rd`) or a three-word surname (`Garcia
    Lopez Marquez G`), and Vancouver lists joined by `and`, `&` or `;`, are read; they used to
    give no surname, so any record with the title was accepted. A section read only given-first
    also keeps its first word as a second, family-first reading (`Wang Xiaoming and Li Hua` is
    Wang). Two given-first entries with a dotted initial (`Michael J. Young, Donald P. Long`)
    are a given-first list, and their surnames count even when they are title words. A name
    that runs on into the title with no period (`Smith J Sleep and memory`) is a second
    reading only, so a record by an author named like a title word is not taken for the work.
  - *DOI matcher, authors (round 16).* Every surname 0.2.x read is kept: the new readers add
    readings and never take one away, so no author section is read with fewer names than in
    0.2.x (each review round from 11 on had found a shape the new readers missed, and a list
    read as empty skips the author check). A 0.2.x name the new readers did not read does not
    count against a record whose title has that word (a reference that starts with its title,
    or `Diabetes, Obesity and ...`), except a first word followed by initials (`Smith J:
    Smith and Jones revisited`). A group author still reads no person. In a given-first list
    (`Hope A. Nakamura, Will D. Long`) the first given name is not read as a surname, and an
    entry followed by a piece that is not a name ran on into the title (`Young K Smith and
    Jones revisited`), so its surname is a second reading only.
  - *DOI matcher, authors (round 17).* An accented surname with no comma after it (`GARCÍA J`,
    `Dvořák P`) is read whole; it was cut at the accent (`Garc`), so the right record was
    rejected. A family-first name with a lower-case particle (`de Vries Jan`) matches a record
    whose family name is `de Vries`.
  - *DOI matcher, authors (round 18).* An author entry of written-out names (`Mark Little`,
    `Little Mark`, `Michael J. Young`, `Wang Xiaoming`) reads family first or given first, so
    its given name also counted as a surname: a record by another author whose family name is
    that given name (`Zoe Mark`), with the cited title and year, was accepted (0.2.x rejected
    it). Where the order is ambiguous, the record's given name must now share an initial with
    the other words of the entry; a record with no given name is compared as before. A
    citation that writes a nickname (`Bill`) for a record's formal given name (`William`) in
    such an entry is now rejected.
  - *DOI matcher, authors (round 19).* The given-name check above vetoes a record only when
    every entry of the reference that holds its family name is of ambiguous order and the
    given name fits none of them (`Mark Little and Zoe Mark` accepts Zoe Mark's record), never
    for an entry longer than four words on a side, and not when the given name is a spelling
    variant of a cited one (`Yulia` / `Julia`, `George` / `Jorge`: two edits or fewer). A
    record with family `R` and a given name in capitals (`SHAKTHI KIRAN`) is read as an
    initial filed as the family, as one in mixed case was.
  - *DOI matcher, authors (round 20).* Four shapes 0.2.x accepted are accepted again: a
    suffix (`Smith Jr`) is not taken for a given name; a sole author entry with no initials at
    the start of the reference is read family first (`Hernandez Ruiz (2014)` against a record
    by Hernandez, Maria: a second surname, not a given name); initials written on to the
    surname are dropped (`SmithJA`); and particles joined to a Crossref family match the
    surname after them (`DeJong` / `Jong`, `VanDerBerg` / `Berg`; not `Mac`, `Mc`, `O`, `D`, so
    `MacDonald` is not `Donald`). Known limit, the same as 0.2.x: a sole author written given
    name first (`Ana Muñoz (2014)`) is accepted against a record whose family name is the cited
    given name (`Ana`) and that has the cited title and year.
  - *DOI matcher, authors (round 21).* The sole-entry reading above also holds before `et al.`
    or `and others` (`Hernandez Ruiz et al. (2014)`), for an entry with no initials; the same
    known limit then covers `Mark Little et al.`. When two or more of a record's authors each
    open a different author entry (`Hernandez Ruiz and Lopez Garcia (2014)` and a record by
    Hernandez and Lopez), the reference lists them family name first and the given-name check
    does not apply. A given name written as one word is a spelling of the same name written in
    parts (`Hsiao-Ming` / `Xiaoming`). Particles joined to the reference's surname are dropped
    too (`DeJong, P.` / a record by Jong), and initials glued to a surname with a capital or a
    hyphen inside it (`McDonaldJA`, `VanDerBergJ`, `Smith-JonesJA`). Known limit: a romanisation more than two edits away
    (`Zongdao` / `Tsung-Dao`) is taken for another given name, like a nickname.
  - *DOI matcher, authors (round 22).* Initials glued to a two-letter surname (`XuJ`, `LiJ`) or
    in front of a surname (`JSmith`) are dropped, and so are initials glued to a Crossref family
    (`SmithJA`). A glued `O` or `D` stays part of the surname (`OBrien` is not `Brien`, as
    `MacDonald` is not `Donald`; 0.2.x accepted both by substring). The given-name check reads only the words before the record's title, so a title word
    next to the family name is not a given name (`WangL. 2014. Wang Group Studies`). The
    family-first reading of round 21 applies only to entries with no initials: in
    `Garcia Lopez, M., Rosa Diaz, A.` a record by Ana Garcia and Luis Rosa is rejected.
  - *DOI matcher, authors (round 23).* The record's title is looked for only where a sentence
    starts (after a period, colon, question mark or year), so a title that opens with a cited
    given name (`Hope Rowe, Anne Bell (2014). Hope.`) no longer switches the given-name check
    off. The family-first reading of round 21 applies only where the reference has no
    `Surname, I.` pair, as 0.2.x read it: `Mark Little, Grace Collins` against a record by Zoe
    Mark and Quinn Grace is rejected. A year right after a sole author entry ends it like a
    period (`Hernandez Ruiz, 2014, Diabetes in adults`).
  - *DOI matcher, authors (rounds 24-25).* Where the record's family was matched only by a
    reading 0.2.x did not make (`Mark` in `Mark Little, Grace Collins`), the given-name compare
    is strict. A shared initial counts as agreement only when one side is an initial
    (`Little` / `L.`). Two written-out names must also share their first two letters, or the
    shorter one (three letters or more) must have its letters in order in the longer one
    (`Kate` / `Katherine`, `Tom` / `Thomas`). So a record by Larry Mark, or by Louis Mark
    against `Mark Lu`, is rejected, as 0.2.x rejected it. Where 0.2.x read the surname too
    (`Mohamed Hassan, Grace Collins` and a record by Hassan, Muhammad), any shared initial
    still agrees, so spellings and nicknames with the same first letter (`Piotr` / `Peter`,
    `Jim` / `James`) keep the right record. Known limit: a record given name that shares the
    first two letters of the cited surname (Lisa Mark against `Mark Little`) is still accepted.
  - *DOI matcher, authors (round 26).* Whether 0.2.x matched the family is judged by 0.2.x's
    own reading, letter for letter: it cut `García` to `Garc`, which still matches a record
    family `Garcia`, so the lenient compare keeps that record (`Mohamed` / `Muhammad`); where
    0.2.x read no surname at all (`Núñez Piotr`), the compare is lenient too. In the strict
    compare an initial before the family does not count when a written word follows it
    (`J. Mark Little`: the `J.` is Little's), so a record by Jane Mark is rejected. A title of
    two or more words is also found after a comma (`Mark Little, Grace Collins, Mark my
    words`), so a given name inside the title no longer switches the check off.
  - *DOI matcher, authors (round 27).* Whether 0.2.x read the first word only is also judged by
    its own ASCII reading: an accent hides a comma pair from it (`Hernández Núñez, López
    García`), so it read the first word, and the first-entry and family-first exemptions apply as
    they did there. The right record by Hernández and López is accepted again.
  - *DOI matcher, authors (round 28).* A period after an initial starts the title only when the
    words found do not end an author entry: in `Zoe A. Mark, Anna B. Hope (2014). Hope.` the
    `Hope` after `B.` is Anna's surname, so a record by Carl Hope titled "Hope" is rejected
    (0.2.x rejected it) and the record by Anna Hope is accepted.
  - *DOI matcher, list numbers (found by the release corpus diff).* A list number
    before the first author (`15. `, `[3] `, `(4) `, `4) `) is dropped before the reference is
    read: with it, `15. Surname MA, Next M` was read as the authors `MA` and `AI`. On 54
    numbered references from real reference lists, right records accepted went from 12 of 27 to
    26 of 27 (0.2.x: 14 of 27).
  - *DOI matcher, titles.* Title words are compared by stem (`organisation` = `organization`,
    `behaviour` = `behavior`, `modelling` = `modeling`, `norms` = `norm`); the main title and
    the full title (with subtitle) are each tried, either may pass, so a reference that drops
    the subtitle is accepted; a title cut with `...` or `…` is compared on the words before the
    cut; a one-word main title that occurs in the reference is `not_comparable`; a title of
    three words or fewer that shares at least one word but not 60% is `not_comparable` when
    author and year both match (`Neural nets` for `Neural networks`), and still rejects
    otherwise.
  - *Deduplication.* `Maria Garcia` / `Mario Garcia`, `Wang Li` / `Wang Lin`, `John Smith` /
    `Jon Smith` score 0.5 (were 0.75 as near names), and a reading with an equal surname wins
    over a near-surname reading. `O'Brien, K.` and `o brien z` (an apostrophe written as a
    space, `d` added to the name particles) are the same surname with conflicting initials,
    0.5. `Smith John A.` is surname Smith with initials JA.
- **Owner decisions in round 11** (also in docs/API.md):
  - *A first-author-only list merges with the full list.* A list that names only the first
    author or authors (with or without `et al.`) and agrees at every position, each pair at
    least 0.75, scores the mean of those pairs (`compareAuthors`), not the symmetric average,
    which counted every unnamed author as a miss.
  - *One preprint, one work.* The DOI comparison ignores a link tail (`/full`, `/pdf`, `/epdf`,
    `/abstract`), a query or fragment, a bioRxiv/medRxiv/openRxiv version (`v2`) and a
    `.v1`-style version (figshare, Zenodo). A preprint and its published version, which carry
    different DOIs, stay two works.
  - *The same DOI with contradicting metadata is not forced to 1.* When the author score and
    the title-word share of two references with one DOI are both below 0.3
    (`SAME_DOI_CONTRADICTION`), the weighted score decides and `doiRelation` returns
    `'same-contradicted'`. The title side is the share of the shorter title's words (three or
    more letters) found in the other title, not the edit-distance `compareTitle`: on the
    labelled set, two unrelated titles scored 0.31 and 0.37 by edit distance. A same-DOI pair
    with a different title but matching authors still scores 1.

### Added
- `JournalMetadata.issnRejected`: ISSNs Crossref listed that fail the check digit.
- `findDOIFromReferenceDetailed(referenceText, creds?)`: the DOI search with `status`
  (`found`, `no_match`, `skipped_unpublishable`, `lookup_failed`), every rejected candidate
  with its reason, and the count dropped under the relevance threshold. `findDOIFromReference`
  returned `null` for all four, and rejected candidates were only logged.
- Shared readers, exported: `cleanDoiInput`, `doiForUrl`, `foldForMatch`, `splitAuthorList`,
  `formatDateParts`, `journalKey`, `normalizeIssn`.
- `compareAuthors` accepts a string array as well as a string.
- `parseName(name)` and `ParsedName` (`surname`, `initials`, `given`, `order`: `'known'` /
  `'unknown'`, `raw`): the one name reading deduplication uses.
- `DoiMatchCheck` (`matched` / `mismatched` / `not_comparable`); `authorCheck`, `yearCheck`
  and `titleCheck` on a `CrossrefResult` found by the DOI search and on each
  `RejectedDoiCandidate`; `DoiSearchOutcome.notComparable` counts candidates per check that
  was `not_comparable`. New rejection reason `Title mismatch: ...`.
- `doiRelation(ref1, ref2)` and `DoiRelation` (`'same'`, `'same-contradicted'`, `'different'`,
  `null`), and `SAME_DOI_CONTRADICTION` (0.3): how two references' DOIs relate, as
  `calculateSimilarity` uses it.
- `findDuplicateGroups(pairs, diagnostics?)` and `DuplicateGroupingDiagnostics`: pass an object
  and `droppedDifferentDoi` is set to the number of pairs dropped because their references carry
  different DOIs (they were dropped silently).
- `tests/labelled/` (the labelled release set and its 0.2.x baseline counts) and
  `scripts/labelled-report.mjs` (scores any build on the set; `--compare` fails when a class
  is worse than a baseline; `--halves` prints the totals on each fixed half of the set).

### Changed
- `CORRECTION_NOTICE` is gone: it read a field Crossref does not serve and never fired, and a
  correction is not an expression of concern (corrections are `HAS_ERRATA`).
- `EocUnavailableReason` gains `malformed_response` and `not_indexed`.
- One shortDOI shape (`SHORT_DOI`, exported from `src/util/normalize.ts`): the token starts with a
  letter or digit (`10/gt3vmw`). `isMalformedDoi` and `isShortFormDoi` no longer accept `10/-abc`,
  `10/.abc` or `10/_abc`, which cleanDoiInput already did not read as a shortDOI (review 10).
  `normalizeAbstractDoi` uses the shared `DOI_SHAPE`, so `10.1/x` and `10.12/x` (a 1- or 2-digit
  registrant, no DOI) return `null` like every other reader.
- `CrossrefResult.publishedDate` is ISO at Crossref's precision: `"2019-03-05"`, `"1998-02"`
  (was `"2019-3-5"`, `"1998-2"`), as are the preprint, reply and expression-of-concern dates.
  `validateDOI` and the DOI search now share one record mapper. JavaScript's `new Date()` reads
  a date-only ISO string as UTC midnight, so west of UTC `new Date("2019-01").getFullYear()` is
  2018: read the year from the string (`Number(s.slice(0, 4))`).
- The lockfile pins `follow-redirects` 1.16.3 (via `axios`), clearing three high advisories in
  1.16.0. A consumer resolves its own copy from `axios`'s range; `npm audit fix` there does the same.
- The dev dependency `rimraf` is gone (its `minimatch`/`glob` carried three moderate advisories, and
  its fixed version needs Node 20): `npm run clean` uses Node's own `fs.rmSync`. `npm audit` reports
  0 vulnerabilities.

### What a consumer does differently
- Expect new expression-of-concern findings: the check works for the first time. One concern
  found by both sources is two issues (one per source). Nothing else is required. A consumer that rendered `publishedDate` sees zero-padded dates. A
  consumer that wants to say "DOI search failed" rather than "no DOI found" switches to
  `findDOIFromReferenceDetailed`. Author scores in deduplication change for most inputs (by
  level, not by letters: different surnames score 0 and near surnames 0.75, the same surname
  with another initial 0.5, a first-author-only list the score of the authors it names), two
  references with different DOIs score just under the threshold in the config (a caller that
  compares with a lower threshold, or transitive closure through a third reference, can still
  join them), and the same DOI scores 1 unless `doiRelation` says `'same-contradicted'`; year
  scores are unchanged. `findDuplicateGroups(pairs, diagnostics)` counts the different-DOI
  pairs it drops. A found DOI whose `authorCheck`, `yearCheck` or `titleCheck` is
  `not_comparable` was accepted on less evidence: show it as such. The DOI search now rejects
  candidates whose title does not fit, so some DOIs 0.2.x found are no longer found. On the
  labelled set (1,263 rows) every candidate 0.2.x accepted and 0.3.0 rejects is a wrong one;
  0.3.0 rejects one right candidate (one-letter surnames, `R SK`), which 0.2.x rejected too.

## 0.2.0 — 2026-10-14

### Added
- `fetchAbstract(doi, options?)` and `fetchAbstracts(dois, options?)`: the abstract of a work by
  DOI, trying Crossref (publisher JATS), OpenAlex (`abstract_inverted_index`), Semantic Scholar
  (only when `semanticScholarApiKey` is passed) and Europe PMC, first usable (>= 200 characters)
  wins. Every source tried is reported in `attempts` (`found`, `absent`, `too_short`, `error`).
- `status` keeps three facts apart: `found`; `not_found` (every source answered, none had one);
  `error` (none had one and at least one source failed, so absence is not established).
- Cross-document cache keyed by normalised DOI (`AbstractCache`, `MemoryAbstractCache`); only
  `found` and `not_found` are cached, an `error` is retried.
- `MetadataCredentials.semanticScholarApiKey` (optional).
- Results carry `sourcesTried` and `shortAbstract` (the longest text under 200 characters, kept
  when nothing longer exists); `fetchAbstracts` returns `invalid_doi` for an input that is not a
  DOI instead of dropping it.

### Guarantees checked before release (review 2026-10-14)
- A cached `not_found` is reused only by a lookup asking no more sources than it consulted.
- A 200 response with an unexpected body (HTML block page, error envelope) is `error`, never
  "no abstract", and is not cached.
- A Europe PMC hit is accepted only when its DOI is the requested one.
- Every source's record must name the requested DOI (`sameDoi`; repeated slashes are
  equivalent): a merged or redirected record for another work is an `error`, never `found`.
- An empty 200 body, a malformed record, or an OpenAlex index with gaps or reused positions is an
  `error`, never "no abstract" or a silently altered text.
- A cached `found` answers only lookups that allow its source; a cached `not_found` expires after
  `notFoundMaxAgeDays` (default 30); `MemoryAbstractCache` copies in and out.
- Markup: named entities decoded, one abstract per field (English first), literal `<` text kept,
  a "Summary"/"Abstract" heading stripped only as a heading.
- Reviewed by two other models (tier-3 cross-model consult) before release; every confirmed finding has a regression test in `tests/abstract/consult.test.ts`.
- The documentation gate normalises CRLF before parsing the README (a Windows checkout made it
  report "no offline js block").

### What a consumer does differently
- Nothing changes for existing checks. To use abstracts, pass an `AbstractCache` backed by your
  database so lookups are shared across documents.

## 0.1.8 — 2026-09-30

**Documentation only; no change to library behaviour.**

### Added
- README rewritten to cover every check: method and data sources (cited by DOI), install, a
  runnable quickstart (an offline block and a live-API block, each with its real output),
  how to read the results, configuration, limitations and failure modes, maintainer scripts,
  how to cite. The full reference for all 84 exports, every result field and every issue code
  is in `docs/API.md`.
- `CITATION.cff` and `CONTRIBUTING.md`.
- Documentation-drift gate `scripts/check-docs-coverage.mjs` (`npm run docs:check`). It derives
  the public surface from `src/index.ts` with the TypeScript compiler, plus issue codes,
  `process.env` reads and maintainer-script flags, and fails when any is missing from the
  docs, when the changelog, README install pin and `CITATION.cff` disagree with
  `package.json`, or when the README quickstart does not run against a fresh build
  (`--online` also runs the live-API block). Pinned two-sided by
  `tests/docsCoverageGate.test.ts`.

### Fixed (documentation)
- README install pin named v0.1.1; it now names the current release.
- "the library never reads environment variables": `formatError` reads `NODE_ENV`. The README
  and the `MetadataCredentials` comment now say so.
- `getOpenAlexEmail`'s comment said it reads `OPENALEX_EMAIL` and falls back to
  `CROSSREF_EMAIL`; it reads only `creds.openAlexEmail`, else `DEFAULT_POLITE_EMAIL`.
- `crossrefGet`'s comment said 5xx responses back off 2 s, 4 s, 8 s; it retries only 502, 503
  and 504, waiting 2 s then 4 s.

### Documented (previously undocumented behaviour)
- The expression-of-concern `KnownList` source is a stub that always reports clean and is
  listed in `sourcesChecked`.
- Several checks return the same value on a network failure as on a clean answer
  (open access, preprint, replies, `checkReferenceForEOC`, citation counts, `checkDOAJ`).
- Declared-but-unused fields and values (`PluginConfig.use*`, `cacheExpiry`,
  `journal_validation_checked_at`, open-access `bronze`/`closed`, reply type `correction`).
- `isMalformedDoi` checks shape only (`10.1037/0` is not flagged).

## 0.1.7 — 2026-09-27

**The fixture capture scripts no longer carry a hardcoded contact address.**
Both `tests/fixtures/crossref/capture.mjs` and `tests/fixtures/doiorg/capture.mjs`
sent a committed email address as the polite-pool `mailto` in their User-Agent.
They now read it from the `CROSSREF_MAILTO` environment variable, have no
default, and exit with an explanation when it is unset or blank:

```powershell
$env:CROSSREF_MAILTO = "you@example.org"; node tests/fixtures/crossref/capture.mjs
```

### Added

- `tests/hygiene/noPersonalEmail.test.ts` fails when any file `git ls-files`
  reports contains an `@gmail.com` or `@hku.hk` address. One address is allowed
  in one file: `DEFAULT_POLITE_EMAIL` in `src/http/credentials.ts`, the
  library's shipped polite-pool fallback. It carries two controls — it must see
  tracked files, and its pattern must match planted addresses — so a broken
  scan cannot pass as a clean tree.

### Unchanged

- No file under `src/` changed, so library behaviour is identical to 0.1.6,
  including the `DEFAULT_POLITE_EMAIL` fallback sent to Crossref and OpenAlex
  when a consumer supplies no `creds`.

**What a consumer must do:** nothing. Repinning to 0.1.7 is optional.

## 0.1.6 — 2026-09-12

**axios was pinned to `^1.6.2`, resolving to `1.16.1` — the range covers 10
published advisories, one of them HIGH.** axios is this library's only runtime
HTTP dependency (every Crossref, doi.org, OpenAlex, OpenCitations and Unpaywall
call goes through it), so a consumer installing `referencecheck` inherited all
ten regardless of whether any code here exercises the vulnerable path.

Measured with `npm audit` against the previously locked `1.16.1`, 2026-09-12:

| severity | count | worst finding |
|---|---|---|
| high | 1 | `GHSA-gcfj-64vw-6mp9` — the Node HTTP adapter can reuse an inherited proxy after interceptor-config cloning, leaking proxy credentials to the wrong host |
| moderate | 9 | prototype-pollution via cloned/nested request options (4 GHSAs), DoS via unbounded `formToJSON`/`formDataToJSON` recursion (3 GHSAs), `maxBodyLength` bypass on HTTP/2 and fetch-adapter streamed uploads (2 GHSAs) |

All ten advisories close at `axios@1.18.0`; every one of their ranges reads
`< 1.18.0`, none `< 1.20.0`.

### Changed

- `dependencies.axios` range raised `^1.6.2` → `^1.18.0`; installed version is
  now `1.20.0`. `npm audit` reports 0 vulnerabilities (info/low/moderate/high/
  critical) after the bump, verified against the same lockfile mechanism.
- No source change and no behavior change — this is a dependency-range bump
  only. Existing tests are unaffected; they exercise this library's own logic,
  not axios's internals.

**What a consumer must do:** repin the tag
(`github:giladfeldman/referencecheck#v0.1.6`) and reinstall. Because npm
resolves this package via git tag + lockfile rather than the registry, `npm
audit` in a consumer tree will not surface this on its own until the lockfile
is regenerated against the new tag — see `DOWNSTREAM.md` for why `npm ls` and
`npm install --dry-run` can both report a version that is not actually
installed.

## 0.1.5 — 2026-09-12

**A shortDOI is an alias, not a malformed DOI.** `0.1.4` shipped
`isShortFormDoi`, which lets a caller refuse a lookup on `10/gt3vmw` — correct,
because handing an unexpanded alias to Crossref returns a 404 or a spurious
fuzzy match. But refusing was the only thing a caller could do with one, and a
shortDOI is not a defect: it stands for exactly one canonical DOI, and the
resolver will say which.

### Added

- **`expandShortDoi(doi, options?)`** — resolves `10/<token>` to its canonical
  DOI through one manual hop of the doi.org redirect. Measured against the live
  resolver, 2026-09-12:

  | input | status | Location |
  |---|---|---|
  | `10/gt3vmw` | 301 | `https://doi.org/10.1111/ECIN.13244` |
  | `10/b77m95` | 301 | `https://doi.org/10.1037/H0054651` |
  | `10/aabbe` | 301 | `https://doi.org/10.1002/(SICI)1097-0258(19980815/30)17:15/16%3C1661::AID-SIM968%3E3.0.CO;2-2` |
  | `10` | 400 | — |
  | `10/zzzzzzzzzz` | 404 | — |
  | `10.1111/1467-9280.00441` | 302 | `https://journals.sagepub.com/...` |

  The discriminator is therefore **not** "there was a redirect": a canonical DOI
  also redirects, straight to the publisher. An expansion is accepted only when
  the resolver answers 3xx with another **doi.org** URL whose path is a
  canonical DOI. Exactly one hop is followed; going further walks into publisher
  redirect chains that carry no DOI at all.

  Anything that is not the shortDOI form — a canonical DOI, a bare `10`, a
  non-string — returns `not-short-form` **without a network request**. That
  bound is the point: this function can only change the verdict for inputs
  `isShortFormDoi` already identifies.

- **`readExpansionTarget(location)`** — the pure half, for callers that already
  have a Location header.
- **`clearShortDoiCache()`** — clears the 24h in-memory expansion cache.

### Two traps this implementation is built around

- **The Location path is taken verbatim.** `10/aabbe` expands to a DOI whose
  suffix contains parentheses, a colon, angle brackets **and two slashes**. A
  `/10\.\d{4,9}\/[^\/]+/` style parser truncates it to
  `10.1002/(SICI)1097-0258(19980815`, which returns Crossref **404** while the
  verbatim form returns **200**. So the path is read with
  `decodeURIComponent(new URL(loc).pathname)` and nothing cleverer, and that DOI
  is a recorded fixture.

- **Case.** The resolver returns the registrant's casing (`10.1111/ECIN.13244`);
  Crossref normalises to lower case (`10.1111/ecin.13244`). Both resolve, so
  lookups are safe either way — but a caller that persists or de-duplicates on
  the redirect's string will hold two spellings of one DOI. Prefer Crossref's
  `message.DOI`, or lower-case before keying.

### Honesty of the failure modes

`ShortDoiExpansionReason` is exhaustive and has no catch-all: `expanded`,
`not-short-form`, `not-registered`, `malformed`, `no-redirect`, `off-resolver`,
`unexpanded-target`, `network-error`. A caller must not be able to collapse
"this alias is not registered" into "we could not reach the resolver" — those
are opposite facts about the reference, and only the first licenses telling an
author their DOI is unusable. For the same reason a `network-error` is **not**
cached: one unreachable minute must not become an hour of references wrongly
reported as unresolvable.

### Tests

21 new tests, every HTTP payload a recorded doi.org response
(`tests/fixtures/doiorg/capture.mjs`). Four sabotages were applied one at a
time and each reddened only its own tests: reading the suffix by regex → only
the exotic-suffix test; dropping the doi.org host check → only the two
off-resolver tests; dropping the short-form guard → only the two
never-called controls; caching network errors → only the not-cached test.

## 0.1.4 — 2026-09-12

**0.1.3 shipped the coverage flags over Crossref detection code that could never
fire.** The Crossref path read `message.update`; Crossref does not serve that
field. The real relation key is `message['updated-by']`. So the only surviving
Crossref detection was a title substring match, and the library's own test kept
the suite green by hard-coding the fictional field.

Measured against the **live compiled library and the live Crossref API**,
2026-09-12 — six DOIs, three genuinely retracted and three healthy controls:

| DOI | truth | 0.1.3 says | 0.1.4 says |
|---|---|---|---|
| `10.1126/science.1256151` (LaCour) | retracted | **not retracted** | retracted |
| `10.1538/expanim.54.1` | retracted | **not retracted** | retracted |
| `10.1016/S0140-6736(97)11096-0` (Wakefield) | retracted | retracted | retracted |
| `10.1038/nature12373` | clean | clean | clean |
| `10.57656/sc-2025-0013` ("Retracted Publications in Indian Science") | clean | **retracted** | clean |
| `10.1126/science.aac6638` (a retraction *notice*) | clean | **retracted** | clean |

**0.1.3 got four of six wrong, and reported `complete: true` on every one.** Two
were false cleans; two were false positives. Wakefield survived only because its
title literally begins "RETRACTED:".

The false positives are the half nobody was looking for, and they matter most to
this library's actual users: a Crossref search for meta-science papers *about*
retraction returned **8 of 8** healthy papers whose titles contain "retract",
every one of which 0.1.3 reports as retracted. That is the literature a
meta-science bibliography is full of.

### Fixed

- **Crossref retraction detection now reads `updated-by`, the field Crossref
  serves.** `message.update` is `undefined` on every work tested, retracted and
  healthy alike. `updated-by` entries carry `source: "retraction-watch"`, so
  Crossref relays Retraction Watch data directly.
  - A retracted paper's `updated-by` commonly lists corrections alongside the
    retraction (Wakefield: a 2004 correction at index 0, the 2010 retraction at
    index 1), so the entry is selected by `type`, never by position.
  - The relation is dated with `updated`; `date` is still read as a fallback.
- **`update-to` is deliberately NOT read as evidence of retraction.** It appears
  on the retraction *notice* and names the paper the notice retracts, so reading
  it would invert the relation and flag every notice as a retracted paper.
- **The title heuristic is now a delimited publisher marker** — ALL-CAPS,
  bracketed, or followed by a colon or dash (`RETRACTED:`, `RETRACTED ARTICLE:`,
  `Retracted:`, `[Retracted]`, `WITHDRAWN`, `REMOVED:`) — instead of a
  `title.includes('retract')` substring test that flagged every healthy paper
  whose title begins "Retracted Publications…".

  A first cut of this release used an ALL-CAPS-only rule. The review below
  showed that loses real retractions: `10.1109/icaccs60874.2024.10717184`
  ("Retracted: Faux Reality Detector") and `10.3892/ol.2018.7943` ("[Retracted]
  Pediatric sarcomas (Review)") are genuinely retracted and deposit an **empty**
  `updated-by`, so the title is their only signal.
- **The `message.type === 'retraction'` branch is removed: it was dead code.**
  `retraction` is not a Crossref work type — the filter returns HTTP 400 where
  `type:journal-article` returns 200 over 123M works, and the `/types` registry
  contains no such id.
- **`checked` and `complete` no longer report a clean while a source went
  unread.** `checkRetraction` hard-coded `checked: true` on the Crossref-clean
  early return, so an OpenRetractions failure followed by a Crossref 200 was
  stamped complete. The mirror case was already correct, so the dedicated
  retraction index's silence was ignored while the general bibliographic
  record's silence was not. Both are now `sourcesUnavailable.length === 0`,
  matching this module's own docstring and `expressionOfConcernService.ts`.
  (0.1.3's CHANGELOG already *claimed* this behaviour; the code never had it.)
- **`checkRetractionDetailed`'s `complete` no longer absorbs a positive
  finding.** It was `isRetracted || checked`, which called a result complete
  whenever a retraction was found even with an index unread. Verdict and
  coverage are now independent.

### Added

- **`RetractionInfo.sourcesChecked`** — which sources actually answered and so
  produced this result. A fallback is never silent.
- **`RetractionCheckOptions`**, accepted as an optional second argument by
  `checkRetraction`, `checkRetractionDetailed` and `checkMultipleRetractions`:
  - `creds` — Crossref polite-pool identity, now threaded through to
    `crossrefGet`. Previously this path had no way to receive it, so a
    consumer's `CROSSREF_EMAIL` was dropped and every request was attributed to
    the library's default contact. Matches `validateDOI(doi, creds)`.
  - `sources` — which indexes to consult. Defaults to
    `DEFAULT_RETRACTION_SOURCES`, exported.
- **`RetractionSourceName`** and **`DEFAULT_RETRACTION_SOURCES`** exports.
- `tests/fixtures/crossref/` — six **verbatim recorded Crossref response
  bodies**, with the `capture.mjs` that re-records them from the live API. The
  0.1.3 suite passed because its fixture was hand-built; a synthetic fixture
  cannot tell you the rule is wrong, only that your fixture is.
- `tests/retraction/retractionDetection.test.ts` — 7 tests including a
  **calibration test**: detection must fire on a known-retracted DOI whose title
  contains no retraction marker (LaCour). That is the test 0.1.3 lacked and the
  one that would have caught this.
- `tsconfig.test.json` so test-only helpers compile outside `rootDir: ./src`.

### Found by a three-model review, and fixed before release

The first cut of v0.1.4 was reviewed by **Fable 5** (anthropic), **Sonnet 5**
(anthropic) and **Grok 4.6** (xai). Two providers, not three — the OpenAI seat was
unavailable and was substituted. Every finding below was **reproduced through the
compiled library against the live Crossref API** before anything was changed, and
each has a regression test watched failing against the pre-fix code.

- **False clean: `withdrawal` and `removal` were not detected.** Crossref serves
  these as first-class `updated-by` types whose labels contain no "retract", so a
  retraction-only matcher reported genuinely pulled papers as clean —
  `10.1002/14651858.cd009522` (a withdrawn Cochrane review),
  `10.1016/j.crad.2024.02.007`, `10.1016/j.asr.2025.03.045` (an Elsevier removal).
  Detection now covers `retraction`, `partial_retraction`, `removal` and
  `withdrawal`. Found independently by all three seats.
- **False clean: a Crossref 404 was treated as a clean bill of health.**
  OpenRetractions is a retraction index, so a 404 there means "not retracted".
  Crossref is a bibliographic register, so a 404 there means "not a Crossref
  work" and says nothing about retraction. `10.5281/zenodo.3242591` (a Zenodo
  DOI) and LaCour's DOI with one character appended both returned
  `checked: true, complete: true, isRetracted: false`. A Crossref 404 is now the
  new unavailable reason **`not_indexed`**. The asymmetry is deliberate and
  per-source.
- **False clean: `sources: []` returned a confident clean having consulted
  nothing.** `checked` now also requires `sourcesChecked.length > 0`.
- **False clean: title markers publishers actually use were missed** — see the
  title-heuristic note above.
- **False RETRACTED: a withdrawn preprint was reported as retracted.**
  `10.31234/osf.io/etvnm_v1` is a PsyArXiv preprint titled simply "WITHDRAWN".
  OSF preprints are routinely withdrawn because the work was published elsewhere,
  not for misconduct. Flagging it is right; calling it *retracted* to a psychology
  author is a false claim about their bibliography. Hence `retractionType`.
- **Wrong number: the title path returned the paper's PUBLICATION date in
  `retractionDate`.** There is no notice to date on that path, so the field is now
  absent rather than wrong.
- **Understated verdict: selection was by array position.**
  `10.33552/ojdoh.2018.01.000503` lists twelve notices with `partial_retraction`
  ahead of `retraction`, and the weaker one was reported. Selection is now by
  severity, then by earliest date — `10.1007/s11277-021-09072-0` carries a
  publisher retraction dated 2021-09-11 and a Retraction Watch record dated
  2022-12-06, and the retraction happened on the earlier date.
- **Corrected claim: the "14 of 14" coverage figure in the first cut was
  circular.** That corpus was drawn from Crossref's own `update-type:retraction`
  filter, so it had the relation by construction and could not measure what
  `updated-by` misses. On five well-known retractions chosen independently (Mehra
  2020, STAP, Stapel 2011, Séralini 2012, Hwang 2005) `updated-by` carried the
  retraction **5 of 5** and a capitalised title marker only **3 of 5** — but the
  two empty-`updated-by` cases above prove coverage is good, not total. Stated in
  the module header as a known limit rather than implied away.

### Added by that review

- **`RetractionInfo.retractionType`** — `retraction` | `partial_retraction` |
  `removal` | `withdrawal`. **`isRetracted` means "this work has been pulled and
  must not be cited as an ordinary reference"**, so a consumer reading only the
  boolean cannot silently drop a withdrawal. Anything that renders a verdict to a
  reader must use `retractionType` for the wording — `retractionReason` now names
  it in words too ("Withdrawn", "Partially retracted").
- `tests/retraction/retractionUpdateTypes.test.ts` — 16 tests, 12 of which fail
  against the pre-review code; the 4 that pass are the two-sided controls, which
  must pass on both.
- Eight further recorded Crossref fixtures covering every case above.

**Consumer action:** Scimeto should read `retractionType` and stop rendering the
word "retracted" for a withdrawal or removal, and should surface `not_indexed`
distinctly — a Zenodo or DataCite DOI is now honestly reported as unchecked
rather than silently clean.

### Changed — read this before upgrading

**OpenRetractions is no longer consulted by default.** `api.openretractions.com`
does not resolve: `EAI_AGAIN` on both `api.openretractions.com` and
`openretractions.com`, measured 2026-09-12, while `api.crossref.org` resolved on
the same call. Combined with the strict completeness rule above, leaving it in
the default list would mark **every** lookup incomplete forever — an alarm that
fires on every reference tells a reader nothing and would drown the genuine
Crossref failures it exists to surface.

It costs no coverage: Crossref's `updated-by` entries carry
`source: "retraction-watch"`, so Crossref relays the same data OpenRetractions
was built on. The source is **not deleted** — pass
`{ sources: ['openretractions', 'crossref'] }` to consult it if the host
returns, and its behaviour stays pinned by tests. Dropping it also removes a
failing DNS lookup from every single reference check.

`RetractionInfo` gained a field and both functions gained an optional argument,
so existing single-argument call sites keep compiling and behaving as before —
except that they now detect retractions they previously missed, and stop
flagging papers that were never retracted.


## 0.1.3 — 2026-09-10

**The same defect 0.1.2 fixed for Expression of Concern was still live in the
retraction path.** `checkRetraction` returned `{ isRetracted: false }` for a
Crossref **429 or timeout** exactly as it did for a genuine clean answer, and
callers read the boolean bare — so a rate-limit storm printed a clean
bibliography over references nobody had successfully looked up. On a tool whose
whole purpose is that check, a retraction lookup that silently passes when it
did not run is the worst available failure.

Two-sided control on the coverage gap itself: Expression of Concern had 19 test
references; the retraction path had **zero test files**. The gap was in
coverage, not in anyone's search for it. The 0.1.2 note above records **81
Crossref 429s in one real SciMeto run**, so the failure mode is measured.

### Added
- `RetractionInfo.checked` — true only when a source actually answered. Read it
  before trusting `isRetracted === false`.
- `RetractionInfo.sourcesUnavailable` — every source that could not be reached,
  and why (`rate_limited` / `timeout` / `server_error` / `network`).
- `checkRetractionDetailed(doi)` → `{ retraction, complete, sourcesUnavailable }`.
  Prefer it anywhere the result reaches a reader. Mirrors
  `checkReferenceForEOCDetailed`.
- `tests/retraction/retractionCoverage.test.ts`, 9 tests, offline and
  deterministic (axios and `crossrefGet` mocked — a live-API test cannot express
  "and now Crossref rate-limits you").

### Changed
- A **404 is now treated as an answer** ("this DOI is not in that index"), while
  429 / timeout / 5xx / socket errors are treated as no answer at all. That
  distinction is what the old single `isRetracted: false` collapsed.
- Crossref answering with an ordinary article now returns an explicit
  `checked: true` negative rather than falling through to the shared bottom
  return.
- `checked` is false when **any** source went unread, even if the other
  answered: retraction is a positive-detection problem, so an unread index is a
  real chance of a missed retraction.

### Not changed
- `checkRetraction`'s signature. This library is consumed by SciMeto through the
  barrel `src/index.ts`, so the published shape is added to, never broken.

### Verified
Watched **RED first, on the real module**: with only the two defective lines
restored (the new types kept, so the failure is in the assertions and not in
compilation), exactly the 5 defect-detecting tests fail while the 4 controls —
clean answer, 404-is-an-answer, a real retraction found, a retraction still
found while the other index is rate-limited — keep passing. Restored: 9/9.
Full suite 132/132 across 11 files, `tsc --noEmit` clean.

**Note for whoever runs these:** `npx jest` cannot run this repository's tests
at all (`TS1378: top-level await`); only `npm test`, which sets
`--experimental-vm-modules`, works. That is pre-existing and applies to the
0.1.2 Expression-of-Concern tests too.

## 0.1.2 — 2026-08-21

**A rate-limited Expression-of-Concern lookup reported as "clean".** Every source
function returned `ExpressionOfConcernIssue | null`, and `null` meant all of: no
expression of concern, DOI not found, HTTP 429, 5xx, and timeout. A caller could
not tell *"we asked and there is nothing"* from *"we never got an answer"*, so a
Crossref rate-limit storm rendered an entire bibliography clean.

Measured downstream on the Scimeto platform, 2026-08-21: a single real document
run logged **81 Crossref 429s** while its Expression-of-Concern plugin recorded
`outcome: completed, issuesFound: 0, referencesChecked: 56`. The user was shown an
all-clear over references nobody had successfully looked up.

### Added
- `checkReferenceForEOCDetailed(reference)` → `EocReferenceResult`, reporting
  `issues`, `sourcesChecked`, `sourcesUnavailable` and `complete`. Prefer it
  anywhere the result reaches a user: `issues: []` with `complete: false` is not
  an all-clear, and only this signature can say so.
- `EocSourceOutcome`, a discriminated `clean | issue | unavailable` per source,
  with `EocUnavailableReason` = `rate_limited | timeout | server_error | network`.

### Changed
- A **404 is still `clean`** — the source was reached and holds no record. Only
  429 / 5xx / timeout / network failures are `unavailable`. That boundary is the
  whole point: one of them is an answer and the other is silence.
- `checkReferenceForEOC` keeps its exact previous signature and returns
  `result.issues`, so existing callers are unaffected.

### Tests
- 11 new offline tests (`tests/expressionOfConcern/eocCoverage.test.ts`) mocking
  axios, because the pre-existing suite hits the live APIs and cannot express
  "and now Crossref rate-limits you". Verified by restoring the 0.1.1 semantics
  (429 → clean) and watching four of them go red. Suite 112 → 123.


## 0.1.1 — 2026-06-08

Deterministic-core hardening (via the platform's hardening workflow). The pure-logic core
(DOI shape, Beall's matching, dedup similarity, reference validation) previously
had **zero** standalone test coverage; this release fixes three correctness bugs
and adds 37 unit tests. Suite 75 → 112.

### Fixed
- **Predatory false positive (D3, integrity-critical).** `checkBeallsList` /
  `isKnownLegitimate` used raw substring matching (`a.includes(b) || b.includes(a)`),
  so a legitimate publisher was branded predatory on a partial-word overlap —
  e.g. "SciTechnology Publications" matched the Beall's entry "SciTechnol". Now
  uses whole-word, order-preserving token-sequence containment with a
  generic-word guard, preserving distinctive single-word and short-form matches
  while eliminating partial-word hits.
- **Whitespace / Unicode in publisher matching (D4).** Folded into the D3 fix:
  tokenization collapses irregular whitespace and keeps accented / non-Latin
  letters instead of relying on exact substring equality.
- **Asymmetric author similarity (D9).** `compareAuthors` averaged best-matches
  over the first list only, so `compareAuthors(a, b) !== compareAuthors(b, a)`
  whenever the lists differed in length — making dedup similarity depend on pair
  ordering. Now averages both directions (commutative).
- **Non-Latin author detection (D6).** `isValidReference`'s author-pattern
  fallback regex was ASCII + Latin-1 only; Cyrillic / Greek-authored references
  lost their "author" indicator. Now Unicode-aware (`\p{Lu}`/`\p{Ll}`).

### Notes (triaged, intentionally unchanged)
- `crossref.ts` final `return` is reachable for the TypeScript control-flow
  analyzer (nested try/catch + rethrow) — kept, not dead code.
- `selectBestReference` throwing on an empty array is intended defensive
  behavior; its only caller guards `length > 1`. Documented with a contract test.
- `doi/doiShape.ts` is a deliberate verbatim copy of the worker's
  `entityOwnership.ts` helpers — behavior-pinned with tests, not modified.

## 0.1.0

- Initial behavior-preserving extraction from the Scimeto platform.
