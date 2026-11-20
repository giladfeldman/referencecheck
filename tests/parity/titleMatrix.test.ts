/**
 * v0.3.0 QA (2026-11-20). Class: "the title compare reads one title differently from another
 * written form of the same title". The title check changed in this release, so every written
 * variant of one title is pinned here: case, British spelling, the main title alone, other
 * subtitle marks, quotes, a cut title, a line-break hyphen, extra spaces, "&", and a plural or
 * singular change are the same title and are accepted. Two different titles that share words with
 * the record are rejected. Both 0.2.x and v0.3.0 accept every variant; 0.2.x also accepted the two
 * different titles, which v0.3.0 rejects.
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

const RECORD = 'Social norms and organizational behavior: A field study';
const accepts = async (title: string) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [RECORD],
    author: [{ family: 'Okafor', given: 'Zara' }],
    published: { 'date-parts': [[2014, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(`Okafor, Z. (2014). ${title}. J Sleep Res.`))?.doi === '10.1/found';
};

describe('a written variant of the same title is accepted', () => {
  it.each([
    ['exact', RECORD],
    ['lower case', 'social norms and organizational behavior: a field study'],
    ['upper case', 'SOCIAL NORMS AND ORGANIZATIONAL BEHAVIOR: A FIELD STUDY'],
    ['British spelling', 'Social norms and organisational behaviour: A field study'],
    ['main title only', 'Social norms and organizational behavior'],
    ['hyphen subtitle', 'Social norms and organizational behavior - A field study'],
    ['em-dash subtitle', 'Social norms and organizational behavior—a field study'],
    ['quoted', `"${RECORD}"`],
    ['cut with ...', 'Social norms and organizational behavior...'],
    ['cut with an ellipsis', 'Social norms and organizational behavior…'],
    ['line-break hyphen', 'Social norms and organiza- tional behavior: A field study'],
    ['double spaces', 'Social  norms and  organizational behavior:  A field study'],
    ['ampersand', 'Social norms & organizational behavior: A field study'],
    ['plural and singular', 'Social norm and organizational behaviors: A field study'],
  ])('%s', async (_name, title) => {
    expect(await accepts(title)).toBe(true);
  });
});

describe('a different title sharing words with the record is rejected', () => {
  it.each([
    ['Social norms in schools: A survey'],
    ['Organizational behavior in schools: A survey'],
  ])('%s', async (title) => {
    expect(await accepts(title)).toBe(false);
  });
});
