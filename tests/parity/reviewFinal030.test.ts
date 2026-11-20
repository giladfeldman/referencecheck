/**
 * v0.3.0 final review (2026-11-20). Class: "one fact written in several forms is read
 * differently, or one value is bound to a result it does not belong to". Members found by
 * the final review, each a matrix:
 *  - "no replies" and "could not ask Crossref" were one answer (replies service);
 *  - the expression-of-concern update type was read case-sensitively, its siblings were not;
 *  - a junk `doi` hid a valid `suggested_doi` in every per-reference service;
 *  - the DOI shape rule had two copies ({3,9} and {4,9} registrant digits);
 *  - a ".vN" ending merged two different works under every DOI prefix (and, once narrowed,
 *    split the versions of Preprints.org, Research Square and ChemRxiv: review 2);
 *  - a short DOI hid a full suggested DOI; a junk DOI counted toward completeness; an empty
 *    relation list read as a reply; any other 4xx read as a network failure (review 2).
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
const { doiRelation, scoreMetadataCompleteness } = await import('../../src/dedup/similarity.js');
const { extractJournalMetadata } = await import('../../src/predatory/journalMetadata.js');
const preprint = await import('../../src/preprint/preprintDetectionService.js');
const { DOI_REGISTRANTS } = await import('../../src/doi/registrants.js');

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
    [httpError(403), 'http_error'],
    [httpError(400), 'http_error'],
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
  it('empty relation lists are not replies (review 2, 2026-11-20)', async () => {
    crossrefGetMock.mockResolvedValue(record({ relation: { 'has-reply': [], 'has-comment': [], 'is-reply-to': [] } }));
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
    [{ doi: '10/abc', suggested_doi: '10.1371/journal.pone.0061107' }, '10.1371/journal.pone.0061107'], // full DOI outranks a short one
    [{ doi: 'n/a', suggested_doi: '10/abc' }, '10/abc'], // a short DOI outranks junk
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
    ['10.1000/x.figshare.12345.v1', '10.1000/x.figshare.12345.v3'], // figshare under another prefix
    // Each form read in Crossref 2026-11-20 (versions linked by is-version-of).
    ['10.20944/preprints202508.1193.v1', '10.20944/preprints202508.1193.v3'], // Preprints.org
    ['10.21203/rs.3.rs-906621/v1', '10.21203/rs.3.rs-906621/v2'], // Research Square
    ['10.26434/chemrxiv-2024-9lpb9', '10.26434/chemrxiv-2024-9lpb9/v2'], // ChemRxiv /vN
    ['10.26434/chemrxiv-2024-g3wwk-v2', '10.26434/chemrxiv-2024-g3wwk'], // ChemRxiv -vN
    ['10.26434/chemrxiv.15000484.v1', '10.26434/chemrxiv.15000484.v2'], // ChemRxiv .vN
    ['10.1101/2020.01.01.123456v1', '10.1101/2020.01.01.123456v2'], // bioRxiv
    ['10.31234/osf.io/qyt2v_v1', '10.31234/osf.io/qyt2v_v2'], // PsyArXiv
    ['10.31219/osf.io/abcde_v3', '10.31219/osf.io/abcde'], // OSF Preprints
    // Review 3 (2026-11-20), each read in Crossref is-version-of:
    ['10.33774/coe-2025-pzt7t-v2', '10.33774/coe-2025-pzt7t'], // Cambridge Open Engage
    ['10.22541/au.172258443.36807633/v1', '10.22541/au.172258443.36807633/v2'], // Authorea
    ['10.36227/techrxiv.24425536.v1', '10.36227/techrxiv.24425536.v2'], // TechRxiv .vN
    ['10.36227/techrxiv.174535600.06736183/v1', '10.36227/techrxiv.174535600.06736183/v3'], // TechRxiv /vN
    ['10.31222/osf.io/krucz_v1', '10.31222/osf.io/krucz_v2'], // MetaArXiv
    // Review 4: a bioRxiv link's file ending names the same version.
    ['10.1101/2020.01.01.123456v1.full', '10.1101/2020.01.01.123456v1'],
    ['10.1101/2020.01.01.123456v2.full.pdf', '10.1101/2020.01.01.123456'],
    ['10.1101/2020.03.22.002386v1.supplementary-material', '10.1101/2020.03.22.002386'], // review 5
    ['10.1101/2020.03.22.002386v2.abstract', '10.1101/2020.03.22.002386v1.article-info'],
    ['10.1101/2020.03.22.002386v1.full-text', '10.1101/2020.03.22.002386'], // review 6
    ['10.1101/2020.03.22.002386v1.full.pdf+html', '10.1101/2020.03.22.002386v1'],
    ['10.31730/osf.io/abcde_v2', '10.31730/osf.io/abcde'], // AfricArXiv
  ])('%s and %s: one work', (a, b) => { expect(rel(a, b)).toBe('same'); });
  it.each([
    // A figshare instance whose DOI does not say so is kept apart: two versions listed
    // twice is the safe error, two works merged into one is not.
    ['10.25384/sage.c.12345.v1', '10.25384/sage.c.12345.v3'],
    ['10.5555/a.v1', '10.5555/a.v2'],
    ['10.1007/s11222.v1', '10.1007/s11222.v2'],
    ['10.1037/abc.v1', '10.1037/abc'],
    ['10.5555/rs/v1', '10.5555/rs/v2'], // a /vN ending outside Research Square / ChemRxiv
    ['10.5555/x-v1', '10.5555/x-v2'],
    ['10.5555/x_v1', '10.5555/x_v2'], // a _vN ending outside OSF
    ['10.31234/osf.io/qyt2v_v1', '10.31234/osf.io/rwjhs_v1'], // two PsyArXiv preprints
    ['10.17605/osf.io/abcde_v1', '10.17605/osf.io/abcde_v2'], // OSF projects, not a preprint server
    ['10.5281/zenodo.123.v1', '10.5281/zenodo.123'], // Zenodo: no version endings (DataCite 200/200)
    ['10.5281/zenodo.1', '10.5281/zenodo.2'], // Zenodo: each version has its own number
    ['10.1101/2020.01.01.123456v1', '10.1101/2020.01.01.123457v1'], // two bioRxiv preprints
    ['10.1101/pdb.prot099176', '10.1101/pdb.prot099177'], // Cold Spring Harbor journal articles
    ['10.12688/f1000research.165282.1', '10.12688/f1000research.165282.2'], // F1000 article versions: kept apart
    ['10.5555/notfigshare-data.v1', '10.5555/notfigshare-data.v2'],
    ['10.20944/preprints202508.1193.v1', '10.20944/preprints202508.1194.v1'], // two preprints
  ])('%s and %s: two works', (a, b) => { expect(rel(a, b)).toBe('different'); });
});

describe('metadata completeness: a DOI counts only when it is one', () => {
  const base = { id: 'a', raw_text: 'x', title: 't', authors: 'Smith, J.', year: '2020' };
  it.each([['n/a'], ['10.12/abc'], ['  ']])('doi %j scores like no DOI', (doi) => {
    expect(scoreMetadataCompleteness({ ...base, doi } as any)).toBe(scoreMetadataCompleteness(base as any));
  });
  it('a real DOI scores higher', () => {
    expect(scoreMetadataCompleteness({ ...base, doi: '10.1000/x' } as any)).toBeGreaterThan(scoreMetadataCompleteness(base as any));
  });
});

describe('journal metadata looks up the valid suggested DOI, not the junk one (review 2)', () => {
  it('doi "n/a", suggested_doi valid -> OpenAlex is asked for the suggested DOI', async () => {
    axiosGetMock.mockResolvedValue({ status: 200, data: {} });
    await extractJournalMetadata({ id: 'r', raw_text: 'x', doi: 'n/a', suggested_doi: '10.1000/real' } as any, true);
    const urls = axiosGetMock.mock.calls.map((c: any[]) => String(c[0])).filter((u) => u.includes('openalex'));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes('10.1000/real') || u.includes(encodeURIComponent('10.1000/real')))).toBe(true);
    expect(urls.some((u) => u.includes('n/a') || u.includes(encodeURIComponent('n/a')))).toBe(false);
  });
});

describe('one registrant list: preprint server names and version rules (review 3)', () => {
  it.each([
    ['10.31222/osf.io/krucz', 'MetaArXiv'],
    ['10.31224/4330', 'engrXiv'],
    ['10.31224/osf.io/mkbwv', 'engrXiv'],
    ['10.31223/x5w163', 'EarthArXiv'],
    ['10.32942/x2j92f', 'EcoEvoRxiv'],
    ['10.31235/osf.io/kv2qc', 'SocArXiv'],
    ['10.35542/osf.io/abcde', 'EdArXiv'],
    ['10.31234/osf.io/47dx2_v1', 'PsyArXiv'],
    ['10.21203/rs.3.rs-906621/v2', 'Research Square'],
    ['10.33774/coe-2025-pzt7t-v2', 'Cambridge Open Engage'],
    ['10.22541/au.172258443.36807633/v2', 'Authorea'],
    ['10.36227/techrxiv.24425536.v2', 'TechRxiv'],
    ['10.6084/m9.figshare.12345.v1', null], // a repository, not a preprint server
    ['10.17605/osf.io/abcde', null], // OSF projects
    ['10.31237/osf.io/abcde', null], // Thesis Commons
  ])('%s -> %s', (doi, server) => {
    expect(preprint.detectKnownPreprintFromDoi(doi)).toBe(server);
  });
  // Review 4 (2026-11-20): names must match exactly. bioRxiv and medRxiv share one DOI
  // prefix, so the list names them together; that is the one refinement allowed.
  const REFINES: Record<string, string> = { bioRxiv: 'bioRxiv/medRxiv', medRxiv: 'bioRxiv/medRxiv' };
  // Servers with no URL pattern, each with its reason.
  const NO_URL: Record<string, string> = { Banglarxiv: 'no OSF provider record (api.osf.io, 2026-11-20)' };
  const doiNames = () => new Set(DOI_REGISTRANTS.flatMap((r: any) => (r.server ? [r.server] : [])));
  const urlNames = () => preprint.KNOWN_PREPRINT_URL_PATTERNS.map((p: any) => REFINES[p.server] ?? p.server);
  it('every URL pattern names a server from the registrant list, exactly', () => {
    const names = doiNames();
    expect(urlNames().filter((n: string) => !names.has(n))).toEqual([]);
  });
  it('every server in the registrant list has a URL pattern', () => {
    const urls = new Set(urlNames());
    expect([...doiNames()].filter((n) => !urls.has(n) && !NO_URL[n])).toEqual([]);
  });
  it.each([
    ['https://osf.io/preprints/lawarxiv/abcde', 'LawArXiv'],
    ['https://osf.io/preprints/africarxiv/abcde', 'AfricArXiv'],
    ['https://osf.io/preprints/psyarxiv/abcde', 'PsyArXiv'],
    ['https://osf.io/preprints/osf/abcde', 'OSF Preprints'],
  ])('URL %s -> %s', (url, server) => { expect(preprint.detectKnownPreprintFromText(url)).toBe(server); });
  it('a journal DOI whose citation mentions ssrn.com is asked of Crossref, not called a preprint', async () => {
    crossrefGetMock.mockResolvedValue(record({ type: 'journal-article' }));
    const issues = await preprint.checkReferenceForPreprint({
      id: 'r', raw_text: 'Smith, J. (2020). A study. J. Fin. 1, 2. Earlier version at ssrn.com/abstract=1', doi: '10.1111/jofi.12345',
      url: 'https://ssrn.com/abstract=1',
    } as any);
    expect(issues.map((i: any) => i.code)).toEqual([]);
    expect(crossrefGetMock).toHaveBeenCalled();
  });
  // No full DOI (none, junk, or an unexpanded short DOI): Crossref cannot answer, so the URL
  // decides (review 5 pre-check, 2026-11-20: 7a59dd1 dropped the junk and short cases).
  // Review 5 (2026-11-20), each reproduced against dist/ at 63a351b.
  const ARXIV = 'https://arxiv.org/abs/2301.12345';
  it('only a suggested DOI: the preprint link still decides (a suggestion is not the author\'s DOI)', async () => {
    // Crossref would call the suggested DOI a journal article; the link must win anyway.
    crossrefGetMock.mockResolvedValue(record({ type: 'journal-article' }));
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', url: ARXIV, suggested_doi: '10.1037/xge0001234' } as any);
    expect(issues.map((i: any) => [i.code, i.metadata.preprintServer])).toEqual([['IS_PREPRINT', 'arXiv']]);
  });
  it.each([
    ['not indexed (404)', httpError(404)],
    ['request failed', httpError(undefined, 'ENOTFOUND')],
  ])('a full DOI Crossref cannot answer for (%s): the reference\'s link decides', async (_label, err) => {
    crossrefGetMock.mockRejectedValue(err);
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', doi: '10.17605/OSF.IO/ABCDE', url: 'https://osf.io/preprints/psyarxiv/abcde' } as any);
    expect(issues.map((i: any) => [i.code, i.metadata.preprintServer])).toEqual([['IS_PREPRINT', 'PsyArXiv']]);
  });
  it('a full DOI Crossref cannot answer for, mentioned in the text only: not a preprint', async () => {
    crossrefGetMock.mockRejectedValue(httpError(404));
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'Data at zenodo; earlier version at arxiv.org', doi: '10.5281/zenodo.99999' } as any);
    expect(issues).toEqual([]);
  });
  it('no DOI field, a resolver link: the DOI inside the link is read', async () => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', url: 'https://doi.org/10.2139/ssrn.123' } as any);
    expect(issues.map((i: any) => [i.code, i.metadata.preprintServer])).toEqual([['IS_PREPRINT', 'SSRN']]);
    crossrefGetMock.mockResolvedValue(record({ type: 'posted-content', institution: [{ name: 'Some Server' }] }));
    const viaCrossref = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', url: 'https://doi.org/10.1000/xyz' } as any);
    expect(viaCrossref.map((i: any) => [i.code, i.metadata.source])).toEqual([['IS_PREPRINT', 'CrossRef']]);
  });
  it.each([
    ['https://edarxiv.org/abcde', 'EdArXiv'],
    ['https://paleorxiv.org/abcde', 'PaleorXiv'],
    ['https://biohackrxiv.org/abcde', 'BioHackrXiv'],
  ])('own address %s -> %s', (url, server) => { expect(preprint.detectKnownPreprintFromText(url)).toBe(server); });
  it.each([[undefined], [''], ['n/a'], ['10/abc']])('DOI %j: a preprint URL is still recognised', async (doi) => {
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', url: 'https://ssrn.com/abstract=1', doi } as any);
    expect(issues.map((i: any) => [i.code, i.metadata.preprintServer])).toEqual([['IS_PREPRINT', 'SSRN']]);
    expect(crossrefGetMock).not.toHaveBeenCalled();
  });
  it('a version ending is read in any case', () => {
    expect(shape.doiWithoutVersion('10.31234/OSF.IO/ABC12_V2')).toBe('10.31234/OSF.IO/ABC12');
    expect(shape.doiWithoutVersion('10.20944/PREPRINTS202508.1193.V3')).toBe('10.20944/PREPRINTS202508.1193');
  });
  it('an empty has-preprint list is not a preprint version', async () => {
    crossrefGetMock.mockResolvedValue(record({ type: 'journal-article', relation: { 'has-preprint': [] } }));
    const issues = await preprint.checkReferenceForPreprint({ id: 'r', raw_text: 'x', doi: '10.1000/x' } as any);
    expect(issues.map((i: any) => i.code)).toEqual([]);
  });
});
