/**
 * Reference-dedup grouping — deterministic-core tests.
 *
 * Added by citationguard-iterate (2026-06-08). Pins the transitive-closure
 * grouping and the selectBestReference contract. D12 (selectBestReference throws
 * on an empty array) was triaged as INTENDED defensive behavior — the only
 * caller guards `groupRefs.length > 1` — so this test documents the throw rather
 * than changing it.
 */
import { describe, it, expect } from '@jest/globals';
import { findDuplicateGroups, selectBestReference } from '../../src/dedup/grouping.js';

const ref = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    normalized_title: 'T',
    normalized_authors: ['A'],
    normalized_year: '2020',
    ...over,
  }) as any;

describe('selectBestReference', () => {
  it('returns the single reference for a singleton group', () => {
    const r = ref('1');
    expect(selectBestReference([r])).toBe(r);
  });

  it('returns the most metadata-complete reference', () => {
    const sparse = ref('1');
    const full = ref('2', { doi: '10.1/x', parsed_data: { source: 'J', volume: '1', pages: '1-2' } });
    expect(selectBestReference([sparse, full]).id).toBe('2');
  });

  it('throws on an empty array (documented defensive contract, D12)', () => {
    expect(() => selectBestReference([])).toThrow();
  });
});

describe('findDuplicateGroups', () => {
  it('returns [] when there are no pairs', () => {
    expect(findDuplicateGroups([])).toEqual([]);
  });

  it('merges A=B and B=C into one transitive group of three', () => {
    const a = ref('A');
    const b = ref('B');
    const c = ref('C');
    const pairs = [
      { ref1: a, ref2: b, similarity: 0.9 },
      { ref1: b, ref2: c, similarity: 0.85 },
    ];
    const groups = findDuplicateGroups(pairs as any);
    expect(groups).toHaveLength(1);
    expect(groups[0].references).toHaveLength(3);
    expect(groups[0].averageSimilarity).toBeCloseTo(0.875, 5);
  });
});
