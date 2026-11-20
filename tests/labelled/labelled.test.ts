/**
 * The labelled release set (rows built in ./rows.mjs; labels by construction, see there).
 *
 * The release gate for the two name readers is DECISIONS, not scores: deduplication's merge
 * decision at the README configuration and the DOI matcher's accept/reject, per shape class.
 * No class may have more false merges, missed merges, wrong accepts or right rejects than
 * 0.2.x (counts in baseline-0.2.x.json, produced by `scripts/labelled-report.mjs` against a
 * build of 0.2.x), and the total must be lower.
 *
 * Every row must get its label, except the KNOWN errors below: each is listed with why it
 * is still wrong, and must still be wrong (a fix makes this test fail until the list is
 * updated, so the list cannot go stale).
 */
import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: jest.fn(), post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});
const lib: any = await import('../../src/index.js');
const { ROWS, MEASURES, scoreRows, tally } = await import('./rows.mjs');

jest.spyOn(console, 'log').mockImplementation(() => {});
axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
const results = await scoreRows(lib, (items) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items } } });
});

/**
 * Rows still decided wrongly, by class and (optionally) the row's note and a text the row
 * contains (`has`, when rows of one class and note differ in outcome), with the reason.
 */
const KNOWN: Array<{ cls: string; note?: string; has?: string; why: string }> = [
  { cls: 'dedup/neg:part-i-vs-part-ii', why: 'titles one character apart; nothing in the metadata separates Part I from Part II' },
  { cls: 'doi/wrong:part-ii', why: 'every title word of Part II occurs in a reference to Part I' },
  { cls: 'dedup/neg:correction-notice', why: 'a correction notice repeats the work\'s title and authors, one year later' },
  { cls: 'doi/wrong:correction-notice', why: 'a notice titled "Corrigendum: <title>" carries every word of the title' },
  { cls: 'doi/owner:preprint-for-published', why: 'same authors, title and year; the matcher does not read the record type or venue' },
  { cls: 'doi/wrong:editorial', note: 'retraction-notice.json "Editorial"', why: 'a one-word title gives no title evidence (not_comparable)' },
  { cls: 'doi/wrong:editorial', note: 'retraction-notice.json "Introduction"', why: 'a one-word title gives no title evidence (not_comparable)' },
  { cls: 'doi/wrong:same-surname-other-initial', note: 'has-reply.json', why: 'two of the three title words ("data", "science") occur in the journal name' },
  { cls: 'doi/right:vancouver', note: 'retracted-title-case.json', why: 'one-letter surnames written Vancouver ("R SK"): "SK" is read as the surname' },
  { cls: 'dedup/same:consumer~vancouver', note: 'retracted-title-case.json', why: 'one-letter surnames: "R SK" with no case is read as initial R, surname SK' },
  { cls: 'dedup/same:et-al-string', note: 'retracted-title-case.json', has: 'R SK, A S, et al.', why: 'one-letter surnames: "R SK, A S, et al." is read as initials and surnames SK, S' },
  { cls: 'dedup/same:surname-full-given', note: 'retracted-title-case.json', why: 'one-letter surnames: "R Shakthi Kiran" has no surname of two letters to compare' },
  { cls: 'doi/wrong:same-title-other-authors', note: 'retracted-title-case.json', why: 'one-letter surnames ("R, S. K.") are not read, so only the title is compared (not_comparable)' },
  { cls: 'doi/wrong:same-title-other-authors~given-first', note: 'retracted-title-case.json', why: 'one-letter surnames are not read, so only the title is compared (not_comparable)' },
  { cls: 'doi/wrong:same-title-other-authors~mixed-script-record', note: 'retracted-title-case.json', why: 'one-letter surnames are not read, so only the title is compared (not_comparable)' },
];
const isKnown = (r: { row: any }) =>
  KNOWN.some((k) => k.cls === `${r.row.kind}/${r.row.cls}` && (k.note === undefined || k.note === r.row.note) && (k.has === undefined || JSON.stringify(r.row).includes(k.has)));

describe('labelled release set', () => {
  it('is the frozen set: 565 deduplication pairs, 1093 DOI candidates', () => {
    expect(ROWS.dedup.length).toBe(565);
    expect(ROWS.doi.length).toBe(1093);
  });

  it('every row gets its label, except the listed known errors', () => {
    const wrong = results.filter((r) => !r.ok && !isKnown(r)).map((r) => `${r.row.kind}/${r.row.cls} ${r.row.note} -> ${r.decision}`);
    expect(wrong).toEqual([]);
  });

  it('every listed known error is still an error (the list does not go stale)', () => {
    const fixed = results.filter((r) => r.ok && isKnown(r)).map((r) => `${r.row.kind}/${r.row.cls} ${r.row.note}`);
    expect(fixed).toEqual([]);
    for (const k of KNOWN) expect(results.some((r) => isKnown(r) && `${r.row.kind}/${r.row.cls}` === k.cls)).toBe(true);
  });

  it('no shape class is worse than 0.2.x, and the total is lower', () => {
    const base = JSON.parse(readFileSync('tests/labelled/baseline-0.2.x.json', 'utf8'));
    const now = tally(results);
    const worse: string[] = [];
    for (const [cls, t] of Object.entries(now)) {
      expect(base.classes[cls]).toBeDefined();
      for (const m of MEASURES) if (t[m] > base.classes[cls][m]) worse.push(`${cls} ${m}: ${base.classes[cls][m]} -> ${t[m]}`);
    }
    expect(worse).toEqual([]);
    const errors = (x: any) => MEASURES.reduce((n, m) => n + x[m], 0);
    const total = Object.values(now).reduce((n, t) => n + errors(t), 0);
    expect(total).toBeLessThan(errors(base.total));
  });

  it('every accepted DOI says how each check went; "not_comparable" is never reported as "matched"', () => {
    const accepted = results.filter((r) => r.row.kind === 'doi' && r.decision === 'accept');
    expect(accepted.length).toBeGreaterThan(100);
    for (const r of accepted) {
      for (const k of ['authorCheck', 'yearCheck', 'titleCheck']) expect(['matched', 'not_comparable']).toContain(r.result[k]);
    }
    const oneWord = results.find((r) => r.row.note === 'retraction-notice.json "Editorial"');
    expect(oneWord?.result.titleCheck).toBe('not_comparable');
    const folded = results.filter((r) => r.row.cls === 'right:folded');
    expect(folded.every((r) => r.result.authorCheck === 'not_comparable')).toBe(true);
    // A reference that starts with its title, or names a group author, has no surname to
    // compare: accepted on title and year, and said so (round 11).
    for (const cls of ['right:no-authors', 'right:corporate-author', 'right:corporate-reference-person-record']) {
      const rows = results.filter((r) => r.row.cls === cls);
      expect(rows.length).toBeGreaterThan(10);
      expect(rows.map((r) => r.result?.authorCheck)).toEqual(rows.map(() => 'not_comparable'));
    }
  });
});
