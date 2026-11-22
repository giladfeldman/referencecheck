/**
 * v0.3.0 review 7 (2026-11-22). Class: one DOI, written with what a copied link adds after it
 * (a query, a fragment, trailing slashes, a publisher page ending), was read as the DOI by
 * deduplication only. Every other reader passed "10.x/y?utm_source=x" on: Crossref answered
 * 404, and a preprint that only Crossref knows read as clean; a prefix-table preprint was
 * flagged with the link junk as its reported DOI. Every consumer's request is checked in
 * doiInputParity.test.ts (LINK_TAILS); this file pins the answers.
 *
 * Also: a preprint link written into the `doi` field is read; a server read from a link
 * reports no DOI beside it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));
const preprint = await import('../../src/preprint/preprintDetectionService.js');
const norm = await import('../../src/util/normalize.js');
const { doiRelation } = await import('../../src/dedup/similarity.js');

/** A preprint that only Crossref knows (SciELO preprints, posted-content; no prefix row). */
const CP = '10.1590/1413-78520212901231439';

beforeEach(() => {
  crossrefGetMock.mockReset();
  crossrefGetMock.mockImplementation(async (u: unknown) => {
    const doi = decodeURIComponent(String(u).split('/works/')[1]);
    if (doi !== CP) throw Object.assign(new Error('404'), { isAxiosError: true, response: { status: 404 } });
    return { status: 200, data: { message: { DOI: CP, type: 'posted-content', subtype: 'preprint', institution: [{ name: 'SciELO Preprints' }], relation: {} } } };
  });
});

const TAILS = ['?utm_source=x', '?versioned=true', '?', '#abs', '/', '//', '/full', '/pdf/', '/abstract', '?a=1#b', '/?utm_medium=email', '/full?casa_token=AbC.', '#abs).'];

describe('cleanDoiInput drops what a link adds after a DOI', () => {
  it.each(TAILS)('10.1000/abc%s -> 10.1000/abc', (tail) => {
    expect(norm.cleanDoiInput(`10.1000/abc${tail}`)).toBe('10.1000/abc');
    expect(norm.cleanDoiInput(`https://doi.org/10.1000/abc${tail}`)).toBe('10.1000/abc');
  });
  it('keeps the "#" that ends a Wiley SICI DOI', () => {
    const sici = '10.1002/(SICI)1099-0992(199711/12)27:6<635::AID-EJSP835>3.0.CO;2-#';
    expect(norm.cleanDoiInput(sici)).toBe(sici);
    expect(norm.cleanDoiInput(`${sici}.`)).toBe(sici);
  });
  it('keeps a "?" or "/" inside the DOI', () => {
    expect(norm.cleanDoiInput('10.1002/(SICI)1099-0992(199711/12)27:6')).toBe('10.1002/(SICI)1099-0992(199711/12)27:6');
  });
});

describe('preprint check: a Crossref-only preprint written with a link tail is still a preprint', () => {
  const forms = TAILS.flatMap((t) => [{ doi: `${CP}${t}` }, { url: `https://doi.org/${CP}${t}` }]);
  it.each(forms)('%j', async (ref) => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', ...ref } as any);
    expect(issues.map((i: any) => [i.code, i.metadata?.doi])).toEqual([['IS_PREPRINT', CP]]);
  });
});

describe('preprint check: a prefix-table preprint reports the DOI, not the link junk', () => {
  it.each([
    ['10.1101/2020.03.22.002386v1.full?versioned=true', '10.1101/2020.03.22.002386v1.full'],
    ['10.2139/ssrn.123?x=1', '10.2139/ssrn.123'],
    ['10.31234/osf.io/abcde/', '10.31234/osf.io/abcde'],
  ])('%s', async (doi, reported) => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', doi } as any);
    expect(issues.map((i: any) => [i.code, i.metadata?.doi])).toEqual([['IS_PREPRINT', reported]]);
  });
});

describe('deduplication reads the same DOI', () => {
  it.each(TAILS)('10.1000/abc%s is the same DOI as 10.1000/abc', (tail) => {
    expect(doiRelation({ id: 'a', raw_text: 'x', doi: `10.1000/abc${tail}` } as any, { id: 'b', raw_text: 'x', doi: '10.1000/abc' } as any)).toMatch(/^same/);
  });
  it('two SICI DOIs differing only before "#" stay different', () => {
    const a = '10.1002/1099-1379(200009)21:6<649::AID-JOB45>3.0.CO;2-#';
    const b = '10.1002/1099-1379(200009)21:6<650::AID-JOB46>3.0.CO;2-#';
    expect(doiRelation({ id: 'a', raw_text: 'x', doi: a } as any, { id: 'b', raw_text: 'x', doi: b } as any)).toBe('different');
  });
});

describe('preprint links written into the doi field; no DOI beside a link-read server', () => {
  it.each([
    ['https://arxiv.org/abs/2301.12345', 'arXiv'],
    ['https://www.biorxiv.org/content/early/2020/01/01/123456', 'bioRxiv'],
    ['ssrn.com/abstract=1', 'SSRN'],
  ])('doi %s -> %s', async (doi, server) => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'Smith (2020).', doi } as any);
    expect(issues.map((i: any) => [i.code, i.metadata?.preprintServer, i.metadata?.doi])).toEqual([['IS_PREPRINT', server, undefined]]);
  });
  it('a DOI Crossref cannot answer for plus an arXiv link: arXiv, no DOI reported', async () => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', doi: '10.5281/zenodo.1', url: 'https://arxiv.org/abs/2301.12345' } as any);
    expect(issues.map((i: any) => [i.code, i.metadata?.preprintServer, i.metadata?.doi])).toEqual([['IS_PREPRINT', 'arXiv', undefined]]);
  });
});
