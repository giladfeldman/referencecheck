/**
 * v0.3.0 review, attempt 11 (2026-11-19). Class: "an author section that can be read two ways
 * is read one way only, and the right surname is lost". Round 11 read "Michael J. LaCour" as
 * given-first by dropping the Vancouver reading whenever the word after a single initial was
 * capitalised and followed by "and", "&" or ", Capital"; a one-author Vancouver reference whose
 * title starts that way ("Hoddy K. Sleep and memory ...") then had its title word read as the
 * surname, and its right DOI was rejected (0.2.x accepted it). Both readings are now kept.
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

beforeEach(() => {
  axiosGetMock.mockReset();
  axiosPostMock.mockReset();
  axiosPostMock.mockRejectedValue(new Error('simple text query unavailable'));
});

const accepts = async (text: string, title: string, families: string[], year: number) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [title], author: families.map((f) => ({ family: f, given: 'K.' })),
    published: { 'date-parts': [[year, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
};

describe('one Vancouver author whose title starts like a name', () => {
  it.each([
    ['Hoddy K. Sleep and memory in adults. Lancet. 2019;393:1-9', 'Sleep and memory in adults'],
    ['Hoddy K. Diabetes and heart disease. Lancet. 2019;393:1-9', 'Diabetes and heart disease'],
    ['Hoddy K. Diabetes, Obesity and cardiovascular risk. Lancet. 2019;393:1-9', 'Diabetes, obesity and cardiovascular risk'],
    ['Hoddy K. Cancer, Heart disease and sleep. Lancet. 2019;393:1-9', 'Cancer, heart disease and sleep'],
    ['Hoddy K. Sleep & memory in adults. Lancet. 2019;393:1-9', 'Sleep & memory in adults'],
    ['Hoddy K. Sleep. Lancet. 2019;393:1-9', 'Sleep'],
  ])('%j: the right DOI is accepted', async (text, title) => {
    expect(await accepts(text, title, ['Hoddy'], 2019)).toBe(true);
  });
  it('another author with the same title and year is still rejected', async () => {
    expect(await accepts('Brown K. Sleep and memory in adults. Lancet. 2019;393:1-9', 'Sleep and memory in adults', ['Hoddy'], 2019)).toBe(false);
  });
});

describe('given-first names with a middle initial', () => {
  it.each([
    ['Michael J. LaCour, Donald P. Green. When contact changes minds. Science. 2014;346:1366-9', ['LaCour', 'Green']],
    ['Michael J. LaCour and Donald P. Green. When contact changes minds. Science. 2014;346:1366-9', ['LaCour', 'Green']],
    ['Michael J. LaCour. When contact changes minds. Science. 2014;346:1366-9', ['LaCour']],
  ])('%j: the right DOI is accepted', async (text, families) => {
    expect(await accepts(text, 'When contact changes minds', families, 2014)).toBe(true);
  });
  it('a record by another author is rejected', async () => {
    expect(await accepts('Michael J. LaCour. When contact changes minds. Science. 2014;346:1366-9', 'When contact changes minds', ['Broockman'], 2014)).toBe(false);
  });
});
