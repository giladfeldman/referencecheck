/**
 * v0.3.0 review, attempt 11 (2026-11-19). Shapes the labelled set did not render until this
 * round, where 0.3.0 decided worse than 0.2.x (one test per member of each class):
 *  - DOI matcher, names: given names first with a middle initial ("Michael J. LaCour") was read
 *    as Vancouver surname "Michael"; a reference starting with its title had its first word
 *    read as a surname; a group author ("World Health Organization") likewise.
 *  - DOI matcher, titles: a Crossref subtitle the reference leaves out was required; one word
 *    spelt another accepted way (behaviour, judgement, plural) failed a short title; a title cut
 *    with "..." was compared whole.
 *  - Deduplication, names: "o brien z" (O'Brien Z folded) was three unknown words and near
 *    "O'Brien, K."; "Maria Garcia" / "Mario Garcia" and "Wang Li" / "Wang Lin" were near
 *    surnames, not conflicting given names; "Smith John A." read "Smith John" as the surname.
 *  - Deduplication, lists and DOIs (owner defaults): the first author alone, a DOI with a
 *    landing-page tail, and preprint versions; one DOI on two different works.
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

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

const REC = {
  DOI: '10.1/lacour',
  title: ['A Study of Moral Judgment in Groups'],
  subtitle: [],
  author: [{ family: 'LaCour', given: 'Michael J.' }, { family: 'Green', given: 'Donald P.' }],
  published: { 'date-parts': [[2014]] },
  'container-title': ['Science'],
  type: 'journal-article',
};

async function search(text: string, record: any) {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{ ...record, score: 90 }] } } });
  return lib.findDOIFromReferenceDetailed(text);
}

describe('DOI matcher: author shapes', () => {
  it.each([
    ['given names first, middle initial', 'Michael J. LaCour, Donald P. Green (2014). A Study of Moral Judgment in Groups. Science.'],
    ['given names first, "and"', 'Michael J. LaCour and Donald P. Green (2014). A Study of Moral Judgment in Groups. Science.'],
    ['one author, given names first', 'Michael J. LaCour (2014). A Study of Moral Judgment in Groups. Science.'],
    ['Chicago, "and"', 'LaCour, Michael J., and Donald P. Green. 2014. A Study of Moral Judgment in Groups. Science.'],
  ])('%s: accepted with the author matched', async (_name, text) => {
    const o = await search(text, REC);
    expect(o.result?.doi).toBe('10.1/lacour');
    expect(o.result?.authorCheck).toBe('matched');
  });

  it('given names first, other people: rejected on the author check', async () => {
    const o = await search('Michael J. Smith, Donald P. Jones (2014). A Study of Moral Judgment in Groups. Science.', REC);
    expect(o.result).toBeNull();
    expect(o.rejected[0].authorCheck).toBe('mismatched');
  });

  it('a real one-author Vancouver list followed by a lower-case title is still read as Vancouver', async () => {
    const rec = { ...REC, author: [{ family: 'Hoddy', given: 'K.' }], title: ['Obesity, diabetes and the heart'] };
    const right = await search('Hoddy K. Obesity, diabetes and the heart. Science. 2014.', rec);
    expect(right.result?.authorCheck).toBe('matched');
    const wrong = await search('Hoddy K. Obesity, diabetes and the heart. Science. 2014.', { ...rec, author: [{ family: 'Jones', given: 'K.' }] });
    expect(wrong.result).toBeNull();
  });

  it.each([
    ['the title first', 'A Study of Moral Judgment in Groups. (2014). Science.'],
    ['the title first, colon', 'Retracted: A Study of Moral Judgment in Groups. (2014). Science.'],
    ['a group author', 'World Health Organization. (2014). A Study of Moral Judgment in Groups. Science.'],
    ['a two-word group author', 'Research Group. (2014). A Study of Moral Judgment in Groups. Science.'],
  ])('%s: no surname read, accepted as not_comparable', async (_name, text) => {
    const rec = text.startsWith('Retracted') ? { ...REC, title: ['Retracted: A Study of Moral Judgment in Groups'] } : REC;
    const o = await search(text, rec);
    expect(o.result?.doi).toBe('10.1/lacour');
    expect(o.result?.authorCheck).toBe('not_comparable');
  });

  it('a record listing an author in a script that cannot be compared does not let other people through', async () => {
    const rec = { ...REC, author: [{ family: 'Jones', given: 'K.' }, { family: '李', given: '明' }] };
    const o = await search('Smith, J. (2014). A Study of Moral Judgment in Groups. Science.', rec);
    expect(o.result).toBeNull();
    expect(o.rejected[0].authorCheck).toBe('mismatched');
    // ... while a record mostly in that script still cannot be compared
    const han = { ...REC, author: [{ family: '王', given: '伟' }, { family: '李', given: '明' }] };
    const h = await search('Smith, J. (2014). A Study of Moral Judgment in Groups. Science.', han);
    expect(h.result?.authorCheck).toBe('not_comparable');
  });
});

describe('DOI matcher: title shapes', () => {
  const APA = 'LaCour, M. J., & Green, D. P. (2014).';
  it.each([
    ['a short subtitle left out', `${APA} Power posing. Science.`, { title: ['Power posing'], subtitle: ['Evidence from fieldwork'] }],
    ['a long subtitle left out', `${APA} Power posing. Science.`, { title: ['Power posing'], subtitle: ['Brief nonverbal displays affect neuroendocrine levels and risk tolerance'] }],
    ['a one-word main title, subtitle left out', `${APA} Pandemics. Science.`, { title: ['Pandemics'], subtitle: ['Lessons from three centuries of outbreaks'] }],
    ['UK spelling, short title', `${APA} Behaviour change. Science.`, { title: ['Behavior change'] }],
    ['judgement / judgment', `${APA} Moral judgement. Science.`, { title: ['Moral judgment'] }],
    ['-ise / -ize', `${APA} Organisation theory. Science.`, { title: ['Organization theory'] }],
    ['plural', `${APA} Social norms. Science.`, { title: ['Social norm'] }],
    ['modelling / modeling', `${APA} Climate modelling. Science.`, { title: ['Climate modeling'] }],
    ['cut with "..."', `${APA} Mechanisms responsible for the initiation of a fast... Science.`, { title: ['Mechanisms responsible for the initiation of a fast breakdown in an atmospheric discharge'] }],
    ['cut mid-word with "…"', `${APA} Mechanisms responsible for the initiation of a fast break… Science.`, { title: ['Mechanisms responsible for the initiation of a fast breakdown in an atmospheric discharge'] }],
  ])('%s: accepted', async (_name, text, patch) => {
    const o = await search(text, { ...REC, subtitle: [], ...patch });
    expect(o.result?.doi).toBe('10.1/lacour');
    expect(o.result?.titleCheck).not.toBe('mismatched');
  });

  it('a short title sharing one of two words, author and year matched: not_comparable, accepted', async () => {
    const o = await search(`${APA} Neural nets. Science.`, { ...REC, title: ['Neural networks'] });
    expect(o.result?.titleCheck).toBe('not_comparable');
  });

  it.each([
    ['a short title sharing no word', `${APA} Cloud physics. Science.`, { title: ['Neural networks'] }],
    ['a short title, one shared word, author matched, no year to compare', 'LaCour, M. J., & Green, D. P. Neural nets. Science.', { title: ['Neural networks'] }],
    ['a long title of another work', `${APA} A Study of Moral Judgment in Groups. Science.`, { title: ['Rotation of stars in open clusters observed by satellites'] }],
    ['the main title of another work, subtitle words present', `${APA} Evidence from fieldwork. Science.`, { title: ['Rotation of stars in open clusters'], subtitle: ['Evidence from fieldwork'] }],
  ])('%s: rejected', async (_name, text, patch) => {
    const o = await search(text, { ...REC, subtitle: [], ...patch });
    expect(o.result).toBeNull();
  });
});

describe('parseName and deduplication: names one letter apart', () => {
  it.each([
    ['o brien z', 'o brien', 'z'],
    ['d angelo n', 'd angelo', 'n'],
    ['Smith John A.', 'smith', 'ja'],
    ['van der Berg Jan H.', 'van der berg', 'jh'],
    ['Garcia Marquez G', 'garcia marquez', 'g'],
  ])('parseName(%j): surname %j, initials %j', (raw, surname, initials) => {
    const p = lib.parseName(raw);
    expect(p.surname).toBe(surname);
    expect(p.initials).toBe(initials);
    expect(p.order).toBe('known');
  });

  it.each([
    [["O'Brien, K."], ['o brien z'], 0.5],
    [["O'Connor, J."], ['o connor k'], 0.5],
    [["D'Angelo, M."], ['d angelo n'], 0.5],
    [["O'Brien, K."], ['o brien k'], 1],
    [["D'Angelo, M."], ['d angelo m'], 1],
    [['Maria Garcia'], ['Mario Garcia'], 0.5],
    [['Wang Li'], ['Wang Lin'], 0.5],
    [['John Smith'], ['Jon Smith'], 0.5],
    [['Smith JA'], ['Smith John A.'], 1],
    [['smith j a'], ['Smith John A.'], 1],
    [['Smith, John A.'], ['Smith John A.'], 1],
    [['Bazhin Alexandr V'], ['Bazhin, A. V.'], 0.75],
    [['Papadopoulos, J.'], ['Papadopoulou, J.'], 0.75],
  ])('%j vs %j: %d', (a, b, want) => {
    expect(lib.compareAuthors(a, b)).toBeCloseTo(want, 6);
  });

  it('names one letter apart are not merged at the README configuration', () => {
    const cfg = { threshold: 0.85, authorWeighting: 0.4, titleWeighting: 0.4 };
    const ref = (a: string) => ({ id: a, raw_text: '', normalized_authors: [a], normalized_title: 'Same title here', normalized_year: '2020' });
    for (const [a, b] of [["O'Brien, K.", 'o brien z'], ['Maria Garcia', 'Mario Garcia'], ['Wang Li', 'Wang Lin'], ['John Smith', 'Jon Smith']]) {
      expect(lib.calculateSimilarity(ref(a), ref(b), cfg)).toBeLessThan(0.85);
    }
  });
});

describe('deduplication: shorter author lists (owner default)', () => {
  const full = ['Parkevich, E. V.', 'Ivanenkov, G. V.', 'Medvedev, M. A.'];
  it.each([
    [['Parkevich, E. V.'], 1],
    [['Parkevich, E. V., et al.'], 1],
    [['Parkevich, E. V.', 'et al.'], 1],
    [['Parkevich, E. V.', 'Ivanenkov, G. V.'], 1],
    [['parkevich'], 0.75],
  ])('%j against the full list: %d', (short, want) => {
    expect(lib.compareAuthors(short, full)).toBeCloseTo(want, 6);
    expect(lib.compareAuthors(full, short)).toBeCloseTo(want, 6);
  });
  it('a shorter list that is not the start of the longer one keeps the averaged score', () => {
    expect(lib.compareAuthors(['Medvedev, M. A.'], full)).toBeLessThan(0.75);
    expect(lib.compareAuthors(['Parkevich, Z.'], full)).toBeLessThan(0.75);
  });
});

describe('deduplication: DOIs (owner defaults)', () => {
  const cfg = { threshold: 0.85, authorWeighting: 0.4, titleWeighting: 0.4 };
  const ref = (doi: string, extra: any = {}) => ({ id: doi, raw_text: '', normalized_authors: ['Smith, J.'], normalized_title: 'Short', normalized_year: '2020', doi, ...extra });
  const other = { normalized_authors: ['Jones, K.'], normalized_title: 'A survey of sorting algorithms on graphics hardware' };
  it.each([
    ['10.1002/bimj.201500123', 'https://doi.org/10.1002/bimj.201500123/full'],
    ['10.1002/bimj.201500123', '10.1002/bimj.201500123/pdf'],
    ['10.1002/bimj.201500123', '10.1002/bimj.201500123/epdf'],
    ['10.1002/bimj.201500123', '10.1002/bimj.201500123/abstract'],
    ['10.1002/bimj.201500123', '10.1002/bimj.201500123?download=true'],
    ['10.1002/bimj.201500123', '10.1002/bimj.201500123#section1'],
    ['10.1101/123456', '10.1101/123456v2'],
    ['10.1101/2020.03.22.002386v1', '10.1101/2020.03.22.002386v3'],
    ['10.6084/m9.figshare.12345.v1', '10.6084/m9.figshare.12345.v2'],
    ['10.5281/zenodo.123.v1', '10.5281/zenodo.123'],
  ])('%s and %s are one work', (d1, d2) => {
    expect(lib.doiRelation(ref(d1), ref(d2))).toBe('same');
    expect(lib.calculateSimilarity(ref(d1), ref(d2, { normalized_authors: ['Smith J'], normalized_title: 'Short title of the work' }), cfg)).toBe(1);
  });
  it.each([
    ['10.31234/osf.io/abcde', '10.1037/xge0001234'],
    ['10.1002/bimj.201500123', '10.1002/bimj.201500124'],
    ['10.1234/abcv2', '10.1234/abc'],
  ])('%s and %s stay different', (d1, d2) => {
    expect(lib.doiRelation(ref(d1), ref(d2))).toBe('different');
    expect(lib.calculateSimilarity(ref(d1), ref(d2), cfg)).toBeLessThan(0.85);
  });
  it('one DOI on two different works (authors and title both differ): same-contradicted, not merged', () => {
    const a = ref('10.1145/3306346', { normalized_title: 'Neural rendering of clouds over mountain terrain' });
    const b = ref('https://doi.org/10.1145/3306346', other);
    expect(lib.doiRelation(a, b)).toBe('same-contradicted');
    expect(lib.calculateSimilarity(a, b, cfg)).toBeLessThan(0.85);
  });
  it('one DOI, only the title differs: the DOI decides (1)', () => {
    const a = ref('10.1145/3306346', { normalized_title: 'Neural rendering of clouds over mountain terrain' });
    const b = ref('10.1145/3306346', { normalized_title: other.normalized_title });
    expect(lib.doiRelation(a, b)).toBe('same');
    expect(lib.calculateSimilarity(a, b, cfg)).toBe(1);
  });
  it('one DOI, titles in two scripts and no author in common: no contradiction can be seen (1)', () => {
    const a = ref('10.1145/3306346', { normalized_authors: ['王伟'], normalized_title: '关于道德判断的研究' });
    const b = ref('10.1145/3306346', other);
    expect(lib.doiRelation(a, b)).toBe('same');
  });
  it('findDuplicateGroups counts the pairs it drops for different DOIs', () => {
    const d: any = {};
    const pairs = [
      { ref1: ref('10.1000/a'), ref2: ref('10.1000/b'), similarity: 0.95 },
      { ref1: ref('10.1000/a'), ref2: ref('10.1000/a/full'), similarity: 1 },
    ];
    expect(lib.findDuplicateGroups(pairs, d)).toHaveLength(1);
    expect(d.droppedDifferentDoi).toBe(1);
  });
});
