/**
 * v0.3.0 review, attempt 2 (2026-11-18). Each block is a defect the second review
 * reproduced; the first three were introduced by this release's own shared readers.
 *  - splitAuthorList read an all-caps surname ("LI", "SMITH") as initials and merged authors.
 *  - normalizeIssn accepted page and year ranges ("1648-1655", "2019-2020") as ISSNs.
 *  - The anchored 10.1101 rule rejected "...002386.v1", "...v1.full" and a trailing "."; the
 *    new openRxiv prefix 10.64898 was not listed.
 *  - Expression of concern: a Crossref 404 (DOI not registered at Crossref) was "clean".
 *  - Journal metadata read `container-title-short`, which Crossref does not serve.
 *  - HAS_ERRATA fired on `addendum`.
 *  - foldForMatch left ø, ł, ß, đ unfolded, so "Østergaard" did not match "Ostergaard".
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

const crossrefGetMock = jest.fn<any>();
const axiosGetMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  return { default: { get: axiosGetMock, isAxiosError }, isAxiosError };
});
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));

const norm = await import('../../src/util/normalize.js');
const { detectKnownPreprintFromDoi } = await import('../../src/preprint/preprintDetectionService.js');
const { checkReferenceForEOCDetailed } = await import('../../src/expressionOfConcern/expressionOfConcernService.js');
const { extractJournalMetadata } = await import('../../src/predatory/journalMetadata.js');
const { checkReferenceForReplies } = await import('../../src/replies/index.js');
const { checkDOAJ } = await import('../../src/predatory/doaj.js');

const fixture = (rel: string) => JSON.parse(readFileSync(`tests/fixtures/${rel}`, 'utf8'));

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('splitAuthorList: an all-caps surname is not initials', () => {
  it.each([
    ['LI, X., WU, Y.', ['LI, X.', 'WU, Y.']],
    ['SMITH, J., JONES, K.', ['SMITH, J.', 'JONES, K.']],
    ['SMITH, J. K., JONES, K.-L.', ['SMITH, J. K.', 'JONES, K.-L.']],
    // controls
    ['Smith, J. A., Jones, K., & Lee, M.-H.', ['Smith, J. A.', 'Jones, K.', 'Lee, M.-H.']],
    ['Smith, J.K., Jones, K.', ['Smith, J.K.', 'Jones, K.']],
    ['King, M. L., Jr.; Anderson, B.', ['King, M. L., Jr.', 'Anderson, B.']],
  ])('%j', (input, want) => {
    expect(norm.splitAuthorList(input)).toEqual(want);
  });
});

describe('normalizeIssn: the check digit', () => {
  it('rejects page and year ranges that have the ISSN shape', () => {
    for (const s of ['1648-1655', '2019-2020', '1932-6204']) expect(norm.normalizeIssn(s)).toBeNull();
  });
  it('accepts real ISSNs (controls)', () => {
    expect(norm.normalizeIssn('1932-6203')).toBe('1932-6203');
    expect(norm.normalizeIssn('0028-0836')).toBe('0028-0836');
    expect(norm.normalizeIssn('2434-561x')).toBe('2434-561X');
  });
  it('checkDOAJ does not ask DOAJ for a non-ISSN, and says so', async () => {
    expect(await checkDOAJ('1648-1655')).toEqual({ found: false, unavailable: true, reason: 'invalid_issn' });
    expect(axiosGetMock).not.toHaveBeenCalled();
    expect(await checkDOAJ('')).toEqual({ found: false });
  });
});

describe('preprint DOI forms', () => {
  it.each([
    '10.1101/2020.03.22.002386.v1', '10.1101/2020.03.22.002386v1.full', '10.1101/2020.03.22.002386.',
    '10.64898/2026.01.10.698791',
  ])('%j is bioRxiv/medRxiv', (d) => {
    expect(detectKnownPreprintFromDoi(d)).toBe('bioRxiv/medRxiv');
  });
  it('Cold Spring Harbor journal articles stay out (control)', () => {
    expect(detectKnownPreprintFromDoi('10.1101/pdb.prot099176.')).toBeNull();
  });
});

describe('expression of concern: a Crossref 404 is not_indexed, not clean', () => {
  it('a DOI Crossref does not hold leaves the check incomplete', async () => {
    crossrefGetMock.mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { isAxiosError: true, response: { status: 404 } }));
    axiosGetMock.mockResolvedValue({ status: 200, data: fixture('europepmc/not-found.json') });
    const r = await checkReferenceForEOCDetailed({ id: 'r', raw_text: 'x', doi: '10.5281/zenodo.1' } as any);
    expect(r.complete).toBe(false);
    expect(r.sourcesChecked).not.toContain('CrossRef');
    expect(r.sourcesChecked).toContain('PubMed');
    expect(r.sourcesUnavailable).toEqual([{ source: 'CrossRef', reason: 'not_indexed', detail: '404' }]);
  });
});

describe('journal metadata: short-container-title', () => {
  it('reads the abbreviation Crossref serves when the full title is missing', async () => {
    const msg = fixture('crossref/not-retracted.json').message;
    delete msg['container-title'];
    msg['short-container-title'] = ['Nature'];
    const meta = await extractJournalMetadata({ id: 'r', raw_text: 'x', doi_crossref_data: msg } as any, false);
    expect(meta.journal).toBe('Nature');
  });
});

describe('replies: an addendum is not an erratum', () => {
  it('updated-by type addendum raises nothing; correction does (control)', async () => {
    const rec = fixture('crossref/corrected.json');
    rec.message['updated-by'][0].type = 'addendum';
    crossrefGetMock.mockResolvedValue({ status: 200, data: rec });
    expect(await checkReferenceForReplies({ id: 'r', raw_text: 'x', doi: '10.1088/1361-6595/aaebdb' } as any)).toEqual([]);
    crossrefGetMock.mockResolvedValue({ status: 200, data: fixture('crossref/corrected.json') });
    expect((await checkReferenceForReplies({ id: 'r', raw_text: 'x', doi: '10.1088/1361-6595/aaebdb' } as any))[0].code).toBe('HAS_ERRATA');
  });
});

describe('foldForMatch: letters NFKD does not decompose', () => {
  it.each([
    ['Østergaard', 'ostergaard'], ['Łukasz', 'lukasz'], ['Straße', 'strasse'], ['Đorđević', 'dordevic'], ['Ærø', 'aero'],
  ])('%j', (a, want) => {
    expect(norm.foldForMatch(a)).toBe(want);
  });
});
