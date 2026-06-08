/**
 * Reference-dedup similarity — deterministic-core tests.
 *
 * Added by citationguard-iterate (2026-06-08). D9: compareAuthors averaged
 * best-matches over list 1 only, so the score depended on argument order when
 * the lists differed in length. The symmetry test fails against that
 * implementation and passes against the both-directions average.
 */
import { describe, it, expect } from '@jest/globals';
import {
  compareAuthors,
  compareTitle,
  compareYear,
  scoreMetadataCompleteness,
} from '../../src/dedup/similarity.js';

describe('compareAuthors (D9 symmetry)', () => {
  it('scores identical author lists ~1.0', () => {
    expect(compareAuthors('Smith, J', 'Smith, J')).toBeCloseTo(1.0, 5);
  });

  it('is commutative for DIFFERENT-length lists (the D9 fix)', () => {
    const a = 'Smith, J';
    const b = 'Smith, J; Jones, A';
    expect(compareAuthors(a, b)).toBeCloseTo(compareAuthors(b, a), 10);
  });

  it('penalizes an unmatched extra author (a subset is not a perfect match)', () => {
    expect(compareAuthors('Smith, J', 'Smith, J; Jones, A')).toBeLessThan(1.0);
  });

  it('returns 0.5 when both lists are missing and 0 when only one is', () => {
    expect(compareAuthors('', '')).toBe(0.5);
    expect(compareAuthors('Smith', '')).toBe(0.0);
  });
});

describe('compareYear', () => {
  it('exact match 1.0, off-by-one 0.5, further apart 0', () => {
    expect(compareYear('2020', '2020')).toBe(1.0);
    expect(compareYear('2020', '2021')).toBe(0.5);
    expect(compareYear('2020', '2025')).toBe(0.0);
  });

  it('both missing neutral, one missing 0, non-numeric 0', () => {
    expect(compareYear(null, null)).toBe(0.5);
    expect(compareYear('2020', null)).toBe(0.0);
    expect(compareYear('abcd', 'efgh')).toBe(0.0);
  });
});

describe('compareTitle', () => {
  it('identical titles score ~1.0', () => {
    expect(compareTitle('A Study of X', 'A Study of X')).toBeCloseTo(1.0, 5);
  });

  it('clearly different titles score < 1', () => {
    expect(compareTitle('A Study of X', 'Completely Different')).toBeLessThan(1.0);
  });
});

describe('scoreMetadataCompleteness', () => {
  it('ranks a fully-populated reference above a sparse one', () => {
    const full = {
      id: '1',
      normalized_title: 'T',
      normalized_authors: ['A'],
      normalized_year: '2020',
      doi: '10.1/x',
      parsed_data: { source: 'J', volume: '1', pages: '1-2' },
    } as any;
    const sparse = { id: '2', normalized_title: 'T' } as any;
    expect(scoreMetadataCompleteness(full)).toBeGreaterThan(scoreMetadataCompleteness(sparse));
  });
});
