/**
 * v0.3.0 review, attempt 3 (2026-11-19). findReferenceYear floored years at 1900, while
 * parseYear (the year-field reader) accepts 1500-2099 and 0.2.x read any "(dddd)". A
 * reference to a pre-1900 work then had no year, so the DOI matcher skipped its year check
 * and could accept a modern reprint's DOI on the author check alone.
 */
import { describe, it, expect } from '@jest/globals';
import { findReferenceYear, parseYear } from '../../src/util/normalize.js';

describe('findReferenceYear accepts the same year range as parseYear', () => {
  it.each([
    ['Darwin, C. (1859). On the origin of species.', 1859],
    ['Newton, I. (1687). Principia.', 1687],
    // A bare pre-1900 number is not read (it is more often a count or a volume): no year, as in 0.2.x.
    ['Darwin C. On the origin of species. London: Murray; 1859.', null],
    ['James, W. (1890, May). The principles of psychology.', 1890],
    // controls
    ['Smith, J. (2019). Title.', 2019],
    ['Smith J. Pages 1999-2003 only.', null],
    ['Smith, J. (1499). Too early.', null],
  ])('%j', (text, want) => {
    expect(findReferenceYear(text)).toBe(want);
    if (want !== null) expect(parseYear(String(want))).toBe(want);
  });
});

/**
 * Review attempt 4: 72f48ca also widened the BARE-number branch to 1500, so a count,
 * volume or page from 1500-1899 became the year and rejected the right DOI. Only a
 * parenthetical is read from 1500; a bare number must be 1900-2099, as in 0.2.x.
 * "(1781/1998)" (original/reprint) reads the reprint year, which is what Crossref holds.
 */
describe('a bare 1500-1899 number is not a year; a parenthetical one is', () => {
  it.each([
    ['Smith J. Effects in 1650 participants. J Psych. 2019;12:1-5.', 2019],
    ['Ann. N.Y. Acad. Sci., vol. 1521, no. 1, pp. 1–10, 2023.', 2023],
    ['Kant, I. (1781/1998). Critique of pure reason. Cambridge University Press.', 1998],
    ['Smith J. Title. J Hist. pp. 1648 – 1655. 1999', 1999],
    ['Smith J. Trial (N = 1648). Lancet. 2019;393:10-20.', 2019],
    ['Smith J. Article 1750. 2019', 2019],
    // controls
    ['Darwin, C. (1859). On the origin of species.', 1859],
    ['Smith, J. (2019). Title. J, 1648(3), 5', 2019],
  ])('%j', (text, want) => {
    expect(findReferenceYear(text)).toBe(want);
  });
});
