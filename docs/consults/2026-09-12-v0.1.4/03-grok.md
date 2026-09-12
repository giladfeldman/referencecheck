<!-- seat=grok provider=xai verdict=OK seconds=649.1 attempts=1 -->

I'll look up the brief and any existing findings so I can print them exactly as requested.The scratch folder is empty, so I’m searching nearby consult round files and transcripts for the brief and token.This looks like a consult resume turn. I’ll pull the matching Grok brief and any earlier session output so I can print the findings.I’ll pin the cited lines in the retraction checker so the printed findings match the files.## Verification
CONSULT-0AD35B13EB68-GROK
  it('CALIBRATION: detects a retraction whose title contains no retraction marker', async () => {
export type { OpenAccessIssue } from './openAccessFinderService.js';

Questions checked against the code and recorded fixtures: 1, 2, 3, 4, 5. Live Crossref and OpenRetractions DNS were not re-queried here; claims that need a live record not in tests/fixtures/crossref/ are labeled hypothesis.

Finding 1 — Crossref 404 is recorded as a trusted clean
src/retraction/retractionChecker.ts:142-152
 * Classify a thrown request error into "the source answered 'no'" versus
 * "the source never answered". A 404 from either API is a real answer: the DOI
 * is not in that retraction index.
src/retraction/retractionChecker.ts:152
  if (status === 404) return null; // answered: not in this index
src/retraction/retractionChecker.ts:332-334
      const unavailable = classifyRequestFailure('crossref', error);
      if (unavailable) sourcesUnavailable.push(unavailable);
      else sourcesChecked.push('crossref');

OpenRetractions /doi/{doi} 404 means "not in this retraction index". Crossref /works/{doi} 404 means "this work is not in Crossref". The same classifier is used for both.

False CLEAN input: checkRetraction('10.9999/not-in-crossref') when Crossref returns 404 (default sources). Result: isRetracted: false, checked: true, sourcesChecked: ['crossref'], complete: true.

The 404 test in tests/retraction/retractionCoverage.test.ts:123 only covers OpenRetractions 404 plus a Crossref 200 body. Crossref 404 is untested.

Refute: show that every DOI Scimeto will ask about is in Crossref, or add a Crossref-404 fixture and accept "not in Crossref" as a trusted negative. A retracted DataCite-only DOI that 404s on Crossref would make this a true missed retraction.

Finding 2 — updated-by selection is correct for the recorded retraction shape, incomplete for other Crossref update types
src/retraction/retractionChecker.ts:186-193
function findRetractionRelation(message: any): any | null {
  const updatedBy = message?.['updated-by'];
  if (!Array.isArray(updatedBy)) return null;
  return (
    updatedBy.find(
      (u: any) =>
        u?.type === 'retraction' ||
        (typeof u?.label === 'string' && u.label.toLowerCase().includes('retract'))

Verified on recorded bodies: LaCour 10.1126/science.1256151 has updated-by[0].type === "retraction" and no message.update; Wakefield 10.1016/S0140-6736(97)11096-0 has correction at index 0 and retraction at index 1; notice 10.1126/science.aac6638 has update-to type retraction and no updated-by. Not reading update-to as evidence about the queried DOI is correct. All six fixtures have "relation": {} and type journal-article.

Not complete: the matcher does not treat type === 'withdrawal' or type === 'removal', while the title fallback does treat WITHDRAWN (line 176). Same product, two policies. partial_retraction is not === 'retraction'; it is only caught if label contains "retract" (hypothesis, no recorded body). The 14/14 corpus was drawn from filter=update-type:retraction, so it cannot show retractions Crossref does not already mark with that update type.

False CLEAN input (code path; Crossref shape is hypothesis): a work whose updated-by entries are only type "withdrawal" / "removal" with labels that do not contain "retract", and whose title does not match /^\s*(?:RETRACTED|WITHDRAWN)\b/.

Refute: GET https://api.crossref.org/works?filter=update-type:withdrawal&rows=20 (and removal, partial_retraction), then inspect the subject works' updated-by[].type and label.

Finding 3 — Title fallback: the brief's HTML example matches; other real prefixes do not; WITHDRAWN is a false-RETRACTED path
src/retraction/retractionChecker.ts:176
const RETRACTION_TITLE_MARKER = /^\s*(?:RETRACTED|WITHDRAWN)\b/;
Used only after updated-by misses (lines 312-314).

"Retracted Publications in Indian Science: Reasons and Institutions" does not match. Wakefield "RETRACTED: Ileal-lymphoid-nodular hyperplasia..." does match, but that test never exercises the fallback because updated-by already hits. The brief's 10.4236/fns.2013.46a006 title RETRACTED: &amp;lt;i&amp;gt;… would match (entities after the marker). I did not fetch that DOI.

False negatives of the fallback (matter only when updated-by is empty): Retracted: / Withdrawn: (title case); [RETRACTED] …; leading quotes or <i>/&lt;i&gt; before the marker; marker as a suffix.

False RETRACTED input: Crossref 200, title: ["WITHDRAWN: Some preprint"], no retraction updated-by. isRetracted: true, reason "Title carries a publisher retraction marker".

False CLEAN input (fallback-only): Crossref 200, no retraction updated-by, title: ["Retracted: Original title"].

If title fallback fires, retractionDate is message.published (line 321), the original publication date, not a retraction date.

Refute: pull titles for works with updated-by type retraction and for withdrawn preprints; fetch 10.4236/fns.2013.46a006 and quote message.title[0] exactly.

Finding 4 — Dropping OpenRetractions is sound if the host is still dead; default complete: true from one source is then honest and brittle
src/retraction/retractionChecker.ts:105
export const DEFAULT_RETRACTION_SOURCES: readonly RetractionSourceName[] = ['crossref'];
src/retraction/retractionChecker.ts:349
    checked: sourcesUnavailable.length === 0,
src/retraction/retractionChecker.ts:381
    complete: retraction.sourcesUnavailable.length === 0,

I did not re-measure EAI_AGAIN on api.openretractions.com. If that still holds, leaving OpenRetractions in the default list would make every lookup complete: false forever. Residual cost: a Crossref 200 with missing updated-by is now a confident clean (complete: true).

sourcesChecked populated but the answer should not be trusted: Crossref 404 (Finding 1); Crossref 200, no retraction relation, no CAPS prefix, retraction not yet deposited (hypothesis); caller requested both sources and OpenRetractions returned retracted: true immediately:
src/retraction/retractionChecker.ts:242-245
        if (data.retracted === true) {
          return {
            isRetracted: true,
            checked: true,
That path never calls Crossref even when sources includes 'crossref'. Verdict is still retracted (not a false clean); complete is a lie about coverage. Tests pin the asymmetry (retractionCoverage.test.ts:152-164 vs 167-183).

Non-200 Crossref other than 404: 429 / timeout / 5xx correctly go to sourcesUnavailable. A 2xx other than 200 would push neither sourcesChecked nor sourcesUnavailable and still return checked: true with an empty sourcesChecked (hypothesis — Crossref serves 200).

Refute: DNS-lookup both OpenRetractions hosts today next to api.crossref.org. If they resolve and return retraction JSON, dropping them from defaults is a coverage regression while complete: true remains.

Finding 5 — Remaining false CLEAN / false RETRACTED that can still reach a caller
False CLEAN:
1. Crossref 404 on the default path (Finding 1). Input: a DOI Crossref does not have.
2. checkRetraction(doi) during a Crossref 429/timeout: isRetracted: false, checked: false. Any caller that still reads the boolean bare prints a clean bibliography.
3. Retracted article, updated-by missing or only non-retraction types, title not an ALL-CAPS prefix (Findings 2-3). Input: title: ["Retracted: …"] and updated-by absent.
4. Vacuous complete: checkRetraction(doi, { sources: [] }) returns isRetracted: false, checked: true, sourcesChecked: [].

False RETRACTED:
1. title: ["WITHDRAWN: …"] and no retraction relation (Finding 3).
2. updated-by entry whose label contains "retract" but type is not a retraction (hypothesis; no fixture shows this).
3. Control that does not fire: notice 10.1126/science.aac6638 / fixture retraction-notice.json is not flagged, because update-to is ignored.

Finding 6 — Tests pin Crossref's recorded shape well; they assert a dead fallback and skip the 404/WITHDRAWN/HTML cases
Behaviour actually tested: updated-by on a plain-title retraction (LaCour), a second plain-title retraction, type-not-position on Wakefield, healthy paper, healthy "Retracted Publications…" paper, notice not flagged, coverage flags, default source list, creds threading.

Gaps: title fallback is never the sole reason a test passes (Wakefield has both CAPS title and updated-by). No Crossref-404 test. No WITHDRAWN / title-case Retracted: / HTML-prefixed title fixture. retracted-caps-title.json is Wakefield's clean RETRACTED: Ileal-…, not 10.4236/fns.2013.46a006. OpenRetractions payloads in the coverage suite are hand-built, not recorded bodies. expect(r.retractionDate).toBe('2015-6-5') in tests/retraction/retractionDetection.test.ts:83 pins date-parts.join('-') zero-stripping; that is format, not detection.

The six Crossref fixtures look like live REST bodies (captured 2026-09-12, reference stripped). They are a thin slice: three retractions, all with type "retraction" on updated-by, all with empty relation.

Refute: add a calibration test that must pass with updated-by removed from a CAPS-title fixture; add a Crossref 404 case; add one recorded withdrawal/HTML-prefix body. If those tests stay green on current code, these gaps are documentary only.

Q1–Q5
1. updated-by + type === 'retraction' is the right field and selector for the recorded retractions; not reading update-to on the queried DOI is right. Completeness is unproven (sampling frame + unmatched withdrawal/removal).
2. CAPS prefix kills the meta-science false positive in the fixture. It misses title-case/bracket/HTML-prefix markers in the fallback window. WITHDRAWN can false-flag withdrawals. The brief's &amp;lt;i&amp;gt; example still matches.
3. Dropping dead OpenRetractions from defaults is defensible; complete: true from Crossref alone is then tautological and a single point of confident failure. Crossref 404 must not be sourcesChecked.
4. See Finding 5.
5. See Finding 6.
CONSULT-0AD35B13EB68-GROK