#!/usr/bin/env node
/**
 * Is OpenRetractions reachable again?
 *
 * `DEFAULT_RETRACTION_SOURCES` is `['crossref']` alone, because
 * `api.openretractions.com` stopped resolving (`EAI_AGAIN`, measured 2026-09-12
 * and re-measured independently the same day). The source is still implemented
 * and still opt-in via `{ sources: ['openretractions', 'crossref'] }`.
 *
 * The gap this closes: if the host comes back, the library silently keeps not
 * using it. Nothing fails, no test turns red, and default retraction detection
 * stays single-source forever on the strength of a measurement that has expired.
 * So a *successful* probe is a FAILURE here -- it is the signal to re-evaluate
 * the default source list.
 *
 * The control is the entire design. "openretractions does not resolve" and "this
 * machine has no DNS" produce the identical observation, and only the first one
 * licenses leaving the default list alone. So a live control host is resolved on
 * the same run: if the control fails too, the verdict is could-not-verify, never
 * a pass.
 *
 *   0  host still unreachable AND control reachable -> default list still correct
 *   1  host is REACHABLE -> re-evaluate DEFAULT_RETRACTION_SOURCES
 *   2  control unreachable -> could not verify (no network), not a pass
 *
 * Usage:  node scripts/openretractions-probe.mjs
 *   PROBE_HOST    override the host under test   (default api.openretractions.com)
 *   PROBE_CONTROL override the control host      (default api.crossref.org)
 */
import { lookup } from 'node:dns/promises';

const HOST = process.env.PROBE_HOST || 'api.openretractions.com';
const CONTROL = process.env.PROBE_CONTROL || 'api.crossref.org';

async function resolves(host) {
  try {
    const { address } = await lookup(host);
    return { ok: true, address };
  } catch (err) {
    return { ok: false, code: err.code || String(err) };
  }
}

console.log(`openretractions-probe: host=${HOST} control=${CONTROL}\n`);

const control = await resolves(CONTROL);
console.log(`control ${CONTROL}: ${control.ok ? `resolves ${control.address}` : `FAILS ${control.code}`}`);

if (!control.ok) {
  console.error('\nCOULD NOT VERIFY: the control host does not resolve either, so this');
  console.error('run cannot distinguish "OpenRetractions is down" from "no DNS here".');
  console.error('Re-run with working DNS. This is not a pass.');
  process.exit(2);
}

const target = await resolves(HOST);
console.log(`target  ${HOST}: ${target.ok ? `resolves ${target.address}` : `FAILS ${target.code}`}`);

if (!target.ok) {
  console.log('\nPASS: still unreachable while the control resolves, so');
  console.log("DEFAULT_RETRACTION_SOURCES = ['crossref'] remains correct.");
  process.exit(0);
}

// It resolved. Confirm it actually answers before raising the alarm -- a
// wildcard DNS record or a parked domain resolves without serving the API, and
// re-enabling a source on the strength of an A record would be a guess.
console.log('\nhost resolves -- checking whether it SERVES the API');
let served = 'no response';
try {
  const res = await fetch(`https://${HOST}/10.1126/science.1256151`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  const body = await res.text();
  served = `HTTP ${res.status}, ${body.length} B: ${body.slice(0, 200)}`;
} catch (err) {
  served = `request failed: ${err?.message || err}`;
}
console.log(`  ${served}`);

console.error(`\nFAIL: ${HOST} resolves again.`);
console.error('OpenRetractions was dropped from DEFAULT_RETRACTION_SOURCES only because');
console.error('it was unreachable. That measurement has now expired, so re-evaluate:');
console.error('  1. does it serve usable answers (see the response above)?');
console.error('  2. if yes, restore it to DEFAULT_RETRACTION_SOURCES so default');
console.error('     detection stops being single-source, and add a live case for it;');
console.error('  3. if no, update the note in src/retraction/retractionChecker.ts with');
console.error('     today\'s measurement, so the reason on file matches what is true.');
process.exit(1);
