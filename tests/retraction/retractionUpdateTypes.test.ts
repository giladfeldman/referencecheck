/**
 * Findings from the three-model review of 2026-09-12, each reproduced against
 * the compiled library and the live Crossref API before a line was changed.
 *
 * Seats: Fable 5 (anthropic), Sonnet 5 (anthropic), Grok 4.6 (xai). Round
 * archived alongside the v0.1.4 release notes. Fable and Sonnet independently
 * found the `withdrawal` gap; Grok found it from the code without the live API.
 * Every payload below is a verbatim recorded Crossref body — see
 * `tests/fixtures/crossref/capture.mjs`.
 *
 * Watched failing first against commit 91d11c8 (the first cut of v0.1.4).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { crossrefFixture as fixture } from '../fixtures/crossrefFixture.js';

const crossrefGetMock = jest.fn<any>();
const axiosGetMock = jest.fn<any>();

const httpError = (status?: number, code?: string, message = 'request failed') => {
  const e: any = new Error(message);
  e.isAxiosError = true;
  if (status !== undefined) e.response = { status };
  if (code) e.code = code;
  return e;
};

jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  return { default: { get: axiosGetMock, isAxiosError }, isAxiosError };
});
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));

/**
 * Deliberately loosened types.
 *
 * These assertions must be runnable against the PREVIOUS implementation, to
 * watch them fail before the fix. Statically typed against the new
 * `RetractionInfo` they fail to COMPILE there instead — which proves a field
 * was added, not that a defect was fixed. The assertions below are on values,
 * which is what the findings were about.
 */
const mod = await import('../../src/retraction/retractionChecker.js');
const checkRetraction = mod.checkRetraction as (doi: string, o?: any) => Promise<any>;
const checkRetractionDetailed = mod.checkRetractionDetailed as (
  doi: string,
  o?: any
) => Promise<any>;

