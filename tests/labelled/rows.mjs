/**
 * The labelled release set for the two name readers (deduplication and the DOI matcher).
 *
 * Every row is labelled BY CONSTRUCTION, never by a reviewer's opinion:
 *  - Positives start from a real Crossref record in `tests/fixtures/crossref/` and render it
 *    as a reference in one written shape (APA, Vancouver, given-first, folded surnames ...).
 *    Two renderings of one record are the same work; a rendering and its own record are the
 *    right DOI.
 *  - Negatives are confusers built from those records: another work by the same first author
 *    in an adjacent year, the same surname with another initial, a reply or a correction
 *    notice, an editorial, Part I vs Part II, a preprint vs its published version.
 *  - Three classes have no fact of the matter and carry the maintainer's label: a conflicting
 *    first initial or given name is NOT the same author; Иванов and Ivanova ARE the same
 *    author; a preprint and its published version (different DOIs) are NOT duplicates.
 *
 * Plain JavaScript with no import from the library, so the same rows can be scored against
 * any build (`scripts/labelled-report.mjs` scores the 0.2.x build for the baseline).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { givenNameFor } from './givenName.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'crossref');

/** The configuration the README documents. */
export const DEDUP_CONFIG = { threshold: 0.85, authorWeighting: 0.4, titleWeighting: 0.4 };

const MAX_AUTHORS = 6;

function load(name) {
  const j = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  return j.message ?? j;
}

function yearOf(m) {
  for (const k of ['published', 'published-online', 'published-print', 'issued']) {
    const y = m?.[k]?.['date-parts']?.[0]?.[0];
    if (y) return y;
  }
  return null;
}

