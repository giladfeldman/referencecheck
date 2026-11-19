/**
 * v0.3.0 review, attempt 14 (2026-11-19). Class: "the author readers meet an author section
 * shape they do not recognise and return no surname, or only a title word, where 0.2.x read
 * the surname". Vancouver entries with dotted initials, a suffix, three-word surnames, or
 * joined by "and" / "&" / ";" came back empty (any record with the title was accepted);
 * family-first full names joined by "and" were read given-first; a given-first list whose
 * later surnames are all title words kept only the given name; a given-first entry running on
 * into the title read a title word. 0.2.x decided every case below correctly.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const axiosGetMock = jest.fn<any>();
const axiosPostMock = jest.fn<any>();
jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  const api = { get: axiosGetMock, head: jest.fn(), post: axiosPostMock, isAxiosError };
  return { default: api, ...api };
});
const lib: any = await import('../../src/index.js');
// A record of a cited author carries that author's given name, as Crossref records do (round 17).
const { givenNameFor } = await import('../labelled/givenName.mjs');

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
});

const accepts = async (text: string, title: string, authors: string[]) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [title],
    author: authors.map((a) => ({ family: a, given: givenNameFor(text, a) })),
    published: { 'date-parts': [[2014, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
};
const T = 'Sleep and memory in older adults';
const tail = `${T}. J Sleep Res. 2014;1:1-9.`;

describe('Vancouver lists the readers missed are read, so the author check runs', () => {
  it.each([
    [`Smith J.A., Jones B.C. ${tail}`, ['Smith', 'Jones']],
    [`Smith J.A. ${tail}`, ['Smith']],
    [`Smith J.A. (2014). ${T}. J Sleep Res, 1, 1-9.`, ['Smith']],
    [`Smith J., Jones K. (2014). ${T}. J Sleep Res, 1, 1-9.`, ['Smith', 'Jones']],
    [`Smith JA Jr. ${tail}`, ['Smith']],
    [`Smith JA 3rd, Jones BC. ${tail}`, ['Smith', 'Jones']],
    [`Smith JA and Jones BC. ${tail}`, ['Smith', 'Jones']],
    [`Smith JA & Jones BC. ${tail}`, ['Smith', 'Jones']],
    [`Smith J and Jones B (2014) ${T}. J Sleep Res 1:1-9.`, ['Smith', 'Jones']],
    [`Smith JA; Jones BC; Brown DE. ${tail}`, ['Smith', 'Jones', 'Brown']],
    [`Smith JA; Jones BC; et al. ${tail}`, ['Smith', 'Jones', 'Lee']],
    [`Garcia Lopez Marquez G, Jones BC. ${tail}`, ['Garcia Lopez Marquez', 'Jones']],
    [`Garcia Lopez Marquez G. ${tail}`, ['Garcia Lopez Marquez']],
  ])('%j: own record accepted, other authors and a title-word author rejected', async (text, fams) => {
    expect(await accepts(text, T, fams)).toBe(true);
    expect(await accepts(text, T, ['Okafor', 'Lee'])).toBe(false);
    expect(await accepts(text, T, ['Sleep'])).toBe(false);
  });
});

describe('family-first full names', () => {
  it.each([
    [`Wang Xiaoming and Li Hua. ${T} (2014). J Sleep Res 1:1-9.`, ['Wang', 'Li']],
    [`Wang Xiaoming & Zhang Wei. ${T} (2014). J Sleep Res 1:1-9.`, ['Wang', 'Zhang']],
  ])('%j: own record accepted, another author rejected', async (text, fams) => {
    expect(await accepts(text, T, fams)).toBe(true);
    expect(await accepts(text, T, ['Okafor'])).toBe(false);
  });
});

describe('a given-first list whose later surnames are title words', () => {
  it.each([
    'Michael J. Young, Donald P. Long. Long memory in young adults. J Sleep Res. 2014;1:1-9.',
    'Michael J. Young, Donald P. Long. Long memory in young adults (2014). J Sleep Res 1:1-9.',
  ])('%j: own record accepted, another author rejected', async (text) => {
    expect(await accepts(text, 'Long memory in young adults', ['Young', 'Long'])).toBe(true);
    expect(await accepts(text, 'Long memory in young adults', ['Okafor'])).toBe(false);
  });
});

describe('a name that runs on into the title stays a second reading', () => {
  it('"Smith J Sleep and memory ..." is Smith, not Sleep', async () => {
    const text = `Smith J ${T} (2014). J Sleep Res 1:1-9.`;
    expect(await accepts(text, T, ['Smith'])).toBe(true);
    expect(await accepts(text, T, ['Sleep'])).toBe(false);
  });
  it.each([
    ['Charles R. Rich; Michael J. Bird Sleep and memory in older adults. J Sleep Res. 2014.', T, 'Sleep'],
    ['Alex J. K. De la Cruz, Eric A. Garcia Marquez Darwin and the finches of the Galapagos. J Sleep Res. 2014.', 'Darwin and the finches of the Galapagos', 'Darwin'],
  ])('%j vs a record by %s... named like the first title word: rejected', async (text, title, fam) => {
    expect(await accepts(text, title, [fam])).toBe(false);
  });
  it('a title-case title is not a second given-first entry ("Hoddy K. Sleep and Mood Disorders")', async () => {
    const title = 'Sleep and Mood Disorders in Older Adults';
    const text = `Hoddy K. ${title}. J Sleep Res. 2014;1:1-9.`;
    expect(await accepts(text, title, ['Hoddy'])).toBe(true);
    expect(await accepts(text, title, ['Sleep'])).toBe(false);
    expect(await accepts(text, title, ['Disorders'])).toBe(false);
  });
});
