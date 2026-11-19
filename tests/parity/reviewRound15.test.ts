/**
 * v0.3.0 review, attempt 15 (2026-11-19). Class: "the new author readers read fewer or other
 * names than 0.2.x". Rounds 11 to 15 each found an author section shape the new readers did not
 * recognise. The fix keeps every surname 0.2.x read (uncertain when it may be a title word), so
 * no section is read with fewer names than 0.2.x. 0.2.x decided every case below correctly.
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
const SD = 'Sleep deprivation affects memory';
const SM = 'Sleep and memory in older adults';
const SJ = 'Smith and Jones revisited: a replication';
const YO = 'Young and old adults in the lab';

describe('an author entry that runs into the title is still read', () => {
  it.each([
    `Smith J ${SD} (2014). J Sleep Res 1:1-9.`,
    `Smith J: ${SD} (2014). J Sleep Res 1:1-9.`,
    `Smith J "${SD}" (2014). J Sleep Res 1:1-9.`,
    `Smith JA ${SD}. J Sleep Res. 2014;1:1-9.`,
    `Smith JA Jr ${SD}. J Sleep Res. 2014;1:1-9.`,
  ])('%j: Smith accepted, Jones rejected', async (text) => {
    expect(await accepts(text, SD, ['Smith'])).toBe(true);
    expect(await accepts(text, SD, ['Jones'])).toBe(false);
  });
});

describe('the first given name of a given-first list is not a surname', () => {
  it.each([
    [`Hope A. Nakamura, Will D. Long. ${SM} (2014). J Sleep Res 1:1-9.`, ['Nakamura', 'Long'], 'Hope'],
    [`Mark A. Baker, Craig B. Smith, Mary C. Jones. ${SM}. J Sleep Res. 2014;1:1-9.`, ['Baker', 'Smith', 'Jones'], 'Mark'],
  ])('%j', async (text, fams, given) => {
    expect(await accepts(text, SM, fams)).toBe(true);
    expect(await accepts(text, SM, [given])).toBe(false);
  });
});

describe('a family-first surname repeated in the title counts', () => {
  it.each([
    ['Wang Xiaoming and Li Hua. Wang and the new methods of sampling. J Sleep Res. 2014;1:1-9.', 'Wang and the new methods of sampling', ['Wang', 'Li']],
    ['Kim Minjun and Park Jiho. Kim effects in memory research. J Sleep Res. 2014.', 'Kim effects in memory research', ['Kim', 'Park']],
  ])('%j', async (text, title, fams) => {
    expect(await accepts(text, title, fams)).toBe(true);
    expect(await accepts(text, title, ['Okafor'])).toBe(false);
  });
});

describe('an entry running into a title that starts with a surname-like word', () => {
  it.each([
    [`Young K ${SJ}. J Sleep Res. 2014;1:1-9.`, SJ, ['Young'], 'Smith'],
    [`Smith J: ${SJ}. J Sleep Res. 2014.`, SJ, ['Smith'], 'Okafor'],
    [`Smith JA Jr ${SJ}. J Sleep Res. 2014;1:1-9.`, SJ, ['Smith'], 'Okafor'],
    [`J. A. Smith, ${SJ}. J Sleep Res. 2014.`, SJ, ['Smith'], 'Okafor'],
    [`Wang Xiaoming ${SJ}. J Sleep Res. 2014;1:1-9.`, SJ, ['Wang'], 'Smith'],
    [`Michael J. Young, Donald P. Long ${YO}. J Sleep Res. 2014;1:1-9.`, YO, ['Young', 'Long'], 'Okafor'],
    [`Michael J. Young, Donald P. Long: ${YO}. J Sleep Res. 2014.`, YO, ['Young', 'Long'], 'Okafor'],
  ])('%j: own record accepted, %s... rejected', async (text, title, fams, other) => {
    expect(await accepts(text, title, fams)).toBe(true);
    expect(await accepts(text, title, [other])).toBe(false);
  });
});

describe('what the new readers fixed stays fixed', () => {
  it('a group author reads no person ("Research Group.")', async () => {
    expect(await accepts('Research Group. (2015). Editorial retraction. Science.', 'Editorial retraction', ['McNutt'])).toBe(true);
  });
  it('a 0.2.x comma reading of a title word does not count ("Diabetes, Obesity")', async () => {
    expect(await accepts('Singh U. Diabetes, Obesity and cardiovascular risk in midlife. Journal. 2014;1:1-9.', 'Diabetes, Obesity and cardiovascular risk in midlife', ['Diabetes'])).toBe(false);
  });
});
