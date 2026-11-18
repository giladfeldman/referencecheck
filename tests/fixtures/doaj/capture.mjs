/**
 * Re-capture the DOAJ fixtures in this directory from the LIVE API:
 *
 *   node tests/fixtures/doaj/capture.mjs
 *
 * Verbatim DOAJ v2 journal-search bodies. They record the fact the 0.3.0 fix rests on:
 * DOAJ finds a journal by its hyphenated ISSN and finds nothing for the same ISSN
 * without the hyphen. If that ever changes, the diff here is a finding about the API.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = { 'User-Agent': 'referencecheck-fixture-capture/1.0' };

/** [filename, query ISSN, why]. */
const CASES = [
  ['found-hyphenated.json', '1932-6203', 'PLOS ONE by its hyphenated ISSN: found.'],
  ['not-found-unhyphenated.json', '19326203', 'The same ISSN without the hyphen, as sent before 0.3.0: total 0.'],
];

for (const [file, issn, why] of CASES) {
  const res = await fetch(`https://doaj.org/api/v2/search/journals/issn:${issn}`, { headers: UA });
  if (res.status !== 200) throw new Error(`${issn} -> HTTP ${res.status}`);
  const body = await res.json();
  body.__fixture = { issn, why, capturedAt: new Date().toISOString().slice(0, 10), note: 'Verbatim DOAJ v2 body.' };
  await writeFile(join(HERE, file), JSON.stringify(body, null, 2) + '\n');
  console.log('captured', file, '<-', issn, 'total', body.total);
}
