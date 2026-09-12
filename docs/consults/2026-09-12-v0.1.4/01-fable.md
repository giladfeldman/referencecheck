<!-- seat=fable provider=anthropic verdict=OK seconds=437.2 attempts=1 -->

Probing is complete. Writing up the findings now.

## Verification

`CONSULT-0AD35B13EB68-FABLE`

`tests/retraction/retractionDetection.test.ts` line 71:
```
  it('CALIBRATION: detects a retraction whose title contains no retraction marker', async () => {
```
`src/openAccess/index.ts` line 5:
```
export type { OpenAccessIssue } from './openAccessFinderService.js';
```

## Scope

All five questions were checked against the code at commit 91d11c8, the six recorded fixtures, and the live Crossref API on 2026-09-12. Every "false clean" and "false retracted" below was reproduced by calling the **compiled v0.1.4 library** (`dist/retraction/retractionChecker.js`, which contains the `updated-by` code) against live Crossref, not by a reimplementation. Read-only throughout.

Brief measurements re-tested: `updated-by` absent on healthy controls and present with `source: "retraction-watch"` on retracted ones (confirmed); `update-to` on the LaCour notice, no `updated-by` (confirmed from the fixture and live); `filter=type:retraction` HTTP 400 and no `retraction` id in `/types` (confirmed); both OpenRetractions hosts `EAI_AGAIN` while `api.crossref.org` resolved on the same call (confirmed). The 14-of-14 and 9-of-14 corpus numbers were not reproduced, see F7.

## Findings: 8

### F1. False CLEAN: `updated-by` entries of type `withdrawal` and `removal` are ignored (Q1, Q4)

`src/retraction/retractionChecker.ts:192`
```
        u?.type === 'retraction' ||
```
Crossref serves these as first-class update types on the queried work: `filter=update-type:withdrawal` returns 3,394 notices and `update-type:removal` 699. The target records carry `{"type":"withdrawal","label":"Withdrawal"}` / `{"type":"removal","label":"Removal"}`; neither label contains "retract", so the selector at :192-193 skips them and the result falls through to the clean return at :347. Compiled v0.1.4, live:

| DOI | What it is | v0.1.4 result |
|---|---|---|
| 10.1002/14651858.cd009522 | withdrawn Cochrane review | clean, `checked: true`, `complete: true` |
| 10.2514/6.2018-2123 | withdrawn AIAA paper, plain title | clean, `checked: true` |
| 10.1016/j.asr.2025.03.045 | Elsevier "REMOVED:" article, `updated-by` removal | clean, `checked: true` |

`partial_retraction` is caught only by accident of the label fallback ("Partial retraction" contains "retract"); no test pins it. Whether a withdrawal should render as "retracted" is a product decision, but rendering it as a checked clean is a false clean under any policy. Minimum fix: surface the update type in the result and let the consumer decide.

**Would refute:** a Crossref work record whose `updated-by` carries `withdrawal`/`removal` that Scimeto's users would legitimately cite as healthy. The Cochrane case argues the opposite.

### F2. False RETRACTED, and inconsistent with F1: a "WITHDRAWN" title is reported as a retraction, including withdrawn PsyArXiv/OSF preprints (Q2, Q4)

`src/retraction/retractionChecker.ts:176`
```
const RETRACTION_TITLE_MARKER = /^\s*(?:RETRACTED|WITHDRAWN)\b/;
```
A withdrawal in `updated-by` is clean (F1) but the same word in the title returns `isRetracted: true`. Live `filter=type:posted-content&query.title=WITHDRAWN`: 100 hits, 97 published by Center for Open Science, all titled exactly "WITHDRAWN", none with `updated-by`. Compiled v0.1.4: `10.31234/osf.io/etvnm_v1` (PsyArXiv) → `isRetracted: true, reason: "Title carries a publisher retraction marker"`. OSF preprints are routinely withdrawn because the paper was published; the author of a psychology bibliography will be told a citation was retracted. The result shape has no field to say "withdrawn, not retracted".

