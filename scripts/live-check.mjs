#!/usr/bin/env node
/**
 * Live end-to-end check: the COMPILED library against the REAL APIs.
 *
 * Why this exists, and why the Jest suite is not a substitute. Every test in
 * `tests/` mocks the transport, which is correct -- a live suite cannot express
 * "and now Crossref rate-limits you", and offline determinism is what makes the
 * failure-mode tests possible. But a mock measures the mock. v0.1.3 shipped
 * retraction detection that read `message.update` while Crossref serves
 * `message['updated-by']`; the suite hard-coded the fictional field, stayed
 * green for a week, and the library could not detect any retraction whose title
 * did not literally begin "RETRACTED:".
 *
 * So this probe deliberately differs from the suite on all three axes that hid
 * that defect:
 *
 *   1. it runs against `dist/`, the artifact a consumer actually installs, not
 *      against TypeScript sources compiled on the fly by ts-jest;
 *   2. it talks to the live API, so a field name the library invented cannot
 *      pass; and
 *   3. its expectations come from the published record of each work, not from a
 *      fixture this repo controls.
 *
 * The DOIs are the same ones recorded under `tests/fixtures/crossref/`, so a
 * disagreement between this probe and the suite localises the problem: both red
 * is a library regression; this red and the suite green means the recorded
 * fixtures have drifted from what Crossref now serves.
 *
 * Exit codes are three-valued on purpose. A probe that cannot reach the network
 * must never report a pass -- and must not report a failure either, because
 * those are different claims and only one of them is about this library.
 *
 *   0  every case answered and matched
 *   1  at least one case answered and MISMATCHED  -> a real defect
 *   2  at least one case could not be checked     -> could-not-verify, not a pass
 *
 * Usage:  node scripts/live-check.mjs [--verbose]
 * Requires `npm run build` first: it imports `dist/`, never `src/`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'index.js');
const VERBOSE = process.argv.includes('--verbose');

if (!existsSync(DIST)) {
  console.error(`live-check: ${DIST} is missing. Run \`npm run build\` first.`);
  console.error('This probe checks the COMPILED artifact on purpose -- a pass from');
  console.error('src/ would not tell you what a consumer installs.');
  process.exit(2);
}

const lib = await import(pathToFileURL(DIST).href);

/**
 * The entry points this probe needs. A missing one is a FAIL, never a
 * could-not-verify: it means `dist/` is not the version it claims to be, or the
 * API was dropped. `npm ls` and `npm install --dry-run` both read the lockfile
 * and will happily name a version that is not on disk, so an export is the only
 * honest evidence of which build this is.
 */
const REQUIRED_EXPORTS = ['checkRetraction', 'expandShortDoi'];
const missingExports = REQUIRED_EXPORTS.filter((n) => typeof lib[n] !== 'function');
if (missingExports.length) {
  console.error('live-check: FAIL -- dist/ does not export: ' + missingExports.join(', '));
  console.error(`dist/ built from a version that predates them. Rebuild, or check out the`);
  console.error('release you meant to probe. This is a defect, not a network problem.');
  process.exit(1);
}

/** Polite-pool identity, so Crossref can attribute and throttle us fairly. */
const creds = { crossrefEmail: process.env.CROSSREF_EMAIL || undefined };

/**
 * Expectations come from the published record of each work -- the retraction
 * notice, the publisher's withdrawal statement -- and each case is documented in
 * the matching `tests/fixtures/crossref/*.json` under `__fixture.why`.
 */
const RETRACTION_CASES = [
  // --- pulled from the literature, title carries NO marker -------------------
  // The case the pre-v0.1.4 code could not see at all.
  { doi: '10.1126/science.1256151', retracted: true, type: 'retraction', note: 'LaCour & Green 2014; plain title' },
  { doi: '10.1538/expanim.54.1', retracted: true, type: 'retraction', note: 'second plain-titled retraction' },

  // --- pulled, title carries a marker ---------------------------------------
  { doi: '10.1016/S0140-6736(97)11096-0', retracted: true, type: 'retraction', note: 'Wakefield 1998; RETRACTED: prefix' },
  { doi: '10.3892/ol.2018.7943', retracted: true, type: 'retraction', note: 'Spandidos [Retracted]; EMPTY updated-by' },
  { doi: '10.1109/icaccs60874.2024.10717184', retracted: true, type: 'retraction', note: 'IEEE Retracted:; EMPTY updated-by' },

  // --- selection must use severity, never array position --------------------
  { doi: '10.1007/s11277-021-09072-0', retracted: true, type: 'retraction', note: 'two retraction entries' },
  { doi: '10.33552/ojdoh.2018.01.000503', retracted: true, type: 'retraction', note: 'partial_retraction listed first' },

  // --- pulled, but NOT a retraction: the word matters in a report ------------
  { doi: '10.1016/j.asr.2025.03.045', retracted: true, type: 'removal', note: 'Elsevier removal, after an erratum' },
  { doi: '10.1002/14651858.cd009522', retracted: true, type: 'withdrawal', note: 'withdrawn Cochrane review' },
  { doi: '10.31234/osf.io/etvnm_v1', retracted: true, type: 'withdrawal', note: 'withdrawn PsyArXiv preprint' },
  { doi: '10.1016/j.crad.2024.02.007', retracted: true, type: 'withdrawal', note: 'withdrawal alongside an erratum' },

  // --- the false-positive direction: a clean paper must come back CLEAN -----
  // A false positive tells an author a good reference is retracted. Meta-science
  // bibliographies are full of papers *about* retraction, and v0.1.3 flagged
  // 8 of 8 of them.
  { doi: '10.1038/nature12373', retracted: false, note: 'healthy paper, no updated-by' },
  { doi: '10.57656/sc-2025-0013', retracted: false, note: 'a paper ABOUT retraction; healthy' },
  { doi: '10.1126/science.aac6638', retracted: false, note: 'the retraction NOTICE itself; carries update-to' },
];

