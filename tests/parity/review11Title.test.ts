/**
 * v0.3.0 review 11 (2026-11-22). Class: "the title check reads in one direction only". A
 * candidate was accepted when the record's title words occurred in the reference; the
 * reference's own title was never compared back, so a reference to another work whose title
 * holds the record's title was accepted for that record. Members: words written before the
 * record's title, a longer title around it, another part of a work (with a part number after the
 * title, or a short title too short to compare), and, on the author side, a reference that starts
 * with its title and holds "and" (title words read as two authors, rejecting the right DOI).
 * Controls: the written forms of one title the compare back must keep (a subtitle the record
 * lacks, bracketed notes, author lists without a year before the title, quoted titles, no
 * punctuation). Every member here was accepted (or, for the "and" title, rejected) by 0.2.x and
 * by v0.3.0 before review 11.
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

interface Rec { title: string; subtitle?: string; authors: Array<[string, string]>; year: number }
const accepts = async (reference: string, rec: Rec) => {
  axiosGetMock.mockResolvedValue({ status: 200, data: { message: { items: [{
    DOI: '10.1/found', score: 90, title: [rec.title], subtitle: rec.subtitle ? [rec.subtitle] : [],
    author: rec.authors.map(([family, given]) => ({ family, given })),
    published: { 'date-parts': [[rec.year, 1, 1]] },
  }] } } });
  return (await lib.findDOIFromReference(reference))?.doi === '10.1/found';
};

const MOODIE: Array<[string, string]> = [['Moodie', 'Erica E M'], ['le Cessie', 'Saskia']];
const COMMENTARY: Rec = { title: 'Commentary: Mendelian Randomization for Causal Inference', authors: MOODIE, year: 2024 };
const REPLACEMENT: Rec = { title: 'Instrumental Variables Analysis and Mendelian Randomization for Causal Inference', authors: MOODIE, year: 2024 };

describe('review 11: the reference title is compared back with the record title', () => {
  it.each([
    ['words before the record title (a different work)', 'Moodie, L. (2024). Instrumental Variables Analysis and Mendelian Randomization for Causal Inference. The Journal of Infectious Diseases.', COMMENTARY],
    ['words before, APA', 'Gilovich, T., & Medvec, V. H. (1994). The temporal pattern to the experience of regret. Journal of Personality and Social Psychology, 67(3), 357-365.', { title: 'The experience of regret: What, when, and why.', authors: [['Gilovich', 'Thomas'], ['Medvec', 'Victoria Husted']], year: 1995 } as Rec],
    ['a longer title around it', 'Okafor, Z. (2014). Field evidence on social norms and organizational behavior in rural cooperatives. J Sleep Res.', { title: 'Social norms and organizational behavior', authors: [['Okafor', 'Zara']], year: 2014 } as Rec],
    ['a part number the record does not have', 'McCullough, M. E., Rachal, K. C., & Sandage, S. J. (1998). Interpersonal forgiving in close relationships: II. Theoretical elaboration and measurement. Journal of Personality and Social Psychology.', { title: 'Interpersonal forgiving in close relationships.', authors: [['McCullough', 'Michael E.']], year: 1997 } as Rec],
    ['Part I against the record of Part II', 'Moodie, E. E. M., & le Cessie, S. (2024). Commentary: Mendelian Randomization for Causal Inference. Part I. The Journal of Infectious Diseases.', { ...COMMENTARY, title: 'Commentary: Mendelian Randomization for Causal Inference. Part II' }],
    ['Part I against Part II, a title too short to compare', 'McNutt, M. (2015). Editorial retraction. Part I. Science.', { title: 'Editorial retraction. Part II', authors: [['McNutt', 'Marcia']], year: 2015 } as Rec],
    ['Part 1 against Part 2', 'Okafor, Z. (2014). Social norms and organizational behavior, part 1. J Sleep Res.', { title: 'Social norms and organizational behavior, part 2', authors: [['Okafor', 'Zara']], year: 2014 } as Rec],
  ])('%s is rejected', async (_name, reference, rec) => {
    expect(await accepts(reference, rec)).toBe(false);
  });

  it.each([
    ['the cited work itself', 'Moodie, L. (2024). Instrumental Variables Analysis and Mendelian Randomization for Causal Inference. The Journal of Infectious Diseases.', REPLACEMENT],
    ['the same part', 'Moodie, E. E. M., & le Cessie, S. (2024). Commentary: Mendelian Randomization for Causal Inference. Part II. The Journal of Infectious Diseases.', { ...COMMENTARY, title: 'Commentary: Mendelian Randomization for Causal Inference. Part II' }],
    ['a subtitle the record lacks', 'Salerno, K. E. Radiation therapy for soft tissue sarcoma: Indications, timing, benefits, and consequences. Surg. Clin. N. Am. 102(4), 567-582 (2022).', { title: 'Radiation Therapy for Soft Tissue Sarcoma', authors: [['Salerno', 'Kilian E.']], year: 2022 } as Rec],
    ['a bracketed note', 'Scheel, A. M., Schijen, M., & Lakens, D. (2020). An excess of positive results: Comparing the standard Psychology literature with Registered Reports [Preprint].', { title: 'An excess of positive results: Comparing the standard Psychology literature with Registered Reports', authors: [['Scheel', 'Anne M.']], year: 2021 } as Rec],
    ['a parenthesised report number', 'Trendl, A., Stewart, N., & Mullett, T. L. (2018). A zero attraction effect in naturalistic choice (SSRN Scholarly Paper ID 3299524). Social Science Research Network.', { title: 'A Zero Attraction Effect in Naturalistic Choice', authors: [['Trendl', 'Anna']], year: 2018 } as Rec],
    ['Vancouver, no year before the title', 'Garewal D, Powell S, Milan SJ, Nordmeyer J, Waikar P. Sedative techniques for endoscopic retrograde cholangiopancreatography. Cochrane Database Syst Rev. 2012.', { title: 'Sedative techniques for endoscopic retrograde cholangiopancreatography', authors: [['Garewal', 'Dave']], year: 2012 } as Rec],
    ['Nature style, a surname the reader did not read', '3. Katz, D., Palmerini, E. & Pollack, S. M. More than 50 subtypes of soft tissue sarcoma: Paving the path for histology-driven treatments. Am. Soc. Clin. Oncol. Book 38, 925-938 (2018).', { title: 'More Than 50 Subtypes of Soft Tissue Sarcoma: Paving the Path for Histology-Driven Treatments', authors: [['Katz', 'Daniela']], year: 2018 } as Rec],
    ['IEEE, quoted', '[7] M. Herajy, F. Liu, and M. Heiner, ‘‘Design patterns for the construction of computational biological models,’’ Briefings Bioinf., vol. 25, no. 4, p. 318, Jul. 2024.', { title: 'Design patterns for the construction of computational biological models', authors: [['Herajy', 'Mostafa']], year: 2024 } as Rec],
    ['Vancouver with a year before the title', 'Siegel J, Mathys C, Rutledge R, Crockett M. 2018 Beliefs about bad people are volatile. Nat. Hum. Behav. 2, 750-756.', { title: 'Beliefs about bad people are volatile', authors: [['Siegel', 'Jenifer Z.']], year: 2018 } as Rec],
    ['a long bracketed note after a short title', 'Okafor, Z. (2014). Social norms at work (Working Paper No. 12, National Bureau of Economic Research). Cambridge.', { title: 'Social norms at work', authors: [['Okafor', 'Zara']], year: 2014 } as Rec],
    ['a bracketed note longer than the title', 'Okafor, Z. (2014). Social norms at work (Conference presentation, Annual Meeting of the Economic Science Association, Tucson). Cambridge.', { title: 'Social norms at work', authors: [['Okafor', 'Zara']], year: 2014 } as Rec],
    ['no punctuation', 'fishman j b berg e a 2019 peptide affinity purification of antibodies cold spring harbor protocols', { title: 'Peptide Affinity Purification of Antibodies', authors: [['Fishman', 'Jordan B.'], ['Berg', 'Eric A.']], year: 2019 } as Rec],
    ['a numeral that is not a part', 'Pi-Sunyer X, Blackburn G. Reduction in weight and cardiovascular disease risk factors in individuals with type 2 diabetes: one-year results of the Look AHEAD trial. Diabetes Care. 2007.', { title: 'Reduction in Weight and Cardiovascular Disease Risk Factors in Individuals With Type 2 Diabetes', authors: [['Pi-Sunyer', 'Xavier']], year: 2007 } as Rec],
  ])('%s is accepted', async (_name, reference, rec) => {
    expect(await accepts(reference, rec)).toBe(true);
  });
});

describe('review 11: a reference that starts with its title reads no title word as an author', () => {
  it.each([
    ['"and" inside the title', 'Instrumental Variables Analysis and Mendelian Randomization for Causal Inference. (2024). The Journal of Infectious Diseases.'],
    ['the other order', 'Instrumental Variables Analysis and Mendelian Randomization for Causal Inference (2024). The Journal of Infectious Diseases.'],
    ['a list number first', '12. Instrumental Variables Analysis and Mendelian Randomization for Causal Inference. (2024). The Journal of Infectious Diseases.'],
  ])('%s: the right DOI is accepted', async (_name, reference) => {
    expect(await accepts(reference, REPLACEMENT)).toBe(true);
  });

  it('a record whose title starts the same but is another work is still rejected', async () => {
    expect(await accepts('Instrumental Variables Analysis and Mendelian Randomization for Causal Inference. (2024). The Journal of Infectious Diseases.', { ...REPLACEMENT, title: 'Instrumental Variables Analysis in Labour Economics' })).toBe(false);
  });
});