**Would refute:** evidence that OSF's "WITHDRAWN" is reserved for misconduct, or that Scimeto's report already renders the `retractionReason` string so the reader can tell.

### F3. False CLEAN with `checked: true` on a Crossref 404 (Q3, Q4)

`src/retraction/retractionChecker.ts:152`
```
  if (status === 404) return null; // answered: not in this index
```
and `:334` `      else sourcesChecked.push('crossref');`. That comment is true of OpenRetractions, which is an index. It is false for Crossref: `/works/{doi}` 404 means the DOI is not a Crossref DOI at all. Compiled v0.1.4, live: `10.5281/zenodo.3242591` (DataCite) → clean, `checked: true`, `sourcesChecked: ["crossref"]`; `10.1126/science.1256151x` (LaCour with a typo) → identical. A mistyped DOI for a retracted paper is reported as a checked clean. A 404 should be a distinct outcome ("not a Crossref work"), not membership in `sourcesChecked`.

**Would refute:** a Crossref 404 body that says the work exists but has no updates. It says "Resource not found".

### F4. False CLEAN: `checked`/`complete` are true when no source was consulted at all (Q3, Q4)

`src/retraction/retractionChecker.ts:349`
```
    checked: sourcesUnavailable.length === 0,
```
and `:381`. Compiled v0.1.4: `checkRetractionDetailed('10.1126/science.1201068', { sources: [] })` on the retracted Stapel paper returns `{"isRetracted":false,"checked":true,"sourcesChecked":[],"complete":true}`. The same gap covers the non-200 branch at `:285` (`if (crossrefResponse.status === 200)`): a 2xx that is not 200 pushes to neither array and returns a checked clean. `checked` should additionally require `sourcesChecked.length > 0`. The type allows an empty list and Scimeto is an external caller.

**Would refute:** a runtime guard on `sources` that I missed. There is none between :216 and :354.

### F5. False CLEAN: publisher title markers the prefix regex does not match, on records with no `updated-by` (Q2, Q4)

`src/retraction/retractionChecker.ts:176` (line quoted in F2). Live survey of 1,000 Crossref titles containing "retract" (pub date ≥ 2020), leading-marker forms:

| Leading form | Count | Matched by regex |
|---|---|---|
| `[RETRACTED]` | 659 | no (bracket) |
| `RETRACTED:` | 95 | yes |
| `Retracted` (no colon) | 93 | no |
| `Retracted:` | 71 | no |
| `RETRACTED` (bare) | 30 | yes |

The `[RETRACTED]` mass is mostly protocols.io and small publishers. The case that reaches a real bibliography is IEEE: of 40 prefix-10.1109 records titled "Retracted: …", 40 have no `update-to` (they are the papers, not notices) and 39 have no `updated-by`. Compiled v0.1.4: `10.1109/icaccs60874.2024.10717184` → clean, `checked: true`. Spandidos "[Retracted] …": 8 of 40 are the article itself with no `updated-by`; `10.3892/ol.2018.7943` → clean. Elsevier's `REMOVED:` and Wiley's `EXPRESSION OF CONCERN:` prefixes are also unmatched. HTML-entity prefix from the brief (`10.4236/fns.2013.46a006`) is fine: the marker precedes the markup and `updated-by` catches it anyway.

Two-sided control for keeping case sensitivity: "Retracted Distributions" (`10.1002/0471667196.ess3082`, a statistics entry) and "Retracted Publications in the Drug Literature" are healthy and correctly clean. A marker requiring a colon or brackets (`^\s*\[?(?:RETRACTED|Retracted|WITHDRAWN)(?:\s+ARTICLE)?\]?\s*:` or `^\s*\[(?:RETRACTED|Retracted)\]`) catches IEEE/Spandidos/Hindawi and still excludes both healthy forms. Hypothesis: I found no healthy title beginning "Retracted:" or "[Retracted]" in the sample, but did not inspect all 1,000.

