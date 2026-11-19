/**
 * Retraction timing must not depend on the machine's time zone.
 *
 * JavaScript reads "2019-01" as UTC midnight, which is still 2018 in Los
 * Angeles; a comparison that went through `Date` would move a boundary date
 * into the previous year there. The time zone is fixed when Node starts, so
 * setting `process.env.TZ` inside a running test does nothing (measured
 * 2026-11-19 on Windows: `new Date('2019-01').getFullYear()` stayed 2019).
 * This file therefore re-runs itself in a fresh Node per zone, and each child
 * first proves its zone is live (the control) before checking the library.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CHILD_ZONE = process.env.RC_TZ_CHILD;
const ZONES: Array<[string, number]> = [
  // [zone, the year `new Date('2019-01')` gives there]
  ['America/Los_Angeles', 2018],
  ['Pacific/Kiritimati', 2019],
  ['UTC', 2019],
];

if (!CHILD_ZONE) {
  const here = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(here), '..', '..');
  const jestBin = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js');

  // Jest reads the path as a pattern: backslashes would be regex escapes.
  describe('retraction timing under other time zones (one fresh Node per zone)', () => {
    it.each(ZONES)('TZ=%s', (zone) => {
      const run = spawnSync(
        process.execPath,
        ['--experimental-vm-modules', jestBin, '--runInBand', '--ci', path.relative(root, here).split(path.sep).join('/')],
        { cwd: root, env: { ...process.env, TZ: zone, RC_TZ_CHILD: zone }, encoding: 'utf8', windowsHide: true }
      );
      const out = `${run.stdout}\n${run.stderr}`;
      // A child that ran nothing must not pass: it has to report its tests.
      expect(out).toMatch(/Tests:\s+\d+ passed/);
      expect(run.status).toBe(0);
    }, 120000);
  });
} else {
  const mod: any = await import('../../src/retraction/retractionChecker.js');
  const cmp = (r: string, c: string) => mod.compareRetractionTiming(r, { date: c, source: 'caller' }).timing;

  describe(`in TZ=${CHILD_ZONE}`, () => {
    it('control: the zone is live in this process', () => {
      const expected = ZONES.find(([z]) => z === CHILD_ZONE)![1];
      expect(new Date('2019-01').getFullYear()).toBe(expected);
    });

    it.each([
      ['2019-01', '2018-12-31', 'after_citing'],
      ['2019', '2018-12', 'after_citing'],
      ['2020-01-01', '2019-12-31', 'after_citing'],
      ['2018-12-31', '2019-01', 'before_citing'],
      ['2019-01-01', '2018-12-31T23:30:00-08:00', 'after_citing'],
      ['2019-01-01', '2019', 'unknown'],
    ])('retraction %s vs citing %s -> %s', (r, c, expected) => {
      expect(cmp(r, c)).toBe(expected);
    });

    it('the sentence shows the dates as recorded, not shifted', () => {
      const s = mod.describeRetractionTiming(
        { timing: 'after_citing', retractionDate: '2019-01-01', citingPublishedDate: '2018-12-31' },
        'retraction'
      );
      expect(s).toContain('on 2019-01-01');
      expect(s).toContain('(2018-12-31)');
    });
  });
}
