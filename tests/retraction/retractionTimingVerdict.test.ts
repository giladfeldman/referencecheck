/**
 * v0.4.0 — three verdicts, retraction timing, and retracted-and-replaced.
 *
 * The class these tests cover: every field and path that carries a retraction
 * STATUS or a DATE. Status paths: Crossref `updated-by`, the title-marker
 * fallback, OpenRetractions, every way a source can fail to answer (429,
 * timeout, 5xx, 404, a 200 with an unusable body, a non-DOI input, no sources),
 * and the batch call. Date fields: the Crossref relation date (Retraction Watch
 * and publisher sourced), the title path (no date), OpenRetractions
 * `retraction_date`, and the citing paper's date from the caller or from
 * Crossref `published` / `issued`, at year / month / day precision. The
 * retraction module has no cache (checked: no cache in src/retraction/), so
 * there is no cache-hit path to cover.
 *
 * Watched failing against v0.2.0 (commit 33278cf) before the fix — the types
 * are loosened for that reason, as in retractionUpdateTypes.test.ts.
 *
 * Bodies are verbatim recorded Crossref responses (tests/fixtures/crossref/)
 * except where a test says it derives one: there, the derivation is the point
 * of the test (a failure mode, or a field no real retracted record carries).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { crossrefFixture as fixture } from '../fixtures/crossrefFixture.js';
import { DOI_SHAPE, formatDateParts } from '../../src/util/normalize.js';

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

const mod: any = await import('../../src/retraction/retractionChecker.js');
const checkRetraction = mod.checkRetraction as (doi: string, o?: any) => Promise<any>;
const checkMultipleRetractions = mod.checkMultipleRetractions as (
  dois: string[],
  o?: any
) => Promise<Map<string, any>>;

/** Real DOIs, matching the recorded bodies they are served with. */
const JAMA = '10.1001/jama.2018.17933'; // retracted 2019-10-08 (Retraction Watch entry)
const CITING = '10.1038/nature12373'; // published 2013-07-31 (not-retracted.json)
const CITING_LATE = '10.57656/sc-2025-0013'; // published 2025-12-31

const clone = (x: any) => JSON.parse(JSON.stringify(x));

const LABS = 'https://api.labs.crossref.org/works/';
const WORKS = 'https://api.crossref.org/works/';

/**
 * Route crossrefGet by URL. `api.crossref.org/works/<doi>` is served from
 * `bodies[doi]`; Crossref Labs (`api.labs.crossref.org/works/<doi>?mailto=…`)
 * from `bodies['labs:' + doi]`, defaulting to the recorded EMPTY Labs block so a
 * test that is not about replacement is not about Labs either. Unknown
 * Crossref DOIs 404.
 */
function serve(bodies: Record<string, any>) {
  crossrefGetMock.mockImplementation(async (url: string) => {
    let key: string;
    if (url.startsWith(LABS)) {
      const doi = decodeURIComponent(url.slice(LABS.length).split('?')[0]);
      key = 'labs:' + doi;
      if (!(key in bodies)) {
        const empty = clone(fixture('retraction/labs-empty-carcin.json'));
        empty.data.message.DOI = doi;
        return empty;
      }
    } else {
      key = decodeURIComponent(url.slice(WORKS.length));
    }
    const body = bodies[key];
    if (body instanceof Error) throw body;
    if (body === undefined) throw httpError(404);
    return body;
  });
}
const citingCalls = (doi: string) =>
  crossrefGetMock.mock.calls.filter((c: any[]) => decodeURIComponent(c[0]) === WORKS + doi).length;

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

// =========================================================== three verdicts
describe('every result says clean, flagged or could_not_check', () => {
  it('flagged: a Crossref updated-by retraction', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA);
    expect(r.verdict).toBe('flagged');
  });

  it('flagged: the title-marker fallback', async () => {
    serve({ '10.3892/ol.2018.7943': fixture('retracted-bracketed.json') });
    expect((await checkRetraction('10.3892/ol.2018.7943')).verdict).toBe('flagged');
  });

  it('clean: every source answered and none flags it', async () => {
    serve({ [CITING]: fixture('not-retracted.json') });
    expect((await checkRetraction(CITING)).verdict).toBe('clean');
  });

  it.each([
    ['429', httpError(429)],
    ['timeout', httpError(undefined, 'ECONNABORTED', 'timeout of 5000ms')],
    ['503', httpError(503)],
    ['socket', httpError(undefined, 'ECONNRESET', 'socket hang up')],
    ['404 (not a Crossref work)', httpError(404)],
  ])('could_not_check: Crossref %s', async (_label, err) => {
    serve({ [CITING]: err });
    const r = await checkRetraction(CITING);
    expect(r.verdict).toBe('could_not_check');
    expect(r.isRetracted).toBe(false);
  });

  it('could_not_check: no sources asked', async () => {
    expect((await checkRetraction(CITING, { sources: [] })).verdict).toBe('could_not_check');
  });

  it('flagged wins over a source that went unread (and checked stays false)', async () => {
    axiosGetMock.mockRejectedValue(httpError(undefined, 'EAI_AGAIN', 'getaddrinfo EAI_AGAIN'));
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA, { sources: ['openretractions', 'crossref'] });
    expect(r.verdict).toBe('flagged');
    expect(r.checked).toBe(false);
  });

  it('flagged: OpenRetractions naming a retraction', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: true, retraction_date: '2019-10-08' } });
    const r = await checkRetraction(JAMA, { sources: ['openretractions'] });
    expect(r.verdict).toBe('flagged');
  });

  it.each([
    ['a JSON 404 (the API: not in its index)', { message: 'not found' }, 'clean'],
    ['a 404 with no JSON body (a parked host)', undefined, 'could_not_check'],
  ])('OpenRetractions %s plus a Crossref clean', async (_l, data, verdict) => {
    const e = httpError(404);
    if (data) e.response.data = data;
    axiosGetMock.mockRejectedValue(e);
    serve({ [CITING]: fixture('not-retracted.json') });
    const r = await checkRetraction(CITING, { sources: ['openretractions', 'crossref'] });
    expect(r.verdict).toBe(verdict);
  });

  it('the batch call carries the verdict on every entry', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [CITING]: fixture('not-retracted.json'), '10.9999/gone': httpError(429) });
    const m = await checkMultipleRetractions([JAMA, CITING, '10.9999/gone']);
    expect([...m.values()].map((r) => r.verdict)).toEqual(['flagged', 'clean', 'could_not_check']);
  });
});