/** A Crossref 404 means "not a Crossref work", which is not "not retracted". */
const NOT_INDEXED_CASE = { doi: '10.5281/zenodo.3242591', note: 'Zenodo DOI; not a Crossref work' };

/** shortDOI aliases, and the canonical DOI each one resolves to. */
const SHORTDOI_CASES = [
  { short: '10/b77m95', canonical: '10.1037/H0054651', note: 'Stroop 1935' },
  { short: '10/gt3vmw', canonical: '10.1111/ECIN.13244', note: 'upper-cased publisher suffix' },
  { short: '10/zzzzzzzzzz', canonical: null, reason: 'not-registered', note: 'well-formed but unregistered' },
];

let matched = 0;
const mismatches = [];
const unchecked = [];

function report(label, ok, detail) {
  if (ok) {
    matched += 1;
    if (VERBOSE) console.log(`  ok    ${label} -- ${detail}`);
  } else {
    console.log(`  FAIL  ${label} -- ${detail}`);
  }
}

console.log('live-check: compiled dist/ against the live APIs\n');
console.log(`retraction: ${RETRACTION_CASES.length} cases`);

for (const c of RETRACTION_CASES) {
  let r;
  try {
    r = await lib.checkRetraction(c.doi, { creds });
  } catch (err) {
    unchecked.push(`${c.doi} threw: ${err?.message || err}`);
    console.log(`  ????  ${c.doi} -- threw ${err?.message || err}`);
    continue;
  }

  // `checked: false` means no source answered. That is could-not-verify, and
  // folding it into either column is the exact defect this library exists to
  // stop a consumer making one layer up.
  //
  // The field is `sourcesUnavailable`. The first draft of this probe read
  // `r.unavailable`, which is always undefined -- so it reported the Zenodo
  // case as a library defect when the library was right. That is v0.1.3's
  // failure reproduced in the checker instead of the code under test: reading
  // a field the source does not serve, and believing the empty answer.
  if (!r.checked) {
    const why = (r.sourcesUnavailable || []).map((u) => `${u.source}:${u.reason}`).join(',') || 'no source answered';
    unchecked.push(`${c.doi} unchecked (${why})`);
    console.log(`  ????  ${c.doi} -- could not check (${why})`);
    continue;
  }

  const okFlag = r.isRetracted === c.retracted;
  const okType = c.retracted ? r.retractionType === c.type : r.retractionType === undefined;
  const detail = `isRetracted=${r.isRetracted} type=${r.retractionType ?? '-'} expected=${c.retracted}/${c.type ?? '-'} (${c.note})`;
  report(c.doi, okFlag && okType, detail);
  if (!(okFlag && okType)) mismatches.push(`${c.doi}: ${detail}`);
}

console.log('\nnot_indexed: 1 case');
{
  const c = NOT_INDEXED_CASE;
  try {
    const r = await lib.checkRetraction(c.doi, { creds });
    const reasons = (r.sourcesUnavailable || []).map((u) => u.reason);
    const ok = r.checked === false && reasons.includes('not_indexed');
    const detail = `checked=${r.checked} reasons=[${reasons.join(',')}] expected checked=false + not_indexed (${c.note})`;
    report(c.doi, ok, detail);
    if (!ok) mismatches.push(`${c.doi}: ${detail}`);
  } catch (err) {
    unchecked.push(`${c.doi} threw: ${err?.message || err}`);
    console.log(`  ????  ${c.doi} -- threw ${err?.message || err}`);
  }
}

console.log(`\nshortDOI: ${SHORTDOI_CASES.length} cases`);
for (const c of SHORTDOI_CASES) {
  try {
    const r = await lib.expandShortDoi(c.short, { noCache: true });
    if (r.reason === 'network-error') {
      unchecked.push(`${c.short} network-error: ${r.error}`);
      console.log(`  ????  ${c.short} -- could not check (${r.error})`);
      continue;
    }
    const ok = c.canonical
      ? r.expanded === true && r.doi === c.canonical
      : r.expanded === false && r.reason === c.reason;
    const detail = `expanded=${r.expanded} doi=${r.doi ?? '-'} reason=${r.reason} expected=${c.canonical ?? c.reason} (${c.note})`;
    report(c.short, ok, detail);
    if (!ok) mismatches.push(`${c.short}: ${detail}`);
  } catch (err) {
    unchecked.push(`${c.short} threw: ${err?.message || err}`);
    console.log(`  ????  ${c.short} -- threw ${err?.message || err}`);
  }
}

const total = RETRACTION_CASES.length + 1 + SHORTDOI_CASES.length;
console.log('\n--- live-check summary ---');
console.log(`cases:      ${total}`);
console.log(`matched:    ${matched}`);
console.log(`mismatched: ${mismatches.length}`);
console.log(`unchecked:  ${unchecked.length}`);

// Control against a silently empty run: a probe that checked nothing must not
// exit 0. A green from an empty input is the failure mode whose summary line
// looks identical to a real pass.
if (matched === 0 && mismatches.length === 0) {
  console.error('\nlive-check: NOTHING was checked. Reporting could-not-verify, not a pass.');
  process.exit(2);
}

if (mismatches.length) {
  console.error('\nMISMATCHES (a real defect -- the live record disagrees with the library):');
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}
if (unchecked.length) {
  console.error('\nCOULD NOT VERIFY (not a pass):');
  for (const u of unchecked) console.error(`  - ${u}`);
  process.exit(2);
}
console.log('\nlive-check: PASS');
