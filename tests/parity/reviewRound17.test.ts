/**
 * v0.3.0 review, attempt 17 (2026-11-19). Class: "a wrong record whose author's family name is a
 * given name of a cited author is accepted". An author entry of written-out words ("Mark Little",
 * "Little Mark", "Michael J. Young") reads family first or given first, so its given name was a
 * surname too: a record by Zoe Mark with the cited title and year was taken for the work. 0.2.x
 * rejected these. The record's given name now decides where the order is ambiguous.
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
const accepts = async (text: string, people: Array<[string, string | undefined]>) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [SD],
    author: people.map(([family, given]) => (given === undefined ? { family } : { family, given })),
    published: { 'date-parts': [[2014, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
};

describe('a record by an author named like a cited given name is rejected', () => {
  it.each([
    [`Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, 'Mark'],
    [`Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, 'Grace'],
    [`Little Mark & Collins Grace 2014. ${SD}. J Sleep Res.`, 'Mark'],
    [`Michael J. Young, Donald Long (2014). ${SD}. J Sleep Res.`, 'Michael'],
    [`Wells Kate, Rowe Hope (2014). ${SD}. J Sleep Res.`, 'Hope'],
    [`Min-jun Kim, Dean Martin: ${SD}. J Sleep Res. 2014.`, 'Min-jun'],
    [`Sean O'Brien, Daisy Hoddy (2014). ${SD}. J Sleep Res.`, 'Sean'],
    [`Hoddy Daisy and Little Mark (2014). ${SD}. J Sleep Res.`, 'Mark'],
  ])('%j vs a record by Zoe %s', async (text, family) => {
    expect(await accepts(text, [[family, 'Zoe']])).toBe(false);
  });
});

describe('a record of the cited author is still accepted', () => {
  it.each([
    [`Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, [['Little', 'Mark'], ['Collins', 'Grace']]],
    [`Little Mark & Collins Grace 2014. ${SD}. J Sleep Res.`, [['Little', 'Mark']]],
    [`Michael J. Young, Donald Long (2014). ${SD}. J Sleep Res.`, [['Young', 'Michael J.']]],
    [`Hoddy K. ${SD}. J Sleep Res. 2014;1:1-9.`, [['Hoddy', 'Karen']]],
    [`Smith J ${SD} (2014). J Sleep Res 1:1-9.`, [['Smith', 'John A.']]],
    [`Wang Xiaoming and Li Hua (2014). ${SD}. J Sleep Res.`, [['Wang', 'Xiao-Ming']]],
    [`J. Michael Smith (2014). ${SD}. J Sleep Res.`, [['Smith', 'John Michael']]],
    [`Michael Smith (2014). ${SD}. J Sleep Res.`, [['Smith', 'J. Michael']]],
    [`Mark Little (2014). ${SD}. J Sleep Res.`, [['Little', undefined]]],
    [`Smith, J. A. (2014). ${SD}. J Sleep Res.`, [['Smith', 'Karen']]],
  ] as Array<[string, Array<[string, string | undefined]>]>)('%j', async (text, people) => {
    expect(await accepts(text, people)).toBe(true);
  });
});
