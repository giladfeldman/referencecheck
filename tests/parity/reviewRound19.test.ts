/**
 * v0.3.0 review, attempt 19 (2026-11-19). Class: "the author check of v0.3.0 rejects a right
 * record 0.2.x accepted". The given-name check of round 17 took a second surname ("Hernandez
 * Ruiz") or a suffix ("Smith Jr") for a given name; the whole-word compare missed initials
 * written on to the surname ("SmithJA") and particles joined to the Crossref family ("DeJong",
 * "VanDerBerg"). Review 19 then found the sole-entry rule missing "et al.", a list of double
 * surnames with no given names vetoed, and "Hsiao-Ming" taken for another person than
 * "Xiaoming". 0.2.x accepted every right record below.
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
    [`Hernandez Ruiz (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria']]],
    [`Smith Jr (2014). ${SD}. J Sleep Res.`, [['Smith', 'Robert']]],
    [`Smith Jr. (2014). ${SD}. J Sleep Res.`, [['Smith', 'Robert']]],
    [`SmithJA, Jones KL (2014). ${SD}. J Sleep Res.`, [['Smith', 'John A']]],
    [`Jong, A. (2014). ${SD}. J Sleep Res.`, [['DeJong', 'A']]],
    [`Berg, A. (2014). ${SD}. J Sleep Res.`, [['VanDerBerg', 'A']]],
    // review 19: "et al." after a sole double surname, a family-first list, an older romanisation
    [`Hernandez Ruiz et al. (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria'], ['Lopez', 'Juan']]],
    [`Hernandez Ruiz and others (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria']]],
    [`Hernandez Ruiz and Lopez Garcia (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria'], ['Lopez', 'Ana']]],
    [`Wang Hsiao-Ming and Li Hua (2014). ${SD}. J Sleep Res.`, [['Wang', 'Xiaoming'], ['Li', 'Hua']]],
    // review 20: particles joined on the reference side
    [`DeJong, P. (2014). ${SD}. J Sleep Res.`, [['Jong', 'P.']]],
    [`VanDyke, J. (2014). ${SD}. J Sleep Res.`, [['Dyke', 'J.']]],
    [`VanDerBerg, J. (2014). ${SD}. J Sleep Res.`, [['Berg', 'J.']]],
    // review 21: initials glued to a surname with a capital inside it
    [`McDonaldJA (2014). ${SD}. J Sleep Res.`, [['McDonald', 'James A.']]],
    [`VanDerBergJ (2014). ${SD}. J Sleep Res.`, [['Berg', 'J.']]],
    [`OBrienJ (2014). ${SD}. J Sleep Res.`, [['OBrien', 'J.']]],
    [`Smith-JonesJA (2014). ${SD}. J Sleep Res.`, [['Smith-Jones', 'J. A.']]],
  ] as Array<[string, Array<[string, string]>]>)('%j', async (text, people) => {
    expect(await accepts(text, people)).toBe(true);
    expect(await accepts(text, [['Okafor', 'Zoe']])).toBe(false);
  });
});

describe('records by other authors are still rejected', () => {
  it.each([
    [`Donald, A. (2014). ${SD}. J Sleep Res.`, 'MacDonald', 'A'],
    [`MacDonald, A. (2014). ${SD}. J Sleep Res.`, 'Donald', 'A'],
    [`Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, 'Mark', 'Zoe'],
    [`Little Mark & Collins Grace 2014. ${SD}. J Sleep Res.`, 'Mark', 'Zoe'],
    [`Mark Little and Grace Collins (2014). ${SD}. J Sleep Res.`, 'Mark', 'Zoe'],
  ])('%j vs a record by %s', async (text, family, given) => {
    expect(await accepts(text, [[family, given]])).toBe(false);
  });
});
