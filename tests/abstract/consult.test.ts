/**
 * Regressions from the tier-3 consult of 2026-10-14 on fetchAbstract (Sonnet + Sol),
 * each watched failing on 8236d5d before the fix.
 */
import { describe, it, expect } from '@jest/globals';
import {
  cleanAbstractMarkup, fetchAbstract, invertedIndexToText, MemoryAbstractCache, normalizeAbstractDoi, type JsonGet,
} from '../../src/abstract/index.js';

const LONG = 'Participants who slept less recalled fewer words in a free-recall test. '.repeat(4);
const DOI = '10.1234/example.5';

function routes(map: Record<string, unknown>): JsonGet {
  return (async (url: string) => {
    const host = Object.keys(map).find((h) => url.includes(h));
    if (!host) throw new Error(`unrouted ${url}`);
    const v = map[host];
    if (v instanceof Error) throw v;
    return v ?? null;
  }) as unknown as JsonGet;
}
const inv = (text: string) => Object.fromEntries(
  text.split(' ').reduce((m, w, i) => m.set(w, [...(m.get(w) ?? []), i]), new Map<string, number[]>()));

describe('a record for another DOI is never accepted, from any source (both seats)', () => {
  it('Crossref message.DOI mismatch', async () => {
    const r = await fetchAbstract(DOI, { sources: ['crossref'],
      httpGet: routes({ 'api.crossref.org': { message: { DOI: '10.9/other', abstract: LONG } } }) });
    expect(r.status).not.toBe('found');
  });
  it('OpenAlex doi mismatch', async () => {
    const r = await fetchAbstract(DOI, { sources: ['openalex'],
      httpGet: routes({ 'api.openalex.org': { id: 'W1', doi: 'https://doi.org/10.9/other', abstract_inverted_index: inv(LONG.trim()) } }) });
    expect(r.status).not.toBe('found');
  });
  it('Semantic Scholar externalIds.DOI mismatch', async () => {
    const r = await fetchAbstract(DOI, { sources: ['semanticscholar'], credentials: { semanticScholarApiKey: 'k' },
      httpGet: routes({ 'api.semanticscholar.org': { paperId: 'P', externalIds: { DOI: '10.9/other' }, abstract: LONG } }) });
    expect(r.status).not.toBe('found');
  });
  it('the same work written with a doubled slash IS accepted (measured: 1 of 40 OpenAlex works)', async () => {
    const r = await fetchAbstract('10.1037/0882-7974.17.4.677', { sources: ['openalex'],
      httpGet: routes({ 'api.openalex.org': { id: 'W1', doi: 'https://doi.org/10.1037//0882-7974.17.4.677', abstract_inverted_index: inv(LONG.trim()) } }) });
    expect(r.status).toBe('found');
  });
  it('a mismatched record is not cached', async () => {
    const cache = new MemoryAbstractCache();
    await fetchAbstract(DOI, { sources: ['crossref'], cache,
      httpGet: routes({ 'api.crossref.org': { message: { DOI: '10.9/other', abstract: LONG } } }) });
    expect(cache.size).toBe(0);
  });
});

describe('malformed 200 responses are errors (Sol)', () => {
  it('Crossref message: [] is an error', async () => {
    const r = await fetchAbstract(DOI, { sources: ['crossref'], httpGet: routes({ 'api.crossref.org': { message: [] } }) });
    expect(r.status).toBe('error');
  });
  it('OpenAlex abstract_inverted_index: [] is an error', async () => {
    const r = await fetchAbstract(DOI, { sources: ['openalex'],
      httpGet: routes({ 'api.openalex.org': { id: 'W1', doi: `https://doi.org/${DOI}`, abstract_inverted_index: [] } }) });
    expect(r.status).toBe('error');
  });
  it('an inverted index with a gap or a duplicated position is an error, not a reconstructed text', () => {
    expect(() => invertedIndexToText({ a: [0], b: [2] })).toThrow();
    expect(() => invertedIndexToText({ a: [0], b: [0] })).toThrow();
    expect(invertedIndexToText({ a: [0, 2], b: [1] })).toBe('a b a');
  });
  it('an empty source list is refused, never a cached not_found', async () => {
    await expect(fetchAbstract(DOI, { sources: [], httpGet: routes({}) })).rejects.toThrow(/source/);
  });
});