/** Accents off, lower case, punctuation to one space: the folded shape a consumer stores. */
function fold(s) {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function stripAccents(s) {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}
function cleanTitle(t) {
  return String(t ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** Initial letters of a Crossref `given`: "P. C." -> [P, C]; "AJ" -> [A, J]; "Svetlana Yu" -> [S, Y]. */
function initialsOf(given) {
  const out = [];
  for (const w of String(given ?? '').split(/[\s.\-‐]+/).filter(Boolean)) {
    if (/^\p{Lu}{1,3}$/u.test(w)) out.push(...w);
    else out.push(w[0].toUpperCase());
  }
  return out;
}

// ------------------------------------------------------------------ name renderings
const apaName = (a) => (a.initials.length ? `${a.family}, ${a.initials.map((l) => `${l}.`).join(' ')}` : a.family);
const vancouverName = (a) => `${a.family}${a.initials.length ? ` ${a.initials.join('')}` : ''}`;
const givenFirstName = (a) => `${a.initials.map((l) => `${l}.`).join(' ')}${a.initials.length ? ' ' : ''}${a.family}`;
const apaList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}` : names[0]);

function authorsOf(m, limit = MAX_AUTHORS) {
  return (m.author ?? [])
    .filter((a) => typeof a.family === 'string' && a.family.trim())
    .slice(0, limit)
    .map((a) => ({ family: a.family.trim(), given: a.given ?? '', initials: initialsOf(a.given) }));
}

/** The work as a record the renderers read. */
function work(m, overrides = {}) {
  return {
    doi: m.DOI,
    title: cleanTitle(m.title?.[0]),
    year: yearOf(m),
    journal: cleanTitle(m['container-title']?.[0]) || 'Journal',
    authors: authorsOf(m),
    record: m,
    ...overrides,
  };
}

// normalized_authors shapes (deduplication input)
const AUTHOR_SHAPES = {
  apa: (w) => w.authors.map(apaName),
  vancouver: (w) => w.authors.map(vancouverName),
  'given-first': (w) => w.authors.map(givenFirstName),
  'consumer-surnames': (w) => w.authors.map((a) => fold(a.family)),
  'folded-initials': (w) => w.authors.map((a) => fold(`${a.family} ${a.initials.join(' ')}`)),
  'all-caps': (w) => w.authors.map((a) => apaName(a).toUpperCase()),
  'one-string': (w) => [apaList(w.authors.map(apaName))],
  suffix: (w) => w.authors.map((a, i) => (i === 0 ? `${apaName(a)}, Jr.` : apaName(a))),
};

// reference-text shapes (DOI matcher input)
const TEXT_SHAPES = {
  apa: (w) => `${apaList(w.authors.map(apaName))} (${w.year}). ${w.title}. ${w.journal}.`,
  vancouver: (w) => `${w.authors.slice(0, 6).map(vancouverName).join(', ')}${(w.record.author ?? []).length > 6 ? ', et al' : ''}. ${w.title}. ${w.journal}. ${w.year}.`,
  'given-first': (w) => `${w.authors.map(givenFirstName).join(', ')}, "${w.title}," ${w.journal}, ${w.year}.`,
  'all-caps': (w) => TEXT_SHAPES.apa(w).toUpperCase(),
  folded: (w) => fold(TEXT_SHAPES.apa(w)),
  suffix: (w) => `${apaList(w.authors.map((a, i) => (i === 0 ? `${apaName(a)}, Jr.` : apaName(a))))} (${w.year}). ${w.title}. ${w.journal}.`,
};

// ------------------------------------------------------------------ the records
const FIXTURE_FILES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
const WORKS = FIXTURE_FILES
  .map((f) => ({ file: f, w: work(load(f)) }))
  .filter(({ w }) => w.authors.length > 0 && w.year && w.title && w.title.toUpperCase() !== 'WITHDRAWN');

/** Cyrillic spellings of the authors of two records whose authors publish in Russian. */
const CYRILLIC = {
  'corrected.json': [['Паркевич', 'Е. В.'], ['Иваненков', 'Г. В.'], ['Медведев', 'М. А.'], ['Хирьянова', 'А. И.'], ['Селюков', 'А. С.'], ['Агафонов', 'А. В.']],
  'eoc-publisher.json': [['Бажин', 'А. В.'], ['Савченко', 'М. С.'], ['Шифрина', 'О. Н.'], ['Демоура', 'С. А.'], ['Чикина', 'С. Ю.']],
};
function cyrillicWork(file) {
  const w = WORKS.find((x) => x.file === file).w;
  const authors = CYRILLIC[file].map(([family, ini]) => ({ family, given: ini, initials: ini.replace(/\./g, '').split(/\s+/) }));
  return { latin: { ...w, authors: w.authors.slice(0, authors.length) }, cyr: { ...w, authors } };
}

/** The accented authors of the bioRxiv record (positions 68, 77, 84 in Crossref's list). */
function accentedWork() {
  const m = load('preprint-biorxiv.json');
  const picked = (m.author ?? []).filter((a) => /[^\x00-\x7f]/.test(`${a.family}`) && !/’/.test(a.family));
  const authors = picked.map((a) => ({ family: a.family, given: a.given ?? '', initials: initialsOf(a.given) }));
  const w = work(m, { authors });
  const stripped = { ...w, authors: authors.map((a) => ({ ...a, family: stripAccents(a.family) })), title: stripAccents(w.title) };
  return { w, stripped };
}

/** A synthetic particle record: the Cold Spring Harbor record with "Berg" written "van den Berg" in Crossref. */
function particleWork() {
  const m = structuredClone(load('cshl-journal-article.json'));
  m.author = m.author.map((a) => (a.family === 'Berg' ? { ...a, family: 'van den Berg' } : a));
  const w = work(m);
  // References write the surname with the particle, capitalised, or without it.
  const dropped = { ...w, authors: w.authors.map((a) => (a.family === 'van den Berg' ? { ...a, family: 'Berg' } : a)) };
  const capital = { ...w, authors: w.authors.map((a) => (a.family === 'van den Berg' ? { ...a, family: 'Van den Berg' } : a)) };
  return { w, dropped, capital };
}

/** Glued surnames written spaced: "LaCour" / "La Cour", "McNutt" / "Mc Nutt". */
function gluedWorks() {
  return WORKS.filter(({ w }) => w.authors.some((a) => /^\p{Lu}\p{Ll}+\p{Lu}\p{Ll}/u.test(a.family))).map(({ file, w }) => ({
    file,
    w,
    spaced: { ...w, authors: w.authors.map((a) => ({ ...a, family: a.family.replace(/^(\p{Lu}\p{Ll}+)(\p{Lu})/u, '$1 $2') })) },
  }));
}

const FIRST_NAMES = ['Anna', 'Bruno', 'Clara', 'David', 'Elena', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas', 'Karl', 'Lena', 'Marco', 'Nora', 'Oscar', 'Paula', 'Rosa', 'Simon', 'Tobias', 'Ursula', 'Viktor', 'Wanda', 'Yara', 'Zeno'];
function otherInitial(letter) {
  const alphabet = 'ABCDEFGHIJKLMNOPRSTVWZ';
  return alphabet[(alphabet.indexOf(letter.toUpperCase()) + 7 + alphabet.length) % alphabet.length] ?? 'Q';
}

// ------------------------------------------------------------------ rows
function dedupRef(id, w, authors, overrides = {}) {
  return { id, raw_text: '', normalized_authors: authors, normalized_title: w.title, normalized_year: String(w.year), ...overrides };
}

/** Synthetic records carry the given name the cited author's record would hold (see ./givenName.mjs). */
function withGivenNames(text, candidate) {
  if (!Array.isArray(candidate?.author) || !candidate.author.some((a) => a?.given === 'X.')) return candidate;
  return { ...candidate, author: candidate.author.map((a) => (a?.given === 'X.' ? { family: a.family, ...(givenNameFor(text, a.family) ? { given: givenNameFor(text, a.family) } : {}) } : a)) };
}

function buildRows() {
  const dedup = [];
  const doi = [];
  const addDedup = (cls, label, a, b, note) => dedup.push({ kind: 'dedup', cls, label, a, b, note });
  const addDoi = (cls, label, text, candidate, note) => doi.push({ kind: 'doi', cls, label, text, candidate: withGivenNames(text, candidate), note });

  WORKS.forEach(({ file, w }, i) => {
    const other = WORKS[(i + 1) % WORKS.length].w;
    // Positives: the APA rendering against every other shape.
    for (const [shape, render] of Object.entries(AUTHOR_SHAPES)) {
      if (shape === 'apa') continue;
      const title = shape === 'all-caps' ? w.title.toUpperCase() : w.title;
      addDedup(`same:${shape}`, 'same', dedupRef('a', w, AUTHOR_SHAPES.apa(w)), dedupRef('b', w, render(w), { normalized_title: title }), file);
    }
    // The consumer's folded surnames against the other shapes.
    for (const shape of ['vancouver', 'given-first', 'folded-initials']) {
      addDedup(`same:consumer~${shape}`, 'same', dedupRef('a', w, AUTHOR_SHAPES['consumer-surnames'](w), { normalized_title: fold(w.title) }), dedupRef('b', w, AUTHOR_SHAPES[shape](w)), file);
    }
    // Same DOI, the title shortened to its part before a colon (or its first four words).
    const short = w.title.includes(':') ? w.title.split(':')[0] : w.title.split(' ').slice(0, 4).join(' ');
    addDedup('same:same-doi-short-title', 'same', dedupRef('a', w, AUTHOR_SHAPES.apa(w), { doi: w.doi }), dedupRef('b', w, AUTHOR_SHAPES.vancouver(w), { normalized_title: short, doi: `https://doi.org/${w.doi}` }), file);

    // Negatives.
    const first = w.authors[0];
    if (first.initials.length) {
      const changed = { ...first, initials: [otherInitial(first.initials[0]), ...first.initials.slice(1)] };
      addDedup('owner:initial-conflict', 'different', dedupRef('a', w, [apaName(first)]), dedupRef('b', w, [apaName(changed)]), file);
      const given = first.given && !/^\p{Lu}{1,3}$/u.test(first.given.replace(/[.\s-]/g, '')) ? first.given.split(' ')[0] : null;
      if (given) {
        const alt = FIRST_NAMES.find((n) => n[0] === given[0] && n !== given) ?? FIRST_NAMES.find((n) => n !== given);
        addDedup('owner:given-conflict', 'different', dedupRef('a', w, [`${first.family}, ${given}`]), dedupRef('b', w, [`${first.family}, ${alt}`]), file);
      }
    }
    addDedup('neg:adjacent-year-other-work', 'different', dedupRef('a', w, AUTHOR_SHAPES.apa(w)), dedupRef('b', w, AUTHOR_SHAPES.apa(w), { normalized_title: other.title, normalized_year: String(w.year + 1) }), file);
    addDedup('owner:preprint-vs-published', 'different', dedupRef('a', w, AUTHOR_SHAPES.apa(w), { doi: w.doi }), dedupRef('b', w, AUTHOR_SHAPES.apa(w), { doi: `10.31234/osf.io/pre${i}` }), file);
    addDedup('neg:part-i-vs-part-ii', 'different', dedupRef('a', w, AUTHOR_SHAPES.apa(w), { normalized_title: `${w.title}. Part I` }), dedupRef('b', w, AUTHOR_SHAPES.apa(w), { normalized_title: `${w.title}. Part II` }), file);

    // DOI positives: each text shape against the record itself.
    for (const [shape, render] of Object.entries(TEXT_SHAPES)) addDoi(`right:${shape}`, 'accept', render(w), w.record, file);
    // DOI negatives.
    const otherWork = { ...w.record, DOI: `${w.doi}.other`, title: [other.title], subtitle: [], published: { 'date-parts': [[w.year + 1]] } };
    addDoi('wrong:same-author-adjacent-year', 'reject', TEXT_SHAPES.apa(w), otherWork, file);
    if (first.initials.length) {
      const refOther = { ...w, title: other.title, authors: [{ ...first, initials: [otherInitial(first.initials[0])] }] };
      addDoi('wrong:same-surname-other-initial', 'reject', TEXT_SHAPES.apa(refOther), w.record, file);
    }
    addDoi('wrong:other-authors', 'reject', TEXT_SHAPES.apa(w), { ...other.record, published: { 'date-parts': [[w.year]] } }, file);
    addDoi('wrong:part-ii', 'reject', TEXT_SHAPES.apa({ ...w, title: `${w.title}. Part I` }), { ...w.record, DOI: `${w.doi}.2`, title: [`${w.title}. Part II`], subtitle: [] }, file);
    addDoi('owner:preprint-for-published', 'reject', TEXT_SHAPES.apa(w), { ...w.record, DOI: `10.31234/osf.io/pre${i}`, type: 'posted-content' }, file);
  });

  // Cyrillic renderings (the maintainer's label: Иванов and Ivanova are one author).
  for (const file of Object.keys(CYRILLIC)) {
    const { latin, cyr } = cyrillicWork(file);
    addDedup('same:cyrillic', 'same', dedupRef('a', latin, AUTHOR_SHAPES.apa(latin)), dedupRef('b', cyr, AUTHOR_SHAPES.apa(cyr)), file);
    addDedup('same:cyrillic', 'same', dedupRef('a', latin, AUTHOR_SHAPES['consumer-surnames'](latin)), dedupRef('b', cyr, AUTHOR_SHAPES['consumer-surnames'](cyr)), file);
    addDoi('right:cyrillic', 'accept', TEXT_SHAPES.apa(cyr), latin.record, file);
    addDoi('right:cyrillic', 'accept', TEXT_SHAPES.vancouver(cyr), latin.record, file);
  }
  {
    const w = WORKS.find((x) => x.file === 'has-reply.json').w;
    const ivanov = { ...w, authors: [{ family: 'Иванов', given: 'И.', initials: ['И'] }] };
    const ivanova = { ...w, authors: [{ family: 'Ivanova', given: 'I.', initials: ['I'] }] };
    addDedup('owner:ivanov-ivanova', 'same', dedupRef('a', ivanov, AUTHOR_SHAPES.apa(ivanov)), dedupRef('b', ivanova, AUTHOR_SHAPES.apa(ivanova)), 'synthetic');
    const rec = { ...w.record, author: [{ family: 'Ivanova', given: 'I.' }] };
    addDoi('owner:ivanov-ivanova', 'accept', TEXT_SHAPES.apa(ivanov), rec, 'synthetic');
  }
  // Accents stripped.
  {
    const { w, stripped } = accentedWork();
    addDedup('same:accents-stripped', 'same', dedupRef('a', w, AUTHOR_SHAPES.apa(w)), dedupRef('b', stripped, AUTHOR_SHAPES.apa(stripped)), 'preprint-biorxiv.json');
    addDoi('right:accents-stripped', 'accept', TEXT_SHAPES.apa(stripped), w.record, 'preprint-biorxiv.json');
    addDoi('right:accents-stripped', 'accept', TEXT_SHAPES.vancouver(stripped), w.record, 'preprint-biorxiv.json');
  }
  // Particles.
  {
    const { w, dropped, capital } = particleWork();
    addDedup('same:particle', 'same', dedupRef('a', w, AUTHOR_SHAPES.apa(w)), dedupRef('b', dropped, AUTHOR_SHAPES.apa(dropped)), 'cshl-journal-article.json');
    addDedup('same:particle', 'same', dedupRef('a', capital, AUTHOR_SHAPES.apa(capital)), dedupRef('b', w, AUTHOR_SHAPES.vancouver(w)), 'cshl-journal-article.json');
    addDedup('same:particle', 'same', dedupRef('a', w, AUTHOR_SHAPES['consumer-surnames'](w)), dedupRef('b', dropped, AUTHOR_SHAPES['consumer-surnames'](dropped)), 'cshl-journal-article.json');
    for (const [variant, ref] of [['with', w], ['capital', capital], ['dropped', dropped]]) {
      // Second author only, so the particle surname is the evidence.
      const only = { ...ref, authors: ref.authors.slice(1) };
      addDoi('right:particle', 'accept', TEXT_SHAPES.apa(only), w.record, `cshl-journal-article.json ${variant}`);
      addDoi('right:particle', 'accept', TEXT_SHAPES.vancouver(only), w.record, `cshl-journal-article.json ${variant}`);
    }
  }
  // Glued vs spaced.
  for (const { file, w, spaced } of gluedWorks()) {
    addDedup('same:glued-spaced', 'same', dedupRef('a', w, AUTHOR_SHAPES.apa(w)), dedupRef('b', spaced, AUTHOR_SHAPES.apa(spaced)), file);
    addDoi('right:glued-spaced', 'accept', TEXT_SHAPES.apa(spaced), w.record, file);
  }

  // Replies, corrections, editorials.
  {
    const reply = WORKS.find((x) => x.file === 'is-reply-to.json').w;
    const original = { ...reply, title: 'Hydrological response of a mountain catchment to monsoon variability', year: 2018 };
    addDedup('neg:reply-vs-work', 'different', dedupRef('a', original, AUTHOR_SHAPES.apa(original)), dedupRef('b', reply, AUTHOR_SHAPES.apa(reply)), 'is-reply-to.json');
    addDoi('wrong:reply', 'reject', TEXT_SHAPES.apa(original), reply.record, 'is-reply-to.json');

    const corrected = WORKS.find((x) => x.file === 'corrected.json').w;
    const note = corrected.record['updated-by'][0];
    const notice = { ...corrected.record, DOI: note.DOI, title: [`Corrigendum: ${corrected.title}`], published: { 'date-parts': [[note.updated['date-parts'][0][0]]] } };
    addDedup('neg:correction-notice', 'different', dedupRef('a', corrected, AUTHOR_SHAPES.apa(corrected)), dedupRef('b', corrected, AUTHOR_SHAPES.apa(corrected), { normalized_title: notice.title[0], normalized_year: String(notice.published['date-parts'][0][0]) }), 'corrected.json');
    addDoi('wrong:correction-notice', 'reject', TEXT_SHAPES.apa(corrected), notice, 'corrected.json');

    const withdrawal = WORKS.find((x) => x.file === 'withdrawn-with-erratum.json').w;
    const inner = withdrawal.title.match(/‘([^’]+)’/)?.[1] ?? withdrawal.title;
    const article = { ...withdrawal, title: inner };
    addDedup('neg:correction-notice', 'different', dedupRef('a', article, AUTHOR_SHAPES.apa(article)), dedupRef('b', withdrawal, AUTHOR_SHAPES.apa(withdrawal)), 'withdrawn-with-erratum.json');
    addDoi('wrong:correction-notice', 'reject', TEXT_SHAPES.apa(article), withdrawal.record, 'withdrawn-with-erratum.json');

    const editorial = WORKS.find((x) => x.file === 'retraction-notice.json').w;
    const cited = { ...editorial, title: 'Integrity in the scientific record' };
    addDoi('wrong:editorial', 'reject', TEXT_SHAPES.apa(cited), editorial.record, 'retraction-notice.json');
    for (const t of ['Editorial', 'Introduction']) {
      addDoi('wrong:editorial', 'reject', TEXT_SHAPES.apa(cited), { ...editorial.record, DOI: `${editorial.doi}.${t.toLowerCase()}`, title: [t] }, `retraction-notice.json "${t}"`);
    }
  }
  // A preprint record offered for its published version (the bioRxiv fixture, cited as a journal article).
  {
    const pre = WORKS.find((x) => x.file === 'preprint-biorxiv.json').w;
    const published = { ...pre, journal: 'Nature' };
    addDoi('owner:preprint-for-published', 'reject', TEXT_SHAPES.apa(published), pre.record, 'preprint-biorxiv.json');
  }
  addRound11Rows(addDedup, addDoi);
  addRound12Rows(addDoi);
  dedup.forEach((r, i) => { r.half = halfOf(`${r.kind}/${r.cls}/${r.note}/${i}`); });
  doi.forEach((r, i) => { r.half = halfOf(`${r.kind}/${r.cls}/${r.note}/${i}`); });
  return { dedup, doi };
}

