<!-- seat=sonnet provider=anthropic verdict=OK seconds=445.1 attempts=1 -->

## Verification

Token: `CONSULT-0AD35B13EB68-SONNET`

- `tests/retraction/retractionDetection.test.ts:71` — verbatim:
  `  it('CALIBRATION: detects a retraction whose title contains no retraction marker', async () => {`
- `src/openAccess/index.ts:5` — verbatim:
  `export type { OpenAccessIssue } from './openAccessFinderService.js';`

## Findings

**Questions checked:** all five, against `retractionChecker.ts`, both test files, all six fixtures, plus live Crossref API queries I ran today (2026-09-12) — not just the brief's cited measurements.

**1. CONFIRMED — false clean on a real, currently-live DOI (answers Q4).**
`src/retraction/retractionChecker.ts:186-196` (`findRetractionRelation`) and `:176` (title regex). Crossref's `type: "withdrawal"` is a real, populated `updated-by` entry type — 3,394 works under `filter=update-type:withdrawal` as of today — that matches neither `type === 'retraction'` nor the label substring `"retract"`. The title fallback also only matches the word "WITHDRAWN," not "Withdrawal."
Concrete failing input, fetched live today: DOI `10.1016/j.crad.2024.02.007` — `updated-by: [{type: "withdrawal", label: "Withdrawal", ...}]`, title `"Withdrawal notice to 'Relationship between coronary microvascular dysfunction (CMD)...' ClinRad Volume 79, Issue 7, July 2024, Pages 536-543"`. Neither check fires; the function falls through to `{isRetracted: false, checked: true}` for a genuinely withdrawn paper. I hand-traced this real fetched JSON through the source rather than running the compiled library, so the exact runtime output is one step short of fully verified. Suggested fix (not applied): treat `type === 'withdrawal'` as equivalent to `'retraction'`, and extend the title regex the same way the code already treats WITHDRAWN as a RETRACTED synonym.

**2. PLAUSIBLE, minor — non-deterministic `retractionDate`/`retractionReason` under multiple qualifying entries.**
`retractionChecker.ts:189-195`. `.find()` takes the first array match; Crossref doesn't guarantee ordering. Verified live: DOI `10.1007/s11277-021-09072-0` has two `type: "retraction"` entries (retraction-watch, 2022-12-06, first; publisher, 2021-09-11, second) — the earlier publisher date is silently discarded. A more consequential variant on DOI `10.33552/ojdoh.2018.01.000503` (looks like a publisher placeholder/test record) returns "Partial retraction" as the reason even though a full `retraction` entry exists later in the same array; `isRetracted` stays correct but severity is understated.

**3. UNVERIFIED hypothesis, low severity — latent gap if a resolved response is ever non-200.**
`retractionChecker.ts:284-287` and `:238-240` guard on `response.status === 200` before recording a source as checked, implying that path is reachable. Today it isn't — `crossrefGet` (`src/http/crossref.ts:75`) uses axios's default `validateStatus`, which throws on any non-2xx, so a resolved response is always 200. But nothing enforces that at the call site; if a future change relaxed `validateStatus`, a resolved non-200 would skip both `sourcesChecked` and `sourcesUnavailable`, and `checked` would wrongly compute `true`. Not reproduced — would require editing `crossrefGet`, out of scope for read-only review.

**Per-question disposition:** Q1 — real gap (finding 1) + minor ordering issue (finding 2); `update-to` non-use confirmed correct; no evidence Crossref's separate `relation` object ever carries retraction data (empty on all ~50 live records sampled, but that doesn't rule it out elsewhere). Q2 — the brief's own flagged entity-encoded title does *not* break the regex; finding 1 is the real title-side gap. Q3 — `checked`/`complete` logic and the 404-path are correct and tested; OpenRetractions-unreachable rationale reconfirmed live today; finding 3 is the only (unverified) concern. Q4 — answered by finding 1; no concrete false-RETRACTED input found. Q5 — tests assert behavior on verbatim fixtures; no realism concerns beyond the (genuine) double-encoded title.

Full detail, evidence, and fix direction saved to `<local path>`. No files under review were modified.
