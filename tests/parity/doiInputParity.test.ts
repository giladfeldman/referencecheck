/**
 * Parity matrix: one DOI, every way a caller can write it, every function that reads it.
 *
 * Class (2026-11-18 sweep): "one input shape is read
 * differently in different code paths". Before this test the library cleaned a DOI in
 * eleven places with four different rules — five copies of
 * `replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim()` (strip runs BEFORE trim, so a
 * leading space defeats it; no `doi:` prefix; no `www.`), one richer rule in the abstract
 * module, and four services (EOC, preprint, replies, open access) that interpolated the raw
 * string into a URL with no cleaning and no encoding at all. The DOI-shape helpers
 * (`isMalformedDoi`, `isShortFormDoi`, `expandShortDoi`) read a URL-form DOI as malformed.
 *
 * The matrix varies wrapper x spacing x prefix case and asserts that every DOI consumer
 * sends the SAME request and reports the SAME identity as for the bare DOI. HTTP is mocked
 * at axios, so every service is exercised through its real code path offline.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosGetMock = jest.fn<any>();
const axiosHeadMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();

jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: axiosHeadMock, post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});

const lib: any = await import('../../src/index.js');

/** A PsyArXiv DOI, so the preprint prefix detector takes part too. Mixed case on purpose. */
const BARE = '10.31234/OSF.io/AbCdE';
const SHORT = '10/gt3vmw';

const WRAPPERS = [
  '',
  'https://doi.org/',
  'http://doi.org/',
  'https://dx.doi.org/',
  'http://dx.doi.org/',
  'https://www.doi.org/',
  'HTTPS://DOI.ORG/',
  'doi.org/',
  'doi:',
  'doi: ',
  'DOI:',
  'DOI: ',
];
const LINK_TAILS = ['?utm_source=x', '?versioned=true', '?', '#abs', '#sec1.2', '/', '//', '/full', '/pdf/', '/abstract', '?a=1#b', '/?utm_medium=email', '/full?casa_token=AbC.', '#abs).'];
const SPACING: Array<[string, string]> = [
  ['', ''],
  ['  ', ''],
  ['', ' \n'],
  ['\t', '  '],
];

const variantsOf = (bare: string): string[] => {
  const out: string[] = [];
  for (const w of WRAPPERS) for (const [lead, trail] of SPACING) out.push(`${lead}${w}${bare}${trail}`);
  // A DOI copied out of a URL bar arrives percent-encoded.
  out.push(`https://doi.org/${encodeURIComponent(bare)}`);
  // What a copied link adds after the DOI (v0.3.0 review 7): a query, a fragment, trailing
  // slashes, a publisher page ending, and those followed by citation punctuation.
  for (const w of ['', 'https://doi.org/']) for (const tail of LINK_TAILS) out.push(`${w}${bare}${tail}`);
  return out;
};

const crossrefBody = (doi: string) => ({
  status: 200,
  data: {
    message: {
      DOI: doi.toLowerCase(),
      title: ['A title'],
      author: [{ family: 'Alder', given: 'J.' }],
      published: { 'date-parts': [[2020, 3, 5]] },
      'container-title': ['PsyArXiv'],
      type: 'posted-content',
      subtype: 'preprint',
      relation: {},
    },
  },
});

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosHeadMock.mockReset();
  axiosPostMock.mockReset();
  axiosGetMock.mockImplementation(async (url: string) => {
    if (url.includes('opencitations')) return { status: 200, data: [{ count: '7' }] };
    if (url.includes('openalex')) return { status: 200, data: { id: 'S1', primary_location: { source: { display_name: 'J', issn: [] } } } };
    if (url.includes('unpaywall')) return { status: 200, data: { is_oa: false } };
    if (url.includes('europepmc')) return { status: 200, data: { resultList: { result: [] } } };
    return crossrefBody(BARE);
  });
});

/** Every URL the mocks were asked for, in order. */
const requested = () => [
  ...axiosGetMock.mock.calls.map((c) => String(c[0])),
  ...axiosHeadMock.mock.calls.map((c) => String(c[0])),
];

