/**
 * The one place each input shape is read.
 *
 * Class fixed 2026-11-18 ("one shape read differently in different code paths"): before
 * this module the library cleaned a DOI in eleven places with four different rules, parsed
 * a year two ways (one of them read "(2019)" as no year), and folded names and titles with
 * an ASCII-only rule that deleted every non-Latin letter — so two identical Cyrillic or
 * Chinese titles scored 0.0 similarity, and "Müller" became "m ller". Every reader now goes
 * through these functions, and `tests/parity/` binds them with variant matrices.
 */

/** Wrappers a DOI arrives in: resolver URLs (any scheme, dx./www.), bare host, `doi:` labels. */
const DOI_WRAPPER = /^(?:(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\/|doi:\s*)/i;

/**
 * Reduce any written form of a DOI to the DOI itself: surrounding whitespace removed,
 * resolver URL or `doi:` label removed, percent-encoding decoded. Case is PRESERVED (DOIs
 * are case-insensitive, but callers report the DOI back and some compare case-folded
 * themselves). Anything that is not a DOI is returned trimmed and otherwise unchanged, so
 * shape checks downstream still see it and reject it.
 */
export function cleanDoiInput(doi: string | null | undefined): string {
  if (typeof doi !== 'string') return '';
  let d = doi.trim();
  // Twice: "https://doi.org/doi:10.x/y" occurs in hand-built links.
  for (let i = 0; i < 2; i++) d = d.replace(DOI_WRAPPER, '').trim();
  if (/%[0-9a-f]{2}/i.test(d)) {
    try {
      d = decodeURIComponent(d);
    } catch {
      // A malformed escape is left as written; the shape check will reject it.
    }
  }
  return d.trim();
}

/** `encodeURIComponent(cleanDoiInput(doi))` — the only form a DOI may take inside a URL. */
export function doiForUrl(doi: string | null | undefined): string {
  return encodeURIComponent(cleanDoiInput(doi));
}

/**
 * Fold text for similarity matching: Unicode-aware. Accents are removed by decomposition
 * (Müller -> muller), every letter and digit of every script is kept (Иванов stays
 * иванов), all other characters become one space.
 */
const FOLD_EXTRA: Record<string, string> = { 'ø': 'o', 'ł': 'l', 'ß': 'ss', 'đ': 'd', 'ı': 'i', 'æ': 'ae', 'œ': 'oe', 'þ': 'th' };

export function foldForMatch(text: string | null | undefined): string {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    // Letters NFKD does not decompose: Østergaard, Łukasz, Straße, Đorđević, ı.
    .replace(/[øłßđıæœþ]/g, (c) => FOLD_EXTRA[c] ?? c)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The one definition of a year, shared by every year reader in the library (2026-11-19):
 * YEAR is the range a year may take, 1500-2099. A BARE number in running text counts
 * only from 1900 (BARE_YEAR): a bare 1500-1899 number is far more often a count, volume
 * or page ("1650 participants", "vol. 1521") than a year. Year context (a parenthetical
 * that is only a year, or a year field) allows the whole range.
 */
export const YEAR = '(?:1[5-9]|20)\\d{2}';
export const BARE_YEAR = '(?:19|20)\\d{2}';
// A bare year not inside an identifier ("arXiv:1706.03762"), a range ("1648-1655",
// "1648 – 1655") or a volume:issue run.
const BARE_YEAR_IN_TEXT = new RegExp(`(?<![\\d.:/\\u2013-])(${BARE_YEAR})[a-z]?(?![\\d]|\\s*[\\u2013-]\\s*\\d|\\.\\d|:\\d)`);
const PARENTHETICAL_YEAR = new RegExp(
  `\\(\\s*(?:${YEAR}[a-z]?\\s*\\/\\s*)?(${YEAR})[a-z]?\\s*(?:,[^()]*)?\\)`,
);

/**
 * The first parenthetical that is only a year: "(2019)", "(2019a)", "(2019, March 3)",
 * "(1859)"; "(1781/1998)" (original/reprint) is the reprint year, the one Crossref holds.
 * Returns the year and where the parenthetical sits, or null.
 */
export function findParentheticalYear(text: string | null | undefined): { year: number; index: number; length: number } | null {
  if (typeof text !== 'string') return null;
  const m = text.match(PARENTHETICAL_YEAR);
  return m && m.index !== undefined ? { year: parseInt(m[1], 10), index: m.index, length: m[0].length } : null;
}

/**
 * The publication year in a value: the first stand-alone four-digit year 1500-2099,
 * whatever surrounds it ("2019", "2019a", "(2019)", "(2019, March 3)", "c. 1984", 2019).
 * Null when there is none ("in press", "n.d.", "", "12345").
 */
export function parseYear(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1500 && value <= 2099 ? value : null;
  }
  // "1781/1998" (original/reprint) is the reprint year, as in findParentheticalYear.
  const m = String(value).match(new RegExp(`(?<!\\d)(?:${YEAR}[a-z]?\\s*\\/\\s*)?(${YEAR})(?!\\d)`));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Split a written author list into one entry per author.
 *
 * The comma is ambiguous: in "Smith, J., Jones, K." it separates surname from initials AND
 * author from author. The earlier rule split on every comma, so that list became four
 * "authors" (smith, j, jones, k) while the same list written "J. Smith; K. Jones" was two —
 * one list, two readings. Rule now: `;`, `&` and the word "and" always separate authors; a
 * comma separates authors unless what follows it is only initials or a suffix (Jr., III),
 * in which case it is joined to the surname before it.
 */
export function splitAuthorList(authors: string | readonly string[] | null | undefined): string[] {
  if (authors === null || authors === undefined) return [];
  if (Array.isArray(authors)) {
    return authors.map((a) => String(a ?? '').trim()).filter((a) => a.length > 0);
  }
  const text = String(authors);
  const out: string[] = [];
  for (const group of text.split(/\s*(?:;|&|\band\b)\s*/i)) {
    const pieces = group.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
    for (const piece of pieces) {
      // Initials: every capital is followed by a period, a space, a hyphen or the end
      // ("J.", "J. K.", "J.K.", "J.-P.", "J"). An all-caps surname ("LI", "SMITH") is not.
      const isInitialsOrSuffix =
        /^(?:\p{Lu}(?:\.|(?=[\s-]|$))[\s-]*)+$/u.test(piece) || /^(?:jr|sr|ii|iii|iv)\.?$/i.test(piece);
      if (isInitialsOrSuffix && out.length > 0 && out[out.length - 1] !== '') {
        out[out.length - 1] = `${out[out.length - 1]}, ${piece}`;
      } else {
        out.push(piece);
      }
    }
  }
  return out.filter((a) => a.length > 0);
}

/**
 * Crossref `date-parts` as ISO text: [2019, 3, 5] -> "2019-03-05", [2019, 3] -> "2019-03",
 * [2019] -> "2019". Undefined when there is no year.
 */
export function formatDateParts(parts: unknown): string | undefined {
  if (!Array.isArray(parts) || typeof parts[0] !== 'number') return undefined;
  const [y, m, d] = parts as number[];
  let s = String(y).padStart(4, '0');
  if (typeof m === 'number') s += `-${String(m).padStart(2, '0')}`;
  if (typeof m === 'number' && typeof d === 'number') s += `-${String(d).padStart(2, '0')}`;
  return s;
}

/**
 * An ISSN in the one form the indexes answer to: "1932-6203", check digit X upper-cased.
 * Accepts it with or without the hyphen, with spaces, or with an `ISSN` label. Null for
 * anything that is not eight ISSN characters. DOAJ finds `issn:1932-6203` and returns
 * nothing for `issn:19326203` (measured 2026-11-18), so the hyphen is not optional.
 */
export function normalizeIssn(issn: string | null | undefined): string | null {
  if (typeof issn !== 'string') return null;
  const s = issn.replace(/^\s*(?:e-?|p-?)?issn\s*:?\s*/i, '').replace(/[\s\u2010-\u2015-]/g, '').toUpperCase();
  if (!/^\d{7}[\dX]$/.test(s)) return null;
  // The ISSN check digit (mod 11): without it a page range "1648-1655" or a year range
  // "2019-2020" has the same shape as an ISSN.
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  if (s[7] !== (check === 10 ? 'X' : String(check))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * The publication year of a whole reference string (not of a year field: that is
 * `parseYear`). A parenthetical that is only a year wins, 1500-2099 (the range parseYear
 * accepts): "(2019)", "(2019a)", "(2019, March 3)", "(1859)"; "(1781/1998)" (original/
 * reprint) is the reprint year, the one Crossref holds. Otherwise the first BARE 1900-2099
 * number that is not part of an identifier, page range or volume(issue) run, as in 0.2.x:
 * a bare 1500-1899 number is far more often a count, volume or page than a year, and a
 * wrong year rejects the right DOI. "arXiv:1706.03762", "1648-1655" and "(N = 1648)" are
 * not years. Null when there is none (the DOI matcher then skips its year check).
 */
export function findReferenceYear(text: string | null | undefined): number | null {
  if (typeof text !== 'string') return null;
  const p = findParentheticalYear(text);
  if (p) return p.year;
  const m = text.match(BARE_YEAR_IN_TEXT);
  return m ? parseInt(m[1], 10) : null;
}

