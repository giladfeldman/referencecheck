/**
 * Surname comparison shared by deduplication and the DOI matcher (internal; not exported
 * from the package root).
 *
 * - A surname key is the `foldForMatch` fold with spaces removed, so "van dyke" = "vandyke"
 *   and "o'brien" = "obrien" (the fold already turned hyphens and apostrophes into spaces).
 * - Name particles: a surname also matches when it equals the other one minus its leading
 *   particles ("van der Berg" / "Berg"). Particles are stripped only where they are written
 *   as separate words; a glued "Vandyke" is never cut, so "Dean" never becomes "an".
 * - Two scripts: Latin, Cyrillic and Greek names are compared through a loose romanisation
 *   (consonant skeleton plus first letter). A name in any other script is comparable only
 *   with a name in the same script.
 */
import { foldForMatch } from './normalize.js';

/** Name particles, written as separate lower- or title-case words before a surname. */
export const NAME_PARTICLES = [
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'dos', 'das',
  'ter', 'ten', 'af', 'al', 'el', 'bin', 'ibn', 'ben', 'st', 'mac', 'mc', 'o',
] as const;
const PARTICLE_SET = new Set<string>(NAME_PARTICLES);

/** The script a name is written in, from its first letter. */
export type NameScript = 'latin' | 'cyrillic' | 'greek' | 'other' | 'none';

export function scriptOf(text: string): NameScript {
  const m = text.match(/\p{L}/u);
  if (!m) return 'none';
  const c = m[0];
  if (/\p{Script=Latin}/u.test(c)) return 'latin';
  if (/\p{Script=Cyrillic}/u.test(c)) return 'cyrillic';
  if (/\p{Script=Greek}/u.test(c)) return 'greek';
  return 'other';
}

/** Scripts the loose romanisation can bring together. */
const ROMANISABLE = new Set<NameScript>(['latin', 'cyrillic', 'greek']);

/**
 * Whether two names can be compared at all: same script, or both Latin, Cyrillic or
 * Greek. Han, Arabic, Hangul ... against Latin are not comparable (neither a match nor a
 * mismatch). Two "other" names are compared as written.
 */
export function scriptsComparable(a: string, b: string): boolean {
  const sa = scriptOf(a);
  const sb = scriptOf(b);
  if (sa === 'none' || sb === 'none') return false;
  if (sa === sb) return true;
  return ROMANISABLE.has(sa) && ROMANISABLE.has(sb);
}

/** True when the two names are in different scripts that the romanisation compares. */
export function crossScript(a: string, b: string): boolean {
  const sa = scriptOf(a);
  const sb = scriptOf(b);
  return sa !== sb && ROMANISABLE.has(sa) && ROMANISABLE.has(sb);
}

/** Folded words of a surname. */
function words(surname: string): string[] {
  return foldForMatch(surname).split(' ').filter(Boolean);
}

/** The surname key: folded, spaces (from spaces, hyphens, apostrophes) removed. */
export function surnameKey(surname: string): string {
  return words(surname).join('');
}

/** The key after dropping leading particle words; the last word always stays. */
export function surnameKeyWithoutParticles(surname: string): string {
  const w = words(surname);
  let i = 0;
  while (i < w.length - 1 && PARTICLE_SET.has(w[i])) i++;
  return w.slice(i).join('');
}

/** True when `word` (one word) is a name particle. */
export function isParticle(word: string): boolean {
  return PARTICLE_SET.has(foldForMatch(word));
}

/**
 * Same-script surname equality: equal keys, or one equals the other minus its leading
 * particles.
 */
export function sameSurname(a: string, b: string): boolean {
  const ka = surnameKey(a);
  const kb = surnameKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  return surnameKeyWithoutParticles(a) === kb || ka === surnameKeyWithoutParticles(b);
}

// ----------------------------------------------------------------- loose romanisation

/** One Latin spelling per Cyrillic and Greek letter; the normalisation below absorbs the rest. */
const ROMAN: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i',
  'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
  'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y',
  'ь': '', 'э': 'e', 'ю': 'iu', 'я': 'ia', 'і': 'i', 'ї': 'i', 'є': 'e', 'ґ': 'g', 'ў': 'u',
  'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i',
  'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'ks', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's',
  'ς': 's', 'τ': 't', 'υ': 'i', 'φ': 'f', 'χ': 'kh', 'ψ': 'ps', 'ω': 'o',
};

/**
 * A name as loose Latin: romanised, then the spellings that vary between romanisation
 * systems brought together (tch/ch, kh/h, ts/tz/c, x/ks, w/v, final -ff/-v, y/j/i, g/h).
 */
export function looseLatin(name: string): string {
  let s = [...foldForMatch(name).replace(/ /g, '')].map((c) => ROMAN[c] ?? c).join('');
  s = s
    .replace(/tch/g, 'ch')
    .replace(/kh/g, 'h')
    .replace(/t[sz]/g, 'c')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/ff$/g, 'v')
    .replace(/[yj]/g, 'i')
    .replace(/g/g, 'h');
  return s;
}

/**
 * First letter plus the consonants of the rest, vowels dropped and repeats collapsed. The
 * feminine endings (-a, -aya) are vowels, so "Ivanova" and "Ivanov" share a skeleton.
 */
function skeleton(loose: string): { first: string; rest: string } {
  const rest = loose.slice(1).replace(/[aeiou]/g, '').replace(/(.)\1+/g, '$1');
  return { first: loose.slice(0, 1), rest };
}

/**
 * Cross-script surname equality (Cyrillic or Greek against Latin, or Cyrillic against
 * Greek): same first letter and same consonant skeleton. With fewer than two consonants
 * after the first letter the skeleton says too little ("Li" / "Lu"), so the whole loose
 * spelling must be equal.
 */
export function looseSurnameMatch(a: string, b: string): boolean {
  const la = looseLatin(a);
  const lb = looseLatin(b);
  if (!la || !lb) return false;
  const sa = skeleton(la);
  const sb = skeleton(lb);
  if (sa.first !== sb.first || sa.rest !== sb.rest) return false;
  if (sa.rest.length < 2) return la.replace(/(.)\1+/g, '$1') === lb.replace(/(.)\1+/g, '$1');
  return true;
}

/** The first letter of a given name or initial, in loose Latin (for cross-script initials). */
export function looseInitial(nameOrInitial: string): string {
  return looseLatin(nameOrInitial).slice(0, 1);
}
