/**
 * v0.4.0 review: two members of the "value bound to the wrong record / reader misses a form" classes.
 * The bodies are derived (a field no recorded retracted record lacks), as each test says.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => ({ default: { get: jest.fn() }, isAxiosError: () => false }));
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));
const mod: any = await import('../../src/retraction/retractionChecker.js');
const ok = (message: any) => ({ status: 200, data: { message } });

beforeEach(() => {
  crossrefGetMock.mockReset();
});

describe('the earliest notice is the one dated, whether or not it carries a date-time', () => {
  it('a notice with only date-parts (2022) is not outranked by a later one (2023) that has a date-time... and vice versa', async () => {
    const body = (earlyHasDateTime: boolean) =>
      ok({
        DOI: '10.1111/a',
        title: ['x'],
        'updated-by': [
          {
            type: 'retraction',
            DOI: '10.1111/late',
            updated: { 'date-parts': [[2023, 5, 5]], 'date-time': '2023-05-05T00:00:00Z' },
          },
          {
            type: 'retraction',
            DOI: '10.1111/early',
            updated: {
              'date-parts': [[2022, 1, 1]],
              ...(earlyHasDateTime ? { 'date-time': '2022-01-01T00:00:00Z' } : {}),
            },
          },
        ],
      });
    for (const withDt of [true, false]) {
      crossrefGetMock.mockImplementation(async () => body(withDt));
      const r = await mod.checkRetraction('10.1111/a', {
        citing: { publishedDate: '2022-06' },
        checkReplacement: false,
      });
      expect(r.retractionDate).toBe('2022-01-01');
      expect(r.retractionNoticeUrl).toBe('https://doi.org/10.1111/early');
      expect(r.timing.timing).toBe('before_citing');
    }
  });
});

describe('a title that says retracted-and-replaced is also a retraction marker', () => {
  it.each([
    ['Retracted and Replaced: a study', 'flagged'],
    ['Retracted and republished - a study', 'flagged'],
    ['RETRACTED AND REPLACED a study', 'flagged'],
    // negative: a paper ABOUT retraction stays clean
    ['Retracted and replaced articles in medicine: a review', 'clean'],
    ['Retracted Publications in Indian Science: Reasons and Institutions', 'clean'],
  ])('%s -> %s', async (title, verdict) => {
    crossrefGetMock.mockImplementation(async () => ok({ DOI: '10.1111/a', title: [title] }));
    const r = await mod.checkRetraction('10.1111/a', { checkReplacement: false });
    expect(r.verdict).toBe(verdict);
  });
});
