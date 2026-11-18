/**
 * "Clean" and "could not check" must be distinguishable (v0.1.2, 2026-08-21).
 *
 * Every source function returned `ExpressionOfConcernIssue | null`, and `null`
 * covered all of: no expression of concern, DOI not found, HTTP 429, 5xx, and
 * timeout. A caller had no way to tell "we asked and there is nothing" from "we
 * never got an answer", so a Crossref rate-limit storm reported an entire
 * bibliography clean.
 *
 * Measured downstream on the Scimeto platform, 2026-08-21: one real document run
 * logged 81 Crossref 429s while its Expression-of-Concern plugin recorded
 * `outcome: completed, issuesFound: 0, referencesChecked: 56`.
 *
 * These tests mock axios so they are deterministic and offline — the pre-existing
 * suite in this directory hits the live APIs, which cannot express "and now
 * Crossref rate-limits you".
 *
 * Written against the defect: on v0.1.1 every assertion about `complete` and
 * `sourcesUnavailable` fails, because neither field existed and a 429 was
 * indistinguishable from a clean answer.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
const axiosGetMock = jest.fn<any>();

/** Minimal AxiosError shape: `axios.isAxiosError` checks `isAxiosError === true`. */
const httpError = (status?: number, code?: string, message = 'request failed') => {
  const e: any = new Error(message);
  e.isAxiosError = true;
  if (status !== undefined) e.response = { status };
  if (code) e.code = code;
  return e;
};

jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  return {
    default: { get: axiosGetMock, isAxiosError },
    isAxiosError,
  };
});

jest.unstable_mockModule('../../src/http/crossref.js', () => ({
  crossrefGet: crossrefGetMock,
}));

const { checkReferenceForEOCDetailed, checkReferenceForEOC } =
  await import('../../src/expressionOfConcern/expressionOfConcernService.js');

import { readFileSync } from 'node:fs';
const fixture = (rel: string) => JSON.parse(readFileSync(`tests/fixtures/${rel}`, 'utf8'));

const REF = { id: 'r1', raw_text: 'Smith, J. (2020).', doi: '10.1/abc' } as any;

/** Crossref answers cleanly; PubMed has nothing indexed. */
const bothClean = () => {
  crossrefGetMock.mockResolvedValue({ data: { message: { type: 'journal-article' } } });
  axiosGetMock.mockResolvedValue({ data: { resultList: { result: [] } } });
};

beforeEach(() => {
  crossrefGetMock.mockReset();
  axiosGetMock.mockReset();
});