const DOI = '10.1/abc';

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('a withdrawn or removed paper is not a clean reference', () => {
  it('a Cochrane WITHDRAWAL is flagged, and typed as a withdrawal', async () => {
    // Reproduced live on 10.1002/14651858.cd009522: `updated-by` type is
    // `withdrawal`, its label is "Withdrawal" and contains no "retract", so a
    // retraction-only matcher returned a checked clean for a review the
    // publisher has pulled.
    crossrefGetMock.mockResolvedValue(fixture('withdrawn-cochrane.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('withdrawal');
    expect(r.checked).toBe(true);
  });

  it('a withdrawal listed alongside an erratum is still found', async () => {
    crossrefGetMock.mockResolvedValue(fixture('withdrawn-with-erratum.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('withdrawal');
  });

  it('an Elsevier REMOVAL listed after an erratum is found, and typed removal', async () => {
    // The removal is the SECOND entry; the first is an erratum, which is not a
    // withdrawal of any kind. Position-based selection gets this wrong.
    crossrefGetMock.mockResolvedValue(fixture('removed-elsevier.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('removal');
  });

  it('CONTROL: an ordinary paper is still clean', async () => {
    // Two-sided. Widening the type list must not make everything positive.
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(false);
    expect(r.retractionType).toBeUndefined();
  });
});

describe('the verdict is the most severe notice, not the first one deposited', () => {
  it('a full retraction outranks a partial retraction in the same list', async () => {
    // 10.33552/ojdoh.2018.01.000503 lists twelve update entries with
    // `partial_retraction` ahead of `retraction`. Reporting "Partial
    // retraction" understates a full retraction to the reader.
    crossrefGetMock.mockResolvedValue(fixture('multi-update-severity.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('retraction');
    expect(r.retractionReason).toBe('Retraction');
  });

  it('among equally severe notices the EARLIEST date is reported', async () => {
    // Two `retraction` entries: publisher 2021-09-11, Retraction Watch
    // 2022-12-06. The retraction happened on the earlier date; the later one is
    // when a third party recorded it.
    crossrefGetMock.mockResolvedValue(fixture('multi-retraction-dates.json'));

    const r = await checkRetraction(DOI);

    expect(r.retractionDate).toBe('2021-9-11');
  });
});

describe('the title fallback catches the forms publishers actually use', () => {
  it('IEEE "Retracted: …" with an EMPTY updated-by is caught', async () => {
    // 10.1109/icaccs60874.2024.10717184 is genuinely retracted and deposits no
    // update relation at all, so the title is the only signal. A case-sensitive
    // ALL-CAPS-only rule reported it clean.
    crossrefGetMock.mockResolvedValue(fixture('retracted-title-case.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('retraction');
  });

  it('Spandidos "[Retracted] …" with an empty updated-by is caught', async () => {
    crossrefGetMock.mockResolvedValue(fixture('retracted-bracketed.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('retraction');
  });

  it('a withdrawn preprint titled "WITHDRAWN" is flagged as WITHDRAWN, never retracted', async () => {
    // 10.31234/osf.io/etvnm_v1, a PsyArXiv preprint. OSF preprints are
    // routinely withdrawn because the work was published elsewhere, not for
    // misconduct. Flagging it is right; calling it "retracted" to a psychology
    // author is a false claim about their bibliography.
    crossrefGetMock.mockResolvedValue(fixture('withdrawn-preprint.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('withdrawal');
    expect(r.retractionReason).toMatch(/^Withdrawn/);
    expect(r.retractionReason?.toLowerCase()).not.toMatch(/retracted/);
  });

  it('the title path reports NO retraction date rather than the publication date', async () => {
    // It used to return `message.published`, the date the paper came out, in a
    // field called `retractionDate` — a wrong number straight into a report.
    crossrefGetMock.mockResolvedValue(fixture('retracted-title-case.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.retractionDate).toBeUndefined();
  });

  it('CONTROL: healthy papers ABOUT retraction are still not flagged', async () => {
    // The regression this whole rule exists to avoid. "Retracted Publications
    // in Indian Science: Reasons and Institutions" is a real, healthy 2025
    // paper, and widening the marker must not catch it.
    crossrefGetMock.mockResolvedValue(fixture('about-retraction-not-retracted.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(false);
  });

  it('CONTROL: a retraction NOTICE is still not reported as a retracted paper', async () => {
    crossrefGetMock.mockResolvedValue(fixture('retraction-notice.json'));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(false);
  });
});

describe('a Crossref 404 is not a clean bill of health', () => {
  it('a DOI Crossref does not hold is UNCHECKED, not clean', async () => {
    // Crossref is a bibliographic register, not a retraction index. A 404 means
    // "not a Crossref work" — a DataCite/Zenodo DOI, or a typo — and says
    // nothing about retraction. Reproduced live on 10.5281/zenodo.3242591 and
    // on LaCour's DOI with one character appended: both returned a checked,
    // complete clean.
    crossrefGetMock.mockRejectedValue(httpError(404));

    const d = await checkRetractionDetailed(DOI);

    expect(d.retraction.isRetracted).toBe(false);
    expect(d.retraction.checked).toBe(false);
    expect(d.complete).toBe(false);
    expect(d.retraction.sourcesChecked).toEqual([]);
    expect(d.retraction.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'not_indexed', detail: '404' },
    ]);
  });

  it('CONTROL: an OpenRetractions 404 IS still an answer', async () => {
    // The asymmetry is the point, and it is per-source. OpenRetractions is a
    // retraction index: absence there really does mean "not retracted".
    axiosGetMock.mockRejectedValue(httpError(404));
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction(DOI, { sources: ['openretractions', 'crossref'] });

    expect(r.checked).toBe(true);
    expect(r.sourcesChecked.sort()).toEqual(['crossref', 'openretractions']);
    expect(r.sourcesUnavailable).toEqual([]);
  });
});

describe('a check that consulted nothing is not a check', () => {
  it('sources: [] is UNCHECKED, not a confident clean', async () => {
    // Returned `checked: true, complete: true, sourcesChecked: []` — a clean
    // bill of health from consulting no source at all.
    const d = await checkRetractionDetailed(DOI, { sources: [] });

    expect(d.retraction.isRetracted).toBe(false);
    expect(d.retraction.checked).toBe(false);
    expect(d.complete).toBe(false);
    expect(d.retraction.sourcesChecked).toEqual([]);
    expect(crossrefGetMock).not.toHaveBeenCalled();
  });

  it('a non-200 Crossref response counts as unavailable, not as silence', async () => {
    // Unreachable while crossrefGet throws on non-2xx, but a status that
    // reaches neither array would compute `checked: true` off an empty list.
    crossrefGetMock.mockResolvedValue({ status: 204, data: {} });

    const r = await checkRetraction(DOI);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'server_error', detail: '204' },
    ]);
  });
});
