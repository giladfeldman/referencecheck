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
 * These tests mock axios and crossrefGet so they are deterministic and offline
 * — a live-API test cannot express "and now Crossref rate-limits you". Where a
 * Crossref BODY matters rather than its failure mode, the payload is a verbatim
 * recorded response from `tests/fixtures/crossref/`, never a hand-built object:
 * this suite previously injected `update: [{type:'retraction'}]`, a shape no
 * Crossref server has ever returned, and so stayed green over detection code
 * that could not fire. See `retractionDetection.test.ts`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { crossrefFixture as fixture } from '../fixtures/crossrefFixture.js';

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

/**
 * Consult BOTH indexes.
 *
 * OpenRetractions is off by default from v0.1.4 — `api.openretractions.com` does
 * not resolve (EAI_AGAIN, measured 2026-09-12), and under the strict
 * completeness rule keeping it in the default list would mark every lookup in
 * production incomplete forever. These tests opt back in precisely so the
 * two-source behaviour stays pinned for the day the host returns.
 */
const BOTH = { sources: ['openretractions', 'crossref'] as const };

/** OpenRetractions holds no record; Crossref answers with an ordinary article. */
const bothClean = () => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
  crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));
};

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('a source that answered is not the same as a source that did not', () => {
  it('reports checked when every source answers and neither names a retraction', async () => {
    bothClean();
    const r = await checkRetraction(DOI, BOTH);

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(true);
    expect(r.sourcesUnavailable).toEqual([]);
    expect(r.sourcesChecked.sort()).toEqual(['crossref', 'openretractions']);
  });

  it('a Crossref 429 makes the result UNCHECKED, not clean', async () => {
    // THE defect. Pre-fix this returned { isRetracted: false } with nothing to
    // distinguish it from the clean case above.
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(429));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'rate_limited', detail: '429' },
    ]);
  });

  it('a Crossref timeout makes the result UNCHECKED, not clean', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(undefined, 'ECONNABORTED', 'timeout of 5000ms'));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([{ source: 'crossref', reason: 'timeout' }]);
  });

  it('a Crossref 503 makes the result UNCHECKED, not clean', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(503));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'server_error', detail: '503' },
    ]);
  });

  it('a 404 IS an answer — the index was reached and holds no record', async () => {
    // The control that keeps the fix from becoming "everything is unchecked".
    axiosGetMock.mockRejectedValue(httpError(404));
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.checked).toBe(true);
    expect(r.sourcesUnavailable).toEqual([]);
    expect(r.sourcesChecked.sort()).toEqual(['crossref', 'openretractions']);
  });

  it('both sources down reports both, and stays unchecked', async () => {
    axiosGetMock.mockRejectedValue(httpError(429));
    crossrefGetMock.mockRejectedValue(httpError(429));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.checked).toBe(false);
    expect(r.sourcesChecked).toEqual([]);
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
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.isRetracted).toBe(true);
    expect(r.checked).toBe(true);
    expect(r.source).toBe('openretractions');
    expect(r.retractionReason).toBe('Data fabrication');
  });

  it('a Crossref retraction is still found when OpenRetractions is rate-limited', async () => {
    // A degraded source must not suppress a positive from a working one. The
    // Crossref body here is the real LaCour record, whose title says nothing
    // about retraction — so this can only pass by reading `updated-by`.
    axiosGetMock.mockRejectedValue(httpError(429));
    crossrefGetMock.mockResolvedValue(fixture('retracted-plain-title.json'));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.isRetracted).toBe(true);
    expect(r.source).toBe('crossref');
    expect(r.retractionNoticeUrl).toBe('https://doi.org/10.1126/science.aac6638');
    // The 429 is still reported, because one index genuinely went unread.
    expect(r.sourcesUnavailable).toEqual([
      { source: 'openretractions', reason: 'rate_limited', detail: '429' },
    ]);
  });
});

describe('checkRetractionDetailed', () => {
  it('complete is false exactly when a source went unread', async () => {
    bothClean();
    expect((await checkRetractionDetailed(DOI, BOTH)).complete).toBe(true);

    crossrefGetMock.mockRejectedValue(httpError(429));
    const degraded = await checkRetractionDetailed(DOI, BOTH);
    expect(degraded.complete).toBe(false);
    expect(degraded.sourcesUnavailable).toHaveLength(1);
  });

  it('a positive finding does not paper over a source that went unread', async () => {
    // `complete` used to be `isRetracted || checked`, so ANY retraction made the
    // result complete even with an index unread. A reader deciding whether to
    // re-run the check needs coverage and verdict kept apart.
    axiosGetMock.mockRejectedValue(httpError(429));
    crossrefGetMock.mockResolvedValue(fixture('retracted-plain-title.json'));

    const d = await checkRetractionDetailed(DOI, BOTH);

    expect(d.retraction.isRetracted).toBe(true);
    expect(d.complete).toBe(false);
  });
});

