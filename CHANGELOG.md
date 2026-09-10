# Changelog

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