/**
 * Each row's half, fixed by a hash of its class, note and position (seed below): `fit` and
 * `gate`. A rule tuned while looking at rows must be judged on the half it was not tuned on;
 * `scripts/labelled-report.mjs --halves` prints both.
 */
const HALF_SEED = 0x2f11;
function halfOf(key) {
  let h = HALF_SEED;
  for (const c of key) h = Math.imul(h ^ c.codePointAt(0), 0x01000193) >>> 0;
  return h % 2 === 0 ? 'fit' : 'gate';
}

// ------------------------------------------------------------------ shapes added in review round 11
// Classes the first version of the set never rendered (review 2026-11-19 found the build worse
// than 0.2.x on them). Labels by construction, as above; the owner's defaults are marked owner:.

/** Given names as Crossref writes them, first: "Michael J. LaCour" (initials when no given name). */
const givenFullFirstName = (a) => (a.given ? `${a.given} ${a.family}` : givenFirstName(a));
/** The other works' authors, none sharing a surname with `w`. */
function otherAuthorsWork(w, offset) {
  const fams = new Set(w.authors.map((a) => fold(a.family)));
  for (let k = 1; k < WORKS.length; k++) {
    const o = WORKS[(WORKS.findIndex((x) => x.w === w) + offset + k) % WORKS.length].w;
    if (o.authors.every((a) => !fams.has(fold(a.family)))) return o;
  }
  throw new Error('no work with other authors');
}

/** One word of a title written another accepted way: UK spelling, -ise, plural. Null when no word fits. */
const UK = { behavior: 'behaviour', color: 'colour', labor: 'labour', favor: 'favour', modeling: 'modelling', judgment: 'judgement', center: 'centre', analyze: 'analyse' };
function oneWordVariant(title) {
  const words = title.split(' ');
  const rules = [
    (x) => (/ization/i.test(x) ? x.replace(/ization/i, 'isation') : null),
    (x) => (/ize/i.test(x) ? x.replace(/ize/i, 'ise') : null),
    (x) => { const k = Object.keys(UK).find((u) => x.toLowerCase().startsWith(u)); return k ? x.replace(new RegExp(k, 'i'), UK[k]) : null; },
    (x) => (/^\p{L}{5,}$/u.test(x) ? (/[^s]s$/.test(x) ? x.slice(0, -1) : `${x}s`) : null),
  ];
  for (const rule of rules) {
    for (let i = words.length - 1; i >= 0; i--) {
      const v = rule(words[i]);
      if (v && v !== words[i]) return [...words.slice(0, i), v, ...words.slice(i + 1)].join(' ');
    }
  }
  return null;
}

/** Short titles (two or three distinctive words) and a variant a reference writes for each. */
const SHORT_TITLES = [
  ['Behavior change', 'Behaviour change'],
  ['Moral judgment', 'Moral judgement'],
  ['Social norm', 'Social norms'],
  ['Organization theory', 'Organisation theory'],
  ['Climate modeling', 'Climate modelling'],
  ['Neural networks', 'Neural network'],
  ['Prospect theory revisited', 'Prospect theories revisited'],
  ['Randomized controlled trials', 'Randomised controlled trials'],
];

