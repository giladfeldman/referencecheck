/**
 * Regressions from referencecheck-review attempt 1 (2026-10-14), each watched
 * failing on 1385afe before the fix.
 */
import { describe, it, expect } from '@jest/globals';
import { fetchAbstract, fetchAbstracts, MemoryAbstractCache, type JsonGet } from '../../src/abstract/index.js';
import { withIdentity } from './_identity.js';

const LONG = 'Participants who slept less recalled fewer words in a free-recall test. '.repeat(4);
const DOI = '10.1234/example.5';

function routes(map: Record<string, unknown>): JsonGet & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const host = Object.keys(map).find((h) => url.includes(h));
    if (!host) throw new Error(`unrouted ${url}`);
    const v = map[host];
    if (v instanceof Error) throw v;
    return withIdentity(url, v ?? null);
  }) as unknown as JsonGet & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('cache never serves a narrower lookup to a wider one (finding 1)', () => {
  it('a not_found from crossref-only is not reused by a default lookup', async () => {
    const cache = new MemoryAbstractCache();
    const get = routes({ 'api.crossref.org': { message: { title: ['T'] } },
      'api.openalex.org': { id: 'W1', abstract_inverted_index: { [LONG.trim()]: [0] } }, 'ebi.ac.uk': { resultList: { result: [] } } });
    expect((await fetchAbstract(DOI, { httpGet: get, cache, sources: ['crossref'] })).status).toBe('not_found');
    const r = await fetchAbstract(DOI, { httpGet: get, cache });
    expect(r).toMatchObject({ status: 'found', source: 'openalex' });
  });
});

describe('an unexpected 200 body is an error, never "absent" (finding 2)', () => {
  it('an HTML page from every source is error, not not_found, and is not cached', async () => {
    const cache = new MemoryAbstractCache();
    const get = routes({ 'api.crossref.org': '<html>blocked</html>', 'api.openalex.org': '<html>x</html>', 'ebi.ac.uk': '<html>x</html>' });
    const r = await fetchAbstract(DOI, { httpGet: get, cache });
    expect(r.status).toBe('error');
    expect(cache.size).toBe(0);
  });
  it('a JSON error envelope is an error', async () => {
    const get = routes({ 'api.crossref.org': { status: 'failed' }, 'api.openalex.org': null, 'ebi.ac.uk': { resultList: { result: [] } } });
    expect((await fetchAbstract(DOI, { httpGet: get })).attempts[0].outcome).toBe('error');
  });
});

describe('fetchAbstracts reports invalid input instead of dropping it (finding 3)', () => {
  it('an invalid DOI comes back as an invalid entry under its original text', async () => {
    const get = routes({ 'api.crossref.org': { message: { abstract: LONG } } });
    const m = await fetchAbstracts(['not a doi', '10.9/x'], { httpGet: get });
    expect(m.get('not a doi')?.status).toBe('invalid_doi');
    expect(m.get('10.9/x')?.status).toBe('found');
  });
});

describe('a record for a different DOI is never accepted (finding 4)', () => {
  it('a Europe PMC hit whose DOI differs is absent', async () => {
    const get = routes({ 'api.crossref.org': null, 'api.openalex.org': null,
      'ebi.ac.uk': { resultList: { result: [{ doi: '10.9999/other', abstractText: LONG }] } } });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r.status).toBe('not_found');
  });
});

describe('short abstracts and absent records (findings 5, 6)', () => {
  it('a too-short abstract is kept as shortAbstract, not thrown away', async () => {
    const get = routes({ 'api.crossref.org': { message: { abstract: 'A brief report on sleep.' } }, 'api.openalex.org': null,
      'ebi.ac.uk': { resultList: { result: [] } } });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r.status).toBe('not_found');
    expect(r.shortAbstract).toBe('A brief report on sleep.');
  });
  it('a 404 is recorded as "no record", distinct from a record without an abstract', async () => {
    const get = routes({ 'api.crossref.org': null, 'api.openalex.org': { id: 'W1', abstract_inverted_index: null },
      'ebi.ac.uk': { resultList: { result: [] } } });
    const r = await fetchAbstract(DOI, { httpGet: get });
    expect(r.attempts[0]).toMatchObject({ source: 'crossref', outcome: 'absent', detail: 'no record' });
    expect(r.attempts[1]).toMatchObject({ source: 'openalex', outcome: 'absent' });
    expect(r.attempts[1].detail).toBeUndefined();
  });
});
