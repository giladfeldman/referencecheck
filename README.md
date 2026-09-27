# referencecheck

Reference-integrity checks for academic papers, in TypeScript. Given the references of a
manuscript, referencecheck asks public scholarly databases what is known about each one:

| Check | Question | Source |
|---|---|---|
| DOI validation | Does this DOI exist? Which DOI does this reference text belong to? | Crossref, doi.org |
| Retraction | Has the work been retracted, partially retracted, removed or withdrawn? | Crossref `updated-by` (which relays Retraction Watch data); OpenRetractions opt-in |
| Expression of concern | Has a journal published an expression of concern or correction about it? | Crossref, Europe PMC |
| Replies and errata | Is there an erratum, an author reply, a comment, or is this itself a response? | Crossref relations |
| Preprint status | Is this a preprint rather than the published version, or does it have one? | DOI prefixes, URLs, Crossref |
| Open access | Is there a free, legal copy? | Unpaywall |
| Citation count | How often has it been cited, and by what? | OpenCitations |
| Predatory journal screening | Is the journal or publisher on Beall's List, in DOAJ, or does its name show predatory markers? | bundled Beall's List snapshot, DOAJ, OpenAlex, name heuristics |
| Duplicate references | Does the list cite the same work twice? | local fuzzy matching (no network) |
| DOI shape | Is this string shaped like a DOI or a shortDOI, and what does a shortDOI expand to? | local; doi.org for expansion |

Everything is plain functions: no database, no framework, no plugin lifecycle. Contact
addresses for the services' polite pools are passed in as parameters (`MetadataCredentials`).

referencecheck was extracted from the Scimeto manuscript-checking platform so that the
community can inspect, validate and reuse it. Accuracy work is ongoing and every release is
described, with its measurement, in [CHANGELOG.md](./CHANGELOG.md).