function addRound11Rows(addDedup, addDoi) {
  const LONG_SUB = 'A long descriptive subtitle that adds many distinctive words to the record';
  WORKS.forEach(({ file, w }, i) => {
    const apa = AUTHOR_SHAPES.apa(w);
    const authorsApa = apaList(apa);
    // ---- right DOI, more author shapes
    const gf = w.authors.map(givenFullFirstName);
    addDoi('right:given-first-full', 'accept', `${gf.join(', ')} (${w.year}). ${w.title}. ${w.journal}.`, w.record, file);
    const gfAnd = gf.length > 1 ? `${gf.slice(0, -1).join(', ')} and ${gf[gf.length - 1]}` : gf[0];
    addDoi('right:given-first-full-and', 'accept', `${gfAnd} (${w.year}). ${w.title}. ${w.journal}.`, w.record, file);
    addDoi('right:et-al-string', 'accept', `${apa[0]}, et al. (${w.year}). ${w.title}. ${w.journal}.`, w.record, file);
    addDoi('right:et-al-string', 'accept', `${vancouverName(w.authors[0])}, et al. ${w.title}. ${w.journal}. ${w.year}.`, w.record, file);
    // ---- right DOI, title shapes
    addDoi('right:subtitle-dropped-short', 'accept', TEXT_SHAPES.apa(w), { ...w.record, subtitle: ['Evidence from fieldwork'] }, file);
    addDoi('right:subtitle-dropped-long', 'accept', TEXT_SHAPES.apa(w), { ...w.record, subtitle: [LONG_SUB] }, file);
    const variant = oneWordVariant(w.title);
    if (variant) addDoi('right:title-one-word-variant', 'accept', TEXT_SHAPES.apa({ ...w, title: variant }), w.record, `${file} "${variant}"`);
    const tw = w.title.split(' ');
    if (tw.length >= 4) {
      const cut = tw.slice(0, Math.max(2, Math.ceil(tw.length * 0.55))).join(' ');
      addDoi('right:title-truncated', 'accept', `${authorsApa} (${w.year}). ${cut}... ${w.journal}.`, w.record, file);
    }
    // ---- right DOI, no authors (the reference starts with the title); the author check has nothing to compare
    addDoi('right:no-authors', 'accept', `${w.title}. (${w.year}). ${w.journal}.`, w.record, file);
    // ---- right DOI, a corporate author on both sides
    addDoi('right:corporate-author', 'accept', `World Health Organization. (${w.year}). ${w.title}. ${w.journal}.`, { ...w.record, author: [{ name: 'World Health Organization' }] }, file);
    // ... and a group author written where Crossref lists the persons (same work by construction)
    addDoi('right:corporate-reference-person-record', 'accept', `Research Group. (${w.year}). ${w.title}. ${w.journal}.`, w.record, file);

    // ---- wrong DOI, decided ONLY by the author check: same title, same year, other authors
    const o = otherAuthorsWork(w, i % 3);
    const sameTitleOther = { ...w.record, DOI: `${w.doi}.same-title`, author: o.record.author };
    addDoi('wrong:same-title-other-authors', 'reject', TEXT_SHAPES.apa(w), sameTitleOther, file);
    addDoi('wrong:same-title-other-authors~vancouver', 'reject', TEXT_SHAPES.vancouver(w), sameTitleOther, file);
    addDoi('wrong:same-title-other-authors~given-first', 'reject', TEXT_SHAPES['given-first'](w), sameTitleOther, file);
    addDoi('wrong:same-title-other-authors~given-first-full', 'reject', `${gf.join(', ')} (${w.year}). ${w.title}. ${w.journal}.`, sameTitleOther, file);
    // ... also when the record lists one author in a script that cannot be compared (Han)
    const han = { family: '王', given: '伟' };
    addDoi('wrong:same-title-other-authors~mixed-script-record', 'reject', TEXT_SHAPES.apa(w), { ...sameTitleOther, author: [...(o.record.author ?? []).slice(0, 3), han] }, file);
    addDoi('right:mixed-script-record', 'accept', TEXT_SHAPES.apa(w), { ...w.record, author: [...(w.record.author ?? []), han] }, file);
    // ---- wrong DOI, the earlier negatives in other text shapes
    const other = WORKS[(i + 1) % WORKS.length].w;
    const otherWork = { ...w.record, DOI: `${w.doi}.other`, title: [other.title], subtitle: [], published: { 'date-parts': [[w.year + 1]] } };
    addDoi('wrong:same-author-adjacent-year~vancouver', 'reject', TEXT_SHAPES.vancouver(w), otherWork, file);
    addDoi('wrong:same-author-adjacent-year~given-first-full', 'reject', `${gf.join(', ')} (${w.year}). ${w.title}. ${w.journal}.`, otherWork, file);
    addDoi('wrong:other-authors~vancouver', 'reject', TEXT_SHAPES.vancouver(w), { ...other.record, published: { 'date-parts': [[w.year]] } }, file);
    addDoi('wrong:other-authors~given-first', 'reject', TEXT_SHAPES['given-first'](w), { ...other.record, published: { 'date-parts': [[w.year]] } }, file);
    addDoi('wrong:no-authors-other-work', 'reject', `${w.title}. (${w.year}). ${w.journal}.`, { ...other.record, published: { 'date-parts': [[w.year]] } }, file);
    addDoi('wrong:corporate-reference-person-record', 'reject', `Research Group. (${w.year}). ${w.title}. ${w.journal}.`, { ...other.record, published: { 'date-parts': [[w.year]] } }, file);
    addDoi('wrong:corporate-other-work', 'reject', `World Health Organization. (${w.year}). ${w.title}. ${w.journal}.`, { ...other.record, published: { 'date-parts': [[w.year]] }, author: [{ name: 'World Health Organization' }] }, file);

    // ---- dedup: shorter author lists of the same work
    if (w.authors.length >= 2) {
      addDedup('same:first-author-only', 'same', dedupRef('a', w, apa), dedupRef('b', w, apa.slice(0, 1)), file);
      addDedup('same:et-al-string', 'same', dedupRef('a', w, apa), dedupRef('b', w, [`${apa[0]}, et al.`]), file);
      addDedup('same:et-al-string', 'same', dedupRef('a', w, AUTHOR_SHAPES.vancouver(w)), dedupRef('b', w, [`${w.authors.slice(0, 2).map(vancouverName).join(', ')}, et al.`]), file);
      addDedup('same:et-al-element', 'same', dedupRef('a', w, apa), dedupRef('b', w, [apa[0], 'et al.']), file);
    }
    // ---- dedup: surname first, full given name and initial, no comma ("Smith John A.")
    if (w.authors.some((a) => /\p{Ll}/u.test(a.given))) {
      const sg = w.authors.map((a) => (a.given ? `${a.family} ${a.given}` : a.family));
      addDedup('same:surname-full-given', 'same', dedupRef('a', w, sg), dedupRef('b', w, AUTHOR_SHAPES.vancouver(w)), file);
      addDedup('same:surname-full-given', 'same', dedupRef('a', w, sg), dedupRef('b', w, AUTHOR_SHAPES['folded-initials'](w)), file);
    }
    // ---- dedup: DOI written with a landing-page tail or a query, the title shortened (the DOI decides)
    const short = w.title.split(' ').slice(0, 3).join(' ');
    for (const tail of ['/full', '/pdf', '/abstract', '?download=true']) {
      addDedup('same:doi-tail', 'same', dedupRef('a', w, apa, { doi: w.doi }), dedupRef('b', w, AUTHOR_SHAPES.vancouver(w), { normalized_title: short, doi: `https://doi.org/${w.doi}${tail}` }), `${file} ${tail}`);
    }
    // ---- dedup: same DOI, metadata of another work (authors AND title differ): owner default, not merged
    const contra = otherAuthorsWork(w, 1 + (i % 3));
    addDedup('owner:same-doi-contradicted', 'different', dedupRef('a', w, apa, { doi: w.doi }), dedupRef('b', contra, AUTHOR_SHAPES.apa(contra), { doi: w.doi, normalized_year: String(w.year) }), file);
    // ... while the same DOI with only the title written differently stays one work
    addDedup('same:same-doi-other-title', 'same', dedupRef('a', w, apa, { doi: w.doi }), dedupRef('b', w, apa, { doi: w.doi, normalized_title: other.title }), file);
  });

  // ---- dedup: preprint versions (owner default: versions of one preprint are one work)
  WORKS.slice(0, 10).forEach(({ file, w }, i) => {
    const apa = AUTHOR_SHAPES.apa(w);
    addDedup('owner:preprint-versions', 'same', dedupRef('a', w, apa, { doi: `10.1101/12345${i}` }), dedupRef('b', w, apa, { doi: `10.1101/12345${i}v2` }), `${file} bioRxiv`);
    addDedup('owner:preprint-versions', 'same', dedupRef('a', w, apa, { doi: `10.6084/m9.figshare.98765${i}.v1` }), dedupRef('b', w, apa, { doi: `10.6084/m9.figshare.98765${i}.v2` }), `${file} figshare`);
  });

  // ---- dedup: corporate author, mixed-script list
  WORKS.slice(0, 8).forEach(({ file, w }) => {
    addDedup('same:corporate-author', 'same', dedupRef('a', w, ['World Health Organization']), dedupRef('b', w, ['world health organization']), file);
  });
  for (const file of Object.keys(CYRILLIC)) {
    const { latin, cyr } = cyrillicWork(file);
    const mixed = latin.authors.map((a, k) => (k % 2 === 0 ? cyr.authors[k] : a));
    addDedup('same:mixed-script-list', 'same', dedupRef('a', latin, AUTHOR_SHAPES.apa(latin)), dedupRef('b', latin, mixed.map(apaName)), file);
    addDoi('right:mixed-script-list', 'accept', TEXT_SHAPES.apa({ ...latin, authors: mixed }), latin.record, file);
  }

  // ---- dedup: names one letter apart (owner rule: a conflicting initial or given name is another author)
  const w0 = WORKS[0].w;
  const one = (cls, label, a, b) => addDedup(cls, label, dedupRef('a', w0, [a]), dedupRef('b', w0, [b]), `${a} / ${b}`);
  for (const [a, b] of [["O'Brien, K.", 'o brien z'], ["O'Connor, J.", 'o connor k'], ["D'Angelo, M.", 'd angelo n'], ["O'Brien, K.", "O'Brien, Z."]]) one('owner:apostrophe-conflict', 'different', a, b);
  for (const [a, b] of [["O'Brien, K.", 'o brien k'], ["O'Connor, J.", 'oconnor j'], ["D'Angelo, M.", 'd angelo m'], ["O'Brien, K.", 'OBrien K']]) one('same:apostrophe-written-two-ways', 'same', a, b);
  for (const [a, b] of [['Maria Garcia', 'Mario Garcia'], ['Wang Li', 'Wang Lin'], ['John Smith', 'Jon Smith'], ['Anna Mueller', 'Anne Mueller']]) one('owner:given-first-one-letter', 'different', a, b);
  for (const [a, b] of [['Maria Garcia', 'Garcia, M.'], ['John Smith', 'Smith, J.'], ['Smith JA', 'Smith John A.'], ['smith j a', 'Smith John A.'], ['Smith, John A.', 'Smith John A.']]) one('same:full-given-forms', 'same', a, b);

  // ---- right DOI: short titles written another accepted way
  WORKS.slice(0, 8).forEach(({ file, w }, i) => {
    const [title, written] = SHORT_TITLES[i % SHORT_TITLES.length];
    addDoi('right:short-title-variant', 'accept', TEXT_SHAPES.apa({ ...w, title: written }), { ...w.record, title: [title], subtitle: [] }, `${file} "${written}"`);
  });

  // ---- right DOI: the given-first full names of one record with a middle initial (the reviewer's case)
  {
    const w = WORKS.find((x) => x.file === 'retracted-plain-title.json').w;
    addDoi('right:given-first-full', 'accept', `Michael J. LaCour, Donald P. Green (${w.year}). ${w.title}. ${w.journal}.`, w.record, 'retracted-plain-title.json written out');
    addDoi('right:given-first-full-and', 'accept', `LaCour, Michael J., and Donald P. Green. ${w.year}. ${w.title}. ${w.journal}.`, w.record, 'retracted-plain-title.json Chicago');
  }
}

// ------------------------------------------------------------------ shapes added in review round 12
// One author, written so the author section can be read two ways: Vancouver with one initial
// whose title starts like a name ("Hoddy K. Sleep and memory ...", "Hoddy K. Diabetes, Obesity
// and ..."), and given-first with a middle initial and nothing after the surname ("Michael J.
// LaCour. Title."). The record is the reference's own author, title and year, so the right
// label is accept; the same text against a record with another author is reject.