describe('a 200 that is not an answer is not a clean (the folds fixed in v0.4.0)', () => {
  // Failure-mode bodies: derived on purpose, as a live API cannot be made to send them.
  it.each([
    ['an empty body', { status: 200, data: '' }],
    ['an HTML page', { status: 200, data: '<html><body>Service Unavailable</body></html>' }],
    ['JSON with no message', { status: 200, data: { status: 'failed' } }],
    ['a work-list body (what /works/ answers)', { status: 200, data: { status: 'ok', 'message-type': 'work-list', message: { items: [], 'total-results': 0 } } }],
    ['a message with no DOI', { status: 200, data: { status: 'ok', message: { title: ['x'] } } }],
  ])('Crossref 200 with %s is could_not_check / server_error', async (_label, body) => {
    serve({ [CITING]: body });
    const r = await checkRetraction(CITING);
    expect(r.checked).toBe(false);
    expect(r.verdict).toBe('could_not_check');
    expect(r.sourcesUnavailable).toEqual([{ source: 'crossref', reason: 'server_error', detail: '200 without a work record' }]);
  });

  it.each([
    ['an empty object', {}],
    ['an HTML string', '<html>blocked</html>'],
    ['retracted as a string', { retracted: 'false' }],
  ])('OpenRetractions 200 with %s is not an answer', async (_label, data) => {
    axiosGetMock.mockResolvedValue({ status: 200, data });
    serve({ [CITING]: fixture('not-retracted.json') });
    const r = await checkRetraction(CITING, { sources: ['openretractions', 'crossref'] });
    expect(r.verdict).toBe('could_not_check');
    expect(r.sourcesUnavailable).toEqual([{ source: 'openretractions', reason: 'server_error', detail: '200 without a JSON retraction answer' }]);
  });

  it.each([[''], ['   '], ['not a doi'], ['https://doi.org/'], ['10.1234']])(
    'a non-DOI input %j asks nothing and is could_not_check / invalid_doi',
    async (input) => {
      // Before v0.4.0 an empty DOI reached Crossref as /works/, whose 200 LIST
      // body has no updated-by and no title, and so read as a checked clean.
      serve({ '': { status: 200, data: { status: 'ok', 'message-type': 'work-list', message: { items: [] } } } });
      const r = await checkRetraction(input);
      expect(r.verdict).toBe('could_not_check');
      expect(r.sourcesUnavailable.map((u: any) => u.reason)).toEqual(['invalid_doi']);
      expect(crossrefGetMock).not.toHaveBeenCalled();
    }
  );

  // One DOI shape for the library: what DOI_SHAPE (and the shortDOI form)
  // rejects is never sent to Crossref, as a cited or as a citing DOI.
  it.each([['10.12/x', false], ['10.1234567890/x', false], ['10.231/x', true], ['10/abc12', true]])(
    '%s is read by the shared DOI shape (DOI-shaped: %s)',
    async (input, shaped) => {
      expect(DOI_SHAPE.test(input) || /^10\/[A-Za-z0-9._-]+$/.test(input)).toBe(shaped);
      serve({ [input]: fixture('not-retracted.json') });
      const r = await checkRetraction(input);
      expect(r.sourcesUnavailable.some((u: any) => u.reason === 'invalid_doi')).toBe(!shaped);
      expect(crossrefGetMock.mock.calls.length > 0).toBe(shaped);
    }
  );

  it('verdict always agrees with isRetracted and checked', async () => {
    const cases: Array<[string, any]> = [
      [JAMA, fixture('retraction/retracted-rw-jama.json')],
      [CITING, fixture('not-retracted.json')],
      [CITING, httpError(429)],
      [CITING, { status: 200, data: '' }],
    ];
    for (const [doi, body] of cases) {
      crossrefGetMock.mockReset();
      serve({ [doi]: body });
      const r = await checkRetraction(doi);
      const expected = r.isRetracted ? 'flagged' : r.checked ? 'clean' : 'could_not_check';
      expect(r.verdict).toBe(expected);
    }
  });
});

