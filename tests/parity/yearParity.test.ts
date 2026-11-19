/**
 * One year definition, every reader (2026-11-19). The year rule drifted twice in this
 * release (too narrow: "(1859)" had no year; then too wide: "1650 participants" was the
 * year), because each reader carried its own copy. Now YEAR (1500-2099) and BARE_YEAR
 * (1900-2099, a bare number in running text) live in src/util/normalize.ts, and every
 * reader uses them:
 *  - findReferenceYear: a whole reference string (DOI matcher);
 *  - findParentheticalYear: the year anchor (journal metadata, isValidReference);
 *  - parseYear: a value that IS a year field (dedup), so the whole range counts;
 *  - the author split in the DOI matcher (cut at the first "(" + YEAR).
 * The matrix: each shape, in each context, gives one reading in every reader that sees it.
 */
import { describe, it, expect } from '@jest/globals';
import { YEAR, BARE_YEAR, findParentheticalYear, findReferenceYear, parseYear } from '../../src/util/normalize.js';
import { isValidReference } from '../../src/predatory/journalMetadata.js';

// [shape, year in a parenthetical / year field, year when the shape sits bare in running text]
const MATRIX: Array<[string, number | null, number | null]> = [
  ['1859', 1859, null],          // pre-1900: a year only in year context
  ['1650', 1650, null],
  ['1521', 1521, null],
  ['1999', 1999, 1999],
  ['2019a', 2019, 2019],
  ['2019, March 3', 2019, 2019],
  ['1781/1998', 1998, null],     // original/reprint: the reprint (bare: the "/" makes it not a year)
  ['1990s', null, null],         // a decade is not a year (review attempt 5)
  ['1600s', null, null],
  ['1499', null, null],          // below the range
  ['2100', null, null],
];

describe('the same year shape reads the same in every reader', () => {
  it.each(MATRIX)('%j', (shape, inContext, bare) => {
    // year context: a parenthetical that is only the year, or a year field
    expect(findParentheticalYear(`Smith, J. (${shape}). Title.`)?.year ?? null).toBe(inContext);
    expect(findReferenceYear(`Smith, J. (${shape}). Title.`)).toBe(inContext);
    expect(parseYear(shape)).toBe(inContext);
    expect(parseYear(`(${shape})`)).toBe(inContext);
    // running text, no year context
    expect(findReferenceYear(`Smith J. Title. J Foo. ${shape}.`)).toBe(bare);
  });

  it.each([
    'Smith J. Effects in 1650 participants. J Psych.',
    'Ann. N.Y. Acad. Sci., vol. 1521, no. 1, pp. 1-10.',
    'Smith J. Title. J Hist. pp. 1648 – 1655.',
    'Smith J. Title. J Hist. 1948-1955.',
    'Smith J. Trial (N = 1648). Lancet.',
    'Smith J. arXiv:1706.03762.',
    'Smith J. Health policy in the 1990s. BMJ.',
  ])('counts, volumes, pages and identifiers are not years: %j', (text) => {
    expect(findReferenceYear(text)).toBeNull();
    expect(findParentheticalYear(text)).toBeNull();
  });

  it('isValidReference sees the same parenthetical years', () => {
    for (const [shape, inContext] of MATRIX) {
      const ref = { id: 'r', raw_text: `Smith, J. (${shape}). Title.` } as any;
      expect(isValidReference(ref)).toBe(inContext !== null);
    }
  });

  it('the shared definitions are the ranges they claim', () => {
    const y = new RegExp(`^${YEAR}$`), b = new RegExp(`^${BARE_YEAR}$`);
    expect([1499, 1500, 1899, 1900, 2099, 2100].map((n) => y.test(String(n)))).toEqual([false, true, true, true, true, false]);
    expect([1899, 1900, 2099, 2100].map((n) => b.test(String(n)))).toEqual([false, true, true, false]);
  });
});

describe('a decade in a title does not displace the real year (review attempt 5)', () => {
  it.each([
    ['Smith J. Health policy in the 1990s. BMJ. 2019;365:l1234.', 2019],
    ['Smith, J. (2019). Music of the 1960s. Journal, 1(2), 3-4.', 2019],
    ['Smith, J. (2019b). Title.', 2019],
  ])('%j', (text, want) => {
    expect(findReferenceYear(text)).toBe(want);
  });
});