/** Titles whose first word is capitalised and followed by "and", "&" or ", Capital". */
const NAME_LIKE_TITLES = [
  'Sleep and memory in older adults',
  'Diabetes, Obesity and cardiovascular risk in midlife',
  'Cancer, Heart disease and sleep quality',
  'Anxiety & attention in the classroom',
  'Trust and cooperation in repeated games',
];

function addRound12Rows(addDoi) {
  WORKS.slice(0, 10).forEach(({ file, w }, i) => {
    const first = w.authors[0];
    if (!first?.initials.length || !/\p{Ll}/u.test(first.family)) return;
    const title = NAME_LIKE_TITLES[i % NAME_LIKE_TITLES.length];
    const ini = first.initials[0];
    const record = { ...w.record, title: [title], subtitle: [], author: [{ family: first.family, given: `${ini}.` }] };
    const other = otherAuthorsWork(w, 0).authors[0];
    const otherRecord = { ...record, DOI: `${w.doi}.other-author`, author: [{ family: other.family, given: `${ini}.` }] };
    const vancouver = `${first.family} ${ini}. ${title}. ${w.journal}. ${w.year};1:1-9.`;
    addDoi('right:vancouver-one-author-name-like-title', 'accept', vancouver, record, `${file} "${title}"`);
    addDoi('wrong:vancouver-one-author-name-like-title', 'reject', vancouver, otherRecord, `${file} "${title}"`);
    const given = `Alex ${ini}. ${first.family}. ${title}. ${w.journal}. ${w.year}.`;
    const givenRecord = { ...record, author: [{ family: first.family, given: `Alex ${ini}.` }] };
    addDoi('right:given-first-one-author', 'accept', given, givenRecord, file);
    addDoi('wrong:given-first-one-author', 'reject', given, { ...givenRecord, DOI: `${w.doi}.other-author`, author: [{ family: other.family, given: `Alex ${ini}.` }] }, file);
    // ---- the cited author is Hoddy-like; the candidate record is by an author named like the
    // title's first word (same title and year): not the cited work, by construction
    const titleWordAuthor = { ...record, DOI: `${w.doi}.title-word-author`, author: [{ family: title.split(/[ ,&]/)[0], given: `${ini}.` }] };
    addDoi('wrong:vancouver-one-author-title-word-author', 'reject', vancouver, titleWordAuthor, `${file} "${title}"`);
    addDoi('wrong:vancouver-et-al-title-word-author', 'reject', `${first.family} ${ini}, et al. ${title}. ${w.journal}. ${w.year};1:1-9.`, titleWordAuthor, `${file} "${title}"`);
    addDoi('right:vancouver-et-al-name-like-title', 'accept', `${first.family} ${ini}, et al. ${title}. ${w.journal}. ${w.year};1:1-9.`, { ...record, author: [{ family: first.family, given: `${ini}.` }, { family: other.family, given: 'A.' }] }, `${file} "${title}"`);
  });

  // ---- given-first, one middle initial, then a surname of another shape: particles, two
  // words, more initials, a suffix, a bare year after it. The record is the written authors.
  const w = WORKS[0].w;
  const SHAPES = [
    ['particle', 'Michael J. van der Berg, Donald P. Green', ['van der Berg', 'Green']],
    ['particle', 'Michael J. de Rooij, Donald P. Green', ['de Rooij', 'Green']],
    ['particle', 'Michael J. de Rooij', ['de Rooij']],
    ['particle', 'Michael J. Van Dyke and Donald P. Green', ['Van Dyke', 'Green']],
    ['two-word-surname', 'Maria J. Garcia Marquez, Ana B. Lopez', ['Garcia Marquez', 'Lopez']],
    ['two-word-surname', 'Maria J. Garcia Marquez', ['Garcia Marquez']],
    ['more-initials', 'Alex J. K. Smith', ['Smith']],
    ['more-initials', 'Jordan B. K. Fishman and Eric A. Berg', ['Fishman', 'Berg']],
    ['suffix', 'Michael J. LaCour Jr', ['LaCour']],
  ];
  for (const [shape, names, families] of SHAPES) {
    const record = { ...w.record, title: [w.title], subtitle: [], author: families.map((f) => ({ family: f, given: 'X.' })) };
    const wrong = { ...record, DOI: `${w.doi}.other-author`, author: [{ family: 'Broockman', given: 'D.' }] };
    for (const text of [`${names} (${w.year}). ${w.title}. ${w.journal}.`, `${names}. ${w.title}. ${w.journal}. ${w.year}.`]) {
      addDoi(`right:given-first-one-initial-${shape}`, 'accept', text, record, names);
      addDoi(`wrong:given-first-one-initial-${shape}`, 'reject', text, wrong, names);
    }
  }
  addRound13Rows(addDoi);
  addRound14Rows(addDoi);
  addRound15Rows(addDoi);
  addRound16Rows(addDoi);
  addRound17Rows(addDoi);
  addRound18Rows(addDoi);
  addRound19Rows(addDoi);
  addRound20Rows(addDoi);
  addRound21Rows(addDoi);
  addRound22Rows(addDoi);
  {
    const record = { ...w.record, title: [w.title], subtitle: [], author: [{ family: 'LaCour', given: 'Michael J.' }] };
    const text = `Michael J. LaCour ${w.year}. ${w.title}. ${w.journal}.`;
    addDoi('right:given-first-one-initial-bare-year', 'accept', text, record, 'bare year');
    addDoi('wrong:given-first-one-initial-bare-year', 'reject', text, { ...record, DOI: `${w.doi}.other-author`, author: [{ family: 'Broockman', given: 'D.' }] }, 'bare year');
  }
}

// ------------------------------------------------------------------ shapes added in review round 13
// Vancouver entries with capitalised particles or two-word surnames, "et al" without a comma,
// "and others"; an author whose surname is a word of the title (writing about their own name);
// a record by an author named like any title word. Labels by construction: the record lists
// the written authors (accept) or only other authors (reject).
function addRound13Rows(addDoi) {
  const TITLE = 'Sleep and memory consolidation in older adults';
  const base = { ...WORKS[0].w.record, title: [TITLE], subtitle: [], published: { 'date-parts': [[2014]] } };
  const rec = (doi, fams) => ({ ...base, DOI: `${WORKS[0].w.doi}.r13-${doi}`, author: fams.map((f) => ({ family: f, given: 'X.' })) });
  const tail = `${TITLE}. J Sleep Res. 2014;1:1-9.`;
  const VANCOUVER = [
    ['two-word-surname', 'Garcia Marquez G', ['Garcia Marquez']],
    ['capital-particle', 'Van Dyke J', ['Van Dyke']],
    ['capital-particle', 'De la Cruz M', ['de la Cruz']],
    ['capital-particle', 'Le Roux P', ['Le Roux']],
    ['capital-particle', 'Van der Berg JH', ['van der Berg']],
  ];
  VANCOUVER.forEach(([shape, entry, fams], k) => {
    for (const [n, text] of [['one', `${entry}. ${tail}`], ['two', `${entry}, Smith A. ${tail}`]]) {
      const authors = n === 'one' ? fams : [...fams, 'Smith'];
      addDoi(`right:vancouver-${shape}`, 'accept', text, rec(`v${k}${n}`, authors), entry);
      addDoi(`wrong:vancouver-${shape}`, 'reject', text, rec(`v${k}${n}w`, ['Jones', 'Lee']), entry);
      addDoi(`wrong:vancouver-${shape}-title-word-author`, 'reject', text, rec(`v${k}${n}s`, ['Sleep']), entry);
    }
  });
  const ETAL = ['Hoddy K et al.', 'Hoddy KK et al.', 'Hoddy K, Gibbons C et al.', 'Hoddy K and others.', 'Hoddy K et al'];
  ETAL.forEach((lead, k) => {
    const text = `${lead} ${tail}`;
    addDoi('right:vancouver-et-al-no-comma', 'accept', text, rec(`e${k}`, ['Hoddy', 'Gibbons', 'Lee']), lead);
    addDoi('wrong:vancouver-et-al-no-comma', 'reject', text, rec(`e${k}w`, ['Smith', 'Lee']), lead);
    addDoi('wrong:vancouver-et-al-no-comma', 'reject', text, rec(`e${k}s`, ['Sleep', 'Lee']), lead);
  });
  // an author whose surname is a word of the title
  const own = [
    ['Darwin C. Darwin and the origin of species. J Hist Biol. 2014;1:1-9.', 'Darwin and the origin of species', ['Darwin']],
    ['Hoddy K. Hoddy and the origin of species. J Hist Biol. 2014;1:1-9.', 'Hoddy and the origin of species', ['Hoddy']],
    ['Charles R. Brown, Donald P. Green. Brown and the hidden costs of anger. J Sleep Res. 2014.', 'Brown and the hidden costs of anger', ['Brown', 'Green']],
    ['Charles R. Price, Donald P. Green. Price and the hidden costs of anger. J Sleep Res. 2014.', 'Price and the hidden costs of anger', ['Price', 'Green']],
  ];
  own.forEach(([text, title, fams], k) => {
    const r = { ...base, DOI: `${WORKS[0].w.doi}.r13-o${k}`, title: [title], author: fams.map((f) => ({ family: f, given: 'X.' })) };
    addDoi('right:own-name-in-title', 'accept', text, r, text.slice(0, 20));
    addDoi('wrong:own-name-in-title', 'reject', text, { ...r, DOI: `${r.DOI}w`, author: [{ family: 'Smith', given: 'X.' }] }, text.slice(0, 20));
  });
  // a record by an author named like a title word that is not the first one
  const later = [
    ['Hoddy K. Garcia Marquez and magic realism. J Lit. 2014.', 'Garcia Marquez and magic realism', 'Marquez'],
    ['Hoddy K. The Sleep and memory. J Sleep Res. 2014.', 'The Sleep and memory', 'Sleep'],
    ['Hoddy K. Sleep and memory in older adults. J Sleep Res. 2014;1:1-9.', 'Memory and sleep in older adults', 'Sleep'],
  ];
  later.forEach(([text, title, fam], k) => {
    const r = { ...base, DOI: `${WORKS[0].w.doi}.r13-l${k}`, title: [title], author: [{ family: fam, given: 'X.' }] };
    addDoi('wrong:title-word-author-later-word', 'reject', text, r, text.slice(0, 24));
  });
}

