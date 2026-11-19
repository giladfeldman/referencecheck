#!/usr/bin/env node
/**
 * Score the labelled release set (`tests/labelled/rows.mjs`) against a BUILT copy of the
 * library and print, per shape class, the four error counts the release gate reads:
 * false merges and missed merges (deduplication at the README configuration), wrong
 * accepts and right rejects (the DOI matcher, with Crossref mocked to return the row's
 * candidate record). No network: the Crossref requests are answered in-process.
 *
 *     npm run build && node scripts/labelled-report.mjs
 *     node scripts/labelled-report.mjs --lib <dir>/dist/index.js   # another build, e.g. 0.2.x
 *     node scripts/labelled-report.mjs --json out.json             # also write the counts
 *     node scripts/labelled-report.mjs --compare tests/labelled/baseline-0.2.x.json
 *     node scripts/labelled-report.mjs --halves    # also the totals on each half of the set
 *
 * `--compare` exits 1 when any class has more errors of any kind than the given counts, or
 * the total is not lower (the gate). The JSON holds counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROWS, MEASURES, scoreRows, tally } from '../tests/labelled/rows.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const libPath = path.resolve(opt('--lib') ?? path.join(ROOT, 'dist', 'index.js'));

/** The axios instance the build imports: resolved from the build's own directory upwards. */
function axiosFor(file) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', 'axios', 'index.js');
    if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    if (path.dirname(dir) === dir) throw new Error(`no node_modules/axios above ${file}`);
  }
}

const axios = (await import(pathToFileURL(axiosFor(libPath)).href)).default;
let items = [];
axios.post = async () => { throw new Error('simple text query disabled'); };
axios.get = async () => ({ status: 200, data: { message: { items } } });
axios.head = async () => ({ status: 404 });

const lib = await import(pathToFileURL(libPath).href);
const log = console.log;
const warn = console.warn;
console.log = () => {};
console.warn = () => {};
const results = await scoreRows(lib, (next) => { items = next; });
console.log = log;
console.warn = warn;

const byClass = tally(results);
const total = Object.fromEntries(MEASURES.map((m) => [m, 0]));
total.rows = 0;
for (const t of Object.values(byClass)) {
  total.rows += t.rows;
  for (const m of MEASURES) total[m] += t[m];
}

const pad = (s, n) => String(s).padEnd(n);
log(`library: ${path.relative(ROOT, libPath) || libPath}`);
log(`rows: ${ROWS.dedup.length} deduplication pairs, ${ROWS.doi.length} DOI candidates`);
log(`${pad('class', 56)}${pad('rows', 6)}${MEASURES.map((m) => pad(m, 14)).join('')}`);
for (const [cls, t] of Object.entries(byClass).sort()) log(`${pad(cls, 56)}${pad(t.rows, 6)}${MEASURES.map((m) => pad(t[m], 14)).join('')}`);
log(`${pad('TOTAL', 56)}${pad(total.rows, 6)}${MEASURES.map((m) => pad(total[m], 14)).join('')}`);

if (args.includes('--halves')) {
  // Every row carries a fixed half (`fit` / `gate`, a hash split in rows.mjs): a rule tuned
  // while looking at rows is judged on the half it was not tuned on.
  for (const half of ['fit', 'gate']) {
    const t = tally(results.filter((r) => r.row.half === half));
    const sum = Object.fromEntries(MEASURES.map((m) => [m, 0]));
    let rows = 0;
    for (const c of Object.values(t)) { rows += c.rows; for (const m of MEASURES) sum[m] += c[m]; }
    log(`${pad(`half ${half}`, 56)}${pad(rows, 6)}${MEASURES.map((m) => pad(sum[m], 14)).join('')}`);
  }
}

const out = { library: opt('--label') ?? path.relative(ROOT, libPath), classes: byClass, total };
if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(out, null, 2)}\n`);

if (opt('--compare')) {
  const base = JSON.parse(fs.readFileSync(opt('--compare'), 'utf8'));
  const worse = [];
  for (const [cls, t] of Object.entries(byClass)) {
    const b = base.classes[cls];
    if (!b) continue;
    for (const m of MEASURES) if (t[m] > b[m]) worse.push(`${cls} ${m}: ${b[m]} -> ${t[m]}`);
  }
  const errors = (x) => MEASURES.reduce((n, m) => n + x[m], 0);
  log(`errors: baseline ${errors(base.total)}, this build ${errors(total)}`);
  for (const w of worse) log(`WORSE ${w}`);
  if (worse.length > 0 || errors(total) >= errors(base.total)) process.exit(1);
}
