/**
 * Re-capture the Crossref fixtures in this directory from the LIVE API.
 *
 *   $env:CROSSREF_MAILTO = "you@example.org"; node tests/fixtures/crossref/capture.mjs
 *
 * CROSSREF_MAILTO (required) is the contact address sent in the User-Agent so
 * Crossref routes the requests to its polite pool. It is read from the
 * environment and has no default, so no one's address is committed here; the
 * script refuses to run without it.
 *
 * These fixtures exist because the previous retraction tests were hand-built and
 * asserted a field Crossref does not serve (`message.update`), so the suite was
 * green over code that could never fire. A synthetic fixture cannot tell you the
 * rule is wrong, only that your fixture is — so every fixture here is a verbatim
 * Crossref response body, captured by this script, with only the `reference`
 * array removed (it is large, and no code path under test reads it).
 *
 * Re-run this if a test starts failing and you suspect Crossref changed shape.
 * A diff in `updated-by` is a real finding about the API, not a fixture to patch.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAILTO = process.env.CROSSREF_MAILTO?.trim();
if (!MAILTO) {
  console.error('CROSSREF_MAILTO is not set. Set it to your contact email for the Crossref polite pool, e.g.\n' +
    '  $env:CROSSREF_MAILTO = "you@example.org"; node tests/fixtures/crossref/capture.mjs');
  process.exit(1);
}
const UA = { 'User-Agent': `referencecheck-fixture-capture/1.0 (mailto:${MAILTO})` };

/** Each entry: [filename, DOI, why this case is in the corpus]. */
const CASES = [
  ['retracted-plain-title.json', '10.1126/science.1256151',
    'LaCour & Green 2014. Retracted, but the title contains no retraction marker — the case the title heuristic cannot see.'],
  ['retracted-caps-title.json', '10.1016/S0140-6736(97)11096-0',
    'Wakefield 1998. Retracted AND title prefixed "RETRACTED:" — the only case the old code caught.'],
  ['retracted-plain-title-2.json', '10.1538/expanim.54.1',
    'Second plain-titled retraction, so the corpus does not rest on one paper.'],
  ['not-retracted.json', '10.1038/nature12373',
    'Negative control: a healthy paper. Carries no `updated-by` at all.'],
  ['about-retraction-not-retracted.json', '10.57656/sc-2025-0013',
    'The false-positive control that matters for a meta-science tool: a HEALTHY paper whose title is "Retracted Publications in Indian Science". The old substring heuristic reports this as retracted.'],
  ['retraction-notice.json', '10.1126/science.aac6638',
    'The retraction NOTICE for LaCour. Carries `update-to`, not `updated-by` — proof that `update-to` points the other way and must never be read as "this DOI was retracted".'],

  // Added after the 2026-09-12 three-model review, which reproduced a false
  // clean or a false positive on every one of these against the live API.
  ['withdrawn-cochrane.json', '10.1002/14651858.cd009522',
    'A withdrawn Cochrane review. `updated-by` type is `withdrawal`, not `retraction`, and its label contains no "retract" — reported CLEAN before this.'],
  ['withdrawn-with-erratum.json', '10.1016/j.crad.2024.02.007',
    'A withdrawal alongside an erratum, so the selector must not be confused by a second entry.'],
  ['removed-elsevier.json', '10.1016/j.asr.2025.03.045',
    'Elsevier `removal`, listed AFTER an erratum — reported CLEAN before this.'],
  ['retracted-title-case.json', '10.1109/icaccs60874.2024.10717184',
    'IEEE "Retracted: Faux Reality Detector" with an EMPTY `updated-by`. The title is the only signal, and a case-sensitive ALL-CAPS rule misses it.'],
  ['retracted-bracketed.json', '10.3892/ol.2018.7943',
    'Spandidos "[Retracted] Pediatric sarcomas (Review)", also with an empty `updated-by`.'],
  ['withdrawn-preprint.json', '10.31234/osf.io/etvnm_v1',
    'A PsyArXiv preprint titled simply "WITHDRAWN". Flagged, but as a WITHDRAWAL — calling this "retracted" to a psychology author is a false claim.'],
  ['multi-update-severity.json', '10.33552/ojdoh.2018.01.000503',
    'Twelve update entries listing `partial_retraction` BEFORE `retraction`. Selection by array position reports the weaker verdict.'],
  ['multi-retraction-dates.json', '10.1007/s11277-021-09072-0',
    'Two `retraction` entries: a publisher notice dated 2021-09-11 and a Retraction Watch record dated 2022-12-06. The retraction happened on the earlier date.'],

  // Added 2026-11-18 (class sweep): expressions of concern. Crossref serves them only
  // in `updated-by` (type `expression_of_concern`); it has no EOC relation type.
  ['eoc-publisher.json', '10.1016/j.lungcan.2003.10.006',
    'Expression of concern recorded by the publisher, paper not retracted. Reported CLEAN before 0.3.0.'],
  ['eoc-two-sources.json', '10.1371/journal.pone.0061107',
    'Expression of concern recorded twice (publisher and Retraction Watch), paper not retracted.'],

  // Added 2026-11-18 (class sweep, second round): fields other checks read.
  ['corrected.json', '10.1088/1361-6595/aaebdb',
    'A corrected paper. Crossref serves the correction in `updated-by` (type `correction`); it has no `is-corrected-by` relation, which is what HAS_ERRATA read before 0.3.0.'],
  ['has-reply.json', '10.1162/99608f92.66fb00a2',
    'A paper with `has-reply` relations (and `is-comment-on`).'],
  ['is-reply-to.json', '10.5194/hess-2018-380-ac1',
    'An author comment carrying `is-reply-to`, which IS_RESPONSE read as `is-response-to` before 0.3.0.'],
  ['preprint-biorxiv.json', '10.1101/2020.03.22.002386',
    'A bioRxiv posted-content record: `institution` is an ARRAY ([{name}]), read as an object before 0.3.0.'],
  ['cshl-journal-article.json', '10.1101/pdb.prot099176',
    'A Cold Spring Harbor Protocols journal article under the bioRxiv prefix 10.1101, flagged as a preprint by the prefix heuristic before 0.3.0.'],
  // Added 2026-11-18 for retraction timing and retracted-and-replaced (v0.3.0).
  ['retracted-rw-jama.json', '10.1001/jama.2018.17933',
    'JAMA 2018, retracted 2019-10-08. Crossref carries a plain Retraction Watch `retraction` (no reason, no replacement link); a later JAMA article with a near-identical title exists (10.1001/jama.2019.11982), but neither Crossref nor Retraction Watch labels it a replacement.'],
  ['retracted-f1000-versions.json', '10.12688/f1000research.8114.1',
    'F1000Research v1, retracted, with `new_version` entries naming v2 and v3 — which were retracted too. Proof that `new_version` is not evidence of a corrected replacement.'],
  ['rr-title-carcin.json', '10.1093/carcin/bgs140',
    'OUP retract-and-replace whose OWN title reads "RETRACTED AND REPLACED:". Its `updated-by` is a plain Retraction Watch `retraction`.'],
  ['rr-notice-carcin.json', '10.1093/carcin/bgaf065',
    'Its notice, titled "Retraction and replacement of: ...".'],
  ['rr-plain-infdis.json', '10.1093/infdis/jiae178',
    'OUP retract-and-replace with a PLAIN title; only the notice title and the Retraction Watch reason say "replace".'],
  ['rr-notice-infdis.json', '10.1093/infdis/jiae358',
    'Its notice, titled "Retraction and replacement of: ...".'],
  ['rr-replacement-infdis.json', '10.1093/infdis/jiae357',
    'The replacement article the Retraction Watch notes link to (".../doi/10.1093/infdis/jiae357/7727684").'],
  ['jama-notice.json', '10.1001/jama.2019.11954',
    'The JAMA notice: "Notice of Retraction. ..." — no replacement wording.'],
];