/**
 * Review round 14: author sections the readers did not read (dotted initials, suffixes,
 * "and" / "&" / ";" between Vancouver entries, three-word surnames), family-first full names
 * joined by "and", a given-first list whose every later surname is a title word, and a
 * given-first entry that runs on into the title.
 */
function addRound14Rows(addDoi) {
  const TITLE = 'Sleep and memory consolidation in older adults';
  const base = { ...WORKS[0].w.record, title: [TITLE], subtitle: [], published: { 'date-parts': [[2014]] } };
  const rec = (doi, fams, title = TITLE) => ({ ...base, title: [title], DOI: `${WORKS[0].w.doi}.r14-${doi}`, author: fams.map((f) => ({ family: f, given: 'X.' })) });
  const tail = `${TITLE}. J Sleep Res. 2014;1:1-9.`;
  const VANCOUVER = [
    ['dotted-initials', `Smith J.A., Jones B.C. ${tail}`, ['Smith', 'Jones']],
    ['dotted-initials', `Smith J.A. ${tail}`, ['Smith']],
    ['dotted-initials', `Smith J., Jones K. ${tail}`, ['Smith', 'Jones']],
    ['dotted-initials', `Smith J.A. (2014). ${TITLE}. J Sleep Res, 1, 1-9.`, ['Smith']],
    ['dotted-initials', `Smith J., Jones K. (2014). ${TITLE}. J Sleep Res, 1, 1-9.`, ['Smith', 'Jones']],
    ['suffix', `Smith JA Jr. ${tail}`, ['Smith']],
    ['suffix', `Smith JA 3rd, Jones BC. ${tail}`, ['Smith', 'Jones']],
    ['and-separator', `Smith JA and Jones BC. ${tail}`, ['Smith', 'Jones']],
    ['and-separator', `Smith JA & Jones BC. ${tail}`, ['Smith', 'Jones']],
    ['and-separator', `Smith J and Jones B (2014) ${TITLE}. J Sleep Res 1:1-9.`, ['Smith', 'Jones']],
    ['semicolon-separator', `Smith JA; Jones BC; Brown DE. ${tail}`, ['Smith', 'Jones', 'Brown']],
    ['semicolon-separator', `Smith JA; Jones BC; et al. ${tail}`, ['Smith', 'Jones', 'Lee']],
    ['three-word-surname', `Garcia Lopez Marquez G, Jones BC. ${tail}`, ['Garcia Lopez Marquez', 'Jones']],
    ['three-word-surname', `Garcia Lopez Marquez G. ${tail}`, ['Garcia Lopez Marquez']],
  ];
  VANCOUVER.forEach(([shape, text, fams], k) => {
    addDoi(`right:vancouver-r14-${shape}`, 'accept', text, rec(`v${k}`, fams), text.slice(0, 24));
    addDoi(`wrong:vancouver-r14-${shape}`, 'reject', text, rec(`v${k}w`, ['Okafor', 'Lee']), text.slice(0, 24));
    addDoi(`wrong:vancouver-r14-${shape}-title-word-author`, 'reject', text, rec(`v${k}s`, ['Sleep']), text.slice(0, 24));
  });
  // family-first full names: "Wang Xiaoming" is surname Wang
  const FAMILY_FIRST = [
    [`Wang Xiaoming and Li Hua. ${TITLE} (2014). J Sleep Res 1:1-9.`, ['Wang', 'Li']],
    [`Wang Xiaoming & Zhang Wei. ${TITLE} (2014). J Sleep Res 1:1-9.`, ['Wang', 'Zhang']],
    [`Wang Xiaoming, Li Hua, Zhang Wei. ${tail}`, ['Wang', 'Li', 'Zhang']],
  ];
  FAMILY_FIRST.forEach(([text, fams], k) => {
    addDoi('right:family-first-full-names', 'accept', text, rec(`f${k}`, fams), text.slice(0, 24));
    addDoi('wrong:family-first-full-names', 'reject', text, rec(`f${k}w`, ['Okafor']), text.slice(0, 24));
  });
  // a given-first list whose later surnames are all words of the title
  const LONG = 'Long memory in young adults';
  for (const [k, text] of [`Michael J. Young, Donald P. Long. ${LONG}. J Sleep Res. 2014;1:1-9.`, `Michael J. Young, Donald P. Long. ${LONG} (2014). J Sleep Res 1:1-9.`].entries()) {
    addDoi('right:given-first-surnames-title-words', 'accept', text, rec(`g${k}`, ['Young', 'Long'], LONG), text.slice(0, 24));
    addDoi('wrong:given-first-surnames-title-words', 'reject', text, rec(`g${k}w`, ['Okafor'], LONG), text.slice(0, 24));
  }
  // a capitalised title read as a second given-first entry ("Mood Disorders")
  const MOOD = 'Sleep and Mood Disorders in Older Adults';
  const mood = `Hoddy K. ${MOOD}. J Sleep Res. 2014;1:1-9.`;
  addDoi('right:vancouver-one-author-title-case', 'accept', mood, rec('m0', ['Hoddy'], MOOD), 'Hoddy K.');
  addDoi('wrong:vancouver-one-author-title-case', 'reject', mood, rec('m0s', ['Sleep'], MOOD), 'Hoddy K.');
  addDoi('wrong:vancouver-one-author-title-case', 'reject', mood, rec('m0d', ['Disorders'], MOOD), 'Hoddy K.');
  // an entry with no period before the title runs on into it
  const run = `Smith J ${TITLE} (2014). J Sleep Res 1:1-9.`;
  addDoi('right:entry-runs-into-title', 'accept', run, rec('r0', ['Smith']), 'Smith J');
  addDoi('wrong:entry-runs-into-title', 'reject', run, rec('r0s', ['Sleep']), 'Smith J');
  addDoi('wrong:entry-runs-into-title', 'reject', run, rec('r0w', ['Okafor']), 'Smith J');
}

/**
 * Review round 15: author entries that run into the title with no period (read as no author),
 * the first given name of a given-first list read as a Vancouver surname, a family-first
 * surname repeated in the title, and given-first entries that run into a title starting with
 * a surname-like word.
 */
function addRound15Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const rec = (doi, fams, title) => ({ ...base, title: [title], DOI: `${WORKS[0].w.doi}.r15-${doi}`, author: fams.map((f) => ({ family: f, given: 'X.' })) });
  const SD = 'Sleep deprivation affects memory';
  const runIn = [
    `Smith J ${SD} (2014). J Sleep Res 1:1-9.`,
    `Smith J: ${SD} (2014). J Sleep Res 1:1-9.`,
    `Smith J "${SD}" (2014). J Sleep Res 1:1-9.`,
    `Smith JA ${SD}. J Sleep Res. 2014;1:1-9.`,
    `Smith JA Jr ${SD}. J Sleep Res. 2014;1:1-9.`,
  ];
  runIn.forEach((text, k) => {
    addDoi('right:vancouver-runs-into-title', 'accept', text, rec(`a${k}`, ['Smith'], SD), text.slice(0, 16));
    addDoi('wrong:vancouver-runs-into-title', 'reject', text, rec(`a${k}w`, ['Jones'], SD), text.slice(0, 16));
  });
  const SM = 'Sleep and memory in older adults';
  const lists = [
    [`Hope A. Nakamura, Will D. Long. ${SM} (2014). J Sleep Res 1:1-9.`, ['Nakamura', 'Long'], 'Hope'],
    [`Mark A. Baker, Craig B. Smith, Mary C. Jones. ${SM}. J Sleep Res. 2014;1:1-9.`, ['Baker', 'Smith', 'Jones'], 'Mark'],
    [`Grace B. Okafor, Dean C. Ross. ${SM}. J Sleep Res. 2014;1:1-9.`, ['Okafor', 'Ross'], 'Grace'],
  ];
  lists.forEach(([text, fams, given], k) => {
    addDoi('right:given-first-list-given-name', 'accept', text, rec(`g${k}`, fams, SM), text.slice(0, 16));
    addDoi('wrong:given-first-list-given-name', 'reject', text, rec(`g${k}w`, [given], SM), text.slice(0, 16));
  });
  const familyFirst = [
    ['Wang Xiaoming and Li Hua. Wang and the new methods of sampling. J Sleep Res. 2014;1:1-9.', 'Wang and the new methods of sampling', ['Wang', 'Li']],
    ['Kim Minjun and Park Jiho. Kim effects in memory research. J Sleep Res. 2014.', 'Kim effects in memory research', ['Kim', 'Park']],
  ];
  familyFirst.forEach(([text, title, fams], k) => {
    addDoi('right:family-first-name-in-title', 'accept', text, rec(`f${k}`, fams, title), text.slice(0, 16));
    addDoi('wrong:family-first-name-in-title', 'reject', text, rec(`f${k}w`, ['Okafor'], title), text.slice(0, 16));
  });
  const SJ = 'Smith and Jones revisited: a replication';
  const YO = 'Young and old adults in the lab';
  const titleRepeats = [
    [`Young K ${SJ}. J Sleep Res. 2014;1:1-9.`, SJ, ['Young'], 'Smith'],
    [`Smith J: ${SJ}. J Sleep Res. 2014.`, SJ, ['Smith'], 'Okafor'],
    [`Smith JA Jr ${SJ}. J Sleep Res. 2014;1:1-9.`, SJ, ['Smith'], 'Okafor'],
    [`J. A. Smith, ${SJ}. J Sleep Res. 2014.`, SJ, ['Smith'], 'Okafor'],
    [`Wang Xiaoming ${SJ}. J Sleep Res. 2014;1:1-9.`, SJ, ['Wang'], 'Smith'],
    [`Michael J. Young, Donald P. Long ${YO}. J Sleep Res. 2014;1:1-9.`, YO, ['Young', 'Long'], 'Okafor'],
    [`Michael J. Young, Donald P. Long: ${YO}. J Sleep Res. 2014.`, YO, ['Young', 'Long'], 'Okafor'],
  ];
  titleRepeats.forEach(([text, title, fams, other], k) => {
    addDoi('right:entry-runs-into-name-title', 'accept', text, rec(`t${k}`, fams, title), text.slice(0, 16));
    addDoi('wrong:entry-runs-into-name-title', 'reject', text, rec(`t${k}w`, [other], title), text.slice(0, 16));
  });
}

