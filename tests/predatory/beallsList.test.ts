/**
 * Beall's-List predatory matching — deterministic-core tests.
 *
 * Added by citationguard-iterate (2026-06-08). The matcher previously had ZERO
 * standalone coverage. D3: the old `a.includes(b) || b.includes(a)` raw-substring
 * test branded legitimate publishers predatory on partial-word overlaps (e.g.
 * "SciTechnology" matched the Beall's entry "SciTechnol"). These tests fail
 * against that implementation and pass against the whole-word token matcher.
 */
import { describe, it, expect } from '@jest/globals';
import {
  publisherNameMatches,
  checkBeallsList,
  isKnownLegitimate,
} from '../../src/predatory/beallsList.js';

describe('publisherNameMatches (D3 whole-word fix)', () => {
  it('matches a distinctive single-word entry that appears as a full token', () => {
    expect(publisherNameMatches('SciTechnol Group', 'SciTechnol')).toBe(true);
  });

  it('does NOT match on a partial-word overlap (the D3 false positive)', () => {
    // "scitechnol" is a prefix of "scitechnology" — must no longer match.
    expect(publisherNameMatches('SciTechnology Publications', 'SciTechnol')).toBe(false);
  });

  it('matches a multi-word short form contained in a longer name', () => {
    expect(publisherNameMatches('Royal Society of Chemistry', 'Royal Society')).toBe(true);
  });

  it('is symmetric (order-independent)', () => {
    expect(publisherNameMatches('OMICS Publishing Group', 'OMICS')).toBe(
      publisherNameMatches('OMICS', 'OMICS Publishing Group'),
    );
  });

  it('does NOT match on a single generic word', () => {
    expect(publisherNameMatches('Science', 'Open Science Journal')).toBe(false);
    expect(publisherNameMatches('Press', 'Academic Press Predatory')).toBe(false);
  });

  it('collapses irregular whitespace before matching (D4)', () => {
    // The old substring test failed here: 'omics   publishing  group' (doubled
    // spaces) does not .includes('omics publishing group').
    expect(publisherNameMatches('OMICS   Publishing  Group', 'OMICS Publishing Group')).toBe(true);
  });

  it('keeps accented / non-Latin tokens instead of collapsing to empty (D4)', () => {
    expect(publisherNameMatches('Médecine Générale', 'Médecine Générale')).toBe(true);
  });

  it('returns false for empty inputs', () => {
    expect(publisherNameMatches('', 'Elsevier')).toBe(false);
    expect(publisherNameMatches('Elsevier', '')).toBe(false);
  });
});

describe('checkBeallsList / isKnownLegitimate (bundled data integration)', () => {
  it('flags a known predatory publisher', () => {
    expect(checkBeallsList('SciTechnol')).toBe(true);
  });

  it('does NOT brand a legitimate publisher predatory via a partial-word overlap (D3 regression)', () => {
    expect(checkBeallsList('SciTechnology Incorporated')).toBe(false);
  });

  it('recognizes known legitimate publishers (incl. a short form of a longer name)', () => {
    expect(isKnownLegitimate('Elsevier')).toBe(true);
    expect(isKnownLegitimate('Royal Society of Chemistry')).toBe(true);
  });

  it('returns false for an unknown publisher', () => {
    expect(checkBeallsList('Cambridge University Press')).toBe(false);
  });
});
