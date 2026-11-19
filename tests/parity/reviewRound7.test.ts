/**
 * v0.3.0 review, attempt 7 (2026-11-19). Class: "a written shape read into a wrong value
 * that 0.2.x read right". Each block is one member the review reproduced against 0.2.x:
 *  - DOI matcher: a surname spelled in another script ("Иванов"/"Ivanov") or with the
 *    German digraph ("Müller"/"Mueller") rejected the right DOI; Vancouver "Hoddy KK" was
 *    read as surname "KK" (d-e977e3).
 *  - A DOI followed by citation text ("...002386)", " [preprint]", ".full.pdf") lost its
 *    preprint flag. Fixed once, in cleanDoiInput, for every DOI reader.
 *  - Journal ISSN: a page range in the text replaced a Crossref ISSN with a bad check digit.
 *  - Deduplication: one author list written two ways scored lower; two symbol-only titles
 *    scored 0.5 like two absent ones.
 *  - Errata: one correction written in two cases was counted twice.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: jest.fn(), post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});
const lib: any = await import('../../src/index.js');
// A record of a cited author carries that author's given name, as Crossref records do (round 17).
const { givenNameFor } = await import('../labelled/givenName.mjs');
const { extractJournalMetadata } = await import('../../src/predatory/journalMetadata.js');
const { detectKnownPreprintFromDoi } = await import('../../src/preprint/preprintDetectionService.js');

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
});

describe('DOI matcher: surnames', () => {
  const accepts = async (text: string, family: string) => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
      DOI: '10.1/found', score: 90, title: ['Priming effects'], author: [{ family, given: givenNameFor(text, family) }],
      published: { 'date-parts': [[2015, 1, 1]] },
    }] } } });
    return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
  };
  it.each([
    ['Иванов, И. И. (2015). Priming effects. J, 1, 2.', 'Ivanov', true],
    ['Müller, K. (2015). Priming effects. J, 1, 2.', 'Mueller', true],
    ['Mueller, K. (2015). Priming effects. J, 1, 2.', 'Müller', true],
    ['Hoddy KK, Gibbons C. Priming effects. J Things. 2015;3:1-2.', 'Hoddy', true],
    ['van der Berg JH, Smith A. Priming effects. J Things. 2015;3:1-2.', 'Berg', true],
    // controls: a different person in the same script is still rejected
    ['Müller, K. (2015). Priming effects. J, 1, 2.', 'Smith', false],
    ['Hoddy KK, Gibbons C. Priming effects. J Things. 2015;3:1-2.', 'Jones', false],
    ['Smith, J. (2015). Priming effects. J, 1, 2.', 'Smith', true],
  ])('%j vs Crossref family %j', async (text, family, want) => {
    expect(await accepts(text, family)).toBe(want);
  });
});

describe('a DOI followed by citation text', () => {
  const BASE = '10.1101/2020.03.22.002386';
  it.each([')', ']', ' [preprint]', '>', '"', ').', 'v1)', ':', 'v1.full.pdf', '.supplementary-material', '.'])('%j', (tail) => {
    expect(detectKnownPreprintFromDoi(BASE + tail)).toBe('bioRxiv/medRxiv');
  });
  it.each([
    ['10.1101/2020.03.22.002386)', BASE],
    ['doi:10.1101/2020.03.22.002386 [preprint]', BASE],
    ['https://doi.org/10.1037/a0012345.', '10.1037/a0012345'],
    // brackets that belong to the DOI stay
    ['10.1016/S0140-6736(20)30183-5', '10.1016/S0140-6736(20)30183-5'],
    ['10.1016/S0140-6736(20)30183-5).', '10.1016/S0140-6736(20)30183-5'],
    ['10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0', '10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0'],
    ['10.1000/abc<def>', '10.1000/abc<def>'],
    // not a DOI: returned as written (trimmed)
    ['not a doi).', 'not a doi).'],
  ])('cleanDoiInput(%j)', (input, want) => {
    expect(lib.cleanDoiInput(input)).toBe(want);
  });
  it('Cold Spring Harbor journal DOIs stay out (control)', () => {
    expect(detectKnownPreprintFromDoi('10.1101/pdb.prot099176).')).toBeNull();
    expect(detectKnownPreprintFromDoi('10.1101/gr.123456.110')).toBeNull();
  });
});

describe('journal ISSN', () => {
  const msg = () => JSON.parse(readFileSync('tests/fixtures/crossref/not-retracted.json', 'utf8')).message;
  const meta = async (crossref: any, raw: string): Promise<any> =>
    extractJournalMetadata({ id: 'r', raw_text: raw, doi_crossref_data: crossref } as any, false);
  it('the first valid Crossref ISSN wins; a bad one is listed; the text is not read', async () => {
    const m = await meta({ ...msg(), ISSN: ['1932-6204', '1932-6203'] }, 'Smith (2015). X. PLoS ONE, 10, 1015-1028.');
    expect(m.issn).toBe('1932-6203');
    expect(m.issnRejected).toEqual(['1932-6204']);
  });
  it('only invalid Crossref ISSNs: no ISSN, and the page range is not taken', async () => {
    const m = await meta({ ...msg(), ISSN: ['1932-6204'] }, 'Smith (2015). X. PLoS ONE, 10, 1015-1028.');
    expect(m.issn).toBeUndefined();
    expect(m.issnRejected).toEqual(['1932-6204']);
  });
  it('no Crossref ISSN: the first VALID candidate in the text', async () => {
    const c = msg();
    delete c.ISSN;
    const m = await meta(c, 'Smith (2015). X. J, 10, 1648-1655. ISSN 1932-6203.');
    expect(m.issn).toBe('1932-6203');
  });
});

describe('deduplication', () => {
  it.each([
    ['Smith, J., Jones, K.', 'J. Smith; K. Jones'],
    ['Smith, J. A.; Jones, K.', 'Smith JA, Jones K'],
    ['Smith, J. and Jones, K.', 'J. Smith & K. Jones'],
    ['Smith, Jr., Jones', 'Smith Jr; Jones'],
  ])('%j and %j are one list', (a, b) => {
    expect(lib.compareAuthors(a, b)).toBeCloseTo(1.0, 10);
  });
  it('a surname with no given name matches at the one-side-missing level (0.75)', () => {
    expect(lib.compareAuthors('Smith', 'Smith, J.')).toBeCloseTo(0.75, 10);
  });
  it('different people stay apart (control)', () => {
    expect(lib.compareAuthors('Smith, J.', 'Jones, K.')).toBeLessThan(0.5);
    expect(lib.compareAuthors('Smith, J.', 'Smith, K.')).toBeLessThan(1.0);
  });
  it('two symbol-only titles are not the neutral 0.5', () => {
    expect(lib.compareTitle('???', '!!!')).toBe(0);
    expect(lib.compareTitle('∑∫', '±≠')).toBe(0);
    expect(lib.compareTitle('???', '???')).toBe(1);
    expect(lib.compareTitle('', '')).toBe(0.5);
  });
});

describe('errata: one correction is one correction', () => {
  it('two case forms of a correction DOI and the work itself count once', async () => {
    const rec = JSON.parse(readFileSync('tests/fixtures/crossref/corrected.json', 'utf8'));
    const first = rec.message['updated-by'][0];
    rec.message['updated-by'] = [first, { ...first, DOI: first.DOI.toUpperCase() }, { ...first, DOI: '10.1088/1361-6595/aaebdb' }];
    axiosGetMock.mockResolvedValue({ status: 200, data: rec });
    const issues = await lib.checkReferenceForReplies({ id: 'r', raw_text: 'x', doi: '10.1088/1361-6595/aaebdb' });
    expect(issues[0].code).toBe('HAS_ERRATA');
    expect(issues[0].metadata.replyCount).toBe(1);
  });
});