/**
 * Review round 16: accented surnames without a comma ("GARCÍA J", "Dvořák P") were cut at the
 * accent ("Garc"), and family-first names with a lower-case particle ("de Vries Jan") were
 * read as one surname that matched no record.
 */
function addRound16Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const rec = (doi, fams, title) => ({ ...base, title: [title], DOI: `${WORKS[0].w.doi}.r16-${doi}`, author: fams.map((f) => ({ family: f, given: 'X.' })) });
  const SD = 'Sleep deprivation affects memory';
  const rows = [
    [`GARCÍA J (2014). ${SD}. J Sleep Res.`, ['García']],
    [`GARCÍA J, SMITH B (2014). ${SD}. J Sleep Res.`, ['García', 'Smith']],
    [`García J ${SD}. J Sleep Res. 2014.`, ['García']],
    [`MUÑOZ A, JONES J (2014). ${SD}. J Sleep Res.`, ['Muñoz', 'Jones']],
    [`Dvořák P ${SD}. J Sleep Res. 2014.`, ['Dvořák']],
    [`Schäfer K: ${SD}. J Sleep Res. 2014.`, ['Schäfer']],
    [`de Vries Jan (2014). ${SD}. J Sleep Res.`, ['de Vries']],
    [`von Neumann John (2014). ${SD}. J Sleep Res.`, ['von Neumann']],
    [`van der Berg Jan (2014). ${SD}. J Sleep Res.`, ['van der Berg']],
    [`de Vries Jan and Smith John (2014). ${SD}. J Sleep Res.`, ['de Vries', 'Smith']],
  ];
  rows.forEach(([text, fams], k) => {
    const shape = /^[a-z]/.test(text) ? 'lowercase-particle-family-first' : 'accented-surname';
    addDoi(`right:${shape}`, 'accept', text, rec(`a${k}`, fams, SD), text.slice(0, 16));
    addDoi(`wrong:${shape}`, 'reject', text, rec(`a${k}w`, ['Okafor'], SD), text.slice(0, 16));
  });
}

/**
 * Review round 17: a wrong record whose author's family name is a given name of a cited author
 * ("Mark Little, Grace Collins" and a record by Zoe Mark), with the cited title and year, was
 * accepted: the entry reads family first or given first. The record's given name now decides
 * where the order is ambiguous; records of the cited authors carry their real given names.
 */
function addRound17Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const SD = 'Sleep deprivation affects memory';
  const rec = (doi, people) => ({ ...base, title: [SD], DOI: `${WORKS[0].w.doi}.r17-${doi}`, author: people.map(([family, given]) => ({ family, given })) });
  const collisions = [
    [`Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, [['Little', 'Mark'], ['Collins', 'Grace']], 'Mark'],
    [`Little Mark & Collins Grace 2014. ${SD}. J Sleep Res.`, [['Little', 'Mark'], ['Collins', 'Grace']], 'Mark'],
    [`Michael J. Young, Donald Long (2014). ${SD}. J Sleep Res.`, [['Young', 'Michael J.'], ['Long', 'Donald']], 'Michael'],
    [`Wells Kate, Rowe Hope (2014). ${SD}. J Sleep Res.`, [['Wells', 'Kate'], ['Rowe', 'Hope']], 'Hope'],
    [`Min-jun Kim, Dean Martin: ${SD}. J Sleep Res. 2014.`, [['Kim', 'Min-jun'], ['Martin', 'Dean']], 'Min-jun'],
    [`Sean O'Brien, Daisy Hoddy (2014). ${SD}. J Sleep Res.`, [["O'Brien", 'Sean'], ['Hoddy', 'Daisy']], 'Sean'],
    [`Hoddy Daisy and Little Mark (2014). ${SD}. J Sleep Res.`, [['Hoddy', 'Daisy'], ['Little', 'Mark']], 'Mark'],
  ];
  collisions.forEach(([text, people, given], k) => {
    addDoi('right:given-name-collision', 'accept', text, rec(`c${k}`, people), text.slice(0, 16));
    addDoi('wrong:given-name-collision', 'reject', text, rec(`c${k}w`, [[given, 'Zoe']]), text.slice(0, 16));
  });
  // The order is ambiguous, and the record's given name agrees with the citation: accepted.
  const agrees = [
    [`Hoddy K. ${SD}. J Sleep Res. 2014;1:1-9.`, [['Hoddy', 'Karen']]],
    [`Smith J ${SD} (2014). J Sleep Res 1:1-9.`, [['Smith', 'John A.']]],
    [`Wang Xiaoming and Li Hua (2014). ${SD}. J Sleep Res.`, [['Wang', 'Xiao-Ming'], ['Li', 'Hua']]],
    [`J. Michael Smith (2014). ${SD}. J Sleep Res.`, [['Smith', 'John Michael']]],
    [`Michael Smith (2014). ${SD}. J Sleep Res.`, [['Smith', 'J. Michael']]],
  ];
  agrees.forEach(([text, people], k) => addDoi('right:ambiguous-order-given-agrees', 'accept', text, rec(`g${k}`, people), text.slice(0, 16)));
}

/**
 * Review round 18: the given-name check of round 17 rejected the right record when the entry was
 * longer than the words it looked at, when the family name also stood in another entry ("Mark
 * Little and Zoe Mark"), or when the record spells the given name another way ("Yulia" /
 * "Julia"); a record with family "R" and a given name in capitals was not read as "R" filed for
 * an initial.
 */
function addRound18Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const SD = 'Sleep deprivation affects memory';
  const rec = (doi, people) => ({ ...base, title: [SD], DOI: `${WORKS[0].w.doi}.r18-${doi}`, author: people.map(([family, given]) => ({ family, given })) });
  const rows = [
    [`Kiran Shakthi R (2014). ${SD}. J Sleep Res.`, [['R', 'SHAKTHI KIRAN']]],
    [`Gomez Maria Jose Luz Elena Hernandez (2014). ${SD}. J Sleep Res.`, [['Gomez', 'Hernandez']]],
    [`Mark Little and Zoe Mark (2014). ${SD}. J Sleep Res.`, [['Mark', 'Zoe']]],
    [`Julia Smirnova (2014). ${SD}. J Sleep Res.`, [['Smirnova', 'Yulia']]],
    [`Jorge Alvarez and Ana Ruiz (2014). ${SD}. J Sleep Res.`, [['Alvarez', 'George'], ['Ruiz', 'Ana']]],
  ];
  rows.forEach(([text, people], k) => {
    addDoi('right:given-check-scope', 'accept', text, rec(`s${k}`, people), text.slice(0, 16));
    addDoi('wrong:given-check-scope', 'reject', text, rec(`s${k}w`, [['Okafor', 'Zoe']]), text.slice(0, 16));
  });
}

