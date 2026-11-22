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

import { isParticle } from './surnames.js';

/**
 * The DOI shape, the one copy every reader uses: `10.<registrant>/<suffix>`. Registrant codes
 * run from 3 digits (10.231, 10.488, 10.978 and 10.979 are registered, checked against the
 * DOI handle server 2026-11-20) to 9. Before 0.3.0 two readers allowed 3 digits and two
 * required 4, so `10.231/x.` was well-formed to one and kept its full stop in the other.
 */
export const DOI_SHAPE = /^10\.\d{3,9}\/\S+$/;
/** The start of a DOI: `10.<registrant>/`. */
export const DOI_START = /^10\.\d{3,9}\//;

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
      const decoded = decodeURIComponent(d);
      // An escape that decodes to whitespace ("10.1000/a%20b") is kept encoded, written bare
      // or inside a resolver URL alike: decoding it would turn a well-formed DOI into one
      // with a space in it, which the shape check then reports as malformed (0.2.x kept
      // the encoded form and called it well-formed).
      if (countWhitespace(decoded) <= countWhitespace(d)) d = decoded;
    } catch {
      // A malformed escape is left as written; the shape check will reject it.
    }
  }
  d = d.trim();
  // A shortDOI ("10/gt3vmw") arrives in the same links and citations as a full DOI.
  if (DOI_START.test(d) || /^10\/[A-Za-z0-9]/.test(d)) {
    for (let prev = ''; prev !== d; ) {
      prev = d;
      d = stripLinkTail(stripCitationTail(d));
    }
  }
  return d;
}

/**
 * What a link adds after a DOI is not part of it (v0.3.0 review 7): a query
 * ("?utm_source=x", "?versioned=true", a lone "?"), a fragment ("#abs"), trailing slashes
 * and a publisher page ending ("/full", "/pdf", "/epdf", "/abstract"). Before, only
 * deduplication dropped them, so the preprint, retraction and Crossref lookups asked for
 * "10.x/y?utm_source=x", got no record, and a preprint read as clean. A "#" that ends the
 * DOI stays: Wiley SICI DOIs end in "CO;2-#" (three in the labelled set).
 */
function stripLinkTail(doi: string): string {
  return doi
    .replace(/\?(?:\S*=\S*)?$/, '')
    .replace(/#.+$/, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:full|pdf|epdf|abstract)$/i, '');
}

function countWhitespace(s: string): number {
  return s.match(/\s/g)?.length ?? 0;
}

const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '>': '<', '}': '{' };

/**
 * What a citation writes after a DOI ("[preprint]", "(PMID 123)", "Accessed 2020") follows
 * a space; it starts with a bracket or one of these words.
 */
