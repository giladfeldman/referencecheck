/**
 * DOI-shape validation — deterministic-core tests.
 *
 * Added by the platform's hardening workflow (2026-06-08) to behavior-pin the structural
 * DOI heuristics. NOTE: doiShape.ts is an intentional verbatim copy of the
 * worker's entityOwnership.ts helpers ("do not let them diverge"), so these
 * tests document the CURRENT structural behavior and must not be used to justify
 * a semantic change here without changing the worker copy in lockstep.
 */
import { describe, it, expect } from '@jest/globals';
import { isMalformedDoi, isShortFormDoi } from '../../src/doi/doiShape.js';

describe('isMalformedDoi', () => {
  it('accepts a standard 10.<registrant>/<suffix> DOI', () => {
    expect(isMalformedDoi('10.1037/abc123')).toBe(false);
    expect(isMalformedDoi('10.1016/j.jesp.2021.104154')).toBe(false);
  });

  it('accepts the short-DOI form 10/<token>', () => {
    expect(isMalformedDoi('10/abc')).toBe(false);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(isMalformedDoi('  10.1037/abc  ')).toBe(false);
  });

  it('rejects empty, wrong-prefix, and suffix-less DOIs', () => {
    expect(isMalformedDoi('')).toBe(true);
    expect(isMalformedDoi('not-a-doi')).toBe(true);
    expect(isMalformedDoi('11.1037/x')).toBe(true);
    expect(isMalformedDoi('10.1037/')).toBe(true);
  });

  it('rejects a non-string input', () => {
    // @ts-expect-error deliberately passing a non-string
    expect(isMalformedDoi(null)).toBe(true);
  });
});

describe('isShortFormDoi', () => {
  it('is true only for the 10/<token> form', () => {
    expect(isShortFormDoi('10/abc')).toBe(true);
    expect(isShortFormDoi('10.1037/abc')).toBe(false);
    expect(isShortFormDoi('')).toBe(false);
  });
});
