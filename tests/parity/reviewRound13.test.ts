/**
 * v0.3.0 review, attempt 13 (2026-11-19). Class: "the author readers return no surname, or
 * drop the right one, so the author check is skipped or decides wrongly". Vancouver entries
 * with capitalised particles or two-word surnames and "et al" without a comma were not read
 * (empty list: any record with the title was accepted); the certain Vancouver surname was
 * dropped with an uncertain one; only the first title word was tested against an uncertain
 * surname; the last given-first entry before the title was not read. 0.2.x decided every
 * case below correctly.
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

const accepts = async (text: string, title: string, authors: Array<string | { family: string; given: string }>) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [title],
    author: authors.map((a) => (typeof a === 'string' ? { family: a, given: 'X.' } : a)),
    published: { 'date-parts': [[2014, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(text))?.doi === '10.1/found';
};
const T = 'Sleep and memory in older adults';

describe('Vancouver entries the readers missed are read, so the author check runs', () => {
  it.each([
    'Hoddy K et al. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Hoddy KK et al. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Hoddy K et al Sleep and memory in older adults. J Sleep Res. 2014.',
    'Hoddy K, Gibbons C et al. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Hoddy K and others. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Garcia Marquez G, Smith A. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Van Dyke J, Smith A. Sleep and memory in older adults. J Sleep Res. 2014.',
    'De la Cruz M, Smith A. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Le Roux P, Smith A. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Van der Berg JH. Sleep and memory in older adults. J Sleep Res. 2014.',
    'Garcia Marquez G. Sleep and memory in older adults. J Sleep Res. 2014.',
  ])('%j vs a record by other authors: rejected', async (text) => {
    expect(await accepts(text, T, ['Jones', 'Lee'])).toBe(false);
    expect(await accepts(text, T, ['Sleep', 'Lee'])).toBe(false);
  });
  it.each([
    ['Garcia Marquez G. Sleep and memory in older adults. J Sleep Res. 2014.', ['Garcia Marquez']],
    ['Van Dyke J. Sleep and memory in older adults. J Sleep Res. 2014.', ['Van Dyke']],
    ['Le Roux P. Sleep and memory in older adults. J Sleep Res. 2014.', ['Le Roux']],
    ['Hoddy K et al. Sleep and memory in older adults. J Sleep Res. 2014.', ['Hoddy', 'Lee']],
  ])('%j vs its own record: accepted', async (text, fams) => {
    expect(await accepts(text, T, fams)).toBe(true);
  });
});

describe('an author named like a word of the title', () => {
  it.each([
    ['Darwin C. Darwin and the origin of species. J Hist Biol. 2014;1:1-9.', 'Darwin and the origin of species'],
    ['Hoddy K. Hoddy and the origin of species. J Hist Biol. 2014;1:1-9.', 'Hoddy and the origin of species'],
  ])('%j vs a record by Smith: rejected (the Vancouver surname is kept)', async (text, title) => {
    expect(await accepts(text, title, ['Smith'])).toBe(false);
  });
  it('the cited author writing about their own name is accepted', async () => {
    expect(await accepts('Charles R. Brown, Donald P. Green. Brown and the hidden costs of anger. J Sleep Res. 2014.', 'Brown and the hidden costs of anger', ['Brown', 'Green'])).toBe(true);
  });
  it.each([
    ['Hoddy K. Garcia Marquez and magic realism. J Lit. 2014.', 'Garcia Marquez and magic realism', 'Marquez'],
    ['Hoddy K. The Sleep and memory. J Sleep Res. 2014.', 'The Sleep and memory', 'Sleep'],
    ['Hoddy K. Sleep and memory in older adults. J Sleep Res. 2014;1:1-9.', 'Memory and sleep in older adults', 'Sleep'],
  ])('%j vs a record by %s named like a later title word: rejected', async (text, title, fam) => {
    expect(await accepts(text, title, [fam])).toBe(false);
  });
});

describe('a Crossref family of one letter is an initial', () => {
  it('"Shakthi Kiran R" matches family "R", given "Shakthi Kiran"', async () => {
    expect(await accepts('Shakthi Kiran R, Sugumar A (2014). Faux reality detector. J.', 'Faux reality detector', [{ family: 'R', given: 'Shakthi Kiran' }, { family: 'A', given: 'Sugumar' }])).toBe(true);
  });
});