**Would refute:** a healthy paper whose title begins `Retracted:` or `[Retracted]`.

### F6. Wrong number: `retractionDate` on the title path is the paper's publication date (Q4)

`src/retraction/retractionChecker.ts:321`
```
            retractionDate: message.published?.['date-parts']?.[0]?.join('-'),
```
Compiled v0.1.4 on `10.1016/j.adengl.2021.11.027` returns `retractionDate: "2021-11"`; the record's own `updated-by` withdrawal is dated 2021-11-29. On `10.31219/osf.io/49zsc_v1` it returns the preprint's posting date. A field called retraction date carrying the publication date goes into the Word report. It should be `undefined` on this path.

**Would refute:** nothing; it is by construction.

### F7. Method: the 14-of-14 coverage figure is circular (Q1)

`src/retraction/retractionChecker.ts:40-42`
```
 * 1. On a 14-work corpus of genuinely retracted papers drawn from Crossref's own
 *    `update-type:retraction` filter, `updated-by` carried a retraction entry on
 *    **14 of 14**
```
A corpus selected by Crossref's update filter has a Crossref update relation by construction, so it cannot measure what `updated-by` misses. Independent check on eight well-known retractions not drawn from the filter (Mehra Lancet and NEJM, both STAP papers, Stapel 2011, both Hwang papers, Séralini 2012): `updated-by` retraction on 8 of 8, title marker on only 5 of 8. So the conclusion holds for high-profile cases, and F5 shows the long tail where it does not. The header should state the selection and label coverage as partial. The 9-of-14 title figure is consistent with everything measured but was not reproduced.

**Would refute:** any retracted work lacking `updated-by`; F5 lists several.

### F8. Tests (Q5)

- `tests/retraction/retractionDetection.test.ts:53`
  ```
  const openRetractionsSilent = () => axiosGetMock.mockRejectedValue(httpError(404));
  ```
  Dead under the default source list: axios is never called (the coverage suite's own assertion at `:285` proves it). Harmless, but its comment claims it makes Crossref the thing under test. Misleading, not wrong.
- `tests/retraction/retractionDetection.test.ts:96` "still detects the CAPS-titled retraction" passes through `updated-by` (Wakefield carries one), so **the title fallback has zero test coverage on any recorded body**. None of the six fixtures has title as its only signal. `retractionDetection.test.ts:83` `expect(r.retractionDate).toBe('2015-6-5');` pins an unpadded, non-ISO date format, asserting implementation.
- No test covers: `withdrawal`/`removal`/`partial_retraction` in `updated-by`, Crossref 404, `sources: []`, the title-path date, bracketed/title-case markers, or a withdrawn preprint. Fixture realism is fine: all six are verbatim and match live Crossref today.

## Answers to the five questions in one line each

1. `updated-by` by `type === 'retraction'` is correct for retraction and not reading `update-to` is right (Spandidos notices: 32 of 32 targets detected via `updated-by`). It is not complete: `withdrawal` and `removal` are missed (F1). `relation` was `{}` and `assertion` absent on every record inspected, so no alternative shape found (hypothesis: none exists).
2. The title regex misses `[RETRACTED]`, `Retracted:`, `REMOVED:` (F5) and over-reports `WITHDRAWN` preprints (F2). Entity markup after the marker is harmless.
3. Dropping OpenRetractions is sound today (DNS re-confirmed dead). `complete: true` from Crossref alone is defensible only if Crossref 404 and an empty source list stop counting as "checked" (F3, F4).
4. Concrete inputs: F1 `10.1002/14651858.cd009522`, F3 `10.5281/zenodo.3242591`, F4 `{ sources: [] }`, F5 `10.1109/icaccs60874.2024.10717184` (all false clean); F2 `10.31234/osf.io/etvnm_v1` (false retracted).
5. F8.
