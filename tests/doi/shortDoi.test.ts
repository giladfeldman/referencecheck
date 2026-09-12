/**
 * Short-DOI expansion.
 *
 * Every HTTP payload below is a RECORDED doi.org response — see
 * `tests/fixtures/doiorg/capture.mjs` for how they were captured and why they
 * are not hand-built. A hand-built redirect can only tell you your fixture is
 * wrong; the exotic-suffix case below was found by re-measuring, not by
 * reasoning, and a hand-reconstructed version of that same suffix 404'd at
 * Crossref and nearly got reported as a Crossref gap.
 *
 * The two-sided controls are the point of this file. An expander that accepts
 * everything passes the three happy cases and fails all four controls:
 *
 *   bare `10`                  400 -> must stay unexpanded (9 production refs)
 *   an unregistered short form 404 -> must stay unexpanded
 *   a CANONICAL DOI            302 -> redirects to the PUBLISHER, not an alias
 *   a redirect off doi.org          -> a link, not an expansion
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'doiorg');

/** A recorded doi.org HEAD response, shaped as axios resolves it. */
function doiOrg(name: string): { status: number; headers: Record<string, any> } {
  const rec = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
  const headers: Record<string, any> = {};
  if (rec.headers.location !== null) headers.location = rec.headers.location;
  return { status: rec.status, headers };
}

const axiosHeadMock = jest.fn<any>();

jest.unstable_mockModule('axios', () => {
  const isAxiosError = (e: any) => !!e?.isAxiosError;
  return { default: { head: axiosHeadMock, get: jest.fn(), isAxiosError }, isAxiosError };
});

const mod = await import('../../src/doi/shortDoi.js');
const { expandShortDoi, clearShortDoiCache, readExpansionTarget } = mod;

beforeEach(() => {
  axiosHeadMock.mockReset();
  clearShortDoiCache();
});

describe('a shortDOI expands to its canonical DOI', () => {
  it('10/gt3vmw -> 10.1111/ECIN.13244', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-ecin.json'));
    const r = await expandShortDoi('10/gt3vmw');
    expect(r).toEqual({
      expanded: true,
      doi: '10.1111/ECIN.13244',
      reason: 'expanded',
      status: 301,
    });
  });

  it('10/b77m95 -> 10.1037/H0054651', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-stroop.json'));
    const r = await expandShortDoi('10/b77m95');
    expect(r.expanded).toBe(true);
    expect(r.doi).toBe('10.1037/H0054651');
  });

  it('10/bdps -> 10.1126/SCIENCE.AAF0918', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-science.json'));
    const r = await expandShortDoi('10/bdps');
    expect(r.doi).toBe('10.1126/SCIENCE.AAF0918');
  });

  it('keeps a suffix containing parentheses, colons, angle brackets AND SLASHES verbatim', async () => {
    // 10/aabbe. The Location is
    //   https://doi.org/10.1002/(SICI)1097-0258(19980815/30)17:15/16%3C1661::AID-SIM968%3E3.0.CO;2-2
    // Measured 2026-09-12: the verbatim path returns Crossref 200; truncating
    // it at the first inner slash — which ANY /10\.\d+\/[^\/]+/ style parser
    // does — yields `10.1002/(SICI)1097-0258(19980815`, which returns 404.
    // This is the case that separates a correct parser from one that merely
    // looks correct on `10/gt3vmw`.
    axiosHeadMock.mockResolvedValue(doiOrg('short-exotic-suffix.json'));
    const r = await expandShortDoi('10/aabbe');
    expect(r.expanded).toBe(true);
    expect(r.doi).toBe('10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM968>3.0.CO;2-2');
  });
});

describe('the controls — what must NOT expand', () => {
  it('a bare `10` is never sent to the resolver at all', async () => {
    // 9 production references hold exactly this. It is genuinely malformed
    // (the resolver answers 400) and must stay invalid. `isShortFormDoi`
    // rejects it, so no request is made: that is what bounds this feature's
    // blast radius to the alias form and nothing else.
    const r = await expandShortDoi('10');
    expect(r).toEqual({ expanded: false, reason: 'not-short-form' });
    expect(axiosHeadMock).not.toHaveBeenCalled();
  });

  it('a canonical DOI is never sent to the resolver either', async () => {
    const r = await expandShortDoi('10.1111/1467-9280.00441');
    expect(r).toEqual({ expanded: false, reason: 'not-short-form' });
    expect(axiosHeadMock).not.toHaveBeenCalled();
  });

  it('a well-formed but unregistered alias reports not-registered, not a DOI', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-unregistered.json'));
    const r = await expandShortDoi('10/zzzzzzzzzz');
    expect(r).toEqual({ expanded: false, reason: 'not-registered', status: 404 });
  });

  it('a redirect that leaves doi.org is a link, not an expansion', async () => {
    // The recorded 302 for a CANONICAL DOI, which goes straight to the
    // publisher. Fed here as though an alias had produced it: a rule that
    // only checked "was there a redirect" would swallow the publisher URL.
    axiosHeadMock.mockResolvedValue(doiOrg('full-doi.json'));
    const r = await expandShortDoi('10/pretend');
    expect(r).toEqual({ expanded: false, reason: 'off-resolver', status: 302 });
  });

  it('a doi.org hop whose path is not a canonical DOI is refused', async () => {
    axiosHeadMock.mockResolvedValue({ status: 301, headers: { location: 'https://doi.org/about/faq' } });
    const r = await expandShortDoi('10/whatever');
    expect(r.expanded).toBe(false);
    expect(r.reason).toBe('unexpanded-target');
  });

  it('an alias pointing at another alias is refused — exactly one hop is taken', async () => {
    axiosHeadMock.mockResolvedValue({ status: 301, headers: { location: 'https://doi.org/10/other' } });
    const r = await expandShortDoi('10/chain');
    expect(r.reason).toBe('unexpanded-target');
  });

  it('a 400 from the resolver is reported as malformed, not as an expansion', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('bare-10.json'));
    const r = await expandShortDoi('10/-');
    expect(r).toEqual({ expanded: false, reason: 'malformed', status: 400 });
  });

  it('a 3xx with no Location header yields no-redirect', async () => {
    axiosHeadMock.mockResolvedValue({ status: 301, headers: {} });
    const r = await expandShortDoi('10/noloc');
    expect(r).toEqual({ expanded: false, reason: 'no-redirect', status: 301 });
  });
});

