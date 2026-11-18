/**
 * Re-capture the Europe PMC fixtures in this directory from the LIVE API:
 *
 *   node tests/fixtures/europepmc/capture.mjs
 *
 * Each fixture is the verbatim body of the search the expression-of-concern check
 * sends (`query=DOI:"<doi>"`, `resultType=core`), with `abstractText` removed: it is
 * article prose, and no code path under test reads it.
 *
 * Why recorded bodies (2026-11-18): the old check read `commentsCorrectionsList`
 * from a `resultType=lite` search. Europe PMC names the field `commentCorrectionList`
 * and serves it only with `resultType=core`, so the check could never fire; a
 * hand-built fixture written from the code's own assumptions would have stayed green.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = [
  ['eoc-in.json', '10.1371/journal.pone.0061107',
    'PLoS One paper with an expression of concern: commentCorrection type "Expression of concern in".'],
  ['no-eoc.json', '10.1038/nature12373',
    'Negative control: an indexed paper with no expression of concern.'],
  ['not-found.json', '10.9999/does-not-exist-2026',
    'A DOI Europe PMC holds no record for: an empty result list, a definitive "no record here".'],
];

for (const [file, doi, why] of CASES) {
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + new URLSearchParams({
    query: `DOI:"${doi}"`, format: 'json', pageSize: '1', resultType: 'core',
  });
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`${doi} -> HTTP ${res.status}`);
  const body = await res.json();
  for (const r of body.resultList?.result ?? []) {
    delete r.abstractText;
    // A comment/correction `reference` is a citation string; the fixture hygiene gate
    // forbids the key in every fixture, and the check reads only `type`, `source`, `id`.
    for (const c of r.commentCorrectionList?.commentCorrection ?? []) delete c.reference;
  }
  body.__fixture = { doi, why, capturedAt: new Date().toISOString().slice(0, 10), note: 'Verbatim Europe PMC search body; abstractText and commentCorrection.reference removed.' };
  await writeFile(join(HERE, file), JSON.stringify(body, null, 2) + '\n');
  console.log('captured', file, '<-', doi, 'hits', body.resultList?.result?.length,
    JSON.stringify(body.resultList?.result?.[0]?.commentCorrectionList?.commentCorrection?.map((c) => c.type) ?? null));
}
