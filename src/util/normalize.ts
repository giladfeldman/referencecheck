/**
 * The one place each input shape is read.
 *
 * Class fixed 2026-11-18 ("one shape read differently in different code paths"): before
 * this module the library cleaned a DOI in eleven places with four different rules and folded names and titles with
 * an ASCII-only rule that deleted every non-Latin letter — so two identical Cyrillic or
 * Chinese titles scored 0.0 similarity, and "Müller" became "m ller". Every reader now goes
 * through these functions, and `tests/parity/` binds them with variant matrices.
 *
 * Years are NOT read here in this release: a shared year reader was tried and regressed
 * against the 0.2.x rules in review, so the 0.2.x year code stays where it was (DOI
 * matcher, deduplication, journal metadata) until a redesign ships on its own.
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
  d = d.trim();
  if (/^10\.\d{4,9}\//.test(d)) d = stripCitationTail(d);
  return d;
}

const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '>': '<', '}': '{' };

/**
 * What a citation puts after a DOI is not part of it (review 2026-11-19): a DOI holds no
 * whitespace, so "10.1101/x [preprint]" is cut at the space; trailing . , ; : and quotes are
 * sentence punctuation; a closing bracket is dropped only when it closes nothing inside the
 * DOI, so "10.1016/S0140-6736(20)30183-5" and SICI forms ending in ">" stay whole while
 * "(doi:10.1101/x)" loses its ")". Applied to DOI-shaped input only.
 */
function stripCitationTail(doi: string): string {
  let d = doi.split(/\s/)[0];
  const count = (ch: string) => d.split(ch).length - 1;
  for (;;) {
    const last = d.slice(-1);
    if (/[.,;:'"‘’“”]/.test(last)) d = d.slice(0, -1);
    else if (CLOSE_TO_OPEN[last] && count(last) > count(CLOSE_TO_OPEN[last])) d = d.slice(0, -1);
    else return d;
  }
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


