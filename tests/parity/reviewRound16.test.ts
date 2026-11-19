/**
 * v0.3.0 review, attempt 16 (2026-11-19). Class: "the 0.2.x surname reader kept by round 15 is
 * ASCII-only, and a multi-word family name is compared only as a whole". An accented surname
 * without a comma ("GARCÍA J", "Dvořák P") was cut at the accent ("Garc"), and a family-first
 * name with a lower-case particle ("de Vries Jan") was read as one longer surname that matched
 * no record, so the right record was rejected.
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

const accepts = async (text: string, title: string, authors: string[]) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [title],
    author: authors.map((a) => ({ family: a, given: 'X.' })),
    published: { 'date-parts': [[2014, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
};
const SD = 'Sleep deprivation affects memory';

describe('an accented surname without a comma is read whole', () => {
  it.each([
    [`GARCÍA J (2014). ${SD}. J Sleep Res.`, ['García']],
    [`GARCÍA J, SMITH B (2014). ${SD}. J Sleep Res.`, ['García', 'Smith']],
    [`García J ${SD}. J Sleep Res. 2014.`, ['García']],
    [`MUÑOZ A, JONES J (2014). ${SD}. J Sleep Res.`, ['Muñoz', 'Jones']],
    [`Dvořák P ${SD}. J Sleep Res. 2014.`, ['Dvořák']],
    [`Schäfer K: ${SD}. J Sleep Res. 2014.`, ['Schäfer']],
  ])('%j: own record accepted, another author rejected', async (text, fams) => {
    expect(await accepts(text, SD, fams)).toBe(true);
    expect(await accepts(text, SD, ['Okafor'])).toBe(false);
  });
});

describe('a family-first name with a lower-case particle matches its record', () => {
  it.each([
    [`de Vries Jan (2014). ${SD}. J Sleep Res.`, ['de Vries']],
    [`von Neumann John (2014). ${SD}. J Sleep Res.`, ['von Neumann']],
    [`van der Berg Jan (2014). ${SD}. J Sleep Res.`, ['van der Berg']],
    [`de Vries Jan and Smith John (2014). ${SD}. J Sleep Res.`, ['de Vries', 'Smith']],
  ])('%j: own record accepted, another author rejected', async (text, fams) => {
    expect(await accepts(text, SD, fams)).toBe(true);
    expect(await accepts(text, SD, ['Okafor'])).toBe(false);
  });
});