describe('an unreachable resolver is not a verdict about the reference', () => {
  it('reports network-error rather than treating the DOI as unresolvable', async () => {
    const err: any = new Error('connect ETIMEDOUT');
    err.isAxiosError = true;
    err.code = 'ETIMEDOUT';
    axiosHeadMock.mockRejectedValue(err);
    const r = await expandShortDoi('10/gt3vmw', { timeoutMs: 10 });
    expect(r.expanded).toBe(false);
    expect(r.reason).toBe('network-error');
    expect(axiosHeadMock).toHaveBeenCalledTimes(3); // retried, then gave up honestly
  });

  it('retries a 503 and then reports the status instead of inventing a clean answer', async () => {
    axiosHeadMock.mockResolvedValue({ status: 503, headers: {} });
    const r = await expandShortDoi('10/gt3vmw');
    expect(r.reason).toBe('network-error');
    expect(r.status).toBe(503);
    expect(axiosHeadMock).toHaveBeenCalledTimes(3);
  });

  it('a network error is NOT cached — one bad minute must not blind an hour', async () => {
    const err: any = new Error('socket hang up');
    err.isAxiosError = true;
    axiosHeadMock.mockRejectedValue(err);
    await expandShortDoi('10/gt3vmw');
    expect(axiosHeadMock).toHaveBeenCalledTimes(3);

    axiosHeadMock.mockReset();
    axiosHeadMock.mockResolvedValue(doiOrg('short-ecin.json'));
    const second = await expandShortDoi('10/gt3vmw');
    expect(second.doi).toBe('10.1111/ECIN.13244');
    expect(axiosHeadMock).toHaveBeenCalledTimes(1);
  });
});

describe('the cache keeps the resolver off the hot path', () => {
  it('a repeated alias costs one request, case-insensitively', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-ecin.json'));
    await expandShortDoi('10/gt3vmw');
    await expandShortDoi('10/gt3vmw');
    await expandShortDoi('10/GT3VMW');
    expect(axiosHeadMock).toHaveBeenCalledTimes(1);
  });

  it('a 404 is cached too — an unregistered alias stays unregistered', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-unregistered.json'));
    await expandShortDoi('10/zzzzzzzzzz');
    await expandShortDoi('10/zzzzzzzzzz');
    expect(axiosHeadMock).toHaveBeenCalledTimes(1);
  });

  it('noCache bypasses it', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-ecin.json'));
    await expandShortDoi('10/gt3vmw');
    await expandShortDoi('10/gt3vmw', { noCache: true });
    expect(axiosHeadMock).toHaveBeenCalledTimes(2);
  });
});

describe('the resolver URL keeps the DOI separator', () => {
  it('does not percent-encode the slash — %2F is not a path separator to the handle resolver', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-ecin.json'));
    await expandShortDoi('10/gt3vmw');
    expect(axiosHeadMock.mock.calls[0][0]).toBe('https://doi.org/10/gt3vmw');
  });

  it('sends a polite User-Agent carrying a contact address', async () => {
    axiosHeadMock.mockResolvedValue(doiOrg('short-ecin.json'));
    await expandShortDoi('10/gt3vmw', { creds: { crossrefEmail: 'someone@example.org' } });
    const cfg: any = axiosHeadMock.mock.calls[0][1];
    expect(cfg.headers['User-Agent']).toContain('mailto:someone@example.org');
    expect(cfg.maxRedirects).toBe(0);
  });
});

describe('readExpansionTarget is pure and enumerable', () => {
  it('names every refusal rather than returning a bare null', () => {
    expect(readExpansionTarget(undefined)).toEqual({ reason: 'no-redirect' });
    expect(readExpansionTarget('')).toEqual({ reason: 'no-redirect' });
    expect(readExpansionTarget('https://example.com/10.1/x')).toEqual({ reason: 'off-resolver' });
    expect(readExpansionTarget('https://dx.doi.org/10.1234/abc')).toEqual({ doi: '10.1234/abc' });
    expect(readExpansionTarget('/10.1234/abc')).toEqual({ doi: '10.1234/abc' });
  });
});
