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
 *   0  host unreachable, or resolving without serving the API (a parked domain,
 *      measured 2026-11-22), AND control reachable -> default list still correct
 *   1  host SERVES the API (a 200 JSON with a boolean `retracted`, or a JSON
 *      404) -> re-evaluate DEFAULT_RETRACTION_SOURCES
 *   2  control unreachable, or the host timed out or answered 5xx -> could not
 *      verify, not a pass
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
let api = false;
let unverified = null;
try {
  // The path the library calls (OPEN_RETRACTIONS_API in src/retraction/retractionChecker.ts).
  const res = await fetch(`https://${HOST}/doi/10.1126/science.1256151`, {
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json' },
  });
  const body = await res.text();
  served = `HTTP ${res.status}, ${body.length} B: ${body.slice(0, 200)}`;
  // The library takes a JSON object as the API's answer: a 200 with a boolean `retracted`, or a
  // 404 with a JSON body ("not in this index"). Either means the API is served.
  let json = null;
  try { json = JSON.parse(body); } catch { json = null; }
  const isObject = json !== null && typeof json === 'object' && !Array.isArray(json);
  api = (res.status === 200 && isObject && typeof json.retracted === 'boolean') || (res.status === 404 && isObject);
  // A 5xx may be the API, down for now: that settles nothing.
  if (!api && res.status >= 500) unverified = `HTTP ${res.status}`;
} catch (err) {
  const code = err?.cause?.code || err?.code || '';
  served = `request failed: ${err?.name || ''} ${err?.message || err} ${code}`.trim();
  // A TLS failure (measured 2026-11-23: ERR_SSL_TLSV1_UNRECOGNIZED_NAME, the parked domain has no
  // certificate for the name), a refused connection or an unknown name are positive signs that
  // nothing serves the API here. A timeout or any other failure is not: could not verify.
  if (!/^(?:ERR_SSL_|ERR_TLS_|ERR_CERT|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ECONNREFUSED$|ENOTFOUND$)/u.test(code)) {
    unverified = `request failed without a sign that no API is there (${`${err?.name || 'error'} ${code}`.trim()})`;
  }
}
console.log(`  ${served}`);

if (unverified) {
  console.error(`\nCOULD NOT VERIFY: ${unverified}. This is not a pass; re-run later.`);
  process.exit(2);
}

if (!api) {
  // Measured 2026-11-22: the name resolves to a parked domain (an HTML redirect to
  // /lander over HTTP, a TLS failure over HTTPS). That is not the API coming back.
  console.log(`\nPASS: ${HOST} resolves but does not serve the API (no JSON retraction`);
  console.log("answer), so DEFAULT_RETRACTION_SOURCES = ['crossref'] remains correct.");
  process.exit(0);
}

console.error(`\nFAIL: ${HOST} serves the API again.`);
console.error('OpenRetractions was dropped from DEFAULT_RETRACTION_SOURCES only because');
console.error('it was unreachable. That measurement has now expired, so re-evaluate:');
console.error('  1. does it serve usable answers (see the response above)?');
console.error('  2. if yes, restore it to DEFAULT_RETRACTION_SOURCES so default');
console.error('     detection stops being single-source, and add a live case for it;');
console.error('  3. if no, update the note in src/retraction/retractionChecker.ts with');
console.error('     today\'s measurement, so the reason on file matches what is true.');
process.exit(1);
