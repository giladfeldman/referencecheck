import { describe, it, expect } from '@jest/globals';
import {
  cleanAbstractMarkup,
  fetchAbstract,
  fetchAbstracts,
  invertedIndexToText,
  MemoryAbstractCache,
  MIN_ABSTRACT_CHARS,
  normalizeAbstractDoi,
  type JsonGet,
} from '../../src/abstract/index.js';

const LONG = 'Participants who slept less recalled fewer words in a free-recall test. '.repeat(4);
const DOI = '10.1234/example.5';

/** A fake network keyed by host. A value of Error throws; null is a 404. */
function fakeGet(routes: Record<string, unknown>): JsonGet & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const host = Object.keys(routes).find((h) => url.includes(h));
    if (!host) throw new Error(`unrouted ${url}`);
    const v = routes[host];
    if (v instanceof Error) throw v;
    return v ?? null;
  }) as unknown as JsonGet & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const crossref = (abstract?: string) => ({ message: { abstract, title: ['T'], issued: { 'date-parts': [[2019]] } } });
const openalex = (text?: string) => ({
  id: 'W1', title: 'T', publication_year: 2019,
  abstract_inverted_index: text ? Object.fromEntries(
    text.split(' ').reduce((m, w, i) => m.set(w, [...(m.get(w) ?? []), i]), new Map<string, number[]>()),
  ) : null,
});

describe('fetchAbstract cascade', () => {
  it('takes the first source with a usable abstract and stops there', async () => {
    const get = fakeGet({ 'api.crossref.org': crossref(`<jats:p>${LONG}</jats:p>`), 'api.openalex.org': openalex(LONG) });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r).toMatchObject({ status: 'found', source: 'crossref', title: 'T', year: 2019 });
    expect(r.abstract).toBe(LONG.trim());
    expect(get.calls).toHaveLength(1);
  });

  it('falls through absent and too-short sources, recording each attempt', async () => {
    const get = fakeGet({
      'api.crossref.org': crossref(undefined),
      'api.openalex.org': openalex('Short stub.'),
      'api.semanticscholar.org': { paperId: 'P1', abstract: LONG, title: 'T', year: 2019 },
      'ebi.ac.uk': null,
    });
    const r = await fetchAbstract(DOI, { httpGet: get, credentials: { semanticScholarApiKey: 'k' } });
    expect(r.source).toBe('semanticscholar');
    expect(r.attempts.map((a) => a.outcome)).toEqual(['absent', 'too_short', 'found']);
  });

  it('skips Semantic Scholar by default without a key, uses it with one', async () => {
    const routes = { 'api.crossref.org': crossref(undefined), 'api.openalex.org': null,
      'api.semanticscholar.org': { paperId: 'P1', abstract: LONG }, 'ebi.ac.uk': null };
    const noKey = fakeGet(routes);
    const r1 = await fetchAbstract(DOI, { httpGet: noKey });
    expect(r1.attempts.map((a) => a.source)).toEqual(['crossref', 'openalex', 'europepmc']);
    expect(r1.status).toBe('not_found');
    const withKey = fakeGet(routes);
    const r2 = await fetchAbstract(DOI, { httpGet: withKey, credentials: { semanticScholarApiKey: 'k' } });
    expect(r2).toMatchObject({ status: 'found', source: 'semanticscholar' });
  });

  it('every source answers without one: not_found', async () => {
    const get = fakeGet({ 'api.crossref.org': null, 'api.openalex.org': null, 'api.semanticscholar.org': null,
      'ebi.ac.uk': { resultList: { result: [] } } });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r).toMatchObject({ status: 'not_found', abstract: null, source: null });
  });

  it('a failed source with no abstract elsewhere is error, never not_found', async () => {
    const get = fakeGet({ 'api.crossref.org': new Error('ECONNRESET'), 'api.openalex.org': null,
      'api.semanticscholar.org': null, 'ebi.ac.uk': null });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r.status).toBe('error');
    expect(r.attempts[0]).toMatchObject({ source: 'crossref', outcome: 'error' });
  });

  it('a failure before a later success is still found', async () => {
    const get = fakeGet({ 'api.crossref.org': new Error('503'), 'api.openalex.org': openalex(LONG) });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r).toMatchObject({ status: 'found', source: 'openalex' });
  });

  it('rejects a non-DOI input loudly', async () => {
    await expect(fetchAbstract('not a doi', { httpGet: fakeGet({}) })).rejects.toThrow(/not a DOI/);
  });
});

describe('cache', () => {
  it('caches found and not_found by normalised DOI; a second lookup makes no request', async () => {
    const cache = new MemoryAbstractCache();
    const get = fakeGet({ 'api.crossref.org': crossref(LONG) });
    await fetchAbstract('https://doi.org/10.1234/EXAMPLE.5', { httpGet: get, cache });
    const again = await fetchAbstract(DOI, { httpGet: get, cache });
    expect(again.status).toBe('found');
    expect(get.calls).toHaveLength(1);
  });

  it('never caches an error, so the next lookup retries', async () => {
    const cache = new MemoryAbstractCache();
    const bad = fakeGet({ 'api.crossref.org': new Error('down'), 'api.openalex.org': new Error('down'),
      'api.semanticscholar.org': new Error('down'), 'ebi.ac.uk': new Error('down') });
    expect((await fetchAbstract(DOI, { httpGet: bad, cache })).status).toBe('error');
    expect(cache.size).toBe(0);
    const good = fakeGet({ 'api.crossref.org': crossref(LONG) });
    expect((await fetchAbstract(DOI, { httpGet: good, cache })).status).toBe('found');
  });

  it('fetchAbstracts fetches each distinct DOI once', async () => {
    const get = fakeGet({ 'api.crossref.org': crossref(LONG) });
    const m = await fetchAbstracts([DOI, DOI.toUpperCase(), 'doi:10.9/x'], { httpGet: get });
    expect([...m.keys()]).toEqual([DOI, '10.9/x']);
    expect(get.calls).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('cleans JATS markup, entities and a leading heading', () => {
    expect(cleanAbstractMarkup('<jats:title>Abstract</jats:title><jats:p>A &amp; B &lt;5&gt; &#x3b1; &#946;</jats:p>'))
      .toBe('A & B <5> α β');
    expect(cleanAbstractMarkup('Abstract: Text here')).toBe('Text here');
  });

  it('rebuilds inverted-index text in word order', () => {
    expect(invertedIndexToText({ the: [0, 3], cat: [1], sat: [2], end: [4] })).toBe('the cat sat the end');
  });

  it('normalises DOI forms and rejects non-DOIs', () => {
    expect(normalizeAbstractDoi(' DOI: 10.1/AbC ')).toBe('10.1/abc');
    expect(normalizeAbstractDoi('http://dx.doi.org/10.1/x')).toBe('10.1/x');
    expect(normalizeAbstractDoi('11.1/x')).toBeNull();
  });

  it('MIN_ABSTRACT_CHARS is the documented 200', () => {
    expect(MIN_ABSTRACT_CHARS).toBe(200);
  });
});
