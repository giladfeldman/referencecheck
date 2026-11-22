/**
 * v0.3.0 review 10 (2026-11-22). Class: one DOI shape written as more than one pattern, each
 * reader with its own rule. Members found: the shortDOI shape (`10/<token>`) was written three
 * times — cleanDoiInput required a letter or digit first, isMalformedDoi and isShortFormDoi
 * accepted `.`, `_` or `-` first — and normalizeAbstractDoi accepted any `10.` + `/` (a 1- or
 * 2-digit registrant) where every other reader uses DOI_SHAPE. Each reader now uses the one
 * exported pattern (SHORT_DOI, SHORT_DOI_START, DOI_SHAPE in src/util/normalize.ts).
 */
import { describe, it, expect } from '@jest/globals';

const norm = await import('../../src/util/normalize.js');
const shape = await import('../../src/doi/doiShape.js');
const { normalizeAbstractDoi } = await import('../../src/abstract/index.js');

const FIRST = ['a', 'Z', '7', '.', '_', '-', '#', '%'];

describe('review 10: one shortDOI shape for every reader', () => {
  for (const c of FIRST) {
    const doi = `10/${c}bc12`;
    it(`"${doi}": cleanDoiInput, isShortFormDoi and isMalformedDoi agree`, () => {
      const short = norm.SHORT_DOI.test(doi);
      expect(norm.SHORT_DOI_START.test(doi)).toBe(short);
      expect(shape.isShortFormDoi(doi)).toBe(short);
      expect(shape.isMalformedDoi(doi)).toBe(!short && !norm.DOI_SHAPE.test(norm.cleanDoiInput(doi)));
      // cleanDoiInput cleans a fragment off exactly the forms read as a shortDOI
      const withFragment = norm.cleanDoiInput(`${doi}#x`);
      expect(withFragment === doi).toBe(short);
    });
  }

  it('real shortDOIs stay shortDOIs', () => {
    for (const d of ['10/gt3vmw', '10/b77m95', 'https://doi.org/10/gt3vmw', '10/gt3vmw#abc']) {
      expect(shape.isShortFormDoi(d)).toBe(true);
      expect(shape.isMalformedDoi(d)).toBe(false);
    }
  });
});

describe('review 10: the abstract reader uses the shared DOI shape', () => {
  for (let digits = 1; digits <= 10; digits++) {
    const doi = `10.${'1'.repeat(digits)}/x`;
    it(`registrant of ${digits} digit(s): normalizeAbstractDoi agrees with DOI_SHAPE`, () => {
      expect(normalizeAbstractDoi(doi) !== null).toBe(norm.DOI_SHAPE.test(doi));
      expect(normalizeAbstractDoi(doi) !== null).toBe(!shape.isMalformedDoi(doi));
    });
  }
});
