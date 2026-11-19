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
    ['Darwin C. On the origin of species. London: Murray; 1859.', 1859],
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
