/**
 * v0.3.0 review, attempt 18 (2026-11-19). Class: "the given-name check of round 17 vetoes the
 * right record". It looked at four words on each side of the family name and at its first
 * occurrence only, and took a given name spelled another way for another person; a record with
 * family "R" and a given name in capitals was not read as an initial filed as the family. 0.2.x
 * accepted every right record below (Smirnova and Alvarez: it read the first word only and
 * rejected them; v0.3.0 reads them and must not lose them to the check).
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

const SD = 'Sleep deprivation affects memory';
const accepts = async (text: string, people: Array<[string, string]>) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [SD],
    author: people.map(([family, given]) => ({ family, given })),
    published: { 'date-parts': [[2014, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
};

describe('the right record is accepted', () => {
  it.each([
    [`Kiran Shakthi R (2014). ${SD}. J Sleep Res.`, [['R', 'SHAKTHI KIRAN']]],
    [`Gomez Maria Jose Luz Elena Hernandez (2014). ${SD}. J Sleep Res.`, [['Gomez', 'Hernandez']]],
    [`Mark Little and Zoe Mark (2014). ${SD}. J Sleep Res.`, [['Mark', 'Zoe']]],
    [`Julia Smirnova (2014). ${SD}. J Sleep Res.`, [['Smirnova', 'Yulia']]],
    [`Jorge Alvarez and Ana Ruiz (2014). ${SD}. J Sleep Res.`, [['Alvarez', 'George']]],
  ] as Array<[string, Array<[string, string]>]>)('%j', async (text, people) => {
    expect(await accepts(text, people)).toBe(true);
    expect(await accepts(text, [['Okafor', 'Zoe']])).toBe(false);
  });
});

describe('the collision the check exists for is still rejected', () => {
  it.each([
    [`Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, 'Mark'],
    [`Little Mark & Collins Grace 2014. ${SD}. J Sleep Res.`, 'Mark'],
    [`Wells Kate, Rowe Hope (2014). ${SD}. J Sleep Res.`, 'Hope'],
  ])('%j vs a record by Zoe %s', async (text, family) => {
    expect(await accepts(text, [[family, 'Zoe']])).toBe(false);
  });
});