// ------------------------------------------------------------------ shapes added in review round 19
// The given-name check took a second surname or a suffix for a given name, and the whole-word
// compare missed initials or particles written joined to the surname. Labels by construction:
// the record lists the cited author (accept) or only another author (reject).
function addRound19Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const SD = 'Sleep deprivation affects memory';
  const rec = (doi, people) => ({ ...base, title: [SD], DOI: `${WORKS[0].w.doi}.r19-${doi}`, author: people.map(([family, given]) => ({ family, given })) });
  const rows = [
    ['second-surname', `Hernandez Ruiz (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria']]],
    ['generational-suffix', `Smith Jr (2014). ${SD}. J Sleep Res.`, [['Smith', 'Robert']]],
    ['generational-suffix', `Smith Jr. (2014). ${SD}. J Sleep Res.`, [['Smith', 'Robert']]],
    ['glued-initials', `SmithJA, Jones KL (2014). ${SD}. J Sleep Res.`, [['Smith', 'John A'], ['Jones', 'K']]],
    ['glued-particle', `Jong, A. (2014). ${SD}. J Sleep Res.`, [['DeJong', 'A']]],
    ['glued-particle', `Berg, A. (2014). ${SD}. J Sleep Res.`, [['VanDerBerg', 'A']]],
    ['glued-particle-reference', `DeJong, P. (2014). ${SD}. J Sleep Res.`, [['Jong', 'P.']]],
    ['glued-particle-reference', `VanDerBerg, J. (2014). ${SD}. J Sleep Res.`, [['Berg', 'J.']]],
    ['glued-initials-inner-capital', `McDonaldJA (2014). ${SD}. J Sleep Res.`, [['McDonald', 'James A.']]],
    ['glued-initials-inner-capital', `VanDerBergJ (2014). ${SD}. J Sleep Res.`, [['Berg', 'J.']]],
    ['glued-initials-inner-capital', `Smith-JonesJA (2014). ${SD}. J Sleep Res.`, [['Smith-Jones', 'J. A.']]],
  ];
  rows.forEach(([shape, text, people], k) => {
    addDoi(`right:${shape}`, 'accept', text, rec(`s${k}`, people), text.slice(0, 16));
    addDoi(`wrong:${shape}`, 'reject', text, rec(`s${k}w`, [['Okafor', 'Zoe']]), text.slice(0, 16));
  });
  // "Mac" belongs to the surname: a record by MacDonald is not one by Donald.
  addDoi('wrong:glued-particle', 'reject', `Donald, A. (2014). ${SD}. J Sleep Res.`, rec('mac', [['MacDonald', 'A']]), 'Donald, A.');
}

// ------------------------------------------------------------------ shapes added in review round 20
// A sole double surname followed by "et al." / "and others", a list of double surnames with no
// given names, and a given name in an older romanisation. Labels by construction: the record
// lists the cited authors (accept) or only another author (reject).
function addRound20Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const SD = 'Sleep deprivation affects memory';
  const rec = (doi, people) => ({ ...base, title: [SD], DOI: `${WORKS[0].w.doi}.r20-${doi}`, author: people.map(([family, given]) => ({ family, given })) });
  const rows = [
    ['second-surname-et-al', `Hernandez Ruiz et al. (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria'], ['Lopez', 'Juan']]],
    ['second-surname-et-al', `Hernandez Ruiz and others (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria']]],
    ['family-first-surname-list', `Hernandez Ruiz and Lopez Garcia (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria'], ['Lopez', 'Ana']]],
    ['family-first-surname-list', `Hernandez Ruiz & Lopez Garcia (2014). ${SD}. J Sleep Res.`, [['Hernandez', 'Maria'], ['Lopez', 'Ana']]],
    ['older-romanisation', `Wang Hsiao-Ming and Li Hua (2014). ${SD}. J Sleep Res.`, [['Wang', 'Xiaoming'], ['Li', 'Hua']]],
  ];
  rows.forEach(([shape, text, people], k) => {
    addDoi(`right:${shape}`, 'accept', text, rec(`s${k}`, people), text.slice(0, 16));
    addDoi(`wrong:${shape}`, 'reject', text, rec(`s${k}w`, [['Okafor', 'Zoe']]), text.slice(0, 16));
  });
  // The collision the given-name check is for, in a list: still rejected.
  addDoi('wrong:given-name-collision-list', 'reject', `Mark Little and Grace Collins (2014). ${SD}. J Sleep Res.`, rec('c', [['Mark', 'Zoe']]), 'Mark Little and');
}

export const ROWS = buildRows();

/** The four error counts the gate reads. */
export const MEASURES = ['falseMerges', 'missedMerges', 'wrongAccepts', 'rightRejects'];

/**
 * Score every row against one build.
 * @param lib `{ calculateSimilarity, findDOIFromReference }` of the build under test
 * @param setSearchItems sets the Crossref search response to the given items (the simple
 *   text query must already fail, so the search is the only stage)
 */
export async function scoreRows(lib, setSearchItems) {
  const results = [];
  for (const row of ROWS.dedup) {
    const s = lib.calculateSimilarity(row.a, row.b, DEDUP_CONFIG);
    const merged = s >= DEDUP_CONFIG.threshold;
    results.push({ row, decision: merged ? 'same' : 'different', ok: (row.label === 'same') === merged, score: s });
  }
  for (const row of ROWS.doi) {
    setSearchItems([{ ...row.candidate, score: 90 }]);
    const r = await lib.findDOIFromReference(row.text);
    const accepted = r?.doi === row.candidate.DOI;
    results.push({ row, decision: accepted ? 'accept' : 'reject', ok: (row.label === 'accept') === accepted, result: r });
  }
  return results;
}

/** Per shape class: rows, false merges, missed merges, wrong accepts, right rejects. */
export function tally(results) {
  const byClass = {};
  for (const { row, decision } of results) {
    const t = (byClass[`${row.kind}/${row.cls}`] ??= { rows: 0, falseMerges: 0, missedMerges: 0, wrongAccepts: 0, rightRejects: 0 });
    t.rows += 1;
    if (row.kind === 'dedup' && row.label === 'different' && decision === 'same') t.falseMerges += 1;
    if (row.kind === 'dedup' && row.label === 'same' && decision === 'different') t.missedMerges += 1;
    if (row.kind === 'doi' && row.label === 'reject' && decision === 'accept') t.wrongAccepts += 1;
    if (row.kind === 'doi' && row.label === 'accept' && decision === 'reject') t.rightRejects += 1;
  }
  return byClass;
}

// ------------------------------------------------------------------ shapes added in review round 21
// Initials glued to a two-letter surname ("XuJ") or in front of it ("JSmith"), initials glued to
// the Crossref family ("SmithJA"), and a record title that repeats the family name next to a
// capitalised word with no parenthesised year. Labels by construction: same title and year, the
// family differs only by the glued initials. The wrong row is a record by authors whose family
// is only the first half of each cited double surname, written "Garcia Lopez, M.".
function addRound21Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const SD = 'Sleep deprivation affects memory';
  const rec = (doi, people, title = SD) => ({ ...base, title: [title], DOI: `${WORKS[0].w.doi}.r21-${doi}`, author: people.map(([family, given]) => ({ family, given })) });
  const rows = [
    ['two-letter-glued-initials', `XuJ (2014). ${SD}. J Sleep Res.`, [['Xu', 'Jie']], SD],
    ['two-letter-glued-initials', `LiJ, WuK (2014). ${SD}. J Sleep Res.`, [['Li', 'J'], ['Wu', 'K']], SD],
    ['leading-glued-initials', `JSmith (2014). ${SD}. J Sleep Res.`, [['Smith', 'J.']], SD],
    ['crossref-glued-initials', `Smith J. (2014). ${SD}. J Sleep Res.`, [['SmithJA', 'Jane']], SD],
    ['title-word-next-to-family', 'WangL. 2014. Wang Group Studies. J Sleep Res.', [['Wang', 'Lei']], 'Wang Group Studies'],
  ];
  rows.forEach(([shape, text, people, title], k) => {
    addDoi(`right:${shape}`, 'accept', text, rec(`s${k}`, people, title), text.slice(0, 16));
    addDoi(`wrong:${shape}`, 'reject', text, rec(`s${k}w`, [['Okafor', 'Zoe']], title), text.slice(0, 16));
  });
  addDoi('wrong:comma-double-surname-collision', 'reject', `Garcia Lopez, M., Rosa Diaz, A. (2014). ${SD}. J Sleep Res.`, rec('gl', [['Garcia', 'Ana'], ['Rosa', 'Luis']]), 'Garcia Lopez, M.');
}

// ------------------------------------------------------------------ shapes added in review round 22
// A sole double surname followed by a year with no parentheses (right record by construction:
// same title and year, the cited first surname is the record's family), a record title whose
// opening word is also a cited given name, and a comma list where two record families are both
// cited given names (wrong records: no cited surname is a record family).
function addRound22Rows(addDoi) {
  const base = { ...WORKS[0].w.record, subtitle: [], published: { 'date-parts': [[2014]] } };
  const SD = 'Sleep deprivation affects memory';
  const DA = 'Diabetes in adults';
  const rec = (doi, people, title = SD) => ({ ...base, title: [title], DOI: `${WORKS[0].w.doi}.r22-${doi}`, author: people.map(([family, given]) => ({ family, given })) });
  const rows = [
    ['sole-entry-bare-year', `Hernandez Ruiz, 2014, ${DA}, Nature 12`, [['Hernandez', 'Maria']], DA],
    ['sole-entry-bare-year', `Hernandez Ruiz 2014 ${DA}. Nature`, [['Hernandez', 'Maria']], DA],
  ];
  rows.forEach(([shape, text, people, title], k) => {
    addDoi(`right:${shape}`, 'accept', text, rec(`s${k}`, people, title), text.slice(0, 16));
    addDoi(`wrong:${shape}`, 'reject', text, rec(`s${k}w`, [['Okafor', 'Zoe']], title), text.slice(0, 16));
  });
  addDoi('wrong:title-opening-is-cited-given-name', 'reject', 'Hope Rowe, Anne Bell (2014). Hope. Nature.', rec('hope', [['Hope', 'Zoe']], 'Hope'), 'Hope Rowe, Anne');
  addDoi('wrong:comma-list-two-collisions', 'reject', `Mark Little, Grace Collins (2014). ${SD}. J Sleep Res.`, rec('mg', [['Mark', 'Zoe'], ['Grace', 'Quinn']]), 'Mark Little, Gra');
}