describe('a misspelled update type still flags the work', () => {
  it('type "retracion" (a real publisher deposit, 10.4048/jbc.2018.21.1.102) is a retraction', async () => {
    // Derived from the recorded JAMA body: the Retraction Watch entry replaced
    // by the misspelt publisher entry the 2026-11-18 scan of all 81,667
    // Crossref retraction notices found. On that real record a Retraction
    // Watch duplicate rescues it; without one, the typo read as clean.
    const body = clone(fixture('retraction/retracted-rw-jama.json'));
    body.data.message['updated-by'][0].type = 'retracion';
    body.data.message['updated-by'][0].label = 'Retracion';
    body.data.message.title = ['Effect of a Program Combining Transitional Care'];
    serve({ [JAMA]: body });
    const r = await checkRetraction(JAMA);
    expect(r.isRetracted).toBe(true);
    expect(r.retractionType).toBe('retraction');
  });
});

// =========================================================== timing
describe('retraction timing relative to the citing paper', () => {
  it('after_citing: citing paper (2013) published before the retraction (2019-10-08)', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA, { citing: { publishedDate: '2013-07-31' } });
    expect(r.timing).toEqual({
      timing: 'after_citing',
      retractionDate: '2019-10-08',
      citingPublishedDate: '2013-07-31',
      citingDateSource: 'caller',
      citingDateField: undefined,
    });
  });

  it('before_citing: citing paper (2025) published after the retraction', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA, { citing: { publishedDate: '2025-12-31' } });
    expect(r.timing.timing).toBe('before_citing');
  });

  it('citing date from the citing DOI\'s Crossref `published`', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [CITING_LATE]: fixture('about-retraction-not-retracted.json') });
    const r = await checkRetraction(JAMA, { citing: { doi: CITING_LATE } });
    expect(r.timing).toMatchObject({
      timing: 'before_citing',
      citingPublishedDate: '2025-12-31',
      citingDateSource: 'crossref',
      citingDateField: 'published',
    });
  });

  it('falls back to `issued` when the citing record has no `published`', async () => {
    const citing = clone(fixture('not-retracted.json'));
    delete citing.data.message.published;
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [CITING]: citing });
    const r = await checkRetraction(JAMA, { citing: { doi: CITING } });
    expect(r.timing).toMatchObject({ timing: 'after_citing', citingDateField: 'issued', citingPublishedDate: '2013-07-31' });
  });

  it.each([
    ['no published or issued date', () => { const c = clone(fixture('not-retracted.json')); delete c.data.message.published; delete c.data.message.issued; return c; }, 'no_date'],
    ['a 429', () => httpError(429), 'rate_limited'],
    ['a 404', () => httpError(404), 'not_indexed'],
    ['a 200 without a work record', () => ({ status: 200, data: '' }), 'server_error: 200 without a work record'],
  ])('citing DOI lookup with %s gives unknown / citing_date_unavailable', async (_l, body, reason) => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [CITING]: body() });
    const r = await checkRetraction(JAMA, { citing: { doi: CITING } });
    expect(r.timing.timing).toBe('unknown');
    expect(r.timing.unknownReason).toBe('citing_date_unavailable');
    expect(r.timing.detail).toContain(reason);
    // The retraction verdict itself is untouched by the citing lookup.
    expect(r.verdict).toBe('flagged');
  });

  it.each([
    ['doi:10.1038/nature12373'],
    ['https://dx.doi.org/10.1038/nature12373'],
    ['https://doi.org/10.1038%2Fnature12373'],
  ])('the citing DOI %s is read by the same cleaner as the cited DOI', async (written) => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [CITING]: fixture('not-retracted.json') });
    const r = await checkRetraction(JAMA, { citing: { doi: written }, checkReplacement: false });
    expect(r.timing).toMatchObject({ timing: 'after_citing', citingPublishedDate: '2013-07-31' });
    expect(citingCalls(CITING)).toBe(1);
  });

  it('an invalid citing DOI is never sent to Crossref', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA, { citing: { doi: 'not-a-doi' }, checkReplacement: false });
    expect(r.timing.unknownReason).toBe('citing_date_unavailable');
    expect(crossrefGetMock).toHaveBeenCalledTimes(1);
  });

  it('unknown / no_citing_date when no citing paper is given', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA);
    expect(r.timing).toMatchObject({ timing: 'unknown', unknownReason: 'no_citing_date', retractionDate: '2019-10-08' });
  });

  it.each([
    ['a full date', [[2019, 10, 8]], '2019-10-08', 'after_citing'],
    ['a month date', [[2019, 3]], '2019-03', 'after_citing'],
    ['a year', [[2019]], '2019', 'after_citing'],
    ['month 13 (not a calendar date)', [[2019, 13, 1]], '2019-13-01', 'unknown'],
    ['no year', [[null]], undefined, 'unknown'],
  ])('retractionDate from %s is zero-padded and compared', async (_l, dateParts, expected, timing) => {
    const body = clone(fixture('retraction/retracted-rw-jama.json'));
    body.data.message['updated-by'][0].updated = { 'date-parts': dateParts };
    serve({ [JAMA]: body });
    const r = await checkRetraction(JAMA, { citing: { publishedDate: '2013-07-31' }, checkReplacement: false });
    expect(r.retractionDate).toBe(expected);
    expect(r.timing.timing).toBe(timing);
  });

  // One shape, one writer: every date this module returns is written by the
  // shared formatDateParts. The retraction date keeps an invalid deposit
  // visible; the citing date accepts only a real calendar date (never a guess).
  it.each([
    [[2019], true], [[2019, 3], true], [[2019, 3, 5], true], [[2019, 12, 31], true],
    [[2020, 2, 29], true], [[2019, 2, 29], false], [[2019, 13, 1], false],
    [['2019'], false], [[], false], [[null], false],
  ])('date-parts %j: retractionDate and the citing date agree with formatDateParts', async (parts, real) => {
    const expected = formatDateParts(parts);
    const body = clone(fixture('retraction/retracted-rw-jama.json'));
    body.data.message['updated-by'][0].updated = { 'date-parts': [parts] };
    const citing = clone(fixture('not-retracted.json'));
    citing.data.message.published = { 'date-parts': [parts] };
    delete citing.data.message.issued;
    serve({ [JAMA]: body, [CITING]: citing });
    const r = await checkRetraction(JAMA, { citing: { doi: CITING }, checkReplacement: false });
    expect(r.retractionDate).toBe(expected);
    expect(r.timing.citingPublishedDate).toBe(real ? expected : undefined);
  });

  it('unknown / no_retraction_date on the title-marker path (no notice to date)', async () => {
    serve({ '10.3892/ol.2018.7943': fixture('retracted-bracketed.json') });
    const r = await checkRetraction('10.3892/ol.2018.7943', { citing: { publishedDate: '2025' } });
    expect(r.timing).toMatchObject({ timing: 'unknown', unknownReason: 'no_retraction_date' });
  });

  it('a publisher-sourced relation date is compared too (earliest notice, 2021-09-11)', async () => {
    serve({ '10.1007/s11277-021-09072-0': fixture('multi-retraction-dates.json') });
    const r = await checkRetraction('10.1007/s11277-021-09072-0', { citing: { publishedDate: '2022-01' } });
    expect(r.timing).toMatchObject({ timing: 'before_citing', retractionDate: '2021-09-11' });
  });

  it('OpenRetractions retraction_date is compared; an unreadable one is unknown', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: true, retraction_date: '2019-10-08' } });
    const ok = await checkRetraction(JAMA, { sources: ['openretractions'], citing: { publishedDate: '2020' } });
    expect(ok.timing.timing).toBe('before_citing');

    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: true, retraction_date: 'October 2019' } });
    const bad = await checkRetraction(JAMA, { sources: ['openretractions'], citing: { publishedDate: '2020' } });
    expect(bad.timing).toMatchObject({ timing: 'unknown', unknownReason: 'unparseable_retraction_date' });
  });

  it('every date on one result has one form: OpenRetractions and caller dates are padded too', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: true, retraction_date: '2019-1-5' } });
    const r = await checkRetraction(JAMA, { sources: ['openretractions'], citing: { publishedDate: '2019-2' } });
    expect(r.retractionDate).toBe('2019-01-05');
    expect(r.timing).toMatchObject({ retractionDate: '2019-01-05', citingPublishedDate: '2019-02', timing: 'before_citing' });

    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const t = await checkRetraction(JAMA, { citing: { publishedDate: '2019-1-5T23:30:00-08:00' }, checkReplacement: false });
    // The date part as written, never shifted through Date: 2019-01-05, not 2019-01-06 (UTC).
    expect(t.timing.citingPublishedDate).toBe('2019-01-05');

    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: true, retraction_date: 'October 2019' } });
    const bad = await checkRetraction(JAMA, { sources: ['openretractions'] });
    expect(bad.retractionDate).toBe('October 2019'); // unreadable: shown as given
  });

  it.each([
    ['2019', 'same_period'], // year-only citing date in the retraction's year
    ['2019-10', 'same_period'], // same month, citing has no day
    ['2019-10-08', 'same_period'], // the same day
    ['2019-09', 'after_citing'],
    ['2019-11', 'before_citing'],
    ['2019-10-07', 'after_citing'],
    ['2019-10-09', 'before_citing'],
    ['2019-10-09T12:00:00Z', 'before_citing'],
  ])('precision: citing %s vs retraction 2019-10-08', async (citingDate, expected) => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA, { citing: { publishedDate: citingDate } });
    if (expected === 'same_period') expect(r.timing).toMatchObject({ timing: 'unknown', unknownReason: 'same_period' });
    else expect(r.timing.timing).toBe(expected);
  });

  it('month-precision retraction dates compare at month precision', () => {
    // Wakefield's record gives the paper 1998-02; a retraction dated by month
    // only must not be ordered against a day inside that month.
    const t = mod.compareRetractionTiming('2010-2', { date: '2010-02-20', source: 'caller' });
    expect(t).toMatchObject({ timing: 'unknown', unknownReason: 'same_period' });
    expect(mod.compareRetractionTiming('2010-2', { date: '2010-03-01', source: 'caller' }).timing).toBe('before_citing');
  });

  it.each([['2019-13-01'], ['2019-02-30'], ['19-10-08'], ['last year'], ['']])(
    'a caller date %j it cannot read throws instead of becoming "unknown"',
    async (bad) => {
      serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
      await expect(checkRetraction(JAMA, { citing: { publishedDate: bad } })).rejects.toThrow(RangeError);
    }
  );

  it('the caller date wins over the citing DOI, and no lookup is made', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [CITING]: fixture('not-retracted.json') });
    const r = await checkRetraction(JAMA, { citing: { publishedDate: '2025-01-01', doi: CITING } });
    expect(r.timing).toMatchObject({ timing: 'before_citing', citingDateSource: 'caller' });
    expect(citingCalls(CITING)).toBe(0);
  });

  it('a clean or unchecked result carries no timing, and never looks the citing DOI up', async () => {
    serve({ [CITING]: fixture('not-retracted.json'), [CITING_LATE]: fixture('about-retraction-not-retracted.json') });
    const r = await checkRetraction(CITING, { citing: { doi: CITING_LATE } });
    expect(r.verdict).toBe('clean');
    expect(r.timing).toBeUndefined();
    expect(citingCalls(CITING_LATE)).toBe(0);
  });

  it('a batch looks the citing DOI up once, however many references are flagged', async () => {
    serve({
      [JAMA]: fixture('retraction/retracted-rw-jama.json'),
      '10.1007/s11277-021-09072-0': fixture('multi-retraction-dates.json'),
      [CITING_LATE]: fixture('about-retraction-not-retracted.json'),
    });
    const m = await checkMultipleRetractions([JAMA, '10.1007/s11277-021-09072-0'], { citing: { doi: CITING_LATE } });
    expect([...m.values()].map((r) => r.timing.timing)).toEqual(['before_citing', 'before_citing']);
    expect(citingCalls(CITING_LATE)).toBe(1);
  });

  it('the plain-language sentence keeps "already retracted" and "good faith" apart', () => {
    const before = mod.describeRetractionTiming(
      { timing: 'before_citing', retractionDate: '2019-10-08', citingPublishedDate: '2025-12-31' }, 'retraction');
    const after = mod.describeRetractionTiming(
      { timing: 'after_citing', retractionDate: '2019-10-08', citingPublishedDate: '2013-07-31' }, 'retraction');
    const unknown = mod.describeRetractionTiming({ timing: 'unknown', unknownReason: 'no_citing_date' }, 'withdrawal');
    expect(before).toMatch(/already retracted when it was cited/);
    expect(after).toMatch(/good faith/);
    expect(after).not.toMatch(/already/);
    expect(unknown).toMatch(/withdrawn/);
    expect(unknown).toMatch(/unknown/);
    expect(unknown).not.toMatch(/retracted/);
  });

  it('the sentence shows dates zero-padded, never the raw "2010-2-6" form', () => {
    const s = mod.describeRetractionTiming(
      { timing: 'before_citing', retractionDate: '2010-2-6', citingPublishedDate: '2012-5' }, 'retraction');
    expect(s).toContain('on 2010-02-06');
    expect(s).toContain('(2012-05)');
    expect(s).not.toMatch(/2010-2-6|2012-5\)/);
  });
});

