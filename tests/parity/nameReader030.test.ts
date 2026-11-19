/**
 * 0.3.0 name reader and DOI-match evidence (2026-11-19 redesign).
 *  - One name parser (`parseName`) for deduplication and the author-list splitter.
 *  - Deduplication scores each name pair by level; two different well-formed DOIs never merge.
 *  - The DOI matcher reports each check as matched / mismatched / not_comparable, compares
 *    other scripts through a loose Latin spelling, and checks the title.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: jest.fn(), post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});
const lib: any = await import('../../src/index.js');
// A record of a cited author carries that author's given name, as Crossref records do (round 17).
const { givenNameFor } = await import('../labelled/givenName.mjs');

jest.spyOn(console, 'log').mockImplementation(() => {});
beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
});

describe('parseName: one reading of every written shape', () => {
  it.each([
    ['Smith, J. A.', 'smith', 'ja', 'known'],
    ['Smith JA', 'smith', 'ja', 'known'],
    ['J. A. Smith', 'smith', 'ja', 'known'],
    ['smith j', 'smith', 'j', 'known'],
    ['SMITH J', 'smith', 'j', 'known'],
    ['Smith J Jr', 'smith', 'j', 'known'],
    ['Smith JH III', 'smith', 'jh', 'known'],
    ['King, M. L., Jr.', 'king', 'ml', 'known'],
    ['Lee J-H', 'lee', 'jh', 'known'],
    ['van der Berg, J.', 'van der berg', 'j', 'known'],
    ['Garcia Marquez, G.', 'garcia marquez', 'g', 'known'],
    ['Smith et al.', 'smith', '', 'known'],
  ])('%j -> surname %j, initials %j, order %s', (raw, surname, initials, order) => {
    const p = lib.parseName(raw);
    expect([p.surname, p.initials, p.order, p.raw]).toEqual([surname, initials, order, raw]);
  });
  it('a two-word name with full words has no shown order', () => {
    expect(lib.parseName('John Smith').order).toBe('unknown');
    expect(lib.parseName('Smith, John')).toMatchObject({ surname: 'smith', order: 'known' });
  });
});

describe('splitAuthorList: one splitter, every element split', () => {
  it.each([
    ['Smith, JA, Jones, KB', ['Smith, JA', 'Jones, KB']],
    ['Smith, J., Jones, K.', ['Smith, J.', 'Jones, K.']],
    ['Smith J, Jones K, et al.', ['Smith J', 'Jones K']],
    ['King, M. L., Jr.; Anderson, B.', ['King, M. L., Jr.', 'Anderson, B.']],
    // one comma and no initials on either side: one name, surname first
    ['Smith, John', ['Smith, John']],
    ['Smith, Jones', ['Smith, Jones']],
    // a given part mixing full names and initials joins a bare surname
    ['Smith, John A.', ['Smith, John A.']],
    ['Smith, J. Alan', ['Smith, J. Alan']],
    ['Garcia Marquez, Gabriel J.', ['Garcia Marquez, Gabriel J.']],
    ['Smith JA, Jones KB', ['Smith JA', 'Jones KB']],
    ['Hoddy KK, Gibbons C, Li X', ['Hoddy KK', 'Gibbons C', 'Li X']],
  ])('%j', (input, want) => {
    expect(lib.splitAuthorList(input)).toEqual(want);
  });
  it('array elements are split too', () => {
    expect(lib.splitAuthorList(['Smith, J., Jones, K.', 'Lee M'])).toEqual(['Smith, J.', 'Jones, K.', 'Lee M']);
    expect(lib.splitAuthorList(['Smith, John'])).toEqual(['Smith, John']);
  });
});

describe('deduplication: one score per name level', () => {
  it.each([
    ['identical', 'Smith, J. A.', 'Smith JA', 1],
    ['compatible given names', 'Smith, J.', 'Smith, John A.', 1],
    ['one side has no given name', 'Smith', 'Smith, K.', 0.75],
    ['order not shown, one reading compatible', 'Wang Wei', 'Wei, W.', 0.75],
    ['same surname, conflicting initial (never merged)', 'Smith, J.', 'Smith, K.', 0.5],
    ['same surname, conflicting given name', 'Mary Jones', 'Michael Jones', 0.5],
    ['Ivanov and Ivanova are one author', 'Иванов, И.', 'Ivanova, I.', 1],
    ['near surname, both 5+ letters', 'Papadopoulos, J.', 'Papadopoulou, J.', 0.75],
    ['short surnames one letter apart are different', 'Li, J.', 'Lu, J.', 0],
    ['different surnames', 'Smith, J.', 'Jones, K.', 0],
  ])('%s: %j vs %j', (_why, a, b, want) => {
    expect(lib.compareAuthors(a, b)).toBeCloseTo(want, 10);
  });

  const cfg = { threshold: 0.85, authorWeighting: 0.4, titleWeighting: 0.4 };
  const ref = (id: string, over: Record<string, unknown> = {}) => ({
    id, raw_text: '', normalized_authors: ['smith j'], normalized_title: 'a study of priming', normalized_year: '2020', ...over,
  });
  // Round 11 (owner decision F8): the same DOI is forced to 1 unless authors AND title both
  // contradict it, so this pair keeps its title and differs only in the author.
  it('the same DOI (any written form) is the same work', () => {
    const s = lib.calculateSimilarity(ref('a', { doi: '10.1037/ABC.1' }), ref('b', { doi: 'https://doi.org/10.1037/abc.1', normalized_authors: ['jones k'] }), cfg);
    expect(s).toBe(1);
  });
  it('two different DOIs stay under the threshold, even with everything else equal', () => {
    const s = lib.calculateSimilarity(ref('a', { doi: '10.1037/abc.1' }), ref('b', { doi: '10.1037/abc.2' }), cfg);
    expect(s).toBeLessThan(0.85);
    expect(s).toBeGreaterThan(0.8);
    const noThreshold = lib.calculateSimilarity(ref('a', { doi: '10.1037/abc.1' }), ref('b', { doi: '10.1037/abc.2' }), { authorWeighting: 0.4, titleWeighting: 0.4 });
    expect(noThreshold).toBeLessThan(0.85);
  });
  it('the cap follows the configured threshold', () => {
    const s = lib.calculateSimilarity(ref('a', { doi: '10.1037/abc.1' }), ref('b', { doi: '10.1037/abc.2' }), { ...cfg, threshold: 0.7 });
    expect(s).toBeLessThan(0.7);
  });
  it('a malformed DOI on one side does not decide anything', () => {
    const s = lib.calculateSimilarity(ref('a', { doi: '10.1/x' }), ref('b', { doi: '10.1037/abc.2' }), cfg);
    expect(s).toBe(1);
  });
  it('grouping drops a pair with two different DOIs', () => {
    const a = ref('a', { doi: '10.1037/abc.1' });
    const b = ref('b', { doi: '10.1037/abc.2' });
    const c = ref('c');
    expect(lib.findDuplicateGroups([{ ref1: a, ref2: b, similarity: 0.99 }])).toEqual([]);
    const groups = lib.findDuplicateGroups([{ ref1: a, ref2: c, similarity: 0.9 }]);
    expect(groups).toHaveLength(1);
  });
});

const crossref = (over: Record<string, unknown> = {}) => ({
  DOI: '10.1/found', score: 90, title: ['Priming effects on memory'], author: [{ family: 'Smith', given: 'J.' }],
  published: { 'date-parts': [[2015, 1, 1]] }, ...over,
});
const search = async (text: string, item: Record<string, unknown>) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [item] } } });
  return lib.findDOIFromReferenceDetailed(text);
};
const apa = (surname: string) => `${surname}, J. (2015). Priming effects on memory. J Things, 1, 2.`;

describe('DOI matcher: names in another script', () => {
  it.each([
    ['Dostoevsky', 'Достоевский'], ['Dostoyevsky', 'Достоевский'], ['Tchaikovsky', 'Чайковский'], ['Chaikovsky', 'Чайковский'],
    ['Yuriev', 'Юрьев'], ['Vasiliev', 'Васильев'], ['Vasilyev', 'Васильев'], ['Solovyov', 'Соловьёв'], ['Soloviev', 'Соловьев'],
    ['Ivanoff', 'Иванов'], ['Alexeev', 'Алексеев'], ['Grigoriev', 'Григорьев'], ['Ilyin', 'Ильин'], ['Zaytsev', 'Зайцев'],
    ['Melnyk', 'Мельник'], ['Hrytsenko', 'Гриценко'], ['Ivanova', 'Иванов'], ['Khirianova', 'Хирьянова'], ['Selyukov', 'Селюков'],
    ['Chikina', 'Чикина'],
  ])('%j matches Crossref %j', async (latin, cyrillic) => {
    const out = await search(apa(latin), crossref({ author: [{ family: cyrillic, given: 'И.' }] }));
    expect(out.result?.doi).toBe('10.1/found');
    expect(out.result?.authorCheck).toBe('matched');
  });
  it.each([
    ['Smith', 'Иванов'], ['Ivanov', 'Петров'], ['Ivashov', 'Иванов'], ['Lu', 'Ли'], ['Kum', 'Ким'],
    ['Simonov', 'Смирнов'], ['Pavlov', 'Попов'], ['Petrenko', 'Петров'], ['Kozlov', 'Кузнецов'],
  ])('%j does not match Crossref %j', async (latin, cyrillic) => {
    const out = await search(apa(latin), crossref({ author: [{ family: cyrillic, given: 'И.' }] }));
    expect(out.result).toBeNull();
    expect(out.rejected[0]).toMatchObject({ reason: expect.stringMatching(/^Author mismatch/), authorCheck: 'mismatched' });
  });
});

describe('DOI matcher: surname extraction and whole-word matching', () => {
  it.each([
    ['Van Dyke, J. (2015). Priming effects on memory. J Things, 1, 2.', 'VanDyke', true],
    ['VanDyke, J. (2015). Priming effects on memory. J Things, 1, 2.', 'Van Dyke', true],
    ['de la Cruz, M. (2015). Priming effects on memory. J Things, 1, 2.', 'de la Cruz', true],
    ['de la Cruz, M. (2015). Priming effects on memory. J Things, 1, 2.', 'Cruz', true],
    ['Smith, J. (2015). Priming effects on memory. J Things, 1, 2.', 'Goldsmith', false],
    ['Li, X. (2015). Priming effects on memory. J Things, 1, 2.', 'Liu', false],
    ['Li, X. (2015). Priming effects on memory. J Things, 1, 2.', 'Williams', false],
  ])('%j vs Crossref %j', async (text, family, want) => {
    const out = await search(text, crossref({ author: [{ family, given: givenNameFor(text, family) }] }));
    expect(out.result?.doi === '10.1/found').toBe(want);
  });
});

describe('DOI matcher: evidence that cannot be compared does not reject, and is reported', () => {
  it('a name in a script with no Latin spelling (Han) is not_comparable, not a mismatch', async () => {
    const out = await search(apa('Smith'), crossref({ author: [{ family: '王' }] }));
    expect(out.result).toMatchObject({ doi: '10.1/found', authorCheck: 'not_comparable', yearCheck: 'matched', titleCheck: 'matched' });
    expect(out.notComparable).toEqual({ author: 1, year: 0, title: 0 });
  });
  it('a Crossref record with no authors is not_comparable', async () => {
    const item = crossref();
    delete (item as any).author;
    const out = await search(apa('Smith'), item);
    expect(out.result?.authorCheck).toBe('not_comparable');
  });
  it('a reference with no readable surname is not_comparable', async () => {
    const out = await search('(2015). Priming effects on memory. J Things, 1, 2.', crossref());
    expect(out.result?.authorCheck).toBe('not_comparable');
  });
  it('a reference with no year is not_comparable on year', async () => {
    const out = await search('Smith, J. Priming effects on memory. J Things, 1, 2.', crossref());
    expect(out.result).toMatchObject({ yearCheck: 'not_comparable', authorCheck: 'matched' });
    expect(out.notComparable.year).toBe(1);
  });
  it('a title in another script is not_comparable on title', async () => {
    const out = await search(apa('Smith'), crossref({ title: ['Эффекты прайминга в памяти'] }));
    expect(out.result?.titleCheck).toBe('not_comparable');
    expect(out.notComparable.title).toBe(1);
  });
  it('a one-word title is not_comparable on title', async () => {
    const out = await search(apa('Smith'), crossref({ title: ['Editorial'] }));
    expect(out.result?.titleCheck).toBe('not_comparable');
  });
  it('rejected candidates are counted too', async () => {
    const out = await search(apa('Smith'), crossref({ author: [{ family: '王' }], title: ['Volcanic eruptions in Iceland'] }));
    expect(out.result).toBeNull();
    expect(out.notComparable.author).toBe(1);
  });
});

describe('DOI matcher: title evidence', () => {
  it('a candidate whose title shares no words with the reference is rejected', async () => {
    const out = await search(apa('Smith'), crossref({ title: ['Volcanic eruptions in Iceland'] }));
    expect(out.result).toBeNull();
    expect(out.rejected[0]).toMatchObject({ reason: expect.stringMatching(/^Title mismatch/), titleCheck: 'mismatched', authorCheck: 'matched', yearCheck: 'matched' });
  });
  it('a candidate whose title words all occur is accepted with titleCheck matched', async () => {
    const out = await search(apa('Smith'), crossref());
    expect(out.result).toMatchObject({ doi: '10.1/found', authorCheck: 'matched', yearCheck: 'matched', titleCheck: 'matched' });
    expect(out.notComparable).toEqual({ author: 0, year: 0, title: 0 });
  });
});

describe('percent-encoded DOIs', () => {
  it.each([
    ['10.1000/a%20b', '10.1000/a%20b'],
    ['https://doi.org/10.1000/abc%20def', '10.1000/abc%20def'],
    ['https://doi.org/10.1037%2Fabc', '10.1037/abc'],
  ])('cleanDoiInput(%j) is %j and well-formed', (input, want) => {
    expect(lib.cleanDoiInput(input)).toBe(want);
    expect(lib.isMalformedDoi(input)).toBe(false);
  });
});