describe('a source that answered is not the same as a source that did not', () => {
  it('reports complete when every source answers', async () => {
    bothClean();
    const r = await checkReferenceForEOCDetailed(REF);

    expect(r.complete).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.sourcesUnavailable).toEqual([]);
    expect(r.sourcesChecked).toEqual(expect.arrayContaining(['CrossRef', 'PubMed']));
  });

  it('a Crossref 429 makes the result INCOMPLETE, not clean', async () => {
    // THE defect. Pre-fix this returned [] and the caller reported "no concerns".
    crossrefGetMock.mockRejectedValue(httpError(429));
    axiosGetMock.mockResolvedValue({ data: { resultList: { result: [] } } });

    const r = await checkReferenceForEOCDetailed(REF);

    expect(r.complete).toBe(false);
    expect(r.issues).toEqual([]);
    expect(r.sourcesUnavailable).toEqual([
      { source: 'CrossRef', reason: 'rate_limited', detail: '429' },
    ]);
    expect(r.sourcesChecked).not.toContain('CrossRef');
  });

  it('a 404 IS clean — the source was reached and holds no record', async () => {
    crossrefGetMock.mockRejectedValue(httpError(404));
    axiosGetMock.mockResolvedValue({ data: { resultList: { result: [] } } });

    const r = await checkReferenceForEOCDetailed(REF);

    expect(r.complete).toBe(true);
    expect(r.sourcesChecked).toContain('CrossRef');
  });

  it('classifies 5xx, timeout and bare network failure distinctly', async () => {
    const cases: Array<[any, string]> = [
      [httpError(503), 'server_error'],
      [httpError(undefined, 'ECONNABORTED'), 'timeout'],
      [httpError(undefined, undefined, 'socket hang up'), 'network'],
    ];
    for (const [err, reason] of cases) {
      crossrefGetMock.mockReset();
      axiosGetMock.mockReset();
      crossrefGetMock.mockRejectedValue(err);
      axiosGetMock.mockResolvedValue({ data: { resultList: { result: [] } } });

      const r = await checkReferenceForEOCDetailed(REF);
      expect(r.complete).toBe(false);
      expect(r.sourcesUnavailable[0]).toMatchObject({ source: 'CrossRef', reason });
    }
  });

  it('a non-axios throw is unavailable, never clean', async () => {
    crossrefGetMock.mockRejectedValue(new Error('boom'));
    axiosGetMock.mockResolvedValue({ data: { resultList: { result: [] } } });

    const r = await checkReferenceForEOCDetailed(REF);
    expect(r.complete).toBe(false);
    expect(r.sourcesUnavailable[0].reason).toBe('network');
  });

  it('both sources down leaves nothing checked and nothing claimed', async () => {
    crossrefGetMock.mockRejectedValue(httpError(429));
    axiosGetMock.mockRejectedValue(httpError(429));

    const r = await checkReferenceForEOCDetailed(REF);
    expect(r.complete).toBe(false);
    expect(r.sourcesUnavailable).toHaveLength(2);
    expect(r.issues).toEqual([]);
  });
});

describe('findings still surface, and still surface while a sibling source is down', () => {
  // Recorded bodies (tests/fixtures/*/eoc-*.json). The hand-built bodies these two
  // tests used before 0.3.0 encoded fields Crossref and Europe PMC do not serve, so
  // they passed over a check that could never fire.
  it('returns the Crossref expression-of-concern issue', async () => {
    crossrefGetMock.mockResolvedValue({ data: fixture('crossref/eoc-publisher.json') });
    axiosGetMock.mockResolvedValue({ data: fixture('europepmc/not-found.json') });

    const r = await checkReferenceForEOCDetailed({ ...REF, doi: '10.1016/j.lungcan.2003.10.006' });
    expect(r.complete).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].code).toBe('EOC_DETECTED');
  });

  it('a PubMed finding survives a Crossref outage, and the result stays incomplete', async () => {
    // Both facts matter: the finding is real AND the coverage is partial.
    crossrefGetMock.mockRejectedValue(httpError(429));
    axiosGetMock.mockResolvedValue({ data: fixture('europepmc/eoc-in.json') });

    const r = await checkReferenceForEOCDetailed({ ...REF, doi: '10.1371/journal.pone.0061107' });
    expect(r.issues.map(i => i.code)).toEqual(['EOC_PUBMED']);
    expect(r.complete).toBe(false);
  });
});

describe('back-compatibility and scope', () => {
  it('checkReferenceForEOC still returns just the issues array', async () => {
    bothClean();
    await expect(checkReferenceForEOC(REF)).resolves.toEqual([]);
  });

  it('a reference with no DOI is complete with nothing checked — not a failure', async () => {
    // There is nothing to look up, so coverage is not the caller's problem here.
    // Reporting incomplete would make every DOI-less bibliography look degraded.
    const r = await checkReferenceForEOCDetailed({ id: 'r2', raw_text: 'No DOI here.' } as any);
    expect(r).toEqual({ issues: [], sourcesChecked: [], sourcesUnavailable: [], complete: true });
    expect(crossrefGetMock).not.toHaveBeenCalled();
  });

  it('uses suggested_doi when doi is absent', async () => {
    bothClean();
    await checkReferenceForEOCDetailed({ id: 'r3', raw_text: 'x', suggested_doi: '10.9/zzz' } as any);
    expect(crossrefGetMock).toHaveBeenCalledWith(
      expect.stringContaining('10.9%2Fzzz'),
      expect.anything(),
    );
  });
});
