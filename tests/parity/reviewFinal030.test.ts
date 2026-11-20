/**
 * v0.3.0 final review (2026-11-20). Class: "one fact written in several forms is read
 * differently, or one value is bound to a result it does not belong to". Members found by
 * the final review, each a matrix:
 *  - "no replies" and "could not ask Crossref" were one answer (replies service);
 *  - the expression-of-concern update type was read case-sensitively, its siblings were not;
 *  - a junk `doi` hid a valid `suggested_doi` in every per-reference service;
 *  - the DOI shape rule had two copies ({3,9} and {4,9} registrant digits);
 *  - a ".vN" ending merged two different works under every DOI prefix.
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
const replies = await import('../../src/replies/citationRepliesService.js');
const eoc = await import('../../src/expressionOfConcern/expressionOfConcernService.js');
const norm = await import('../../src/util/normalize.js');
const shape = await import('../../src/doi/doiShape.js');
const { doiRelation } = await import('../../src/dedup/similarity.js');

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
  // PubMed (Europe PMC) answers "no concern" unless a test says otherwise.
  axiosGetMock.mockResolvedValue({ status: 200, data: JSON.parse(readFileSync('tests/fixtures/europepmc/no-eoc.json', 'utf8')) });
});

const httpError = (status?: number, code?: string) => Object.assign(new Error(code === 'ECONNABORTED' ? 'timeout of 5000ms exceeded' : `status ${status}`), {
  isAxiosError: true, code, response: status === undefined ? undefined : { status }, toJSON: () => ({}),
});
const record = (extra: object = {}) => ({ status: 200, data: { message: { DOI: '10.1000/x', relation: {}, ...extra } } });

describe('replies: "none found" and "could not check" are different answers', () => {
  it.each([
    [httpError(503), 'server_error'],
    [httpError(500), 'server_error'],
    [httpError(429), 'rate_limited'],
    [httpError(404), 'not_indexed'],
    [httpError(undefined, 'ECONNABORTED'), 'timeout'],
    [httpError(undefined, 'ENOTFOUND'), 'network'],
  ])('%#: Crossref failure -> complete false, reason %s', async (err, reason) => {
    crossrefGetMock.mockRejectedValue(err);
    const r = await replies.checkReferenceForRepliesDetailed({ id: 'r', raw_text: 'x', doi: '10.1000/x' } as any);
    expect(r.issues).toEqual([]);
    expect(r.complete).toBe(false);
    expect(r.unavailable?.reason).toBe(reason);
  });
  it('a record with no replies -> complete true, no issues', async () => {
    crossrefGetMock.mockResolvedValue(record());
    const r = await replies.checkReferenceForRepliesDetailed({ id: 'r', raw_text: 'x', doi: '10.1000/x' } as any);
    expect(r).toEqual({ issues: [], complete: true });
  });
  it('a 200 without a work record -> complete false, malformed_response', async () => {
    crossrefGetMock.mockResolvedValue({ status: 200, data: {} });
    const r = await replies.checkReferenceForRepliesDetailed({ id: 'r', raw_text: 'x', doi: '10.1000/x' } as any);
    expect(r.complete).toBe(false);
    expect(r.unavailable?.reason).toBe('malformed_response');
  });
  it('no DOI -> complete true (nothing to look up)', async () => {
    const r = await replies.checkReferenceForRepliesDetailed({ id: 'r', raw_text: 'x' } as any);
    expect(r).toEqual({ issues: [], complete: true });
    expect(crossrefGetMock).not.toHaveBeenCalled();
  });
});

describe('expression of concern: the update type in any case', () => {
  it.each([['expression_of_concern'], ['Expression_Of_Concern'], ['EXPRESSION_OF_CONCERN']])('%s is detected', async (type) => {
    crossrefGetMock.mockResolvedValue(record({ 'updated-by': [{ type, DOI: '10.1000/eoc', updated: { 'date-parts': [[2020, 1, 2]] } }] }));
    const r = await eoc.checkReferenceForEOCDetailed({ id: 'r', raw_text: 'x', doi: '10.1000/x' } as any);
    expect(r.issues.some((i: any) => i.code === 'EOC_DETECTED')).toBe(true);
  });
});

describe('the DOI a reference is checked under: the first one that is a DOI', () => {
  it.each([
    [{ doi: '10.1000/real' }, '10.1000/real'],
    [{ doi: 'https://doi.org/10.1000/real' }, '10.1000/real'],
    [{ suggested_doi: '10.1000/real' }, '10.1000/real'],
    [{ doi: 'n/a', suggested_doi: '10.1000/real' }, '10.1000/real'],
    [{ doi: '10.1037/0', suggested_doi: '10.1000/real' }, '10.1037/0'], // shape-valid, kept
    [{ doi: '  ', suggested_doi: '10.1000/real' }, '10.1000/real'],
    [{ doi: '10.1000/a', suggested_doi: '10.1000/b' }, '10.1000/a'],
    [{ doi: 'n/a' }, 'n/a'], // nothing better: looked up as written, the lookup reports it
    [{}, ''],
  ])('%j -> %s', (ref, want) => {
    expect(shape.referenceDoi(ref as any)).toBe(want);
  });
  it.each([
    ['replies', (ref: any) => replies.checkReferenceForRepliesDetailed(ref)],
    ['expression of concern', (ref: any) => eoc.checkReferenceForEOCDetailed(ref)],
  ])('%s looks up the valid suggested DOI, not the junk one', async (_n, run) => {
    crossrefGetMock.mockResolvedValue(record());
    await run({ id: 'r', raw_text: 'x', doi: 'n/a', suggested_doi: '10.1000/real' });
    const urls = crossrefGetMock.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.includes(encodeURIComponent('10.1000/real')))).toBe(true);
  });
});

describe('DOI shape: one rule for every reader (3-digit registrants exist: 10.231, 10.488, 10.978, 10.979)', () => {
  it.each([['10.231/abc'], ['10.1037/abc'], ['10.123456789/abc']])('%s: well-formed, tail cut, same work as its URL', (d) => {
    expect(shape.isMalformedDoi(d)).toBe(false);
    expect(norm.cleanDoiInput(`${d}.`)).toBe(d);
    expect(norm.cleanDoiInput(`${d} PMID: 1`)).toBe(d);
    expect(doiRelation({ id: 'a', raw_text: 'x', doi: d } as any, { id: 'b', raw_text: 'x', doi: `https://doi.org/${d}` } as any)).toBe('same');
  });
  it.each([['10.12/abc'], ['10.1234567890/abc'], ['11.1037/abc']])('%s: not a DOI anywhere', (d) => {
    expect(shape.isMalformedDoi(d)).toBe(true);
    expect(norm.cleanDoiInput(`${d}.`)).toBe(`${d}.`);
    expect(doiRelation({ id: 'a', raw_text: 'x', doi: d } as any, { id: 'b', raw_text: 'x', doi: d } as any)).toBeNull();
  });
});

describe('dedup: a ".vN" ending is a version only where the registrant versions that way', () => {
  const rel = (a: string, b: string) => doiRelation({ id: 'a', raw_text: 'x', doi: a } as any, { id: 'b', raw_text: 'x', doi: b } as any);
  it.each([
    ['10.6084/m9.figshare.12345.v1', '10.6084/m9.figshare.12345.v2'],
    ['10.5281/zenodo.123.v1', '10.5281/zenodo.123'],
    ['10.1000/x.figshare.12345.v1', '10.1000/x.figshare.12345.v3'], // figshare under another prefix
  ])('%s and %s: one work', (a, b) => { expect(rel(a, b)).toBe('same'); });
  it.each([
    // A figshare instance whose DOI does not say so is kept apart: two versions listed
    // twice is the safe error, two works merged into one is not.
    ['10.25384/sage.c.12345.v1', '10.25384/sage.c.12345.v3'],
    ['10.5555/a.v1', '10.5555/a.v2'],
    ['10.1007/s11222.v1', '10.1007/s11222.v2'],
    ['10.1037/abc.v1', '10.1037/abc'],
  ])('%s and %s: two works', (a, b) => { expect(rel(a, b)).toBe('different'); });
});