/** Run one consumer on one input and return what it requested plus the identity it reports. */
type Probe = (input: string) => Promise<unknown>;
const PROBES: Record<string, Probe> = {
  checkRetraction: async (d) => (await lib.checkRetraction(d)).originalPaperDOI,
  validateDOI: async (d) => (await lib.validateDOI(d)).valid,
  getCitationCount: async (d) => lib.getCitationCount(d),
  getCitingWorks: async (d) => (await lib.getCitingWorks(d)).length,
  resolveOpenAlexByDOI: async (d) => (await lib.resolveOpenAlexByDOI(d)).found ?? null,
  checkReferenceForEOCDetailed: async (d) =>
    (await lib.checkReferenceForEOCDetailed({ id: 'r', raw_text: 'x', doi: d })).complete,
  checkReferenceForPreprint: async (d) =>
    (await lib.checkReferenceForPreprint({ id: 'r', raw_text: 'x', doi: d })).map(
      (i: any) => [i.type, i.metadata?.preprintServer ?? null]
    ),
  checkReferenceForReplies: async (d) =>
    (await lib.checkReferenceForReplies({ id: 'r', raw_text: 'x', doi: d })).length,
  checkReferenceForOpenAccess: async (d) =>
    (await lib.checkReferenceForOpenAccess({ id: 'r', raw_text: 'x', doi: d })).length,
};

describe('DOI parity: every consumer reads every written form of one DOI identically', () => {
  for (const [name, probe] of Object.entries(PROBES)) {
    it(`${name}: same request and same answer for all ${variantsOf(BARE).length} forms`, async () => {
      // validateDOI caches by cleaned DOI: a variant that misses the bare DOI's cache
      // entry sends a request of its own, which shows up below as a mismatch.
      axiosGetMock.mockClear();
      axiosHeadMock.mockClear();
      const bareAnswer = await probe(BARE);
      const bareRequests = requested();
      const mismatches: string[] = [];
      for (const v of variantsOf(BARE)) {
        axiosGetMock.mockClear();
        axiosHeadMock.mockClear();
        const answer = await probe(v);
        const reqs = requested();
        // validateDOI's cache legitimately makes the repeat call request nothing;
        // anything it DOES request must be the same URL.
        const sameReqs =
          name === 'validateDOI' ? reqs.length === 0 || JSON.stringify(reqs) === JSON.stringify(bareRequests)
                                 : JSON.stringify(reqs) === JSON.stringify(bareRequests);
        if (!sameReqs || JSON.stringify(answer) !== JSON.stringify(bareAnswer)) {
          mismatches.push(`${JSON.stringify(v)} -> ${JSON.stringify(answer)} via ${JSON.stringify(reqs)}`);
        }
      }
      expect({ bare: [bareAnswer, bareRequests], mismatches }).toEqual({
        bare: [bareAnswer, bareRequests],
        mismatches: [],
      });
    });
  }

  it('every consumer URL-encodes the DOI (a `#` or `?` in a DOI must not cut the request short)', async () => {
    const odd = '10.1002/(SICI)1097-4679(199901)55:1<1::AID-JCLP1>3.0.CO;2-#';
    const leaks: string[] = [];
    for (const [name, probe] of Object.entries(PROBES)) {
      axiosGetMock.mockClear();
      axiosHeadMock.mockClear();
      await probe(odd);
      for (const url of requested()) if (/[#<>]/.test(url)) leaks.push(`${name}: ${url}`);
    }
    expect(leaks).toEqual([]);
  });
});

describe('DOI parity: the pure DOI readers', () => {
  const pure: Record<string, (d: string) => unknown> = {
    isMalformedDoi: (d) => lib.isMalformedDoi(d),
    detectKnownPreprintFromDoi: (d) => lib.detectKnownPreprintFromDoi(d),
    normalizeAbstractDoi: (d) => lib.normalizeAbstractDoi(d),
  };
  for (const [name, fn] of Object.entries(pure)) {
    it(`${name} gives the bare DOI's answer for every written form`, () => {
      const want = fn(BARE);
      const bad = variantsOf(BARE).filter((v) => JSON.stringify(fn(v)) !== JSON.stringify(want));
      expect(bad).toEqual([]);
    });
  }

  it('isShortFormDoi and isMalformedDoi read a wrapped shortDOI as the shortDOI it is', () => {
    const bad = variantsOf(SHORT).filter(
      (v) => lib.isShortFormDoi(v) !== true || lib.isMalformedDoi(v) !== false
    );
    expect(bad).toEqual([]);
  });

  it('a non-DOI stays malformed whatever wrapper it wears (two-sided control)', () => {
    for (const w of WRAPPERS) {
      expect(lib.isMalformedDoi(`${w}not-a-doi`)).toBe(true);
      expect(lib.isMalformedDoi(`${w}10.1037`)).toBe(true);
      expect(lib.isShortFormDoi(`${w}10.1037/x`)).toBe(false);
    }
  });
});
