/**
 * v0.3.0 review 6 (2026-11-20): the preprint check, every combination of what a reference can
 * carry. Reviews 4, 5 and 6 each found one more combination read wrongly (a mention of
 * ssrn.com overriding a journal DOI; a suggested DOI switching off the link; a DOI Crossref
 * cannot answer for read as clean; a junk DOI hiding the DOI in a doi.org link; a suggested
 * DOI beating the author's link; a junk DOI reported as the reference's DOI). This matrix
 * states the rule once, independently of the code, and checks all 210 combinations:
 *
 *   author's DOI = the `doi` field when it is a full DOI, else the DOI in a doi.org `url`.
 *   With an author's DOI: a known preprint prefix decides; else Crossref decides; when
 *   Crossref cannot answer (404, failure, a 200 without a record), the `url` decides; the
 *   citation text never does.
 *   Without one: the `url`, then the citation text, then the suggested DOI (prefix, then
 *   Crossref).
 *   A reported DOI is always a full DOI, and only when a DOI decided (review 7: a server
 *   read from the link reports none).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));
const preprint = await import('../../src/preprint/preprintDetectionService.js');

const J = '10.1016/j.cell.2020.01.001'; // journal article in Crossref
const J2 = '10.1037/xge0001234'; // journal article in Crossref
const P = '10.31234/osf.io/abcde'; // PsyArXiv
const P2 = '10.2139/ssrn.999'; // SSRN
const D = '10.5281/zenodo.1'; // DataCite: Crossref 404
const E = '10.1000/empty'; // Crossref 200 without a work record
const PREFIX_SERVER: Record<string, string> = { [P]: 'PsyArXiv', [P2]: 'SSRN', '10.2139/ssrn.123': 'SSRN' };

const httpError = (status: number) => Object.assign(new Error(`status ${status}`), { isAxiosError: true, response: { status }, toJSON: () => ({}) });

beforeEach(() => {
  crossrefGetMock.mockReset();
  crossrefGetMock.mockImplementation(async (u: unknown) => {
    const doi = decodeURIComponent(String(u).split('/works/')[1]);
    if (doi === D) throw httpError(404);
    if (doi === E) return { status: 200, data: {} };
    return { status: 200, data: { message: { DOI: doi, type: 'journal-article', relation: {} } } };
  });
});

const DOIS = [undefined, 'n/a', '10/abc', J, P, D, E];
const SUGGESTED = [undefined, J2, P2];
const URLS = [undefined, 'https://arxiv.org/abs/2301.12345', `https://doi.org/${J}`, 'https://doi.org/10.2139/ssrn.123', 'https://example.org/page'];
const TEXTS = ['Smith (2020). A study.', 'Smith (2020). A study. Earlier version at ssrn.com/abstract=1'];

const full = (v?: string) => (v && /^10\.\d{3,9}\/\S+$/.test(v) ? v : '');
const linkDoi = (u?: string) => (u?.startsWith('https://doi.org/') ? u.slice('https://doi.org/'.length) : '');
const urlServer = (u?: string) => (u?.includes('arxiv.org') ? 'arXiv' : null);
const textServer = (t: string) => (t.includes('ssrn.com') ? 'SSRN' : null);
// What Crossref says: 'journal' (answered, not a preprint) or 'none' (cannot answer).
const crossref = (doi: string) => (doi === D || doi === E ? 'none' : 'journal');

/** The rule, written from the header above, not from the code. [server or null, reported DOI]. */
function expected(doi: string | undefined, suggested: string | undefined, url: string | undefined, text: string): [string | null, string | undefined] {
  const author = full(doi) || linkDoi(url);
  if (author) {
    if (PREFIX_SERVER[author]) return [PREFIX_SERVER[author], author];
    if (crossref(author) === 'journal') return [null, undefined];
    const u = urlServer(url);
    return [u, undefined];
  }
  const t = urlServer(url) ?? textServer(text);
  if (t) return [t, undefined];
  const s = full(suggested);
  if (s && PREFIX_SERVER[s]) return [PREFIX_SERVER[s], s];
  return [null, undefined];
}

const cases: Array<[string | undefined, string | undefined, string | undefined, string]> = [];
for (const doi of DOIS) for (const s of SUGGESTED) for (const url of URLS) for (const t of TEXTS) cases.push([doi, s, url, t]);

describe('preprint check: every combination of doi, suggested_doi, url and citation text', () => {
  it('covers 210 combinations', () => { expect(cases.length).toBe(210); });
  it.each(cases)('doi %j, suggested %j, url %j, text %j', async (doi, suggested_doi, url, raw_text) => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text, doi, suggested_doi, url } as any);
    const [server, reportedDoi] = expected(doi, suggested_doi, url, raw_text);
    expect(issues.map((i: any) => [i.code, i.metadata?.preprintServer])).toEqual(server ? [['IS_PREPRINT', server]] : []);
    for (const i of issues as any[]) {
      // A reported DOI is a full DOI, and the one the decision was made on.
      expect(i.metadata?.doi).toBe(reportedDoi);
      expect(String(i.location)).not.toBe('n/a');
    }
  });
});

describe('preprintDois: one rule for the DOIs the check reads', () => {
  it.each([
    [{ doi: 'n/a', url: `https://doi.org/${P2}` }, P2, ''],
    [{ doi: '10/abc', url: `https://doi.org/${J}`, suggested_doi: P }, J, P],
    [{ doi: J, url: `https://doi.org/${P2}` }, J, ''],
    [{ suggested_doi: 'n/a' }, '', ''],
    [{ url: 'https://arxiv.org/abs/1' }, '', ''],
  ])('%j -> author %j, suggested %j', (ref, author, suggested) => {
    expect(preprint.preprintDois({ id: 'r', raw_text: 'x', ...ref } as any)).toEqual({ authorDoi: author, suggestedDoi: suggested });
  });
});
