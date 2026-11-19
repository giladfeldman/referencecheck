/**
 * v0.3.0 review, attempt 8 (2026-11-19). Same class as round 7: "a written shape read into a
 * wrong value that 0.2.x read right", this time introduced by the round-7 fixes themselves.
 *  - Deduplication: a folded name ("smith j", the `normalized_authors` shape) was reordered as
 *    if given-name-first; full given names were cut to initials (John/Jane Smith scored 1.0);
 *    "Lee J-H", "Smith J Jr", "G. Garcia Marquez" and "Smith et al." were misread.
 *  - DOI matcher: "Li" matched inside "Williams"; a name in another script skipped the check
 *    and accepted a wrong DOI; any word before a Vancouver surname was skipped.
 *  - A DOI broken by a space was cut short into a different DOI.
 *  - Errata: a record naming only itself as its correction reported one erratum.
 * Expected values are 0.2.x's (33278cf) wherever 0.2.x read the shape right.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: jest.fn(), post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});
const lib: any = await import('../../src/index.js');

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
});

// 0.3.0 scores names by level (identical / compatible 1.0; one given name missing or order
// unknown 0.75; same surname, conflicting given names 0.5; different surnames 0), where 0.2.x
// scored a share of letters; the folded shape is still read surname-first, as in 0.2.x.
describe('deduplication: folded names are compared as written', () => {
  it.each([
    [['smith j'], ['jones j'], 0],
    [['alder j'], ['adams j'], 0],
    [['li y'], ['wang y'], 0],
    [['alder j'], ['alder'], 0.75],
    [['van der berg jh'], ['van der berg'], 0.75],
    [['SMITH J'], ['JONES J'], 0],
  ])('%j vs %j', (a, b, want) => {
    expect(lib.compareAuthors(a, b)).toBeCloseTo(want, 6);
  });
  it('different folded people are not duplicates (README shape)', () => {
    const ref = (authors: string[]) => ({ id: 'x', raw_text: 'x', normalized_authors: authors, normalized_title: 'a study of priming', normalized_year: '2015' });
    const config = { authorWeighting: 0.4, titleWeighting: 0.4 };
    const s = lib.calculateSimilarity(ref(['smith j']), ref(['jones j']), config);
    expect(s).toBeCloseTo(0.4 * 0 + 0.4 + 0.2, 6);
  });
});

describe('deduplication: names written in a shown order', () => {
  it.each([
    // same surname, conflicting given names: 0.5 (never merged at the README threshold)
    ['John Smith', 'Jane Smith', 0.5],
    // one comma and no initials on either side is one name, surname first
    ['Smith, John', 'Smith, Jane', 0.5],
  ])('full given names stay names: %j vs %j', (a, b, want) => {
    expect(lib.compareAuthors(a, b)).toBeCloseTo(want, 6);
  });
  it('Mary and Michael Jones are not one person', () => {
    expect(lib.compareAuthors('Mary Jones', 'Michael Jones')).toBeLessThan(0.8);
  });
  it.each([
    ['Lee J-H', 'Lee JH'],
    ['Smith J Jr', 'Smith J'],
    ['Smith JH', 'Smith JH Jr'],
    ['Smith JH III', 'Smith, J. H.'],
    ['Garcia Marquez, G.', 'G. Garcia Marquez'],
    ['J. A. Smith', 'Smith JA'],
  ])('%j and %j are one person', (a, b) => {
    expect(lib.compareAuthors(a, b)).toBeCloseTo(1.0, 10);
  });
  it('"John Smith" (order not shown) is Smith, J. at the unknown-order level', () => {
    expect(lib.compareAuthors('John Smith', 'Smith, J.')).toBeCloseTo(0.75, 10);
  });
  it('"Smith et al." keeps its first author (no given name: 0.75)', () => {
    expect(lib.compareAuthors('Smith et al.', 'Smith, J.')).toBeCloseTo(0.75, 10);
  });
  it('"Ivanov II" keeps its Vancouver initials', () => {
    expect(lib.compareAuthors('Ivanov II', 'Ivanov IP')).toBeLessThan(1.0);
  });
});

describe('DOI matcher: surnames', () => {
  const accepts = async (text: string, family: string | string[]) => {
    const families = Array.isArray(family) ? family : [family];
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
      DOI: '10.1/found', score: 90, title: ['Priming effects'], author: families.map((f) => ({ family: f, given: 'X.' })),
      published: { 'date-parts': [[2015, 1, 1]] },
    }] } } });
    return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
  };
  it.each([
    // a surname is a whole word, never a piece of another
    ['Hoddy KK, Gibbons C, Li X. Priming effects. J Things. 2015;3:1-2.', 'Williams', false],
    ['Hoddy KK, Gibbons C, Li X. Priming effects. J Things. 2015;3:1-2.', 'Li', true],
    ['Smith, J. (2015). Priming effects. J, 1, 2.', 'Smith-Jones', true],
    ['O\'Brien, J. (2015). Priming effects. J, 1, 2.', 'OBrien', true],
    // another script: compared through its Latin spelling, never skipped
    ['Smith, J. (2015). Priming effects. J, 1, 2.', 'Иванов', false],
    ['Ivanov, I. (2015). Priming effects. J, 1, 2.', ['Иванов', 'Петров'], true],
    ['Kuznetsova, A. (2015). Priming effects. J, 1, 2.', 'Кузнецова', true],
    ['Petrov, P. (2015). Priming effects. J, 1, 2.', 'Иванов', false],
    ['Papadopoulos, G. (2015). Priming effects. J, 1, 2.', 'Παπαδόπουλος', true],
    // only name particles may stand before a Vancouver surname
    ['Hoddy KK Gibbons C. Priming effects. J Things. 2015;3:1-2.', 'Hoddy', true],
    ['Lee J-H, Kim S. Priming effects. J Things. 2015;3:1-2.', 'Lee', true],
    ['de la Cruz M, Kim S. Priming effects. J Things. 2015;3:1-2.', 'Cruz', true],
  ])('%j vs Crossref %j', async (text, family, want) => {
    expect(await accepts(text, family)).toBe(want);
  });
});

describe('a DOI broken by a space is not cut into another DOI', () => {
  it.each([
    ['10.1371/journal.pone. 0123456', '10.1371/journal.pone. 0123456'],
    ['10.1037/0 022-3514.84.4.822', '10.1037/0 022-3514.84.4.822'],
    ['10.1016/j.cell.2020.\n01.001', '10.1016/j.cell.2020.\n01.001'],
    // percent-decoding that would add a space keeps the encoded form (a DOI has no space)
    ['https://doi.org/10.1000/abc%20def', '10.1000/abc%20def'],
    // a citation tail after the space is still cut
    ['10.1101/2020.03.22.002386 [preprint]', '10.1101/2020.03.22.002386'],
    ['10.1037/a0012345 (PMID: 123456).', '10.1037/a0012345'],
    ['10.1037/a0012345. Accessed 2020-01-01', '10.1037/a0012345'],
    ['10.1037/a0012345 https://example.org/x', '10.1037/a0012345'],
  ])('cleanDoiInput(%j)', (input, want) => {
    expect(lib.cleanDoiInput(input)).toBe(want);
  });
  it.each([
    '10.1371/journal.pone. 0123456',
    '10.1037/0 022-3514.84.4.822',
  ])('isMalformedDoi(%j) is true, as in 0.2.x', (doi) => {
    expect(lib.isMalformedDoi(doi)).toBe(true);
  });
});

describe('errata: the work itself is not its own correction', () => {
  it('a record listing only its own DOI has no errata', async () => {
    const rec = JSON.parse(readFileSync('tests/fixtures/crossref/corrected.json', 'utf8'));
    const first = rec.message['updated-by'][0];
    rec.message['updated-by'] = [{ ...first, DOI: '10.1088/1361-6595/AAEBDB' }];
    axiosGetMock.mockResolvedValue({ status: 200, data: rec });
    const issues = await lib.checkReferenceForReplies({ id: 'r', raw_text: 'x', doi: '10.1088/1361-6595/aaebdb' });
    expect(issues.filter((i: any) => i.code === 'HAS_ERRATA')).toEqual([]);
  });
});
