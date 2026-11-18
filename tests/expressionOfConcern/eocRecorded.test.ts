/**
 * Expression of concern against RECORDED responses (2026-11-18 sweep).
 *
 * Class: "a check reads a field the source does not serve, so it can never fire,
 * and the miss is reported as clean". Members found in this file's code:
 *  - Crossref: `relation['has-expression-of-concern' | 'is-expression-of-concern-for']`
 *    (not a Crossref relation type) and `relationship` (not a Crossref field).
 *    Crossref serves the concern as `updated-by` type `expression_of_concern`.
 *  - Europe PMC: `commentsCorrectionsList` from a `lite` search. The field is
 *    `commentCorrectionList`, served only with `resultType=core`, entry type
 *    "Expression of concern in". The query was not scoped to the DOI field.
 *  - Both: a 200 with no record (`message || {}`, `result || []`) was `clean`.
 *  - `dateIssued` held the PAPER's issue date, unpadded, shown downstream as the date.
 * Every assertion here fails on 0.2.0.
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

const { checkReferenceForEOCDetailed } = await import('../../src/expressionOfConcern/expressionOfConcernService.js');

const fixture = (rel: string) => JSON.parse(readFileSync(`tests/fixtures/${rel}`, 'utf8'));
const ref = (doi: string) => ({ id: 'r', raw_text: 'x', doi }) as any;
const serve = (crossref: unknown, epmc: unknown) => {
  crossrefGetMock.mockResolvedValue({ status: 200, data: crossref });
  axiosGetMock.mockResolvedValue({ status: 200, data: epmc });
};

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('Crossref: the concern is read from updated-by', () => {
  it('a publisher-recorded concern is an issue dated by its notice', async () => {
    serve(fixture('crossref/eoc-publisher.json'), fixture('europepmc/not-found.json'));
    const r = await checkReferenceForEOCDetailed(ref('10.1016/j.lungcan.2003.10.006'));
    expect(r.complete).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({
      code: 'EOC_DETECTED', severity: 'warning', location: '10.1016/j.lungcan.2003.10.006',
      metadata: { doi: '10.1016/j.lungcan.2003.10.006', dateIssued: '2026-02-13', source: 'CrossRef' },
    });
    expect(r.issues[0].metadata?.journalName).toBeTruthy();
    expect(r.issues[0].metadata?.details).toMatch(/recorded by: publisher/);
  });

  it('one concern recorded by two sources is one issue, earliest date, both recorders named', async () => {
    serve(fixture('crossref/eoc-two-sources.json'), { resultList: { result: [] } });
    const r = await checkReferenceForEOCDetailed(ref('10.1371/journal.pone.0061107'));
    const cr = r.issues.filter((i) => i.metadata?.source === 'CrossRef');
    expect(cr).toHaveLength(1);
    expect(cr[0].metadata?.dateIssued).toBe('2023-01-11');
    expect(cr[0].metadata?.details).toMatch(/retraction-watch/);
    expect(cr[0].metadata?.details).toMatch(/publisher/);
  });

  it('a healthy paper is clean (control)', async () => {
    serve(fixture('crossref/not-retracted.json'), fixture('europepmc/no-eoc.json'));
    const r = await checkReferenceForEOCDetailed(ref('10.1038/nature12373'));
    expect(r).toEqual({ issues: [], sourcesChecked: ['CrossRef', 'PubMed', 'KnownList'], sourcesUnavailable: [], complete: true });
  });

  it('a retraction or new version is not an expression of concern (control)', async () => {
    serve(fixture('crossref/retracted-plain-title.json'), { resultList: { result: [] } });
    const r = await checkReferenceForEOCDetailed(ref('10.1126/science.1256151'));
    expect(r.issues).toEqual([]);
  });

  it.each([
    ['an empty body', ''],
    ['an HTML page', '<html>busy</html>'],
    ['a list', []],
    ['an envelope without message', { status: 'ok' }],
  ])('a 200 carrying %s is could-not-check, never clean', async (_label, body) => {
    serve(body, fixture('europepmc/not-found.json'));
    const r = await checkReferenceForEOCDetailed(ref('10.1/x'));
    expect(r.complete).toBe(false);
    expect(r.sourcesChecked).not.toContain('CrossRef');
    expect(r.sourcesUnavailable).toEqual([{ source: 'CrossRef', reason: 'malformed_response', detail: expect.any(String) }]);
  });
});

describe('Europe PMC: the concern is read from commentCorrectionList in a core, DOI-scoped search', () => {
  it('"Expression of concern in" is an issue naming the notice', async () => {
    serve(fixture('crossref/not-retracted.json'), fixture('europepmc/eoc-in.json'));
    const r = await checkReferenceForEOCDetailed(ref('10.1371/journal.pone.0061107'));
    const pm = r.issues.filter((i) => i.code === 'EOC_PUBMED');
    expect(pm).toHaveLength(1);
    expect(pm[0]).toMatchObject({ location: '23593403', metadata: { doi: '10.1371/journal.pone.0061107', source: 'PubMed', journalName: 'PloS one' } });
    expect(pm[0].metadata?.details).toBe('notice: MED 36630355');
    // The old field held the paper's year; the notice date is unknown here, so it is absent.
    expect(pm[0].metadata?.dateIssued).toBeUndefined();
  });

  it('sends a DOI-field query for the core result type', async () => {
    serve(fixture('crossref/not-retracted.json'), fixture('europepmc/not-found.json'));
    await checkReferenceForEOCDetailed(ref('https://doi.org/10.1371/journal.pone.0061107'));
    expect(axiosGetMock.mock.calls[0][1]).toMatchObject({
      params: { query: 'DOI:"10.1371/journal.pone.0061107"', resultType: 'core' },
    });
  });

  it('"Comment in" is not a concern, and no record is clean (controls)', async () => {
    serve(fixture('crossref/not-retracted.json'), fixture('europepmc/no-eoc.json'));
    expect((await checkReferenceForEOCDetailed(ref('10.1038/nature12373'))).issues).toEqual([]);
    serve(fixture('crossref/not-retracted.json'), fixture('europepmc/not-found.json'));
    const r = await checkReferenceForEOCDetailed(ref('10.9999/does-not-exist-2026'));
    expect(r.issues).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('a hit for another DOI is not this paper (control)', async () => {
    serve(fixture('crossref/not-retracted.json'), fixture('europepmc/eoc-in.json'));
    const r = await checkReferenceForEOCDetailed(ref('10.1038/nature12373'));
    expect(r.issues).toEqual([]);
  });

  it('a 200 without a result list is could-not-check, never clean', async () => {
    serve(fixture('crossref/not-retracted.json'), '<html>maintenance</html>');
    const r = await checkReferenceForEOCDetailed(ref('10.1038/nature12373'));
    expect(r.complete).toBe(false);
    expect(r.sourcesUnavailable).toEqual([{ source: 'PubMed', reason: 'malformed_response', detail: expect.any(String) }]);
  });
});
