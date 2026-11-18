/**
 * Fields the sources actually serve (2026-11-18 sweep, second round).
 *
 * Class: "a check reads a field its source does not serve, so it never fires and reports
 * clean", and its sibling "one input shape read differently". Members found by the
 * v0.3.0 review, each checked against a RECORDED response (tests/fixtures/):
 *  - Replies: HAS_ERRATA read relation `is-corrected-by` and IS_RESPONSE read
 *    `is-response-to`; Crossref rejects both relation types. Corrections are in `updated-by`.
 *  - Preprint: `institution` is an array, so the server was always 'Unknown'; the posted
 *    date was unpadded ("2020-3-22"); the 10.1101 prefix flagged Cold Spring Harbor
 *    journal articles as bioRxiv preprints.
 *  - DOAJ: the ISSN was sent without its hyphen, which DOAJ never finds; a failure was
 *    `{ found: false }`, the same as "not listed".
 *  - Expression of concern: Europe PMC hits were matched by lower-casing only, so a record
 *    written 10.1037//... was not this paper.
 * Every assertion that names one of these fails on 420e472.
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

const { checkReferenceForReplies } = await import('../../src/replies/index.js');
const { checkReferenceForPreprint, detectKnownPreprintFromDoi } = await import('../../src/preprint/preprintDetectionService.js');
const { checkDOAJ } = await import('../../src/predatory/doaj.js');
const { determineVerdict } = await import('../../src/predatory/verdict.js');
const { normalizeIssn } = await import('../../src/util/normalize.js');
const { checkReferenceForEOCDetailed } = await import('../../src/expressionOfConcern/expressionOfConcernService.js');

const fixture = (rel: string) => JSON.parse(readFileSync(`tests/fixtures/${rel}`, 'utf8'));
const ref = (doi: string, extra: Record<string, unknown> = {}) => ({ id: 'r', raw_text: 'x', doi, ...extra }) as any;
const crossrefServes = (rel: string) => crossrefGetMock.mockResolvedValue({ status: 200, data: fixture(rel) });

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('replies: corrections come from updated-by, responses from is-reply-to', () => {
  it('a corrected paper is HAS_ERRATA naming the notice and its date', async () => {
    crossrefServes('crossref/corrected.json');
    const issues = await checkReferenceForReplies(ref('10.1088/1361-6595/aaebdb'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'HAS_ERRATA', severity: 'warning',
      metadata: { replyType: 'errata', replyCount: 1, replyDOI: '10.1088/1361-6595/ab245f', replyDate: '2019-07-11', source: 'CrossRef' },
    });
  });

  it('an author comment is IS_RESPONSE', async () => {
    crossrefServes('crossref/is-reply-to.json');
    const issues = await checkReferenceForReplies(ref('10.5194/hess-2018-380-ac1'));
    expect(issues.map((i: any) => i.code)).toEqual(['IS_RESPONSE']);
    expect(issues[0].metadata?.replyDOI).toBe('10.5194/hess-2018-380-RC1');
  });

  it('has-reply is still HAS_AUTHOR_REPLY (control)', async () => {
    crossrefServes('crossref/has-reply.json');
    const issues = await checkReferenceForReplies(ref('10.1162/99608f92.66fb00a2'));
    expect(issues.map((i: any) => i.code)).toEqual(['HAS_AUTHOR_REPLY']);
    expect(issues[0].metadata?.replyCount).toBe(2);
  });

  it('a retraction or an expression of concern is not an erratum (controls)', async () => {
    crossrefServes('crossref/retracted-plain-title.json');
    expect(await checkReferenceForReplies(ref('10.1126/science.1256151'))).toEqual([]);
    crossrefServes('crossref/eoc-publisher.json');
    expect(await checkReferenceForReplies(ref('10.1016/j.lungcan.2003.10.006'))).toEqual([]);
    crossrefServes('crossref/not-retracted.json');
    expect(await checkReferenceForReplies(ref('10.1038/nature12373'))).toEqual([]);
  });
});

describe('preprint: institution array, padded posted date, the 10.1101 prefix', () => {
  it('the Crossref path reads the server from the institution array', async () => {
    const rec = fixture('crossref/preprint-biorxiv.json');
    rec.message.DOI = '10.9999/not-a-known-prefix';
    crossrefGetMock.mockResolvedValue({ status: 200, data: rec });
    const issues = await checkReferenceForPreprint(ref('10.9999/not-a-known-prefix'));
    expect(issues[0]).toMatchObject({
      code: 'IS_PREPRINT', metadata: { preprintServer: 'bioRxiv', preprintDate: '2020-03-22', source: 'CrossRef' },
    });
  });

  it('a Cold Spring Harbor journal article under 10.1101 is not a preprint', async () => {
    crossrefServes('crossref/cshl-journal-article.json');
    expect(detectKnownPreprintFromDoi('10.1101/pdb.prot099176')).toBeNull();
    expect(detectKnownPreprintFromDoi('10.1101/gr.123456.111')).toBeNull();
    expect(await checkReferenceForPreprint(ref('10.1101/pdb.prot099176'))).toEqual([]);
  });

  it('bioRxiv suffix forms are still recognised (controls)', () => {
    for (const d of ['10.1101/2020.03.22.002386', '10.1101/2020.03.22.002386v2', '10.1101/002386', '10.1101/19001234']) {
      expect(detectKnownPreprintFromDoi(d)).toBe('bioRxiv/medRxiv');
    }
  });

  it('suggested_doi is used when doi is absent (recorded, not live)', async () => {
    crossrefServes('crossref/not-retracted.json');
    const issues = await checkReferenceForPreprint({ id: 'r', raw_text: 'x', suggested_doi: '10.1038/nature12373' } as any);
    expect(issues).toEqual([]);
    expect(String(crossrefGetMock.mock.calls[0][0])).toContain('10.1038');
  });
});

describe('DOAJ: the hyphenated ISSN, and could-not-check is not "not listed"', () => {
  const doajServes = () =>
    axiosGetMock.mockImplementation(async (url: any) => ({
      status: 200,
      data: String(url).endsWith('issn:1932-6203') ? fixture('doaj/found-hyphenated.json') : fixture('doaj/not-found-unhyphenated.json'),
    }));

  it.each(['1932-6203', '19326203', ' ISSN 1932-6203 ', 'eISSN: 1932 6203', '1932–6203'])('%j finds PLOS ONE', async (issn) => {
    doajServes();
    const r = await checkDOAJ(issn);
    expect(r).toMatchObject({ found: true });
    expect(r.unavailable).toBeUndefined();
    expect(String(axiosGetMock.mock.calls[0][0])).toMatch(/issn:1932-6203$/);
  });

  it('normalizeIssn: one form, check digit upper-cased; non-ISSNs are null (controls)', () => {
    expect(normalizeIssn('2434-561x')).toBe('2434-561X');
    for (const bad of ['', '1234-567', '2019', '12345-6789', 'abcd-efgh', null, undefined]) expect(normalizeIssn(bad as any)).toBeNull();
  });

  it('a timeout or 5xx is unavailable, and the verdict says DOAJ was not checked', async () => {
    axiosGetMock.mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' }));
    const r = await checkDOAJ('1932-6203');
    expect(r).toEqual({ found: false, unavailable: true, reason: 'ECONNABORTED' });
    const v = determineVerdict(false, r, { isPredatory: false, confidence: 0, indicators: [] } as any);
    expect(v.reasoning).toMatch(/DOAJ could not be checked/);
  });

  it('a 200 without a result list is unavailable', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: '<html>maintenance</html>' });
    expect(await checkDOAJ('1932-6203')).toEqual({ found: false, unavailable: true, reason: 'malformed_response' });
  });

  it('a real miss is found:false without unavailable (control)', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: fixture('doaj/not-found-unhyphenated.json') });
    expect(await checkDOAJ('0000-0019')).toEqual({ found: false });
  });
});

describe('expression of concern: Europe PMC hit matched with the shared DOI comparer', () => {
  it('a record that writes the DOI with a doubled slash is this paper', async () => {
    const epmc = fixture('europepmc/eoc-in.json');
    epmc.resultList.result[0].doi = '10.1371//journal.pone.0061107';
    crossrefGetMock.mockResolvedValue({ status: 200, data: fixture('crossref/not-retracted.json') });
    axiosGetMock.mockResolvedValue({ status: 200, data: epmc });
    const r = await checkReferenceForEOCDetailed(ref('10.1371/journal.pone.0061107'));
    expect(r.issues.filter((i: any) => i.code === 'EOC_PUBMED')).toHaveLength(1);
  });
});