/**
 * The asymmetry, and the reason it is resolved the way it is (2026-09-12).
 *
 * `checkRetraction` hard-coded `checked: true` on the Crossref-clean early
 * return, so an OpenRetractions timeout followed by a Crossref 200 reported a
 * complete, clean answer while one index had genuinely gone unread. The mirror
 * case — OpenRetractions answering and Crossref rate-limiting — correctly
 * reported unchecked. So the dedicated retraction index's silence was ignored
 * while the general bibliographic record's silence was not, which is exactly
 * backwards.
 *
 * It is resolved toward the strict reading, matching the function's own
 * docstring and `expressionOfConcernService.ts`: `checked` is
 * `sourcesUnavailable.length === 0`, whichever source fell over.
 */
describe('a source that went unread is a source that went unread, whichever one it was', () => {
  it('OpenRetractions unreachable + Crossref clean is UNCHECKED, not clean', async () => {
    // THE defect. `api.openretractions.com` did not resolve at all on
    // 2026-09-12 (EAI_AGAIN, while api.crossref.org resolved on the same call),
    // so before this fix every lookup that consulted it took this branch and was
    // stamped complete.
    axiosGetMock.mockRejectedValue(httpError(undefined, 'EAI_AGAIN', 'getaddrinfo EAI_AGAIN'));
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.isRetracted).toBe(false);
    expect(r.checked).toBe(false);
    expect(r.sourcesChecked).toEqual(['crossref']);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'openretractions', reason: 'network', detail: 'EAI_AGAIN' },
    ]);
  });

  it('checkRetractionDetailed does not call that complete either', async () => {
    axiosGetMock.mockRejectedValue(httpError(undefined, 'ECONNABORTED', 'timeout of 5000ms'));
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const d = await checkRetractionDetailed(DOI, BOTH);

    expect(d.complete).toBe(false);
    expect(d.sourcesUnavailable).toEqual([{ source: 'openretractions', reason: 'timeout' }]);
  });

  it('the symmetric case keeps behaving as it already did', async () => {
    // Two-sided control: the direction that was already right must stay right.
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: false } });
    crossrefGetMock.mockRejectedValue(httpError(429));

    const r = await checkRetraction(DOI, BOTH);

    expect(r.checked).toBe(false);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'crossref', reason: 'rate_limited', detail: '429' },
    ]);
  });

  it('a genuine all-answered clean is still complete', async () => {
    // The control that stops the fix collapsing into "nothing is ever checked".
    bothClean();
    const d = await checkRetractionDetailed(DOI, BOTH);
    expect(d.complete).toBe(true);
    expect(d.retraction.checked).toBe(true);
  });
});

describe('the default source list', () => {
  it('consults Crossref only, and does not touch the dead OpenRetractions host', async () => {
    // Pins the v0.1.4 decision. If OpenRetractions is ever restored to the
    // defaults, this fails and the reasoning in the module header gets re-read.
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));

    const r = await checkRetraction(DOI);

    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(r.sourcesChecked).toEqual(['crossref']);
    expect(r.checked).toBe(true);
  });

  it('a Crossref-only run is still unchecked when Crossref fails', async () => {
    crossrefGetMock.mockRejectedValue(httpError(429));

    const r = await checkRetraction(DOI);

    expect(r.checked).toBe(false);
    expect(r.sourcesChecked).toEqual([]);
  });
});

describe('the Crossref polite-pool identity reaches the shared client', () => {
  it('passes the caller credentials through to crossrefGet', async () => {
    // Without this the consumer's CROSSREF_EMAIL is dropped and every request is
    // attributed to the library's default contact. `validateDOI` already threads
    // creds; this path did not.
    crossrefGetMock.mockResolvedValue(fixture('not-retracted.json'));
    const creds = { crossrefEmail: 'someone@example.org' };

    await checkRetraction(DOI, { creds });

    expect(crossrefGetMock).toHaveBeenCalledWith(
      expect.stringContaining('api.crossref.org'),
      expect.anything(),
      creds
    );
  });
});
