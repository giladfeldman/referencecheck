/**
 * The Crossref path read a field Crossref does not serve (2026-09-12).
 *
 * `retractionChecker.ts` did `const updates = message.update || []`. Measured
 * against the live Crossref API on 2026-09-12, `message.update` is `undefined`
 * on every work tested — retracted and healthy alike. The real relation key is
 * `message['updated-by']`, whose entries now carry `source: "retraction-watch"`.
 * So the predicate could never fire, and the ONLY surviving Crossref detection
 * was a title substring match.
 *
 * The suite was green over that dead code because the fixture was hand-built:
 * the old `retractionCoverage.test.ts` injected `update: [{type:'retraction'}]`,
 * a shape no Crossref server has ever returned. A synthetic fixture cannot tell
 * you the rule is wrong, only that your fixture is. Every payload used here is
 * therefore a VERBATIM live Crossref response — see `tests/fixtures/crossref/`
 * and the `capture.mjs` that re-records them.
 *
 * Two measurements from a 14-work real retracted corpus (2026-09-12) set the
 * bar these tests defend:
 *   - `updated-by` carried a retraction entry on 14 of 14.
 *   - A capitalised "RETRACTED"/"WITHDRAWN" title prefix appeared on only 9 of
 *     14, so the title heuristic alone misses roughly a third of retractions.
 * And in the other direction, a Crossref search for meta-science papers ABOUT
 * retraction returned 8 of 8 healthy papers whose titles contain "retract" —
 * every one of which the old substring heuristic reports as RETRACTED. That is
 * the literature this library's own users cite, so the false positive is not a
 * curiosity.
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

const { checkRetraction } = await import('../../src/retraction/retractionChecker.js');

/** OpenRetractions is unreachable in reality (see the coverage suite); make the
 *  Crossref path the thing under test by giving it a definitive 404. */
const openRetractionsSilent = () => axiosGetMock.mockRejectedValue(httpError(404));

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('Crossref retraction detection reads the field Crossref actually serves', () => {
  it('the fixtures confirm `message.update` does not exist and `updated-by` does', () => {
    // The two-sided control for the whole defect. If Crossref ever starts
    // serving `update`, this fails and the premise gets re-examined.
    for (const f of ['retracted-plain-title.json', 'retracted-caps-title.json', 'not-retracted.json']) {
      expect(fixture(f).data.message.update).toBeUndefined();
    }
    expect(fixture('retracted-plain-title.json').data.message['updated-by']).toBeDefined();
    expect(fixture('not-retracted.json').data.message['updated-by']).toBeUndefined();
  });

  it('CALIBRATION: detects a retraction whose title contains no retraction marker', async () => {
    // LaCour & Green 2014 — retracted in 2015, title "When contact changes
    // minds". This is the test that would have caught the defect: it cannot be
    // passed by the title heuristic, only by reading `updated-by`.
    openRetractionsSilent();
    crossrefGetMock.mockResolvedValue(fixture('retracted-plain-title.json'));

    const r = await checkRetraction('10.1126/science.1256151');

    expect(r.isRetracted).toBe(true);
    expect(r.source).toBe('crossref');
    expect(r.retractionNoticeUrl).toBe('https://doi.org/10.1126/science.aac6638');
    expect(r.retractionDate).toBe('2015-6-5');
  });

  it('CALIBRATION, second paper: the corpus does not rest on one retraction', async () => {
    openRetractionsSilent();
    crossrefGetMock.mockResolvedValue(fixture('retracted-plain-title-2.json'));

    const r = await checkRetraction('10.1538/expanim.54.1');

    expect(r.isRetracted).toBe(true);
    expect(r.source).toBe('crossref');
  });

  it('still detects the CAPS-titled retraction, and cites the retraction notice', async () => {
    // Wakefield 1998. Its `updated-by` holds TWO entries — a 2004 correction and
    // the 2010 retraction — so picking the first entry is not good enough.
    openRetractionsSilent();
    crossrefGetMock.mockResolvedValue(fixture('retracted-caps-title.json'));

    const r = await checkRetraction('10.1016/S0140-6736(97)11096-0');

    expect(r.isRetracted).toBe(true);
    expect(r.retractionNoticeUrl).toBe('https://doi.org/10.1016/s0140-6736(10)60175-4');
    expect(r.retractionDate).toBe('2010-2-6');
  });

  it('a healthy paper is not retracted', async () => {
    openRetractionsSilent();
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction('10.1038/nature12373');

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(true);
  });

  it('a HEALTHY paper about retraction is not reported as retracted', async () => {
    // "Retracted Publications in Indian Science: Reasons and Institutions" — a
    // real, healthy 2025 paper. The old substring heuristic flags it, and this
    // is exactly the literature a meta-science bibliography is full of.
    openRetractionsSilent();
    crossrefGetMock.mockResolvedValue(fixture('about-retraction-not-retracted.json'));

    const r = await checkRetraction('10.57656/sc-2025-0013');

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(true);
  });

  it('a retraction NOTICE is not itself reported as a retracted paper', async () => {
    // The notice carries `update-to` (it retracts something else), never
    // `updated-by`. Reading `update-to` as evidence about the queried DOI would
    // invert the relation, so the checker must not do it.
    openRetractionsSilent();
    crossrefGetMock.mockResolvedValue(fixture('retraction-notice.json'));

    const r = await checkRetraction('10.1126/science.aac6638');

    expect(r.isRetracted).toBe(false);
  });
});
