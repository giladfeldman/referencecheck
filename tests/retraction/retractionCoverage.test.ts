/**
 * "Not retracted" and "could not check" must be distinguishable (2026-09-10).
 *
 * `checkRetraction` returned `{ isRetracted: false }` for a Crossref **429 or
 * timeout** as well as for a genuine clean answer, and callers read the boolean
 * bare — so a rate-limit storm printed a clean bibliography over references
 * nobody had successfully looked up.
 *
 * This is the identical defect v0.1.2 already fixed for Expression of Concern
 * one directory away, left live in the retraction path. The two-sided control
 * that showed the gap was in coverage rather than in the search: Expression of
 * Concern had 19 test references, the retraction path had ZERO test files. The
 * v0.1.2 CHANGELOG records 81 Crossref 429s in one real SciMeto run, so the
 * failure mode is measured, not hypothetical.
 *
 * Written against the defect: on the pre-fix code every assertion about
 * `checked`, `complete` and `sourcesUnavailable` fails, because none of those
 * fields existed and a 429 was byte-identical to a clean answer.
 *
 * These tests mock axios and crossrefGet so they are deterministic and offline
 * — a live-API test cannot express "and now Crossref rate-limits you".
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
const axiosGetMock = jest.fn<any>();

/** Minimal AxiosError shape: `axios.isAxiosError` checks `isAxiosError === true`. */
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

jest.unstable_mockModule('../../src/http/crossref.js', () => ({
  crossrefGet: crossrefGetMock,
}));

const { checkRetraction, checkRetractionDetailed } =
  await import('../../src/retraction/retractionChecker.js');

const DOI = '10.1/abc';

/** OpenRetractions holds no record; Crossref answers with an ordinary article. */
const bothClean = () => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
  crossrefGetMock.mockResolvedValue({
    status: 200,
    data: { message: { type: 'journal-article', title: ['A perfectly ordinary paper'] } },
  });
};

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('a source that answered is not the same as a source that did not', () => {
  it('reports checked when every source answers and neither names a retraction', async () => {
    bothClean();
    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(true);
    expect(r.sourcesUnavailable).toEqual([]);
  });

  it('a Crossref 429 makes the result UNCHECKED, not clean', async () => {
    // THE defect. Pre-fix this returned { isRetracted: false } with nothing to
    // distinguish it from the clean case above.
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(429));

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'rate_limited', detail: '429' },
    ]);
  });

  it('a Crossref timeout makes the result UNCHECKED, not clean', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(undefined, 'ECONNABORTED', 'timeout of 5000ms'));

    const r = await checkRetraction(DOI);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([{ source: 'crossref', reason: 'timeout' }]);
  });

  it('a Crossref 503 makes the result UNCHECKED, not clean', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(503));

    const r = await checkRetraction(DOI);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'server_error', detail: '503' },
    ]);
  });

  it('a 404 IS an answer — the index was reached and holds no record', async () => {
    // The control that keeps the fix from becoming "everything is unchecked".
    axiosGetMock.mockRejectedValue(httpError(404));
    crossrefGetMock.mockResolvedValue({
      status: 200,
      data: { message: { type: 'journal-article', title: ['Ordinary'] } },
    });

    const r = await checkRetraction(DOI);

    expect(r.checked).toBe(true);
    expect(r.sourcesUnavailable).toEqual([]);
  });

  it('both sources down reports both, and stays unchecked', async () => {
    axiosGetMock.mockRejectedValue(httpError(429));
    crossrefGetMock.mockRejectedValue(httpError(429));

    const r = await checkRetraction(DOI);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toHaveLength(2);
    expect(r.sourcesUnavailable.map((s: any) => s.source).sort()).toEqual([
      'crossref',
      'openretractions',
    ]);
  });
});

describe('a real retraction still reports as one', () => {
  it('OpenRetractions naming a retraction wins immediately', async () => {
    axiosGetMock.mockResolvedValue({
      status: 200,
      data: { retracted: true, retraction_date: '2021-03-01', reason: 'Data fabrication' },
    });
    crossrefGetMock.mockResolvedValue({ status: 200, data: { message: {} } });

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.checked).toBe(true);
    expect(r.source).toBe('openretractions');
    expect(r.retractionReason).toBe('Data fabrication');
  });

  it('a Crossref retraction update is still found when OpenRetractions is rate-limited', async () => {
    // A degraded source must not suppress a positive from a working one.
    axiosGetMock.mockRejectedValue(httpError(429));
    crossrefGetMock.mockResolvedValue({
      status: 200,
      data: {
        message: {
          type: 'journal-article',
          update: [{ type: 'retraction', label: 'Retraction', DOI: '10.1/retraction' }],
        },
      },
    });

    const r = await checkRetraction(DOI);

    expect(r.isRetracted).toBe(true);
    expect(r.source).toBe('crossref');
    expect(r.retractionNoticeUrl).toBe('https://doi.org/10.1/retraction');
    // The 429 is still reported, because one index genuinely went unread.
    expect(r.sourcesUnavailable).toEqual([
      { source: 'openretractions', reason: 'rate_limited', detail: '429' },
    ]);
  });
});

describe('checkRetractionDetailed', () => {
  it('complete is false exactly when a source went unread', async () => {
    bothClean();
    expect((await checkRetractionDetailed(DOI)).complete).toBe(true);

    crossrefGetMock.mockRejectedValue(httpError(429));
    const degraded = await checkRetractionDetailed(DOI);
    expect(degraded.complete).toBe(false);
    expect(degraded.sourcesUnavailable).toHaveLength(1);
  });
});
