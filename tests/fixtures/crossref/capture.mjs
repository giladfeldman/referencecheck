/**
 * Re-capture the Crossref fixtures in this directory from the LIVE API.
 *
 *   node tests/fixtures/crossref/capture.mjs
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
const UA = { 'User-Agent': 'referencecheck-fixture-capture/1.0 (mailto:giladfel@gmail.com)' };

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
];

for (const [file, doi, why] of CASES) {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: UA });
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