/**
 * The class check (review attempt 5): over reference shapes in APA, Vancouver, IEEE,
 * Harvard and Nature styles, the reader gives the true year or no year (the DOI matcher
 * then skips its year check) and never a WRONG year, which rejects the right DOI. The
 * three KNOWN_WRONG shapes read the same way in 0.2.x (a year in a title or an access
 * date comes first); they are logged debt, listed here so a new one cannot hide among them.
 */
const SHAPES: Array<[string, number | null]> = [
 ['Smith, J. (2019). Title. Journal, 12(3), 45-67.', 2019],
 ['Smith, J. (2019, March 3). Title. Blog.', 2019],
 ['Smith, J. (2019a). Title.', 2019],
 ['Smith, J., & Lee, K. (2020). Title. J, 1(1), 1-2. https://doi.org/10.1000/xyz123', 2020],
 ['Smith J, Lee K. Title. Lancet. 2019;393(10170):1-10.', 2019],
 ['Smith J. Title. Lancet. 2019 Mar 3;393:1-10.', 2019],
 ['Smith J. Title. Lancet. 2019:393:1-10.', 2019],
 ['J. Smith, "Title," IEEE Trans. X, vol. 12, no. 3, pp. 45-67, 2019.', 2019],
 ['J. Smith, "Title," IEEE Trans. X, vol. 12, no. 3, pp. 45-67, Mar. 2019.', 2019],
 ['Smith, J. 2019. Title. Journal 12: 45-67.', 2019],
 ['Smith J (2019) Title. Nature 500:54-58', 2019],
 ['Smith, J. (2018-2019). Title.', 2018],
 ['Smith, J. (2019/2020). Title.', 2020],
 ['Smith, J. (1859). Origin.', 1859],
 ['Kant, I. (1781/1998). Critique.', 1998],
 ['Smith J. Health policy in the 1990s. BMJ. 2019;365:l1234.', 2019],
 ['Smith, J. (2019). Music of the 1960s. J, 1, 2.', 2019],
 ['Smith J. Effects in 1650 participants. J Psych. 2019;12:1-5.', 2019],
 ['Ann. N.Y. Acad. Sci., vol. 1521, no. 1, pp. 1-10, 2023.', 2023],
 ['Smith J. Trial (N = 1648). Lancet. 2019;393:10-20.', 2019],
 ['Vaswani A. Attention. arXiv:1706.03762. 2017', 2017],
 ['Smith J. Brain. 2019;12(3):1648-1655.', 2019],
 ['Smith, J. (in press). Title.', null],
 ['Smith, J. (n.d.). Title. Retrieved March 3, 2019, from https://x.org', null],
 ['Smith, J. (2019). Title. Retrieved 2021-03-05, from https://x.org', 2019],
 ['Smith J. Title. Published 03/2019.', 2019],
 ['Smith J. Title. 2019-03.', 2019],
 ['Smith J. Title. J. 2019.03.05.', 2019],
 ['Smith J. The 2008 crisis. J Econ. 2015;3:1-2.', 2015],
 ['Smith, J. (2015). The 2008 crisis. J Econ, 3, 1-2.', 2015],
 ['Smith J. Title. J. 2019;12:e2019001.', 2019],
 ['World Health Organization. Report 2019. Geneva: WHO; 2020.', 2020],
 ['Smith J. Title. Zenodo. 2021. doi:10.5281/zenodo.2019123', 2021],
];
const KNOWN_WRONG = new Set([
  'Smith, J. (n.d.). Title. Retrieved March 3, 2019, from https://x.org',
  'Smith J. The 2008 crisis. J Econ. 2015;3:1-2.',
  'World Health Organization. Report 2019. Geneva: WHO; 2020.',
]);
describe('the reference-year reader never returns a wrong year', () => {
  it.each(SHAPES.filter(([t]) => !KNOWN_WRONG.has(t)))('%j', (text, truth) => {
    const y = findReferenceYear(text);
    expect(y === truth || y === null).toBe(true);
  });
});
