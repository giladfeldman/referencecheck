/**
 * Short-DOI expansion.
 *
 * `10/gt3vmw` is a shortDOI — a redirect alias issued by shortdoi.org that
 * stands for exactly one canonical DOI. It is NOT a different identifier, and
 * it is not malformed: `https://doi.org/10/gt3vmw` answers 301 and points at
 * `https://doi.org/10.1111/ECIN.13244`, a real Economic Inquiry article.
 *
 * Callers that hand a shortDOI straight to a bibliographic API get a 404 (the
 * register is keyed by canonical DOI) or, worse, a spurious fuzzy match. The
 * existing defence for that is `isShortFormDoi` in `doiShape.ts`, which lets a
 * caller refuse the lookup. This module is the other half: resolve the alias
 * first, then look the real DOI up.
 *
 * MEASURED 2026-09-12 against the live resolver — the four branches and the
 * signature that separates them:
 *
 *   10/gt3vmw               301  location: https://doi.org/10.1111/ECIN.13244
 *   10/b77m95               301  location: https://doi.org/10.1037/H0054651
 *   10                      400  (no location — genuinely malformed)
 *   10/zzzzzzzzzz           404  (well-formed, not registered)
 *   10.1111/1467-9280.00441 302  location: https://journals.sagepub.com/...
 *
 * The discriminator is therefore NOT "there was a redirect". A canonical DOI
 * also redirects — straight to the publisher. Expansion is only accepted when
 * the resolver hands back another **doi.org** URL whose path is a canonical
 * DOI. That is what makes this an alias lookup rather than a link follow, and
 * it is why exactly one hop is taken: following further would walk into
 * publisher redirect chains that carry no DOI at all.
 *
 * Recorded responses for all six cases: `tests/fixtures/doiorg/`.
 */

import axios from 'axios';
import { formatError } from '../util/formatError.js';
import type { MetadataCredentials } from '../http/credentials.js';
import { DEFAULT_POLITE_EMAIL } from '../http/credentials.js';
import { isShortFormDoi } from './doiShape.js';

/** The resolver, and the only host an expansion is accepted from. */
const DOI_RESOLVER = 'https://doi.org/';
const RESOLVER_HOSTS = new Set(['doi.org', 'dx.doi.org']);

/** Canonical DOI shape — the same expression `isMalformedDoi` accepts. */
const CANONICAL_DOI = /^10\.\d{3,9}\/\S+$/;

/**
 * Why an expansion did or did not happen. Every value is a distinct,
 * observable outcome; there is no catch-all "failed". A caller that maps
 * several of these onto one user-facing verdict should do so explicitly —
 * a silent `else` here would hide the difference between "this alias is not
 * registered" and "we could not reach the resolver", which are opposite
 * facts about the reference.
 */
export type ShortDoiExpansionReason =
  /** Resolved: `doi` holds the canonical DOI. */
  | 'expanded'
  /** Input is not the shortDOI form. No request was made. */
  | 'not-short-form'
  /** Resolver answered 404 — well-formed alias, not registered. */
  | 'not-registered'
  /** Resolver answered 400 — the resolver itself rejects the string. */
  | 'malformed'
  /** Resolver answered without a usable redirect (2xx, or 3xx with no Location). */
  | 'no-redirect'
  /** Redirect left doi.org — a link, not an alias expansion. */
  | 'off-resolver'
  /** Redirect stayed on doi.org but its path is not a canonical DOI. */
  | 'unexpanded-target'
  /** Resolver unreachable, timed out, or still failing after retries. */
  | 'network-error';

export interface ShortDoiExpansion {
  /** True only for `reason === 'expanded'`; `doi` is then always populated. */
  expanded: boolean;
  /** The canonical DOI. Present if and only if `expanded` is true. */
  doi?: string;
  reason: ShortDoiExpansionReason;
  /** HTTP status from the resolver, when one was received. */
  status?: number;
  /** Human-readable cause, present for `network-error`. */
  error?: string;
}

export interface ExpandShortDoiOptions {
  creds?: MetadataCredentials;
  /** Per-attempt timeout in ms. Default 8000. */
  timeoutMs?: number;
  /** Bypass the in-memory cache for this call. */
  noCache?: boolean;
}

/**
 * In-memory expansion cache. A shortDOI maps to one canonical DOI forever —
 * that is what the alias IS — so a long TTL is safe, and the worker calls
 * this on a per-reference hot path where the same alias recurs across a
 * document and across re-processes of it.
 *
 * `network-error` is deliberately NOT cached: caching a transient failure
 * would turn one unreachable resolver into an hour of references wrongly
 * reported as unresolvable.
 */
