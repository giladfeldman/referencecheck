/**
 * Parity matrices for the author-list and name/title readers (2026-11-18 sweep). Years keep
 * their 0.2.x rules in this release (see tests/parity/yearRules02.test.ts).
 *
 * Class: "one input shape is read differently in different code paths". Members found:
 *  - Author list: calculateSimilarity joined normalized_authors with ", " and compareAuthors
 *    split on every comma, so ["Smith, J.", "Jones, K."] became four people while
 *    ["J. Smith", "K. Jones"] stayed two.
 *  - Names and titles: an ASCII-only fold turned "Müller" into "m ller" and a Cyrillic or
 *    Chinese name or title into "" — read as ABSENT, so identical non-Latin titles scored 0.
 *  - DOI matcher (findDOIFromReference): the same ASCII-only surname pattern found no
 *    author in "Müller, K." (check silently skipped) and rejected Crossref "Müller" against
 *    a reference "Muller".
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

describe('author-list parity: one list, every way it is written', () => {
  const ONE_LIST: Array<string | string[]> = [
    ['Smith, J.', 'Jones, K.'],
    'Smith, J., Jones, K.',
    'Smith, J.; Jones, K.',
    'Smith, J., & Jones, K.',
    'Smith, J. and Jones, K.',
    ['Smith J', 'Jones K'],
    'Smith J, Jones K',
  ];
  it('compareAuthors scores every written form of the list identically against every other', () => {
    const bad: string[] = [];
    // Compare each form with the array form, after folding the shapes to "surname initials".
    for (const a of ONE_LIST) for (const b of ONE_LIST) {
      const s = lib.compareAuthors(a, b);
      if (s < 0.999) bad.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)} = ${s.toFixed(3)}`);
    }
    expect(bad).toEqual([]);
  });
  it('calculateSimilarity gives the same answer for one author list written two ways', () => {
    const cfg = { authorWeighting: 0.4, titleWeighting: 0.4, similarityThreshold: 0.8 };
    const ref = (authors: string[]) => ({
      id: 'x', raw_text: '', normalized_authors: authors, normalized_title: 'a title', normalized_year: '2019',
    });
    const withCommas = lib.calculateSimilarity(ref(['Smith, J.', 'Jones, K.']), ref(['Smith, J.', 'Jones, K.']), cfg);
    const plain = lib.calculateSimilarity(ref(['smith j', 'jones k']), ref(['smith j', 'jones k']), cfg);
    expect(withCommas).toBeCloseTo(plain, 10);
    expect(withCommas).toBeCloseTo(1.0, 10);
  });
  // Round 11 (owner decision F6): a list naming only the first author scores as the full
  // list, so the control names the second author alone, which is not a prefix.
  it('an extra author still lowers the score (control)', () => {
    expect(lib.compareAuthors('Jones, K.', 'Smith, J.; Jones, K.')).toBeLessThan(0.9);
  });
});

describe('name and title parity across scripts and accents', () => {
  it('accented and unaccented spellings of one name normalise identically', () => {
    expect(lib.normalizeAuthorName('Müller, K.')).toBe(lib.normalizeAuthorName('Muller, K.'));
    // ø does not decompose under NFKD; foldForMatch maps it (0.3.0 review round 2).
    expect(lib.normalizeAuthorName('Ødegård')).toBe('odegard');
  });
  it('a non-Latin name or title is never read as absent', () => {
    for (const s of ['Иванов, И.', '王伟', 'Παπαδόπουλος']) {
      expect(lib.normalizeAuthorName(s).length).toBeGreaterThan(0);
      expect(lib.compareAuthors(s, s)).toBeCloseTo(1.0, 10);
    }
    const ru = 'Психологическая наука сегодня';
    expect(lib.compareTitle(ru, ru)).toBeCloseTo(1.0, 10);
    expect(lib.compareTitle(ru, 'Completely different English title')).toBeLessThan(0.3);
  });
  it('titles differing only in case, punctuation or accents are identical', () => {
    const t = 'Effects of naïve priming: A re-examination';
    for (const v of ['effects of naive priming a re examination', 'EFFECTS OF NAÏVE PRIMING — A RE-EXAMINATION.']) {
      expect(lib.compareTitle(t, v)).toBeCloseTo(1.0, 10);
    }
  });
});

describe('DOI matcher: one reference, every way the surname and year are written', () => {
  const item = (family: string, year: number) => ({
    DOI: '10.1/found', score: 90, title: ['Priming effects'], author: [{ family, given: 'K.' }],
    published: { 'date-parts': [[year, 1, 1]] },
  });
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
  });
  const run = async (refText: string, family: string, year: number) => {
    axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [item(family, year)] } } });
    return lib.findDOIFromReference(refText);
  };
  it('accepts the right surname in accented and unaccented spellings', async () => {
    const cases: Array<[string, string]> = [
      ['Müller, K. (2019). Priming effects. J Psych, 1, 1-2.', 'Müller'],
      ['Muller, K. (2019). Priming effects. J Psych, 1, 1-2.', 'Müller'],
      ['Müller, K. (2019). Priming effects. J Psych, 1, 1-2.', 'Muller'],
      ['Müller, K. (2019, March 3). Priming effects. J Psych, 1, 1-2.', 'Müller'],
    ];
    const bad: string[] = [];
    for (const [text, fam] of cases) if ((await run(text, fam, 2019))?.doi !== '10.1/found') bad.push(`${text} / ${fam}`);
    expect(bad).toEqual([]);
  });
  it('rejects a wrong surname written with an accent (the check is not skipped)', async () => {
    expect(await run('Müller, K. (2019). Priming effects. J Psych, 1, 1-2.', 'Zhang', 2019)).toBeNull();
    expect(await run('Ødegård, K. (2019). Priming effects. J Psych, 1, 1-2.', 'Zhang', 2019)).toBeNull();
  });
  it('reads the year inside "(2019, March 3)", not a later number (control: wrong year rejected)', async () => {
    expect(await run('Smith, K. (2019, March 3). Priming effects in 1984. J Psych.', 'Smith', 2019)).not.toBeNull();
    expect(await run('Smith, K. (2019, March 3). Priming effects in 1984. J Psych.', 'Smith', 2015)).toBeNull();
  });
});

describe('journal-name parity (predatory screening)', () => {
  const source = (name: string) => ({ id: 'S1', display_name: name, type: 'journal', issn_l: '1234-5678', issn: ['1234-5678'] });
  const search = async (query: string, served: string) => {
    axiosGetMock.mockReset();
    axiosGetMock.mockResolvedValue({ status: 200, data: { results: [source(served)] } });
    return lib.searchOpenAlexByJournalName(query);
  };
  it('one journal written with or without accents, "&" or "and", trailing period, is the same match', async () => {
    const pairs: Array<[string, string]> = [
      ['Revista de Psicologia', 'Revista de Psicología'],
      ['Journal of Personality & Social Psychology', 'Journal of Personality and Social Psychology'],
      ['Journal of Experimental Social Psychology.', 'Journal of Experimental Social Psychology'],
      ['JOURNAL OF EXPERIMENTAL SOCIAL PSYCHOLOGY', 'Journal of Experimental Social Psychology'],
    ];
    const bad: string[] = [];
    for (const [q, served] of pairs) {
      const r = await search(q, served);
      if (!r.found || r.journalTitle !== served) bad.push(`${q} -> ${JSON.stringify(r)}`);
    }
    expect(bad).toEqual([]);
  });
  it('a different journal is still no match (control)', async () => {
    const r = await search('Journal of Applied Psychology', 'Journal of Applied Social Psychology');
    expect(r.found).toBe(false);
  });
  it('the APA journal extractor anchors on "(2019, March 3)" as on "(2019)"', async () => {
    const tail = '. Priming effects revisited. Journal of Applied Thinking, 12(3), 1-10.';
    const plain = await lib.extractJournalMetadata({ id: 'a', raw_text: `Alder, J. (2019)${tail}` }, false);
    const dated = await lib.extractJournalMetadata({ id: 'b', raw_text: `Alder, J. (2019, March 3)${tail}` }, false);
    expect(dated.journal).toBe(plain.journal);
    expect(plain.journal).toBeTruthy();
  });
});
