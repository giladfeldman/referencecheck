/**
 * v0.4.0 consult round 2 (Sonnet, 2026-11-25): members of the "value bound to the wrong record"
 * and "reader false positive" classes found in 44d19fc..7852830. Every body here is derived (a
 * shape no recorded retracted record shows), as each test says; real records are covered in
 * retractionTimingVerdict.test.ts and retractionUpdateTypes.test.ts.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const crossrefGetMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => ({ default: { get: jest.fn() }, isAxiosError: () => false }));
jest.unstable_mockModule('../../src/http/crossref.js', () => ({ crossrefGet: crossrefGetMock }));
const mod: any = await import('../../src/retraction/retractionChecker.js');
const ok = (message: any) => ({ status: 200, data: { message } });
const LABS = 'https://api.labs.crossref.org/works/';
const WORKS = 'https://api.crossref.org/works/';

/** Route by URL: `labs:<doi>` for Crossref Labs, `<doi>` for a work; anything else is a 404. */
function serve(bodies: Record<string, any>) {
  crossrefGetMock.mockImplementation(async (url: string) => {
    const key = url.startsWith(LABS)
      ? 'labs:' + decodeURIComponent(url.slice(LABS.length).split('?')[0])
      : decodeURIComponent(url.slice(WORKS.length));
    if (key in bodies) return bodies[key];
    if (key.startsWith('labs:')) return ok({ DOI: key.slice(5), 'cr-labs-updates': [] });
    throw Object.assign(new Error('404'), { response: { status: 404 } });
  });
}
const entry = (source: string, doi: string, [y, m, d]: number[]) => ({
  DOI: doi,
  type: 'retraction',
  label: 'Retraction',
  source,
  updated: { 'date-parts': [[y, m, d]], 'date-time': new Date(Date.UTC(y, m - 1, d)).toISOString() },
});

beforeEach(() => {
  crossrefGetMock.mockReset();
});

describe('F2: only a notice date ON one of the work’s own publication days is dropped', () => {
  it('an online-first notice before a later print `published` is kept (2022-12-20, not the later RW 2023-02-10)', async () => {
    serve({
      '10.1111/w': ok({
        DOI: '10.1111/w',
        title: ['x'],
        published: { 'date-parts': [[2023, 1]] },
        'published-print': { 'date-parts': [[2023, 1, 15]] },
        issued: { 'date-parts': [[2023, 1]] },
        'updated-by': [
          entry('retraction-watch', '10.1111/w', [2023, 2, 10]),
          entry('publisher', '10.1111/notice', [2022, 12, 20]),
        ],
      }),
    });
    const r = await mod.checkRetraction('10.1111/w', {
      citing: { publishedDate: '2023-01-05' },
      checkReplacement: false,
    });
    expect(r.retractionDate).toBe('2022-12-20');
    expect(r.timing.timing).toBe('before_citing');
  });

  it('a notice dated the same day as `published-online` (not `published`) is dropped', async () => {
    serve({
      '10.1111/w': ok({
        DOI: '10.1111/w',
        title: ['x'],
        published: { 'date-parts': [[2021, 9]] },
        'published-online': { 'date-parts': [[2021, 9, 11]] },
        'updated-by': [
          entry('publisher', '10.1111/w', [2021, 9, 11]),
          entry('retraction-watch', '10.1111/w', [2022, 12, 6]),
        ],
      }),
    });
    const r = await mod.checkRetraction('10.1111/w', { checkReplacement: false });
    expect(r.retractionDate).toBe('2022-12-06');
  });
});

describe('F5: the notice link when the dated entry names the work itself', () => {
  const work = (extra: any[]) =>
    ok({
      DOI: '10.1111/w',
      title: ['x'],
      published: { 'date-parts': [[2020, 1, 1]] },
      'updated-by': [entry('retraction-watch', '10.1111/w', [2021, 3, 1]), ...extra],
    });

  it('another retraction entry carrying a notice DOI gives the link', async () => {
    serve({ '10.1111/w': work([entry('publisher', '10.1111/notice', [2021, 3, 9])]) });
    const r = await mod.checkRetraction('10.1111/w', { checkReplacement: false });
    expect(r.retractionDate).toBe('2021-03-01');
    expect(r.retractionNoticeUrl).toBe('https://doi.org/10.1111/notice');
  });

  it('two different notice DOIs: which is the notice is not said, so none', async () => {
    serve({
      '10.1111/w': work([
        entry('publisher', '10.1111/notice-a', [2021, 3, 9]),
        entry('publisher', '10.1111/notice-b', [2021, 4, 9]),
      ]),
    });
    const r = await mod.checkRetraction('10.1111/w', { checkReplacement: false });
    expect(r.retractionNoticeUrl).toBeUndefined();
  });

  it('a notice DOI on an entry of another type (a correction) is not used', async () => {
    serve({ '10.1111/w': work([{ ...entry('publisher', '10.1111/erratum', [2021, 3, 9]), type: 'correction', label: 'Correction' }]) });
    const r = await mod.checkRetraction('10.1111/w', { checkReplacement: false });
    expect(r.retractionNoticeUrl).toBeUndefined();
  });
});

describe('F8: several is-replaced-by DOIs are not settled by a notes DOI', () => {
  it('is-replaced-by {v2, v3} and a note "see instead: v2" give no replacementDOI', async () => {
    serve({
      '10.1111/w': ok({
        DOI: '10.1111/w',
        title: ['x'],
        relation: { 'is-replaced-by': [{ 'id-type': 'doi', id: '10.1111/v2' }, { 'id-type': 'doi', id: '10.1111/v3' }] },
        'updated-by': [entry('retraction-watch', '10.1111/w', [2021, 3, 1])],
      }),
      'labs:10.1111/w': ok({
        DOI: '10.1111/w',
        'cr-labs-updates': [{ reasons: ['+Retract and Replace'], notes: 'see instead: 10.1111/v2' }],
      }),
      '10.1111/v2': ok({ DOI: '10.1111/v2', title: ['v2'] }),
    });
    const r = await mod.checkRetraction('10.1111/w');
    expect(r.replacement.status).toBe('replaced');
    expect(r.replacement.evidence).toEqual(['crossref_is_replaced_by', 'retraction_watch_reason']);
    expect(r.replacement.replacementDOI).toBeUndefined();
  });
});

describe('F10: "Retracted and replaced." followed by a sentence is not a retraction marker', () => {
  it.each([
    ['Retracted and replaced. A study of journal policy', 'clean'],
    ['RETRACTED AND REPLACED. A study', 'flagged'], // capitals: the caps marker still reads it
    ['Retracted and Replaced: a study', 'flagged'],
  ])('%s -> %s', async (title, verdict) => {
    serve({ '10.1111/a': ok({ DOI: '10.1111/a', title: [title] }) });
    const r = await mod.checkRetraction('10.1111/a', { checkReplacement: false });
    expect(r.verdict).toBe(verdict);
  });
});