const expansionCache = new Map<string, { result: ShortDoiExpansion; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Clear the expansion cache. Exposed for tests and for long-lived hosts. */
export function clearShortDoiCache(): void {
  expansionCache.clear();
}

/**
 * Percent-encode a DOI for a resolver URL while KEEPING the `/` separator.
 *
 * `encodeURIComponent` escapes the slash to `%2F`, which the handle resolver
 * does not accept as a path separator. This is the reason short DOIs were
 * never resolvable through the generic `encodeURIComponent` call sites.
 */
function encodeDoiPath(doi: string): string {
  return doi.split('/').map(encodeURIComponent).join('/');
}

function politeUserAgent(creds?: MetadataCredentials): string {
  return `referencecheck (mailto:${creds?.crossrefEmail || DEFAULT_POLITE_EMAIL})`;
}

/**
 * Read the canonical DOI out of a resolver redirect, or explain why there
 * isn't one. Pure — every network concern is in the caller.
 */
export function readExpansionTarget(
  location: string | undefined | null
): { doi: string } | { reason: Extract<ShortDoiExpansionReason, 'no-redirect' | 'off-resolver' | 'unexpanded-target'> } {
  if (!location || typeof location !== 'string' || !location.trim()) {
    return { reason: 'no-redirect' };
  }

  let url: URL;
  try {
    url = new URL(location, DOI_RESOLVER);
  } catch {
    return { reason: 'off-resolver' };
  }

  if (!RESOLVER_HOSTS.has(url.hostname.toLowerCase())) {
    return { reason: 'off-resolver' };
  }

  let candidate: string;
  try {
    candidate = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return { reason: 'unexpanded-target' };
  }
  candidate = candidate.trim();

  // A shortDOI pointing at another shortDOI is not an expansion. Only one hop
  // is taken, deliberately — see the module note.
  if (isShortFormDoi(candidate)) return { reason: 'unexpanded-target' };
  if (!CANONICAL_DOI.test(candidate)) return { reason: 'unexpanded-target' };

  return { doi: candidate };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Expand a shortDOI (`10/<token>`) to its canonical DOI.
 *
 * Anything that is not the shortDOI form — a canonical DOI, a bare `10`, a
 * typo, a non-string — returns `not-short-form` WITHOUT a network call. That
 * is the negative control the caller relies on: this function can only ever
 * change the verdict for inputs `isShortFormDoi` already identifies.
 */
export async function expandShortDoi(
  doi: string,
  options: ExpandShortDoiOptions = {}
): Promise<ShortDoiExpansion> {
  if (typeof doi !== 'string' || !isShortFormDoi(doi)) {
    return { expanded: false, reason: 'not-short-form' };
  }

  const alias = doi.trim();
  const cacheKey = alias.toLowerCase();

  if (!options.noCache) {
    const hit = expansionCache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) return hit.result;
  }

  const result = await resolveAlias(alias, options);

  // Never cache a transient failure — see the cache note above.
  if (result.reason !== 'network-error') {
    expansionCache.set(cacheKey, { result, timestamp: Date.now() });
  }
  return result;
}

async function resolveAlias(
  alias: string,
  options: ExpandShortDoiOptions
): Promise<ShortDoiExpansion> {
  const maxAttempts = 3;
  const timeout = options.timeoutMs ?? 8000;
  let lastError: any;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let status: number;
    let location: string | undefined;
    try {
      const response = await axios.head(`${DOI_RESOLVER}${encodeDoiPath(alias)}`, {
        timeout,
        maxRedirects: 0, // one hop, read manually
        validateStatus: () => true,
        headers: { 'User-Agent': politeUserAgent(options.creds) },
      });
      status = response.status;
      location = response.headers?.location as string | undefined;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      return {
        expanded: false,
        reason: 'network-error',
        error: formatError(err, 'DOI resolver'),
      };
    }

    if (REDIRECT_STATUSES.has(status)) {
      const target = readExpansionTarget(location);
      if ('doi' in target) return { expanded: true, doi: target.doi, reason: 'expanded', status };
      return { expanded: false, reason: target.reason, status };
    }

    if (status === 404) return { expanded: false, reason: 'not-registered', status };
    if (status === 400) return { expanded: false, reason: 'malformed', status };
    if (status >= 200 && status < 300) return { expanded: false, reason: 'no-redirect', status };

    // 429 and 5xx: retry, then report the status rather than inventing a verdict.
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    return {
      expanded: false,
      reason: 'network-error',
      status,
      error: `DOI resolver returned ${status} after ${maxAttempts} attempts`,
    };
  }

  return {
    expanded: false,
    reason: 'network-error',
    error: formatError(lastError, 'DOI resolver'),
  };
}