/**
 * Crossref LABS bodies (api.labs.crossref.org), which add the Retraction Watch
 * block `cr-labs-updates` (reasons, notes). Crossref labels its keys unstable;
 * these fixtures pin the shape measured on the capture date.
 */
const LABS_CASES = [
  ['labs-rr-infdis.json', '10.1093/infdis/jiae178',
    'Reasons include "etract and Replace" (Labs cuts the first character of every reason); notes link the replacement.'],
  ['labs-empty-carcin.json', '10.1093/carcin/bgs140',
    'A retract-and-replace for which Labs serves an EMPTY block `{}` — proof that "no Labs record" is not "not replaced".'],
  ['labs-jama.json', '10.1001/jama.2018.17933',
    'A Retraction Watch record whose reasons do NOT include Retract and Replace.'],
];

// `node capture.mjs a.json b.json` (or ONLY=a.json,b.json) re-captures only those.
const ONLY_LIST = [...process.argv.slice(2), ...(process.env.ONLY ? process.env.ONLY.split(',') : [])];
const ONLY = ONLY_LIST.length ? new Set(ONLY_LIST) : null;
const ALL = [
  ...CASES.map(([f, d, w]) => [f, d, w, `https://api.crossref.org/works/${encodeURIComponent(d)}`]),
  ...LABS_CASES.map(([f, d, w]) => [f, d, w,
    `https://api.labs.crossref.org/works/${encodeURIComponent(d)}?mailto=${encodeURIComponent(MAILTO)}`]),
];
for (const [file, doi, why, url] of ALL) {
  if (ONLY && !ONLY.has(file)) continue;
  let res;
  // Crossref Labs answers 503 often (measured 2026-11-18): a few slow retries.
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, { headers: UA });
    if (res.status !== 503 && res.status !== 504) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (res.status !== 200) throw new Error(`${doi} -> HTTP ${res.status}`);
  const body = await res.json();
  // `reference` is large and no code path under test reads it. `abstract` is
  // ARTICLE PROSE, and a test fixture is no place to keep a copy of someone
  // else's published text — it is metadata we need, not content. Neither field
  // is read by the retraction checker, so stripping both costs nothing.
  delete body.message.reference;
  delete body.message['reference-count'];
  delete body.message.abstract;
  body.__fixture = { doi, why, capturedAt: new Date().toISOString().slice(0, 10), note: 'Verbatim Crossref body; `reference` array stripped.' };
  await writeFile(join(HERE, file), JSON.stringify(body, null, 2) + '\n');
  console.log('captured', file, '<-', doi);
}
