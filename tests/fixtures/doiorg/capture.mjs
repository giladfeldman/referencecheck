/**
 * Record real doi.org HEAD responses for the short-DOI expansion tests.
 *
 * Run from the repo root:  node tests/fixtures/doiorg/capture.mjs
 *
 * These are recorded, not hand-built. A hand-built redirect fixture can only
 * tell you your fixture is wrong; it cannot tell you the rule is. Every case
 * below was chosen because it exercises a DIFFERENT branch of the expander,
 * and the two-sided controls (a bare `10`, an unregistered short form, and a
 * FULL DOI that redirects off doi.org) are what prove the rule discriminates.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

const CASES = {
  // Short forms that expand. All three are cited in real Scimeto documents.
  'short-ecin.json': '10/gt3vmw',
  'short-stroop.json': '10/b77m95',
  'short-science.json': '10/bdps',
  // Controls.
  'bare-10.json': '10',                      // genuinely malformed -> 400
  'short-unregistered.json': '10/zzzzzzzzzz',// well-formed, not registered -> 404
  'full-doi.json': '10.1111/1467-9280.00441',// canonical -> 302 OFF doi.org
  // The case that separates a correct parser from one that merely looks
  // correct on `10/gt3vmw`: this alias expands to a DOI whose suffix contains
  // parentheses, a colon, angle brackets AND TWO SLASHES. Anything that regexes
  // the suffix out of the Location instead of taking the path verbatim
  // truncates it at the first inner slash, and the truncated form 404s at
  // Crossref while the verbatim form returns 200.
  'short-exotic-suffix.json': '10/aabbe',
};

for (const [file, doi] of Object.entries(CASES)) {
  const r = await fetch('https://doi.org/' + encodeURI(doi), {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'referencecheck/capture (mailto:collaborativeopenscience@gmail.com)' },
  });
  const record = {
    recordedAt: new Date().toISOString(),
    request: { method: 'HEAD', url: 'https://doi.org/' + doi },
    status: r.status,
    headers: { location: r.headers.get('location') },
  };
  writeFileSync(join(DIR, file), JSON.stringify(record, null, 2) + '\n');
  console.log(file, record.status, record.headers.location ?? '');
}