**Contents:** [Method](#method) · [Install](#install) · [Quickstart](#quickstart) ·
[API overview](#api-overview) · [Reading the results](#reading-the-results) ·
[Configuration](#configuration) · [Limitations](#limitations-and-failure-modes) ·
[Maintainer scripts](#maintainer-scripts) · [How to cite](#how-to-cite) ·
[Contributing](#contributing) · [License](#license) · full reference in
[docs/API.md](./docs/API.md)

## Method

referencecheck does not judge papers itself; it reports what authoritative registries have
recorded, and says when it could not find out.

- **Retractions** come from Crossref's `updated-by` relations. Publishers deposit retraction,
  partial-retraction, removal and withdrawal notices there, and Crossref relays the Retraction
  Watch database into the same field (entries carry `source: "retraction-watch"`). A title
  marker such as `RETRACTED:` is a fallback for works whose `updated-by` is empty. OpenRetractions
  is implemented but off by default because its host stopped resolving (see
  [CHANGELOG 0.1.4](./CHANGELOG.md)).
- **Open access** status comes from Unpaywall, described in Piwowar et al. (2018),
  https://doi.org/10.7717/peerj.4375.
- **Citation counts and citing works** come from the OpenCitations Index, described in
  Peroni & Shotton (2020), https://doi.org/10.1162/qss_a_00023.
- **Journal metadata** falls back to OpenAlex, described in Priem, Piwowar & Orr (2022),
  https://doi.org/10.48550/arXiv.2205.01833.
- **Predatory-journal screening** combines four signals: the bundled snapshot of Beall's List
  (102 publishers, last maintained January 2017), a list of 30 known legitimate publishers,
  the Directory of Open Access Journals (DOAJ), and keyword heuristics on the journal name.
  The list is a historical snapshot; treat a hit as a prompt to look, not a verdict.
- **Duplicate detection** is a weighted similarity of normalised authors, title (Levenshtein
  distance) and year, grouped by transitive closure.

Every network check distinguishes **"checked, nothing found"** from **"could not check"** where
its return type allows it: `checkRetractionDetailed` and `checkReferenceForEOCDetailed` return
`complete: false` and name the sources that did not answer. Use those in anything a person
reads.

## Install

referencecheck is distributed as a **git-tag dependency**, not through the npm registry. Pin a
tag:

```jsonc
// package.json
"dependencies": {
  "referencecheck": "github:giladfeldman/referencecheck#v0.1.7"
}
```

or from the command line:

```bash
npm install github:giladfeldman/referencecheck#v0.1.7
```

npm clones the repository and runs the `prepare` script, which compiles `dist/` and copies the
bundled Beall's List data into it, so a tag pin installs a working build with no registry
involved. Always pin an explicit tag: a bare `github:giladfeldman/referencecheck` floats on the
default branch. The `files` field in `package.json` is kept ready for a possible future
registry publish and has no effect on the git-tag install.

Requirements: Node.js 18 or later; ES modules only (`"type": "module"`). Runtime dependencies:
`axios` and `fastest-levenshtein`. The package root and the files under `referencecheck/dist/*`
are exported; import from the root.

## Quickstart

Save a block as `quickstart.mjs` in a project where referencecheck is installed and run
`node quickstart.mjs`. The first block needs no network:

```js
import {
  isMalformedDoi, isShortFormDoi, detectKnownPreprintFromDoi,
  calculateSimilarity, findDuplicateGroups,
  checkBeallsList, checkHeuristics, determineVerdict, loadBeallsList,
} from 'referencecheck';

// DOI shape (local)
console.log(isMalformedDoi('10.1037/'), isMalformedDoi('10.1037/xge0000123'), isShortFormDoi('10/gt3vmw'));
console.log(detectKnownPreprintFromDoi('10.31234/osf.io/abcde'));

// Duplicate references (invented records)
const a = { id: 'a', raw_text: 'Alder, J. (2019). Example effects. Journal of Examples.',
  normalized_authors: ['alder j'], normalized_title: 'example effects', normalized_year: '2019' };
const b = { id: 'b', raw_text: 'Alder J. 2019. Example effect. J Examples.',
  normalized_authors: ['alder j'], normalized_title: 'example effect', normalized_year: '2019' };
const similarity = calculateSimilarity(a, b, { threshold: 0.85, authorWeighting: 0.4, titleWeighting: 0.4 });
console.log(similarity.toFixed(3));
console.log(findDuplicateGroups([{ ref1: a, ref2: b, similarity }]).map((g) => [g.references.length, g.bestReference.id]));

// Predatory-journal screening from the bundled list and name heuristics
const publisher = loadBeallsList().publishers[0];
const heuristics = checkHeuristics('International Journal of Rapid Publication', { heuristicSensitivity: 'medium' });
const verdict = determineVerdict(checkBeallsList(publisher), { found: false }, heuristics, publisher);
console.log(verdict.status, verdict.source, verdict.confidence);
```

Output (v0.1.7):

```text
true false true
PsyArXiv
0.973
[ [ 2, 'a' ] ]
predatory bealls_list 0.9
```

The second block calls Crossref, doi.org and OpenCitations. Set `CROSSREF_EMAIL` to your own
contact address so the requests are attributed to you:

```js
// requires network
import { checkRetractionDetailed, validateDOI, expandShortDoi, getCitationCount } from 'referencecheck';

const creds = { crossrefEmail: process.env.CROSSREF_EMAIL };
const doi = '10.1016/S0140-6736(97)11096-0';

const { retraction, complete, sourcesUnavailable } = await checkRetractionDetailed(doi, { creds });
if (!complete) console.log('could not check:', sourcesUnavailable);
console.log(retraction.isRetracted, retraction.retractionType, retraction.retractionDate, retraction.sourcesChecked);

const v = await validateDOI(doi, creds);
console.log(v.valid, v.source, v.data?.journal);
console.log(await expandShortDoi('10/gt3vmw', { creds }));
console.log(await getCitationCount(doi));
```

Output when run on 2026-09-27 (live data; the citation count changes over time):

```text
true retraction 2010-2-6 [ 'crossref' ]
true crossref The Lancet
{
  expanded: true,
  doi: '10.1111/ECIN.13244',
  reason: 'expanded',
  status: 301
}
2356
```

`npm run docs:check` executes the first block against a fresh build on every run;
`npm run docs:check -- --online` runs both.

## API overview

Every name below is exported from the package root. Signatures, every field and every code
are in **[docs/API.md](./docs/API.md)**.

| Area | Functions |
|---|---|
| DOI validation and lookup | `validateDOI(doi, creds?)`, `validateMultipleDOIs(dois, creds?)`, `findDOIFromReference(referenceText, creds?)` |
| DOI shape and shortDOIs | `isMalformedDoi(doi)`, `isShortFormDoi(doi)`, `expandShortDoi(doi, options?)`, `readExpansionTarget(location)`, `clearShortDoiCache()` |
| Retraction | `checkRetractionDetailed(doi, options?)` (preferred), `checkRetraction(doi, options?)`, `checkMultipleRetractions(dois, options?)`, `DEFAULT_RETRACTION_SOURCES` |
| Expression of concern | `checkReferenceForEOCDetailed(reference)` (preferred), `checkReferenceForEOC(reference)`, `getEocSeverityCounts(issues)` |
| Replies and errata | `checkReferenceForReplies(reference)`, `getRepliesSummary(issues)` |
| Preprints | `checkReferenceForPreprint(reference)`, `detectKnownPreprintFromDoi(doi)`, `detectKnownPreprintFromText(text)`, `getPreprintSummary(issues)` |
| Open access | `checkReferenceForOpenAccess(reference)`, `getOpenAccessSummary(issues)` |
| Citations | `getCitationCount(doi)`, `getCitingWorks(doi)` |
| Predatory journals | `extractJournalMetadata(reference, useOpenAlex?, creds?)`, `isValidReference(reference)`, `loadBeallsList()`, `checkBeallsList(publisher)`, `isKnownLegitimate(publisher)`, `checkDOAJ(issn)`, `searchOpenAlexByJournalName(journalName, creds?)`, `resolveOpenAlexByDOI(doi, creds?)`, `getOpenAlexEmail(creds?)`, `checkHeuristics(journalName, config)`, `determineVerdict(beallsResult, doajResult, heuristicsResult, publisher?)` |
| Deduplication | `calculateSimilarity(ref1, ref2, config)`, `compareAuthors(authors1, authors2)`, `compareTitle(title1, title2)`, `compareYear(year1, year2)`, `normalizeAuthorName(name)`, `scoreMetadataCompleteness(ref)`, `findDuplicateGroups(pairs)`, `selectBestReference(refs)` |
| HTTP helpers | `crossrefGet(url, config?, creds?)`, `getCrossrefUserAgent(creds?)`, `formatError(error, context?)`, `DEFAULT_POLITE_EMAIL` |

The per-reference checks take a `ReferenceInput`: `{ id, raw_text, doi?, suggested_doi?,
doi_crossref_data?, parsed_data?, normalized_authors?, normalized_title?, normalized_year?,
url? }`. Only `id` and `raw_text` are required; each check reads the fields it needs (most
use `doi`, falling back to `suggested_doi`). A reference with no DOI is skipped by the DOI-based
checks.

## Reading the results

- **Retraction:** `isRetracted: true` means "pulled from the literature, do not cite it as an
  ordinary reference" and covers `retraction`, `partial_retraction`, `removal` and
  `withdrawal`. **Read `retractionType` before using the word "retracted"** in anything a
  person reads: a withdrawn preprint is not a retracted paper. `isRetracted: false` is only a
  clean answer when `checked` is `true`.
- **Coverage:** `checkRetractionDetailed` and `checkReferenceForEOCDetailed` return
  `complete` and `sourcesUnavailable` (`reason`: `rate_limited`, `timeout`, `server_error`,
  `network`, and for retractions `not_indexed`). An empty result with `complete: false` means
  "we did not find out".
- **Issues:** the per-reference checks return issue objects with `type`, `severity`, `code`,
  `description`, `location`, `suggestion` and `metadata`. The codes are `IS_PREPRINT`,
  `HAS_PREPRINT_VERSION`, `OA_AVAILABLE`, `EOC_DETECTED`, `CORRECTION_NOTICE`, `EOC_PUBMED`,
  `HAS_ERRATA`, `HAS_AUTHOR_REPLY`, `HAS_COMMENTS` and `IS_RESPONSE`
  ([what each means](./docs/API.md#issue-codes)).
- **Predatory verdict:** `determineVerdict` returns `status` (`legitimate`, `predatory`,
  `unknown`), the deciding `source` (`bealls_list`, `doaj`, `heuristics`, `combined`), a
  `confidence`, a plain-language `reasoning`, and the `sources` that contributed.
- **shortDOI expansion:** `expandShortDoi` never returns a bare failure; `reason` is one of
  `expanded`, `not-short-form`, `not-registered`, `malformed`, `no-redirect`, `off-resolver`,
  `unexpanded-target`, `network-error`.

## Configuration

**Credentials.** Crossref and OpenAlex give better service to requests that carry a contact
address (their "polite pool"). Pass yours:

```ts
const creds: MetadataCredentials = { crossrefEmail: myContactAddress, openAlexEmail: myContactAddress };
await validateDOI(doi, creds);
await checkRetractionDetailed(doi, { creds, sources: ['crossref'] });
await extractJournalMetadata(reference, true, creds);
```

Without them the requests use the library's default contact address, `DEFAULT_POLITE_EMAIL`.
Not every check takes credentials: the preprint, expression-of-concern and replies checks use
the default Crossref identity, and the open-access check uses a fixed Unpaywall contact
address. The library has no API keys and needs none.

**Environment variables.** The library itself reads one: `NODE_ENV`. When it is
`development`, `formatError` appends the first lines of an error's stack trace to the message.
Credentials are never read from the environment by the library; read them in your own code
and pass them in, as the quickstart does with `CROSSREF_EMAIL`. The
[maintainer scripts](#maintainer-scripts) read `CROSSREF_EMAIL`, `PROBE_HOST` and
`PROBE_CONTROL`.

**Retraction sources.** `DEFAULT_RETRACTION_SOURCES` is `['crossref']`. Pass
`{ sources: ['openretractions', 'crossref'] }` to consult OpenRetractions as well.

**Deduplication weights.** `calculateSimilarity` takes a `DeduplicationConfig`
`{ threshold, authorWeighting, titleWeighting }`; the year weight is
`1 - authorWeighting - titleWeighting`. The library does not apply `threshold` itself: compare
the returned similarity with it and pass the pairs above it to `findDuplicateGroups`.

**Heuristic sensitivity.** `checkHeuristics(journalName, { heuristicSensitivity })` with
`low`, `medium` (default) or `high`.

## Limitations and failure modes

- **Registries only know what was deposited.** A retraction whose publisher never deposited a
  notice, and whose title carries no marker, is not detected. Coverage is good, not total.
- **Side effects:** the network checks write progress and failure messages to `console.log`,
  `console.warn` and `console.error`. `validateDOI` (30 minutes) and `expandShortDoi` (24 hours)
  keep in-memory caches; `clearShortDoiCache()` empties the second.
- **Several checks cannot say "could not check".** `checkReferenceForOpenAccess`,
  `checkReferenceForPreprint`, `checkReferenceForReplies`, `checkReferenceForEOC`,
  `getCitationCount` (returns `null`) and `getCitingWorks` (returns `[]`) return the same
  value on a network failure as on a clean answer. `checkDOAJ` returns `{ found: false }` on a
  network failure too, which `determineVerdict` reads as "not in DOAJ".
- **The expression-of-concern `KnownList` source is not implemented.** It always reports clean,
  so it is listed in `sourcesChecked` without having checked anything; the two real sources
  are Crossref and Europe PMC (reported as `PubMed`).
- **Beall's List is a 2017 snapshot.** If the bundled file cannot be read, `loadBeallsList`
  logs an error and returns an empty list, so every publisher then reads as "not listed".
- **Declared but unused fields.** `PluginConfig.useBeallsList`, `useDOAJ`, `useHeuristics`,
  `useOpenAlex` and `cacheExpiry`, `ReferenceInput.journal_validation_checked_at`, the open-access
  statuses `bronze` and `closed`, and the reply type `correction` exist in the types but no
  function reads or produces them. `DeduplicationIssue` and `DeduplicationResults` are result
  shapes for a caller's own report; no function returns them.
- **`isMalformedDoi` checks shape only.** `10.1037/0` is well-shaped and returns `false` even
  though it is truncated.
- **Rate limits.** `crossrefGet` retries 429, 502, 503 and 504 responses (3 attempts in all;
  a 429 honours `Retry-After`, at most 30 s per wait); the batch helpers work in groups of 5
  with a 1 s pause between groups. Only Crossref requests are retried.

## Maintainer scripts

Not part of the installed package; run them from a clone.

| Command | Purpose |
|---|---|
| `npm run build` | compile `dist/` and copy the bundled data (`scripts/copy-data.mjs`) |
| `npm test` | the offline Jest suite (every transport is mocked) |
| `npm run docs:check` | the documentation-drift gate (see [CONTRIBUTING.md](./CONTRIBUTING.md)) |
| `node scripts/live-check.mjs [--verbose]` | the compiled library against the live APIs on recorded DOIs. Exit 0 = all matched, 1 = a mismatch (a real defect), 2 = could not verify. Reads `CROSSREF_EMAIL` |
| `node scripts/openretractions-probe.mjs` | is the OpenRetractions host back? A successful probe is the signal to revisit `DEFAULT_RETRACTION_SOURCES`. Reads `PROBE_HOST` and `PROBE_CONTROL` (default `api.crossref.org`, the control host) |

## How to cite

If you use referencecheck in research, please cite the software (see
[CITATION.cff](./CITATION.cff)):

> Feldman, G. (2026). *referencecheck: Reference-integrity checks for academic papers*
> (Version 0.1.7) [Computer software]. https://github.com/giladfeldman/referencecheck

Please also cite the data sources your results depend on (see [Method](#method)).

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development setup and the checks a change must pass.

## License

MIT — see [LICENSE](./LICENSE).
