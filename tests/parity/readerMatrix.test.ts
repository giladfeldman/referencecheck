/**
 * v0.3.0 QA (2026-11-20). Class: "one fact written in several forms is read differently".
 * Variant matrices for the three readers this release added or changed that had only single
 * cases: the ISSN reader (DOAJ and journal metadata), the Crossref date reader (every date the
 * library returns), and the correction-notice type (HAS_ERRATA).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

const crossrefGetMock = jest.fn<any>();
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));
const norm = await import('../../src/util/normalize.js');
const { checkReferenceForReplies } = await import('../../src/replies/citationRepliesService.js');

beforeEach(() => { crossrefGetMock.mockReset(); });

describe('normalizeIssn: every written form of one ISSN reads the same', () => {
  it.each([
    ['1932-6203', '1932-6203'],
    ['19326203', '1932-6203'],
    ['1932 6203', '1932-6203'],
    ['1932–6203', '1932-6203'], // en dash
    ['1932‐6203', '1932-6203'], // Unicode hyphen
    [' 1932-6203 ', '1932-6203'],
    ['ISSN 1932-6203', '1932-6203'],
    ['ISSN: 1932-6203', '1932-6203'],
    ['issn 1932-6203', '1932-6203'],
    ['eISSN 2434-561X', '2434-561X'],
    ['p-ISSN 2434-561X', '2434-561X'],
    ['2434-561x', '2434-561X'],
    ['2434561X', '2434-561X'],
  ])('%j -> %s', (written, want) => {
    expect(norm.normalizeIssn(written)).toBe(want);
  });
  it.each([
    ['1932-6204'], // wrong check digit
    ['1648-1655'], // page range
    ['2019-2020'], // year range
    ['1932-620'], ['1932-62031'], ['ABCD-EFGH'], [''],
  ])('%j is not an ISSN', (written) => {
    expect(norm.normalizeIssn(written)).toBeNull();
  });
});

describe('formatDateParts: every precision Crossref serves', () => {
  it.each([
    [[2019, 3, 5], '2019-03-05'],
    [[2019, 12, 31], '2019-12-31'],
    [[2019, 3], '2019-03'],
    [[2019], '2019'],
    [[2019, 3, null], '2019-03'],
    [[2019, null], '2019'],
    [[null], undefined], // Crossref's "no date" (seen once in 2,585 corpus dates)
    [[], undefined],
    [null, undefined],
    [undefined, undefined],
    // Text parts never occur in Crossref records (0 of 2,585 corpus dates); pinned as no date.
    [['2019', '3', '5'], undefined],
  ])('%j -> %s', (parts, want) => {
    expect(norm.formatDateParts(parts)).toBe(want);
  });
});

describe('correction notices: the update type in any case', () => {
  const run = async (type: string) => {
    const rec = JSON.parse(readFileSync('tests/fixtures/crossref/corrected.json', 'utf8'));
    rec.message['updated-by'][0].type = type;
    crossrefGetMock.mockResolvedValue({ status: 200, data: rec });
    const issues = await checkReferenceForReplies({ id: 'r', raw_text: 'x', doi: '10.1088/1361-6595/aaebdb' } as any);
    return issues.some((i: any) => i.code === 'HAS_ERRATA');
  };
  it.each([['correction'], ['Correction'], ['CORRECTION'], ['erratum'], ['Erratum'], ['corrigendum'], ['Corrigendum']])(
    '%s raises HAS_ERRATA', async (type) => {
      expect(await run(type)).toBe(true);
    });
  it.each([['addendum'], ['clarification'], ['retraction'], ['expression_of_concern']])(
    '%s raises no HAS_ERRATA', async (type) => {
      expect(await run(type)).toBe(false);
    });
});

describe('splitAuthorList: one three-author list in every separator and name order', () => {
  const INVERTED = ['Smith, J. A.', 'Jones, K.', 'Lee, M.-H.'];
  it.each([
    ['Smith, J. A., Jones, K., & Lee, M.-H.', INVERTED],
    ['Smith, J. A., Jones, K., and Lee, M.-H.', INVERTED],
    ['Smith, J. A., Jones, K., Lee, M.-H.', INVERTED],
    ['Smith, J. A.; Jones, K.; Lee, M.-H.', INVERTED],
    ['Smith, J. A. ; Jones, K. ; Lee, M.-H.', INVERTED],
    [INVERTED, INVERTED],
    ['Smith JA, Jones K, Lee MH', ['Smith JA', 'Jones K', 'Lee MH']],
    ['Smith J.A., Jones K., Lee M.H.', ['Smith J.A.', 'Jones K.', 'Lee M.H.']],
    ['J. A. Smith, K. Jones, and M.-H. Lee', ['J. A. Smith', 'K. Jones', 'M.-H. Lee']],
    ['John Smith, Kate Jones & Mi-Hee Lee', ['John Smith', 'Kate Jones', 'Mi-Hee Lee']],
    ['King, M. L., Jr.; Anderson, B.', ['King, M. L., Jr.', 'Anderson, B.']],
    ['King, M. L., Jr., & Anderson, B.', ['King, M. L., Jr.', 'Anderson, B.']],
    ['Smith, J. A.', ['Smith, J. A.']],
    ['Smith', ['Smith']],
    ['', []],
  ])('%j', (written, want) => {
    expect(norm.splitAuthorList(written as any)).toEqual(want);
  });
});

describe('cleanDoiInput: what a citation writes after a DOI is cut, the DOI itself is kept', () => {
  const D = '10.1037/abc123';
  it.each([
    [D, D], [`${D}.`, D], [`${D},`, D], [`${D};`, D], [`"${D}"`.slice(1), D],
    [`${D} PMID: 123`, D], [`${D} [PMID 123]`, D], [`${D} (accessed 2020)`, D],
    [`${D}. Retrieved from x`, D], [`${D} https://x`, D], [`${D} Epub 2020`, D], [`${D} pdf`, D],
    ['10.1101/x).', '10.1101/x'],
    // brackets inside a DOI stay; a DOI broken by a space stays whole for the shape check
    ['10.1037/abc(123)', '10.1037/abc(123)'],
    ['10.1016/S0140-6736(20)30183-5', '10.1016/S0140-6736(20)30183-5'],
    ['10.1002/(SICI)1097-0258(19980430)17:8<857::AID-SIM777>3.0.CO;2-E', '10.1002/(SICI)1097-0258(19980430)17:8<857::AID-SIM777>3.0.CO;2-E'],
    ['10.1371/journal.pone. 0123456', '10.1371/journal.pone. 0123456'],
  ])('%j -> %s', (written, want) => {
    expect(norm.cleanDoiInput(written)).toBe(want);
  });
});
