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
export function foldForMatch(text: string | null | undefined): string {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const m = String(value).match(/(?<!\d)(1[5-9]\d{2}|20\d{2})(?!\d)/);
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
      const isInitialsOrSuffix =
        /^(?:\p{Lu}\.?[\s.-]*)+$/u.test(piece) || /^(?:jr|sr|ii|iii|iv)\.?$/i.test(piece);
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
