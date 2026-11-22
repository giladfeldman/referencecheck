/**
 * v0.3.0 reviews 7 and 8 (2026-11-22). Class: one DOI, written with what a copied link adds
 * after it, was read as the DOI by deduplication only. Every other reader passed
 * "10.x/y?utm_source=x" on: Crossref answered 404, and a preprint that only Crossref knows
 * read as clean; a prefix-table preprint was flagged with the link junk as its reported DOI.
 *
 * Review 8: the first fix cut too much. Real registered DOIs hold a "#..." (28,387 at
 * DataCite, e.g. 10.15475/dhz/kfn/1918/12/28#page-1) or end in "/pdf" or "/full"
 * (10.58079/pdf, 10.82364/144/ssu/ref/meta/full); each was checked at the doi.org handle API
 * 2026-11-22. So: in a resolver link, a raw "?" or "#" starts URL syntax and is cut; written
 * bare, only a key=value query, a lone final "?" and trailing slashes are. Every consumer's
 * request is checked in doiInputParity.test.ts (LINK_TAILS, BARE_TAILS); this file pins the
 * answers and the real DOIs.
 *
 * Also: a preprint link written into the `doi` field is read; a server read from a link
 * reports no DOI beside it.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));
const preprint = await import('../../src/preprint/preprintDetectionService.js');
const norm = await import('../../src/util/normalize.js');
const shape = await import('../../src/doi/doiShape.js');
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

const LINK_TAILS = ['?utm_source=x', '?versioned=true', '?', '#abs', '/', '//', '?a=1#b', '/?utm_medium=email', '#abs).', '?casa_token=AbC.'];
const BARE_TAILS = ['?utm_source=x', '?versioned=true', '?', '/', '//', '?a=1#b', '/?utm_medium=email', '?utm_source=x.'];

describe('cleanDoiInput drops what a link adds after a DOI', () => {
  it.each(LINK_TAILS)('https://doi.org/10.1000/abc%s -> 10.1000/abc', (tail) => {
    expect(norm.cleanDoiInput(`https://doi.org/10.1000/abc${tail}`)).toBe('10.1000/abc');
    expect(norm.cleanDoiInput(`doi.org/10.1000/abc${tail}`)).toBe('10.1000/abc');
  });
  it.each(BARE_TAILS)('10.1000/abc%s -> 10.1000/abc', (tail) => {
    expect(norm.cleanDoiInput(`10.1000/abc${tail}`)).toBe('10.1000/abc');
  });
  it.each(['?utm_source=x', '#abs', '/'])('shortDOI 10/gt3vmw%s in a link -> 10/gt3vmw', (tail) => {
    expect(norm.cleanDoiInput(`https://doi.org/10/gt3vmw${tail}`)).toBe('10/gt3vmw');
  });
});

describe('real registered DOIs stay whole (each resolved at the doi.org handle API, 2026-11-22)', () => {
  const REAL = ['10.58079/pdf', '10.82364/144/ssu/ref/meta/full', '10.15475/dhz/kfn/1918/12/28#page-1',
    '10.1002/(SICI)1099-0992(199711/12)27:6<635::AID-EJSP835>3.0.CO;2-#'];
  it.each(REAL)('%s, written bare', (doi) => {
    expect(norm.cleanDoiInput(doi)).toBe(doi);
    expect(norm.cleanDoiInput(`doi: ${doi}.`)).toBe(doi);
    expect(shape.isMalformedDoi(doi)).toBe(false);
  });
  it.each(REAL)('%s, in a link with its "#" encoded', (doi) => {
    expect(norm.cleanDoiInput(`https://doi.org/${doi.replace('#', '%23')}`)).toBe(doi);
  });
  it('a SICI DOI in a link keeps its final raw "#"', () => {
    const sici = '10.1002/1099-1379(200009)21:6<649::AID-JOB45>3.0.CO;2-#';
    expect(norm.cleanDoiInput(`https://doi.org/${sici}`)).toBe(sici);
  });
  it('two DOIs differing only after "#" are two works; one fragment beside the plain DOI is one (owner default, round 11)', () => {
    const ref = (doi: string) => ({ id: doi, raw_text: 'x', doi }) as any;
    const a = '10.15475/dhz/kfn/1918/12/28#page-1';
    const b = '10.15475/dhz/kfn/1918/12/28#article-f154ec251ff3e13f58359f93ff877690';
    expect(doiRelation(ref(a), ref(b))).toBe('different');
    expect(doiRelation(ref(a), ref('10.15475/dhz/kfn/1918/12/28'))).toBe('same');
    expect(doiRelation(ref(a), ref(a))).toBe('same');
    expect(doiRelation(ref(a), ref('10.15475/dhz/kfn/1918/12/30#page-1'))).toBe('different');
  });
});

describe('review 9: one DOI, every wrapper, one reading', () => {
  const ref = (doi: string) => ({ id: doi, raw_text: 'x', doi }) as any;
  it('10.58079/pdf keeps its DOI identity in deduplication (a page ending is dropped only when a DOI remains)', () => {
    expect(doiRelation(ref('10.58079/pdf'), ref('10.58079/pdf'))).toBe('same');
    expect(doiRelation(ref('10.58079/pdf'), ref('10.58079/other'))).toBe('different');
    expect(doiRelation(ref('10.58079/pdf'), ref('10.1234/other'))).toBe('different');
  });
  it.each(['https://doi.org/10.1000/x#f', 'doi: https://doi.org/10.1000/x#f', 'DOI:https://dx.doi.org/10.1000/x?utm_source=a', 'https://doi.org/doi:10.1000/x#f'])(
    'a link inside a doi: label is a link: %s -> 10.1000/x', (v) => {
      expect(norm.cleanDoiInput(v)).toBe('10.1000/x');
    });
  it('a SICI DOI followed by a query keeps its final "#", in a link and bare', () => {
    const sici = '10.1002/1099-1379(200009)21:6<649::AID-JOB45>3.0.CO;2-#';
    expect(norm.cleanDoiInput(`https://doi.org/${sici}?utm_source=x`)).toBe(sici);
    expect(norm.cleanDoiInput(`${sici}?utm_source=x`)).toBe(sici);
  });
  it('a "?" decoded from %3F is part of the DOI; a raw one is a query', () => {
    expect(norm.cleanDoiInput('https://doi.org/10.1000/a%3Fb%3Dc')).toBe('10.1000/a?b=c');
    expect(norm.cleanDoiInput('10.1000/a%3Fb%3Dc')).toBe('10.1000/a?b=c');
    expect(norm.cleanDoiInput('10.1000/a?b=c')).toBe('10.1000/a');
  });
  it('a shortDOI with a fragment reads the same bare and in a link', () => {
    expect(norm.cleanDoiInput('10/abc#x')).toBe('10/abc');
    expect(shape.isMalformedDoi('10/abc#x')).toBe(false);
    expect(shape.isMalformedDoi('https://doi.org/10/abc#x')).toBe(false);
  });
});

describe('preprint check: a Crossref-only preprint written with a link tail is still a preprint', () => {
  const forms = [
    ...BARE_TAILS.map((t) => ({ doi: `${CP}${t}` })),
    ...LINK_TAILS.map((t) => ({ doi: `https://doi.org/${CP}${t}` })),
    ...LINK_TAILS.map((t) => ({ url: `https://doi.org/${CP}${t}` })),
  ];
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
    ['https://doi.org/10.31234/osf.io/abcde#abs', '10.31234/osf.io/abcde'],
  ])('%s', async (doi, reported) => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', doi } as any);
    expect(issues.map((i: any) => [i.code, i.metadata?.doi])).toEqual([['IS_PREPRINT', reported]]);
  });
});

describe('deduplication reads the same DOI', () => {
  const ref = (doi: string) => ({ id: doi, raw_text: 'x', doi }) as any;
  it.each(BARE_TAILS)('10.1000/abc%s is the same DOI as 10.1000/abc', (tail) => {
    expect(doiRelation(ref(`10.1000/abc${tail}`), ref('10.1000/abc'))).toMatch(/^same/);
  });
  it.each(['/full', '/pdf', '/abstract/'])('a publisher page ending %s is the same work (comparison only)', (tail) => {
    expect(doiRelation(ref(`10.3389/fpsyg.2020.01234${tail}`), ref('10.3389/fpsyg.2020.01234'))).toMatch(/^same/);
    expect(norm.cleanDoiInput(`10.3389/fpsyg.2020.01234${tail}`)).toBe(`10.3389/fpsyg.2020.01234${tail.replace(/\/$/, '')}`);
  });
  it('two SICI DOIs differing only before "#" stay different', () => {
    expect(doiRelation(ref('10.1002/1099-1379(200009)21:6<649::AID-JOB45>3.0.CO;2-#'), ref('10.1002/1099-1379(200009)21:6<650::AID-JOB46>3.0.CO;2-#'))).toBe('different');
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
