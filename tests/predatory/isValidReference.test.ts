/**
 * isValidReference — reference-vs-main-text classification tests.
 *
 * Added by the platform's hardening workflow (2026-06-08). D6: the author-pattern fallback
 * regex was ASCII + Latin-1 only (`[A-ZÀ-Ÿ]`), so a Cyrillic / Greek-authored
 * reference lost its "author" indicator and could fall below the 2-of-4
 * threshold. These tests fail against that regex and pass against the
 * Unicode-aware one.
 */
import { describe, it, expect } from '@jest/globals';
import { isValidReference } from '../../src/predatory/journalMetadata.js';

const refOf = (raw_text: string, over: Record<string, unknown> = {}) =>
  ({ id: '1', raw_text, ...over }) as any;

describe('isValidReference', () => {
  it('accepts a normal ASCII reference (author + year)', () => {
    expect(
      isValidReference(refOf('Smith, J. (2020). A study of things. Journal of Things.')),
    ).toBe(true);
  });

  it('accepts a Cyrillic-authored reference via the Unicode author pattern (D6)', () => {
    expect(
      isValidReference(refOf('Иванов, А. И. (2020). Название статьи в журнале.')),
    ).toBe(true);
  });

  it('accepts a Greek-authored reference (D6)', () => {
    expect(
      isValidReference(refOf('Παπαδόπουλος, Α. (2019). Τίτλος του άρθρου.')),
    ).toBe(true);
  });

  it('rejects main text masquerading as a reference', () => {
    expect(
      isValidReference(refOf('We replicated the original study across three samples and found support.')),
    ).toBe(false);
  });

  it('rejects text too short to be a reference', () => {
    expect(isValidReference(refOf('Smith 2020'))).toBe(false);
  });
});
