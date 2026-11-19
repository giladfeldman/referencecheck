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