describe('Europe PMC picks the matching record that has an abstract (Sol)', () => {
  it('a later matching hit with text wins over an earlier one without', async () => {
    const r = await fetchAbstract(DOI, { sources: ['europepmc'], httpGet: routes({ 'ebi.ac.uk': { resultList: { result: [
      { doi: DOI }, { doi: DOI, abstractText: LONG }] } } }) });
    expect(r.status).toBe('found');
  });
});

describe('DOI normalisation decodes URL encoding (Sol)', () => {
  it('%2F in a doi.org URL is a slash', () => {
    expect(normalizeAbstractDoi('https://doi.org/10.1234%2Fpart')).toBe('10.1234/part');
  });
});

describe('cache (both seats)', () => {
  it('a cached found from a source the caller excluded is not returned', async () => {
    const cache = new MemoryAbstractCache();
    await fetchAbstract(DOI, { cache, sources: ['crossref'], httpGet: routes({ 'api.crossref.org': { message: { DOI, abstract: LONG } } }) });
    const r = await fetchAbstract(DOI, { cache, sources: ['openalex'],
      httpGet: routes({ 'api.openalex.org': { id: 'W1', doi: `https://doi.org/${DOI}`, abstract_inverted_index: null } }) });
    expect(r.source).not.toBe('crossref');
  });
  it('mutating a returned result does not change the cache', async () => {
    const cache = new MemoryAbstractCache();
    const a = await fetchAbstract(DOI, { cache, sources: ['crossref'], httpGet: routes({ 'api.crossref.org': { message: { DOI, abstract: LONG } } }) });
    a.abstract = 'tampered';
    const b = await fetchAbstract(DOI, { cache, sources: ['crossref'], httpGet: routes({}) });
    expect(b.abstract).toBe(LONG.trim());
  });
  it('a cached not_found older than notFoundMaxAgeDays is looked up again', async () => {
    const cache = new MemoryAbstractCache();
    const t0 = new Date('2026-01-01T00:00:00Z');
    await fetchAbstract(DOI, { cache, sources: ['crossref'], now: () => t0, httpGet: routes({ 'api.crossref.org': null }) });
    const later = new Date('2026-03-01T00:00:00Z');
    const r = await fetchAbstract(DOI, { cache, sources: ['crossref'], now: () => later, notFoundMaxAgeDays: 30,
      httpGet: routes({ 'api.crossref.org': { message: { DOI, abstract: LONG } } }) });
    expect(r.status).toBe('found');
  });
});

describe('markup cleaning (both seats)', () => {
  it('decodes common named entities', () => {
    expect(cleanAbstractMarkup('<jats:p>&alpha; = .05 &ndash; &le; 3</jats:p>')).toBe('α = .05 – ≤ 3');
  });
  it('keeps an unescaped comparison sign and its text', () => {
    expect(cleanAbstractMarkup('effects at p<0.05 and q>0.1 held')).toBe('effects at p<0.05 and q>0.1 held');
  });
  it('takes one abstract (English, else the first), never two languages joined', () => {
    const raw = '<jats:abstract xml:lang="de"><jats:p>Deutsch Text.</jats:p></jats:abstract>'
      + '<jats:abstract xml:lang="en"><jats:p>English text.</jats:p></jats:abstract>';
    expect(cleanAbstractMarkup(raw)).toBe('English text.');
  });
  it('strips a heading "Summary:" but not a sentence starting "Summary statistics"', () => {
    expect(cleanAbstractMarkup('Summary: We tested x.')).toBe('We tested x.');
    expect(cleanAbstractMarkup('Summary statistics were computed.')).toBe('Summary statistics were computed.');
  });
});
