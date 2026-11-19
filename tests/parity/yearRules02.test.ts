/**
 * Years keep their 0.2.x rules in this release (owner decision 2026-11-19).
 *
 * A shared year reader was tried in 0.3.0 and failed review six times: each round found
 * reference shapes where 0.2.x read the right year and the new reader a wrong one (a date
 * like "2015-03-03" followed by a later access year, a number glued to letters such as
 * "NCI-H1975", a dated parenthetical in a title, "1781/1998" in deduplication). A wrong
 * year rejects the right DOI. So every year rule is the 0.2.x code again, and this test
 * pins each public path that reads a year to a copy of the 0.2.x rule over the shapes the
 * reviews found. A redesign must ship on its own and must beat these, not match them.
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

// The 0.2.x rules, copied from v0.2.x (src/http/crossref.ts extractYearFromReference,
// src/dedup/similarity.ts compareYear).
const year02 = (t: string): number | null => {
  for (const re of [/\((\d{4})[a-z]?\)/, /\b(19\d{2}|20\d{2})\b/]) { const m = t.match(re); if (m) return parseInt(m[1], 10); }
  return null;
};
const compareYear02 = (a: any, b: any): number => {
  if (!a || !b) return !a && !b ? 0.5 : 0.0;
  const y1 = parseInt(a.toString(), 10), y2 = parseInt(b.toString(), 10);
  if (isNaN(y1) || isNaN(y2)) return 0.0;
  return y1 === y2 ? 1.0 : Math.abs(y1 - y2) === 1 ? 0.5 : 0.0;
};

// Shapes the six review rounds raised, plus ordinary ones (controls). All start "Smith".
const REFS = [
  'Smith, J. (2015). Priming effects. Journal of Things, 3(1), 1-2.',
  'Smith, J. (2015, March 3). Priming effects. Blog.',
  'Smith, J. (2015a). Priming effects. J, 1, 2.',
  'Smith J. Priming effects. J Things. 2015;3:1-2.',
  'Smith J. Priming effects. J Things. 2015-03-03;3(1):1-2. Accessed 2020.',
  'Smith J. Priming effects. J Things. 03/2015;3:1-2. Accessed 2020.',
  'Smith J. Priming effects. J Things. 2015:3:1-2. [cited 2020 Mar 3]',
  'Smith J. Osimertinib resistance in NCI-H1975 cells. Cancer Res. 2015;75:1-2.',
  'Smith J. Sequencing on the HiSeq2000 platform. J Things. 2015;3:1-2.',
  'Smith, J. Aftershocks of the Tohoku earthquake (2011, March 11). Nature 521, 1-2 (2015).',
  'Smith, J. Census undercount (1990/2000). Nature 521, 1-2 (2015).',
  'Smith J. Priming effects. J Things. 2015;3:1-2. Erratum in: J Things (2017, March 3).',
  'Smith, J. (1859). On the origin of species. Murray.',
  'Smith, I. (1781/1998). Critique of pure reason. CUP.',
  'Smith J. Health policy in the 1990s. BMJ. 2015;365:l1234.',
  'Smith J. Effects in 1650 participants. J Psych. 2015;12:1-5.',
  'Smith J. Trial (N = 1648). Lancet. 2015;393:10-20.',
  'Smith J. Attention. arXiv:1706.03762. 2015',
  'Smith J. The 2008 financial crisis. J Things. 2015;3:1-2.',
  'J. Smith, "Priming effects," IEEE Trans. X, vol. 12, no. 3, pp. 45-67, 2015.',
  'Smith, J. (in press). Priming effects. J Things.',
];

describe('the DOI matcher accepts and rejects exactly as 0.2.x did', () => {
  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
  });
  const item = (year: number) => ({
    // No title: these references name other works, and 0.3.0's title check (not a year rule)
    // would reject the candidate; without a title it is not_comparable and only the year decides.
    DOI: '10.1/found', score: 90, title: [], author: [{ family: 'Smith', given: 'J.' }],
    published: { 'date-parts': [[year, 1, 1]] },
  });
  it.each(REFS)('%j', async (text) => {
    for (const crossrefYear of [2015, 2011, 2020, 1859, 1998]) {
      axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [item(crossrefYear)] } } });
      const got = (await lib.findDOIFromReference(text))?.doi === '10.1/found';
      const y = year02(text);
      const want = y === null || Math.abs(y - crossrefYear) <= 1;
      expect({ crossrefYear, accepted: got }).toEqual({ crossrefYear, accepted: want });
    }
  });
});

describe('deduplication compares years exactly as 0.2.x did', () => {
  const VALUES = ['2019', '2020', '2019a', '(2019)', '1781/1998', '1781', '2019/2020', '1450', '1460', 'in press', 'n.d.', '', null, undefined, 'c. 1984', '1984'];
  it('every pair', () => {
    const bad: string[] = [];
    for (const a of VALUES) for (const b of VALUES) if (lib.compareYear(a, b) !== compareYear02(a, b)) bad.push(`${a} | ${b}`);
    expect(bad).toEqual([]);
  });
});

describe('no new year reader is exported in this release', () => {
  it.each(['parseYear', 'findReferenceYear', 'findParentheticalYear', 'YEAR', 'BARE_YEAR', 'YEAR_SUFFIX'])('%s', (name) => {
    expect(lib[name]).toBeUndefined();
  });
});
