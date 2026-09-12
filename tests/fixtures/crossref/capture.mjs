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
];

for (const [file, doi, why] of CASES) {
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: UA });
  if (res.status !== 200) throw new Error(`${doi} -> HTTP ${res.status}`);
  const body = await res.json();
  delete body.message.reference;
  delete body.message['reference-count'];
  body.__fixture = { doi, why, capturedAt: new Date().toISOString().slice(0, 10), note: 'Verbatim Crossref body; `reference` array stripped.' };
  await writeFile(join(HERE, file), JSON.stringify(body, null, 2) + '\n');
  console.log('captured', file, '<-', doi);
}
