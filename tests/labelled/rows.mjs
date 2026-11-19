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

function buildRows() {
  const dedup = [];
  const doi = [];
  const addDedup = (cls, label, a, b, note) => dedup.push({ kind: 'dedup', cls, label, a, b, note });
  const addDoi = (cls, label, text, candidate, note) => doi.push({ kind: 'doi', cls, label, text, candidate, note });

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
