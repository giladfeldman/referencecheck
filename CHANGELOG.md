# Changelog

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
- **The title heuristic is now a case-sensitive publisher-marker prefix**
  (`RETRACTED…`, `RETRACTED ARTICLE…`, `WITHDRAWN…`) instead of a
  `title.includes('retract')` substring test. On a 14-work corpus of genuinely
  retracted papers drawn from Crossref's own `update-type:retraction` filter,
  `updated-by` caught **14 of 14** while a capitalised title marker appeared on
  only **9 of 14** — the heuristic is a supplement, never the rule.
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

### Changed — read this before upgrading

**OpenRetractions is no longer consulted by default.** `api.openretractions.com`
does not resolve: `EAI_AGAIN` on both `api.openretractions.com` and
`openretractions.com`, measured 2026-09-12, while `api.crossref.org` resolved on
the same call. Combined with the strict completeness rule above, leaving it in
the default list would mark **every** lookup incomplete forever — an alarm that
fires on every reference tells a reader nothing and would drown the genuine
Crossref failures it exists to surface.

It costs no coverage: Crossref now relays the same Retraction Watch data and
detected 14 of 14 in the corpus above. The source is **not deleted** — pass
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
