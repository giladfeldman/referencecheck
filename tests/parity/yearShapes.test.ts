/**
 * The full list of number shapes near a reference year (2026-11-19). The year reader failed
 * review three times on one new shape each time (pre-1900, counts and volumes, decades), so
 * every shape a number can take near a reference year is listed here and tested in an APA
 * and a Vancouver frame whose true year is 2015: the reader must give 2015 or no year (the DOI
 * matcher then skips its year check), never another year, which rejects the right DOI.
 *
 * Watched failing (scratchpad harness, not committed): 79 of the 84 assertions fail on at least
 * one of 0.2.x's reader, d359b17's reader, or a planted wrong reader; the other 5 have no
 * other number in the text to misread. 0.2.x reads 26 of them wrong, d359b17 15, this code 12.
 *
 * KNOWN_FIRST_NUMBER: the 12 shapes this code still reads wrong, all wrong in 0.2.x too: in a
 * Vancouver reference with no parenthetical year, the first bare year-like number wins, so a
 * number in the title beats the year after the journal. Logged as debt; listed so a new
 * wrong shape cannot hide among them.
 */
import { describe, it, expect } from '@jest/globals';
import { findReferenceYear } from '../../src/util/normalize.js';

const SHAPES: Array<[string, string]> = [
  ['decade', 'Health policy in the 1990s'], ['decade apostrophe', "Music of the '90s"], ['decade in parens', 'Fashion (1960s) revisited'],
  ['decade early', 'Trade in the 1600s'],
  ['year range bare', 'Recession of 1990-1995'], ['year range en dash', 'Recession of 1990\u20131995'],
  ['year range short slash', 'The 1990/91 season'], ['year range short dash', 'The 1990\u201391 season'],
  ['year range in parens', 'Cohort data (1990-1995)'], ['year range in parens short', 'Cohort data (1990/91)'],
  ['century word', 'Medicine in the 19th century'], ['century hyphen', 'A 20th-century history'],
  ['year in title', 'The 2008 financial crisis'], ['year in title parens', 'After the crisis (2008)'],
  ['olympics', 'London 2012 Olympics'],
  ['page range high', 'Notes, pp. 1990-1995'], ['volume high', 'Vol. 2001 suppl'],
  ['issue as year', 'Series 12(2001)'],
  ['report number', 'Technical Report No. 2019-05'], ['report number plain', 'Working Paper 1998'],
  ['grant number', 'Supported by grant R01-2019-123'], ['grant number plain', 'NIH grant 1950123'],
  ['isbn', 'ISBN 978-0-19-852663-6'], ['isbn short', 'ISBN 0-2019-1995-X'], ['issn', 'ISSN 2049-3630'],
  ['doi digits', 'doi:10.1037/0003-066X.2019.1'], ['doi plain', 'https://doi.org/10.1000/2019.12345'],
  ['url date path', 'https://example.org/2019/05/post'], ['url year path', 'http://www.x.org/archive/1998/'],
  ['sample size', 'A trial in 2001 patients'], ['N equals', 'Trial (N = 2001)'],
  ['article number', 'Article 2019'], ['e-locator', 'e2019001'],
  ['time', 'Recorded at 19:45'], ['money', 'Costs of $2,019'],
  ['ordinal', 'The 2019th case'], ['postcode', 'Vienna 1990 Austria'],
];

const frames = (shape: string): Array<[string, string]> => [
  ['APA', `Smith, J. (2015). ${shape}. Journal of Things, 3(1), 1-2.`],
  ['Vancouver', `Smith J. ${shape}. J Things. 2015;3:1-2.`],
];
const OWN: Array<[string, string, Array<number | null>]> = [
  ['suffixed (2008a)', 'Smith, J. (2008a). Title. J, 1, 2.', [2008]],
  ['suffixed bare 2008b', 'Smith J. Title. J. 2008b;1:2.', [2008, null]],
  ['n.d.', 'Smith, J. (n.d.). Title. J, 1, 2.', [null]],
  ['in press', 'Smith, J. (in press). Title. J.', [null]],
  ['forthcoming', 'Smith, J. (forthcoming). Title. J.', [null]],
  ['multi-year work', 'Smith, J. (1990-1995). Collected papers. Publisher.', [1990, null]],
  ['multi-year short', 'Smith, J. (1990/91). Title. J, 1, 2.', [1990, 1991, null]],
  ['reprint', 'Kant, I. (1781/1998). Critique. CUP.', [1998, null]],
  ['date', 'Smith, J. (2015, March 3). Title. Blog.', [2015]],
  ['season', 'Smith, J. (2015, Spring). Title. J, 1, 2.', [2015]],
];

const KNOWN_FIRST_NUMBER = new Set([
  'year range short slash', 'year range in parens short', 'year in title', 'year in title parens', 'olympics',
  'volume high', 'issue as year', 'report number plain', 'sample size', 'N equals', 'article number', 'postcode',
]);

describe('every number shape near a reference year: the true year or none, never another', () => {
  const cases = SHAPES.flatMap(([label, shape]) => frames(shape).map(([style, text]) => [label, style, text] as const));
  it.each(cases.filter(([label, style]) => !(style === 'Vancouver' && KNOWN_FIRST_NUMBER.has(label))))('%s [%s]', (_l, _s, text) => {
    expect([2015, null]).toContain(findReferenceYear(text));
  });
  it.each(OWN)('own year shape: %s', (_l, text, ok) => {
    expect(ok).toContain(findReferenceYear(text));
  });
  it('the known first-number shapes are still exactly the listed ones', () => {
    const wrong = cases.filter(([, , text]) => ![2015, null].includes(findReferenceYear(text) as any)).map(([l, s]) => `${l} [${s}]`);
    expect(wrong.sort()).toEqual([...KNOWN_FIRST_NUMBER].map((l) => `${l} [Vancouver]`).sort());
  });
});
