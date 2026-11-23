/**
 * v0.3.0 review 12 (2026-11-23). Class: "an HTTP reply is taken as the source's answer without
 * checking that its body is one". A 200 (or, for OpenRetractions, a 404) whose body is not the
 * source's data (an HTML captive portal, a parked domain, an error page) was read as an answer, so
 * "could not check" became "checked, clean" or a number. Members, each reader of an external reply:
 * the Crossref retraction lookup (200), the OpenRetractions 404, validateDOI (200), the Crossref
 * search (200 without a result list), and the OpenCitations count (a text body read by parseInt).
 * Readers checked and already guarded (no test here): expression of concern, replies, preprint
 * (array added), DOAJ, abstracts. Readers whose "nothing" already means "could not check" too, so a
 * bad body changes no claim: OpenAlex metadata fill, Unpaywall, getCitingWorks (logged as debt).
 *
 * Also review 12, the title part rule (review 11 follow-up): a reference that writes no part is
 * not matched to a record of one part ("X, Part II"), and a roman numeral opening the next
 * sentence (a journal such as "II Farmaco") is not a part number.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
const axiosHeadMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: axiosHeadMock, post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});
const lib: any = await import('../../src/index.js');

const HTML = '<!DOCTYPE html><html><body>Please sign in to the network</body></html>';
const httpError = (status: number, data?: unknown) => {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.isAxiosError = true;
  e.response = { status, data };
  return e;
};

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosHeadMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
});

describe('review 12: a reply that is not the source\'s answer is "could not check"', () => {
  it.each([
    ['an HTML page', HTML],
    ['an array', []],
    ['no body', undefined],
  ])('Crossref retraction lookup, 200 with %s: not checked', async (_name, body) => {
    axiosGetMock.mockResolvedValue({ status: 200, data: body === undefined ? undefined : { message: body } });
    if (typeof body === 'string') axiosGetMock.mockResolvedValue({ status: 200, data: body });
    const d = await lib.checkRetractionDetailed('10.1234/abc', { sources: ['crossref'] });
    expect(d.retraction.checked).toBe(false);
    expect(d.complete).toBe(false);
    expect(d.sourcesUnavailable).toEqual([{ source: 'crossref', reason: 'server_error', detail: '200 without a work record' }]);
  });

  it('Crossref retraction lookup, a work record that is not retracted: checked (control)', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: { DOI: '10.1234/abc', title: ['A work'] } } });
    const d = await lib.checkRetractionDetailed('10.1234/abc', { sources: ['crossref'] });
    expect(d.retraction.checked).toBe(true);
    expect(d.retraction.isRetracted).toBe(false);
  });

  it.each([
    ['an HTML page', HTML],
    ['no body', undefined],
  ])('OpenRetractions 404 with %s: not checked', async (_name, body) => {
    axiosGetMock.mockRejectedValue(httpError(404, body));
    const d = await lib.checkRetractionDetailed('10.1234/abc', { sources: ['openretractions'] });
    expect(d.retraction.checked).toBe(false);
    expect(d.sourcesUnavailable).toEqual([{ source: 'openretractions', reason: 'server_error', detail: '404 without a JSON body' }]);
  });

  it('OpenRetractions 404 with a JSON body: answered, not retracted (control)', async () => {
    axiosGetMock.mockRejectedValue(httpError(404, { message: 'not found' }));
    const d = await lib.checkRetractionDetailed('10.1234/abc', { sources: ['openretractions'] });
    expect(d.retraction.checked).toBe(true);
    expect(d.retraction.isRetracted).toBe(false);
  });

  it('validateDOI, Crossref 200 with an HTML page: an unavailable-source error, not a crash', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: HTML });
    const v = await lib.validateDOI('10.9999/review12-html');
    expect(v.valid).toBe(false);
    expect(v.error).toBe('[Crossref API] 200 without a work record');
  });

  it('Crossref search, 200 without a result list: lookup_failed, not no_match', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: HTML });
    const out = await lib.findDOIFromReferenceDetailed('Smith, J. (2019). Causal inference in practice. Journal of Statistics, 4, 1-10.');
    expect(out.status).toBe('lookup_failed');
    expect(out.errors).toContain('search: 200 without a result list');
  });

  it('Crossref search, 200 with an empty result list: no_match (control)', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [] } } });
    const out = await lib.findDOIFromReferenceDetailed('Smith, J. (2019). Causal inference in practice. Journal of Statistics, 4, 1-10.');
    expect(out.status).toBe('no_match');
  });

  it('preprint check, Crossref 200 with an array: not an answer, so the reference own link decides', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: [] } });
    const issues = await lib.checkReferenceForPreprint({ doi: '10.1234/abc', url: 'https://www.biorxiv.org/content/10.1101/2020.01.01.123456v1' });
    expect(issues.length).toBe(1);
  });

  it.each([
    ['an error page starting with a number', '500 Internal Server Error'],
    ['a number followed by text', '42 citations'],
    ['a count field with text', [{ count: '12abc' }]],
  ])('OpenCitations count, %s: no count', async (_name, body) => {
    axiosGetMock.mockResolvedValue({ status: 200, data: body });
    expect(await lib.getCitationCount('10.1234/abc')).toBeNull();
  });

  it.each([
    ['a text count', '42', 42],
    ['an array of objects', [{ count: '17' }], 17],
    ['a number', 5, 5],
  ])('OpenCitations count, %s: read (control)', async (_name, body, want) => {
    axiosGetMock.mockResolvedValue({ status: 200, data: body });
    expect(await lib.getCitationCount('10.1234/abc')).toBe(want);
  });
});

describe('review 12 round 2: a field is read from the reply, never defaulted', () => {
  it.each([
    ['bronze', { is_oa: true, oa_status: 'bronze', journal_is_oa: false }, 'bronze'],
    ['hybrid', { is_oa: true, oa_status: 'hybrid', journal_is_oa: false }, 'hybrid'],
    ['green', { is_oa: true, oa_status: 'green', journal_is_oa: false }, 'green'],
    ['gold', { is_oa: true, oa_status: 'gold', journal_is_oa: true }, 'gold'],
    ['no oa_status (not guessed)', { is_oa: true, journal_is_oa: false }, undefined],
  ])('Unpaywall %s: openAccessStatus is the reply oa_status', async (_name, body, want) => {
    axiosGetMock.mockResolvedValue({ status: 200, data: body });
    const issues = await lib.checkReferenceForOpenAccess({ doi: '10.1234/oa' });
    expect(issues.length).toBe(1);
    expect(issues[0].metadata.openAccessStatus).toBe(want);
    expect(issues[0].description).toBe(want ? `This paper is available as ${want.toUpperCase()} open access` : 'This paper is available as open access (type not reported)');
  });

  it('the summary counts hybrid papers', () => {
    const issue = (s: string) => ({ type: 'open-access', severity: 'info', code: 'OA_AVAILABLE', description: '', location: '', metadata: { openAccessStatus: s } });
    expect(lib.getOpenAccessSummary([issue('hybrid'), issue('bronze'), issue('gold')])).toEqual({ openAccessCount: 3, goldOA: 1, hybridOA: 1, greenOA: 0, bronzeOA: 1 });
  });

  it('simple-text stage: a candidate Crossref could not validate is a stage error, not only a rejection', async () => {
    axiosPostMock.mockResolvedValue({ status: 200, data: '10.1234/review12-st|Causal inference|Smith|2019|J Stat' });
    axiosGetMock.mockResolvedValueOnce({ status: 200, data: HTML }).mockResolvedValue({ status: 200, data: { message: { items: [] } } });
    const out = await lib.findDOIFromReferenceDetailed('Smith, J. (2019). Causal inference in practice. Journal of Statistics, 4, 1-10.');
    expect(out.status).toBe('no_match');
    expect(out.errors).toContain('simple_text_query: validate 10.1234/review12-st: [Crossref API] 200 without a work record');
  });
});

interface Rec { title: string; authors: Array<[string, string]>; year: number }
const accepts = async (reference: string, rec: Rec) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [rec.title], subtitle: [],
    author: rec.authors.map(([family, given]) => ({ family, given })),
    published: { 'date-parts': [[rec.year, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(reference))?.doi === '10.1/found';
};
const SMITH: Array<[string, string]> = [['Smith', 'John']];

describe('review 12: the part rule', () => {
  it.each([
    ['no part written, record of Part II', 'Smith, J. (2019). Causal inference in practice. Journal of Statistics, 4, 1-10.', { title: 'Causal inference in practice, Part II', authors: SMITH, year: 2019 }],
    ['Part I written before the title, record of Part II', 'Smith, J. (2019). Part I: Causal inference in practice. Journal of Statistics, 4, 1-10.', { title: 'Causal inference in practice, Part II', authors: SMITH, year: 2019 }],
    ['no part written, record ending in a bare roman part', 'Smith, J. (2019). Causal inference in practice. Journal of Statistics, 4, 1-10.', { title: 'Causal inference in practice II', authors: SMITH, year: 2019 }],
  ])('%s is rejected', async (_name, reference, rec) => {
    expect(await accepts(reference, rec as Rec)).toBe(false);
  });

  it.each([
    ['the same part written after', 'Smith, J. (2019). Causal inference in practice, Part II. Journal of Statistics, 4, 1-10.', { title: 'Causal inference in practice, Part II', authors: SMITH, year: 2019 }],
    ['the part written before the title', 'Smith, J. (2019). Part II: Causal inference in practice. Journal of Statistics, 4, 1-10.', { title: 'Causal inference in practice, Part II', authors: SMITH, year: 2019 }],
    ['"Part II." as its own sentence before the title', 'Smith, J. (2019). Part II. Causal inference in practice. Journal of Statistics, 4, 1-10.', { title: 'Causal inference in practice, Part II', authors: SMITH, year: 2019 }],
    ['a title ending in a numeral after a short word (review 12 round 2)', 'Smith, J. (2020). Memory of survivors of World War II. Journal of Things, 1, 2-3.', { title: 'Memory of survivors of World War II', authors: SMITH, year: 2020 }],
    ['a title ending in a three-letter numeral', 'Smith, J. (2020). Attitudes toward Rocky III. Journal of Things, 1, 2-3.', { title: 'Attitudes toward Rocky III', authors: SMITH, year: 2020 }],
    ['a title with numerals inside and at the end', 'Smith, J. (2020). Psychology of Henry VIII and Pope Pius IX. Journal of Things, 1, 2-3.', { title: 'Psychology of Henry VIII and Pope Pius IX', authors: SMITH, year: 2020 }],
    ['a numeral inside the title', 'Smith, J. (2019). Type II diabetes in rural clinics. Journal of Statistics, 4, 1-10.', { title: 'Type II diabetes in rural clinics', authors: SMITH, year: 2019 }],
    ['a roman numeral opening the next sentence (a journal name)', 'Smith, J. (2019). Causal inference in practice. II Farmaco, 4, 1-10.', { title: 'Causal Inference in Practice', authors: SMITH, year: 2019 }],
  ])('%s is accepted', async (_name, reference, rec) => {
    expect(await accepts(reference, rec as Rec)).toBe(true);
  });
});
