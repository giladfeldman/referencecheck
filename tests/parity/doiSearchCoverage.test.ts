/**
 * The DOI search: every reject path counted, "no match" told apart from "could not search",
 * and every returned field asserted (2026-11-18 sweep, classes (c), (d), (e)).
 *
 * Before: findDOIFromReference returned null for "nothing matched", "skipped thesis",
 * "every candidate rejected" and "Crossref unreachable" alike; rejected candidates were
 * only logged; and no test read the CrossrefResult fields (title, authors, publishedDate,
 * journal, score) that a consumer stores.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: jest.fn(), post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});

const lib: any = await import('../../src/index.js');

const REF = 'Alder, J. (2019). Priming effects. Journal of Psychology, 1, 1-2.';
const item = (doi: string, family: string, year: number, score: number) => ({
  DOI: doi, score, title: ['Priming effects'], author: [{ family, given: 'J.' }, { family: 'Berg' }],
  published: { 'date-parts': [[year, 3, 5]] }, 'container-title': ['Journal of Psychology'],
});
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status } });

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query down'));
});

describe('findDOIFromReferenceDetailed', () => {
  it('found: returns every CrossrefResult field, dates as ISO', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [item('10.1/ok', 'Alder', 2019, 80)] } } });
    const out = await lib.findDOIFromReferenceDetailed(REF);
    expect(out.status).toBe('found');
    const { rawData, ...fields } = out.result;
    expect(fields).toEqual({
      found: true, doi: '10.1/ok', title: 'Priming effects', authors: ['Alder, J.', 'Berg'],
      publishedDate: '2019-03-05', journal: 'Journal of Psychology', score: 80,
      // 0.3.0: how each check against the reference went
      authorCheck: 'matched', yearCheck: 'matched', titleCheck: 'matched',
    });
    expect(rawData.DOI).toBe('10.1/ok');
  });

  it('no_match: counts every rejected candidate and every below-threshold one', async () => {
    axiosGetMock.mockResolvedValue({
      status: 200,
      data: { message: { items: [item('10.1/low', 'Alder', 2019, 20), item('10.1/wrong-author', 'Zhang', 2019, 90), item('10.1/wrong-year', 'Alder', 2009, 90)] } },
    });
    const out = await lib.findDOIFromReferenceDetailed(REF);
    expect(out.status).toBe('no_match');
    expect(out.result).toBeNull();
    expect(out.belowScoreThreshold).toBe(1);
    expect(out.rejected.map((r: any) => [r.doi, r.stage, r.reason.split(':')[0]])).toEqual([
      ['10.1/wrong-author', 'search', 'Author mismatch'],
      ['10.1/wrong-year', 'search', 'Year mismatch'],
    ]);
  });

  it('lookup_failed: a Crossref outage is not reported as "no DOI exists"', async () => {
    axiosGetMock.mockRejectedValue(httpError(500));
    const out = await lib.findDOIFromReferenceDetailed(REF);
    expect(out.status).toBe('lookup_failed');
    expect(out.errors.length).toBe(2); // both stages failed, both recorded
    expect(await lib.findDOIFromReference(REF)).toBeNull(); // the old signature is unchanged
  });

  it('skipped_unpublishable: a thesis is skipped and says so, with no request sent', async () => {
    const out = await lib.findDOIFromReferenceDetailed('Alder, J. (2019). A study [Doctoral dissertation, University of X].');
    expect(out.status).toBe('skipped_unpublishable');
    expect(axiosGetMock).not.toHaveBeenCalled();
  });

  it('a simple-text candidate that fails the match check is counted too', async () => {
    axiosPostMock.mockResolvedValue({ status: 200, data: '10.1/st|Priming effects|Zhang|2019|J' });
    axiosGetMock.mockImplementation(async (url: string, cfg: any) => {
      if (cfg?.params) return { status: 200, data: { message: { items: [] } } }; // search: empty
      return { status: 200, data: { message: item('10.1/st', 'Zhang', 2019, 0) } }; // validateDOI
    });
    const out = await lib.findDOIFromReferenceDetailed(REF);
    expect(out.status).toBe('no_match');
    expect(out.rejected).toEqual([{ doi: '10.1/st', stage: 'simple_text_query', reason: expect.stringMatching(/^Author mismatch/),
      authorCheck: 'mismatched', yearCheck: 'matched', titleCheck: 'matched' }]);
  });
});

describe('validateDOI returns every field, dates as ISO', () => {
  it('maps the Crossref record field by field', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: item('10.1/validate-fields', 'Alder', 2019, 0) } });
    const out = await lib.validateDOI('10.1/validate-fields');
    expect(out.valid).toBe(true);
    expect(out.source).toBe('crossref');
    const { rawData, ...fields } = out.data;
    expect(fields).toEqual({
      found: true, doi: '10.1/validate-fields', title: 'Priming effects', authors: ['Alder, J.', 'Berg'],
      publishedDate: '2019-03-05', journal: 'Journal of Psychology', score: 100,
    });
  });
});

describe('shared readers (src/util/normalize.ts)', () => {
  it('formatDateParts pads and keeps only the precision given', () => {
    expect(lib.formatDateParts([2019, 3, 5])).toBe('2019-03-05');
    expect(lib.formatDateParts([2019, 3])).toBe('2019-03');
    expect(lib.formatDateParts([2019])).toBe('2019');
    expect(lib.formatDateParts([])).toBeUndefined();
    expect(lib.formatDateParts(undefined)).toBeUndefined();
  });
  it('cleanDoiInput keeps case and leaves a non-DOI recognisably non-DOI', () => {
    expect(lib.cleanDoiInput(' https://doi.org/10.1037/ABC ')).toBe('10.1037/ABC');
    expect(lib.cleanDoiInput('doi:not-a-doi')).toBe('not-a-doi');
    expect(lib.cleanDoiInput(null)).toBe('');
  });
  it('splitAuthorList keeps "Surname, Initials" together and splits authors', () => {
    expect(lib.splitAuthorList('Smith, J. A., Jones, K., & Lee, M.-H.')).toEqual(['Smith, J. A.', 'Jones, K.', 'Lee, M.-H.']);
    expect(lib.splitAuthorList('Smith J, Jones K')).toEqual(['Smith J', 'Jones K']);
    expect(lib.splitAuthorList('King, M. L., Jr.; Anderson, B.')).toEqual(['King, M. L., Jr.', 'Anderson, B.']);
  });
});