// =========================================================== replacement
describe('retracted-and-replaced is told apart only on recorded evidence', () => {
  const CARCIN = '10.1093/carcin/bgs140';
  const INFDIS = '10.1093/infdis/jiae178';
  const JAMA_NOTICE = '10.1001/jama.2019.11954';

  it('the work\'s own title "RETRACTED AND REPLACED" (Labs serves an EMPTY block for it)', async () => {
    serve({
      [CARCIN]: fixture('retraction/rr-title-carcin.json'),
      '10.1093/carcin/bgaf065': fixture('retraction/rr-notice-carcin.json'),
      ['labs:' + CARCIN]: fixture('retraction/labs-empty-carcin.json'),
    });
    const r = await checkRetraction(CARCIN);
    expect(r.retractionType).toBe('retraction');
    expect(r.replacement).toEqual({ status: 'replaced', evidence: ['title_marker', 'notice_title'] });
  });

  it('a plain title: the notice title and the Retraction Watch reason say so; the notes give the replacement DOI', async () => {
    serve({
      [INFDIS]: fixture('retraction/rr-plain-infdis.json'),
      '10.1093/infdis/jiae358': fixture('retraction/rr-notice-infdis.json'),
      ['labs:' + INFDIS]: fixture('retraction/labs-rr-infdis.json'),
      // The notes URL ends .../doi/10.1093/infdis/jiae357/7727684: the full
      // match is not a work (404 here), the trimmed form is.
      '10.1093/infdis/jiae357': fixture('retraction/rr-replacement-infdis.json'),
    });
    const r = await checkRetraction(INFDIS);
    expect(r.replacement).toEqual({
      status: 'replaced',
      evidence: ['notice_title', 'retraction_watch_reason'],
      replacementDOI: '10.1093/infdis/jiae357',
    });
  });

  it('a notes DOI Crossref cannot confirm is not reported, but the replacement still is', async () => {
    serve({
      [INFDIS]: fixture('retraction/rr-plain-infdis.json'),
      '10.1093/infdis/jiae358': fixture('retraction/rr-notice-infdis.json'),
      ['labs:' + INFDIS]: fixture('retraction/labs-rr-infdis.json'),
    });
    const r = await checkRetraction(INFDIS);
    expect(r.replacement.status).toBe('replaced');
    expect(r.replacement.replacementDOI).toBeUndefined();
  });

  it('JAMA: a Retraction Watch record without Retract and Replace and a plain notice title -> not_recorded', async () => {
    serve({
      [JAMA]: fixture('retraction/retracted-rw-jama.json'),
      [JAMA_NOTICE]: fixture('retraction/jama-notice.json'),
      ['labs:' + JAMA]: fixture('retraction/labs-jama.json'),
    });
    expect((await checkRetraction(JAMA)).replacement).toEqual({ status: 'not_recorded', evidence: [] });
  });

  it('a `new_version` entry is NOT a replacement (F1000 v2 and v3 were retracted too)', async () => {
    serve({ '10.12688/f1000research.8114.1': fixture('retraction/retracted-f1000-versions.json') });
    const r = await checkRetraction('10.12688/f1000research.8114.1');
    expect(r.isRetracted).toBe(true);
    expect(r.replacement).toEqual({ status: 'not_recorded', evidence: [] });
  });

  it('relation is-replaced-by naming another DOI is a replacement, with that DOI', async () => {
    // Derived: no retracted Crossref work carries is-replaced-by (0 of the
    // 2,213 works with that relation, measured 2026-11-18), so this grafts the
    // shape PeerJ preprints use onto a recorded retracted record.
    const body = clone(fixture('retraction/retracted-rw-jama.json'));
    body.data.message.relation = {
      'is-replaced-by': [{ 'id-type': 'doi', id: '10.1/replacement', 'asserted-by': 'subject' }],
    };
    serve({ [JAMA]: body, [JAMA_NOTICE]: fixture('retraction/jama-notice.json') });
    const r = await checkRetraction(JAMA);
    expect(r.replacement).toEqual({
      status: 'replaced',
      replacementDOI: '10.1/replacement',
      evidence: ['crossref_is_replaced_by'],
    });
  });

  it('is-replaced-by naming the work itself is not a replacement', async () => {
    const body = clone(fixture('retraction/retracted-rw-jama.json'));
    body.data.message.relation = { 'is-replaced-by': [{ 'id-type': 'doi', id: JAMA.toUpperCase() }] };
    serve({ [JAMA]: body, [JAMA_NOTICE]: fixture('retraction/jama-notice.json') });
    expect((await checkRetraction(JAMA)).replacement.status).toBe('not_recorded');
  });

  it.each([
    ['Labs 503', { ['labs:' + JAMA]: httpError(503) }, 'lookup_failed'],
    ['Labs timeout', { ['labs:' + JAMA]: httpError(undefined, 'ECONNABORTED', 'timeout') }, 'lookup_failed'],
    ['notice 429', { [JAMA_NOTICE]: httpError(429) }, 'lookup_failed'],
    ['Labs HTML 200', { ['labs:' + JAMA]: { status: 200, data: '<html>' } }, 'malformed_response'],
  ])('a failed lookup (%s) with no positive signal is unknown, never not_recorded', async (_l, extra, reason) => {
    serve(Object.assign({ [JAMA]: fixture('retraction/retracted-rw-jama.json'), [JAMA_NOTICE]: fixture('retraction/jama-notice.json') }, extra as Record<string, any>));
    const r = await checkRetraction(JAMA);
    expect(r.replacement.status).toBe('unknown');
    expect(r.replacement.unknownReason).toBe(reason);
    expect(r.verdict).toBe('flagged'); // the retraction itself stands
  });

  it.each([
    ['a non-object block', 'not a block'],
    ['a non-empty object block', { reasons: ['etract and Replace'] }],
    ['a record whose reasons is a string', [{ reasons: 'etract and Replace' }]],
    ['a record with no reasons key (a renamed key)', [{ 'update-reasons': ['etract and Replace'] }]],
  ])('an unreadable Labs block (%s) is unknown / malformed_response', async (_l, block) => {
    const labs = clone(fixture('retraction/labs-jama.json'));
    labs.data.message['cr-labs-updates'] = block;
    serve({
      [JAMA]: fixture('retraction/retracted-rw-jama.json'),
      [JAMA_NOTICE]: fixture('retraction/jama-notice.json'),
      ['labs:' + JAMA]: labs,
    });
    const r = await checkRetraction(JAMA);
    expect(r.replacement).toMatchObject({ status: 'unknown', unknownReason: 'malformed_response' });
  });

  // Q1 matrix for the two title readers: case, spacing, bracket, separator, position,
  // and the near-misses a meta-science bibliography is full of (a title ABOUT retraction).
  it.each([
    ['RETRACTED AND REPLACED: Some finding', true],
    ['RETRACTED AND REPLACED Some finding', true],
    ['  RETRACTED  AND  REPLACED : Some finding', true],
    ['[Retracted and replaced] Some finding', true],
    ['[ RETRACTED AND REPLACED ] Some finding', true],
    ['Retracted and replaced: Some finding', true],
    ['Retracted and Replaced – Some finding', true],
    ['Retracted and replaced articles in medicine: a review', false],
    ['Retracted and replaced papers', false],
    ['Some finding: retracted and replaced', false],
    ['RETRACTED: Some finding', false],
    ['Retracted and replaced - Some finding', true],
    ['Retracted and replaced — Some finding', true],
    ['Retracted and replaced： Some finding', true],
    ['Retracted and replaced. Some finding', true],
    [`Retracted${String.fromCharCode(0xa0)}and replaced: Some finding (a no-break space)`, true],
    ['RETRACTED AND\nREPLACED Some finding', true],
    ['Retracted & replaced: Some finding', true],
    ['RETRACTED & REPLACED Some finding', true],
    ['(Retracted and replaced) Some finding', true],
    ['RETRACTED AND REPUBLISHED: Some finding', true],
    ['Retracted and republished: Some finding', true],
    ['Retracted and republished articles: a bibliometric study', false],
    ['Retracted and replacement trials', false],
  ])('the work title %j is a replacement title marker: %s', async (title, marked) => {
    const work = clone(fixture('retraction/rr-title-carcin.json'));
    work.data.message.title = [title];
    serve({
      [CARCIN]: work,
      '10.1093/carcin/bgaf065': httpError(429),
      ['labs:' + CARCIN]: httpError(503),
    });
    const r = await checkRetraction(CARCIN);
    expect(r.isRetracted).toBe(true);
    expect(r.replacement.evidence.includes('title_marker')).toBe(marked);
  });

  it.each([
    ['Retraction and replacement of: Some finding', true],
    ['RETRACTION AND REPLACEMENT OF Some finding', true],
    ['  Retraction  and  Replacement: Some finding', true],
    ['Notice of Retraction and Replacement: Some finding', true],
    ['NOTICE OF RETRACTION AND REPLACEMENT. Some finding', true],
    ['Retraction of: Some finding', false],
    ['Notice of Retraction: Some finding', false],
    ['Some finding: retraction and replacement', false],
    ['Retraction and Republication: Some finding', true],
    ['Retraction & replacement of: Some finding', true],
    ['RETRACTION AND REPUBLICATION Some finding', true],
    ['Retraction and Correction: Some finding', false],
  ])('the notice title %j is a replacement notice title: %s', async (title, marked) => {
    const work = clone(fixture('retraction/rr-title-carcin.json'));
    work.data.message.title = ['Some finding'];
    const notice = clone(fixture('retraction/rr-notice-carcin.json'));
    notice.data.message.title = [title];
    serve({
      [CARCIN]: work,
      '10.1093/carcin/bgaf065': notice,
      ['labs:' + CARCIN]: httpError(503),
    });
    const r = await checkRetraction(CARCIN);
    expect(r.isRetracted).toBe(true);
    expect(r.replacement.evidence.includes('notice_title')).toBe(marked);
  });

  it.each([['Error in Analyses'], ['rror in Results and/or Conclusions'], ['Retract and Replace (in part)'], ['Withdrawal']])(
    'the reason %j is not Retract and Replace',
    async (reason) => {
      const labs = clone(fixture('retraction/labs-jama.json'));
      labs.data.message['cr-labs-updates'][0].reasons = [reason];
      labs.data.message['cr-labs-updates'][0].notes = '';
      serve({
        [JAMA]: fixture('retraction/retracted-rw-jama.json'),
        [JAMA_NOTICE]: fixture('retraction/jama-notice.json'),
        ['labs:' + JAMA]: labs,
      });
      const r = await checkRetraction(JAMA);
      expect(r.replacement.evidence).not.toContain('retraction_watch_reason');
      // Q2: the queried DOI is returned as originalPaperDOI.
      expect(r.originalPaperDOI).toBe(JAMA);
    }
  );

  it('a positive signal stands even when the other lookups failed', async () => {
    serve({
      [CARCIN]: fixture('retraction/rr-title-carcin.json'),
      '10.1093/carcin/bgaf065': httpError(429),
      ['labs:' + CARCIN]: httpError(503),
    });
    expect((await checkRetraction(CARCIN)).replacement).toEqual({ status: 'replaced', evidence: ['title_marker'] });
  });

  it.each([['etract and Replace'], ['+Retract and Replace'], ['Retract and Replace'], ['retract and replace'], ['  Retract  and  Replace  ']])(
    'the reason %j is recognised (Labs cuts the first character; the CSV prefixes "+")',
    async (reason) => {
      const labs = clone(fixture('retraction/labs-jama.json'));
      labs.data.message['cr-labs-updates'][0].reasons = [reason];
      labs.data.message['cr-labs-updates'][0].notes = '';
      serve({
        [JAMA]: fixture('retraction/retracted-rw-jama.json'),
        [JAMA_NOTICE]: fixture('retraction/jama-notice.json'),
        ['labs:' + JAMA]: labs,
      });
      expect((await checkRetraction(JAMA)).replacement).toEqual({
        status: 'replaced',
        evidence: ['retraction_watch_reason'],
      });
    }
  );

  it.each([
    ['a 3-digit registrant (DOI_SHAPE allows 3 to 9)', '10.123/abc.def', '10.123/abc.def'],
    ['a 9-digit registrant', '10.123456789/x1', '10.123456789/x1'],
    ['a 10-digit registrant (not DOI-shaped)', '10.1234567890/x1', undefined],
  ])('a notes DOI with %s is read with the shared DOI shape', async (_l, noted, expected) => {
    const labs = clone(fixture('retraction/labs-jama.json'));
    labs.data.message['cr-labs-updates'][0].reasons = ['etract and Replace'];
    labs.data.message['cr-labs-updates'][0].notes = `Replacement: https://example.org/doi/${noted}.`;
    const work = clone(fixture('retraction/rr-replacement-infdis.json'));
    work.data.message.DOI = noted;
    serve({
      [JAMA]: fixture('retraction/retracted-rw-jama.json'),
      [JAMA_NOTICE]: fixture('retraction/jama-notice.json'),
      ['labs:' + JAMA]: labs,
      [noted]: work,
    });
    const r = await checkRetraction(JAMA);
    expect(r.replacement.status).toBe('replaced');
    expect(r.replacement.replacementDOI).toBe(expected);
  });

  // v0.4.0 review: a note naming more than one work had its FIRST confirmed DOI reported as the
  // replacement (an editorial about the paper, a related paper). Bodies derived; see each cell.
  const A = '10.9999/editorial';
  const B = '10.9999/newver';
  const NET = 'network';
  it.each<[string, string, Record<string, 'work' | 'net'>, string | undefined]>([
    ['two works, the second after "replaced by"', `Editorial about this: ${A}; replaced by ${B}`, { [A]: 'work', [B]: 'work' }, B],
    ['two works, the first after "see instead"', `see instead: ${B}; editorial: ${A}`, { [A]: 'work', [B]: 'work' }, B],
    ['a cue before a URL prefix', `Editorial ${A}. See instead: https://example.org/doi/${B}`, { [A]: 'work', [B]: 'work' }, B],
    ['two works, no cue: none is chosen', `see also: ${A}; see also: ${B}`, { [A]: 'work', [B]: 'work' }, undefined],
    ['two works, both after a cue: none is chosen', `replaced by ${A}; replaced by ${B}`, { [A]: 'work', [B]: 'work' }, undefined],
    ['one work and one 404 (an answer: not a work)', `${A} and ${B}`, { [B]: 'work' }, B],
    ['the same DOI twice', `${B}; see ${B}`, { [B]: 'work' }, B],
    ['one work, the cued one failed to load: none is chosen', `${A}; replaced by ${B}`, { [A]: 'work', [B]: 'net' }, undefined],
    ['one cued work, an uncued one failed to load', `replaced by ${B}; also ${A}`, { [A]: 'net', [B]: 'work' }, B],
    ['one work, another failed to load, no cue: none is chosen', `${A}; ${B}`, { [A]: 'net', [B]: 'work' }, undefined],
  ])('notes naming several DOIs: %s', async (_l, notes, works, expected) => {
    const labs = clone(fixture('retraction/labs-jama.json'));
    labs.data.message['cr-labs-updates'][0].reasons = ['etract and Replace'];
    labs.data.message['cr-labs-updates'][0].notes = notes;
    const bodies: Record<string, any> = {
      [JAMA]: fixture('retraction/retracted-rw-jama.json'),
      [JAMA_NOTICE]: fixture('retraction/jama-notice.json'),
      ['labs:' + JAMA]: labs,
    };
    for (const [doi, kind] of Object.entries(works)) {
      if (kind === 'net') bodies[doi] = httpError(undefined, 'ECONNRESET', NET);
      else {
        const w = clone(fixture('retraction/rr-replacement-infdis.json'));
        w.data.message.DOI = doi;
        bodies[doi] = w;
      }
    }
    serve(bodies);
    const r = await checkRetraction(JAMA);
    expect(r.replacement.status).toBe('replaced');
    expect(r.replacement.replacementDOI).toBe(expected);
  });

  it('checkReplacement: false makes no extra request and says unknown / not_requested', async () => {
    serve({ [JAMA]: fixture('retraction/retracted-rw-jama.json') });
    const r = await checkRetraction(JAMA, { checkReplacement: false });
    expect(r.replacement).toEqual({ status: 'unknown', evidence: [], unknownReason: 'not_requested' });
    expect(crossrefGetMock).toHaveBeenCalledTimes(1);
  });

  it('a clean result makes no replacement lookup and has no replacement field', async () => {
    serve({ [CITING]: fixture('not-retracted.json') });
    const r = await checkRetraction(CITING);
    expect(r.replacement).toBeUndefined();
    expect(crossrefGetMock).toHaveBeenCalledTimes(1);
  });

  it('the title path is looked up too; the OpenRetractions path has no Crossref record, so unknown', async () => {
    serve({ '10.3892/ol.2018.7943': fixture('retracted-bracketed.json') });
    expect((await checkRetraction('10.3892/ol.2018.7943')).replacement).toEqual({
      status: 'not_recorded',
      evidence: [],
    });
    axiosGetMock.mockResolvedValue({ status: 200, data: { retracted: true } });
    const r = await checkRetraction(JAMA, { sources: ['openretractions'] });
    expect(r.replacement.status).toBe('unknown');
  });
});