const CITATION_TAIL = /^(?:[\[(]|(?:doi|pmid|pmcid|available|accessed|retrieved|epub|published|pdf|url)\b|https?:)/i;

/**
 * What a citation puts after a DOI is not part of it (review 2026-11-19). A space is cut at
 * only when a citation tail follows it: "10.1371/journal.pone. 0123456" is a DOI broken by a
 * space, and stays whole so the shape check reports it, as 0.2.x did, instead of becoming the
 * different DOI "10.1371/journal.pone". Trailing . , ; : and quotes are sentence
 * punctuation; a closing bracket is dropped only when it closes nothing inside the DOI, so
 * "10.1016/S0140-6736(20)30183-5" and SICI forms ending in ">" stay whole while
 * "10.1101/x)." loses ")." Applied to input that starts with a DOI only.
 */
function stripCitationTail(doi: string): string {
  const m = doi.match(/^(\S+)\s+([\s\S]*)$/);
  let d = m && CITATION_TAIL.test(m[2]) ? m[1] : doi;
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

// ------------------------------------------------------------------------------ names

/**
 * One author name, read once. `parseName` is the only place the library decides which part
 * of a name is the surname; deduplication and `splitAuthorList` use it.
 */
export interface ParsedName {
  /** Folded surname ("van der berg", "garcia marquez"). For order `unknown`, the whole folded name. */
  surname: string;
  /** Folded initials of the given names, in order ("ja"); `''` when none are written or the order is unknown. */
  initials: string;
  /** Folded given names, one word per name or initial ("john a"), present only when at least one is written in full. */
  given?: string;
  /**
   * `known`: a comma, initials at one end ("Smith JA", "J. A. Smith"), initials before a
   * surname ("John A. Smith"), or a single word (a surname alone). `unknown`: two or more
   * full words with no comma and no initial ("Wang Wei", "John Smith"): either word could be
   * the surname, and no guess is made.
   */
  order: 'known' | 'unknown';
  /** The name as given. */
  raw: string;
}

/** Jr and Sr are always suffixes; a roman numeral is one unless it is the only given part ("Ivanov II"). */
const SUFFIX = /^(?:jr|sr)\.?$/i;
const ROMAN_SUFFIX = /^(?:ii|iii|iv)\.?$/i;

/** A name with no case information (all lower-case or all capitals). */
function isCaseless(text: string): boolean {
  return !(/\p{Ll}/u.test(text) && /\p{Lu}/u.test(text));
}

/**
 * The one definition of initials: "J", "J.", "JA", "J.A.", "J.-P.", "J-H" (one to three
 * letters, a trailing comma ignored). A single letter of any case is an initial ("alder j").
 * Two or three letters with no separator ("JA") are initials only in a name written in
 * mixed case: in "WANG WEI" or "smith ja" they could be a word.
 */
function isInitialsToken(token: string, caseless: boolean): boolean {
  const t = token.replace(/,+$/, '');
  const parts = t.match(/\p{L}[.\-‐]*/gu);
  if (!parts || parts.join('') !== t || parts.length > 3) return false;
  if (parts.length === 1) return true;
  if (!caseless && /^[\p{Lu}.\-‐]+$/u.test(t)) return true;
  return parts.slice(0, -1).every((p) => p.length > 1);
}

function tokensOf(text: string): string[] {
  return text.split(/\s+/).map((t) => t.replace(/,+$/, '')).filter((t) => t.length > 0);
}

function withoutTrailingEtAl(text: string): string {
  return text.trim().replace(/,?\s*\bet\.?\s+al\b\.?$/i, '').trim();
}

/** Initials and given names from the given-name tokens. */
function givenParts(tokens: string[], caseless: boolean): { initials: string; given?: string } {
  const items: string[] = [];
  let anyFull = false;
  for (const t of tokens) {
    if (isInitialsToken(t, caseless)) {
      items.push(...[...foldForMatch(t).replace(/ /g, '')]);
    } else {
      const words = foldForMatch(t).split(' ').filter(Boolean);
      if (words.length > 0) anyFull = true;
      items.push(...words);
    }
  }
  const initials = items.map((w) => w.slice(0, 1)).join('');
  return anyFull ? { initials, given: items.join(' ') } : { initials };
}

/**
 * Read one author name into surname, initials and given names (see {@link ParsedName}).
 * Suffixes (Jr, Sr, II, III, IV after other given parts) and a trailing "et al." are
 * dropped. Folded input is read too: in "alder j" the one-letter word is the initial.
 */
export function parseName(raw: string): ParsedName {
  const original = typeof raw === 'string' ? raw : '';
  const text = withoutTrailingEtAl(original);
  const caseless = isCaseless(text);
  const known = (surname: string, given: string[]): ParsedName => ({
    surname: foldForMatch(surname),
    ...givenParts(given, caseless),
    order: 'known',
    raw: original,
  });

  const comma = text.indexOf(',');
  if (comma >= 0) {
    let surnameTokens = tokensOf(text.slice(0, comma));
    if (surnameTokens.length > 1 && SUFFIX.test(surnameTokens[surnameTokens.length - 1])) surnameTokens = surnameTokens.slice(0, -1);
    let given = tokensOf(text.slice(comma + 1)).filter((t) => !SUFFIX.test(t));
    if (given.length > 1) given = given.filter((t) => !ROMAN_SUFFIX.test(t));
    return known(surnameTokens.join(' '), given);
  }

  const tokens = tokensOf(text);
  for (;;) {
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && SUFFIX.test(last)) tokens.pop();
    else if (tokens.length > 2 && ROMAN_SUFFIX.test(last)) tokens.pop();
    else break;
  }
  if (tokens.length <= 1) return known(tokens.join(' '), []);

  // Particles before one word: a surname alone ("van der Berg").
  let p = 0;
  while (p < tokens.length - 1 && /^\p{L}+$/u.test(tokens[p]) && isParticle(tokens[p])) p++;
  if (p === tokens.length - 1) return known(tokens.join(' '), []);

  const flags = tokens.map((t) => isInitialsToken(t, caseless));
  const n = tokens.length;
  // Leading particles are part of the surname, even a one-letter one ("o brien z" is
  // O'Brien Z. folded, not three unknown words: round 11).
  if (!flags[p] && flags[n - 1]) {
    // Vancouver: "Smith JA", "van der Berg JH", "lee j h", "o brien z".
    let r = n - 1;
    while (r > p && flags[r - 1]) r--;
    // Surname first, then a full given name and an initial with a period ("Smith John A."):
    // the surname is the first word (with its particles), the rest are given names. A
    // Vancouver list writes its initials without periods, so "Garcia Marquez G" keeps its
    // two-word surname (round 11).
    const periodInitial = tokens.slice(r).some((t) => t.includes('.'));
    if (periodInitial && !caseless && r - p >= 2 && tokens.slice(p + 1, r).every((t) => /^\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?$/u.test(t))) {
      return known(tokens.slice(0, p + 1).join(' '), tokens.slice(p + 1));
    }
    return known(tokens.slice(0, r).join(' '), tokens.slice(r));
  }
  if (!flags[n - 1] && flags.some(Boolean)) {
    // Given names first: the surname is everything after the last initial
    // ("J. A. Smith", "G. Garcia Marquez", "John A. Smith").
    const lastInitial = flags.lastIndexOf(true);
    return known(tokens.slice(lastInitial + 1).join(' '), tokens.slice(0, lastInitial + 1));
  }
  return { surname: foldForMatch(tokens.join(' ')), initials: '', order: 'unknown', raw: original };
}

function isEtAl(piece: string): boolean {
  return /^et\.?\s+al\b\.?$/i.test(piece.trim());
}

function splitOne(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const caseless = isCaseless(trimmed);
  const allInitials = (piece: string) => {
    const toks = tokensOf(piece);
    return toks.length > 0 && toks.every((t) => isInitialsToken(t, caseless));
  };
  const hasInitial = (piece: string) => tokensOf(piece).some((t) => isInitialsToken(t, caseless));
  // One comma and no initial on either side is one name ("Smith, John"), as a string or as
  // an array element: a full given name, not a second author.
  if (!/[;&]|\band\b/i.test(trimmed)) {
    const sides = trimmed.split(',');
    if (sides.length === 2 && sides.every((s) => s.trim().length > 0 && !hasInitial(s))) return [trimmed];
  }
  const out: string[] = [];
  for (const group of trimmed.split(/\s*(?:;|&|\band\b)\s*/i)) {
    for (const piece of group.split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
      if (isEtAl(piece)) continue;
      const prev = out[out.length - 1];
      const isSuffix = SUFFIX.test(piece) || ROMAN_SUFFIX.test(piece);
      // Initials join the surname before them, unless that entry already has its given
      // part ("Smith, J., LI, X.": LI starts a new author). A given part mixing full names
      // and initials ("John A.", "J. Alan") joins a bare surname (no initial of its own:
      // "Smith JA, Jones KB" stays two Vancouver names).
      const givenPart = allInitials(piece) || (hasInitial(piece) && prev !== undefined && !hasInitial(prev));
      if (prev !== undefined && (isSuffix || (givenPart && !prev.includes(',')))) {
        out[out.length - 1] = `${prev}, ${piece}`;
      } else {
        out.push(piece);
      }
    }
  }
  return out;
}

/**
 * Split a written author list into one entry per author.
 *
 * The comma is ambiguous: in "Smith, J., Jones, K." it separates surname from initials AND
 * author from author. Rule: `;`, `&` and the word "and" always separate authors; a comma
 * separates authors unless what follows it is only initials (the {@link parseName}
 * definition: "J.", "JA", "J.-P.") or a suffix (Jr., III), which is joined to the surname
 * before it. "et al." is dropped. Every element of an array goes through the same rule
 * ("Smith J, Jones K" as one element is two authors), except that a string or element with
 * exactly one comma, no `;`/`&`/"and", and no initial on either side ("Smith, John") stays
 * one name.
 */
export function splitAuthorList(authors: string | readonly string[] | null | undefined): string[] {
  if (authors === null || authors === undefined) return [];
  if (Array.isArray(authors)) return authors.flatMap((a) => splitOne(String(a ?? '')));
  return splitOne(String(authors));
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


