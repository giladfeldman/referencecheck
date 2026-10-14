/**
 * Abstract lookup by DOI, with a cache shared across documents.
 *
 * Sources, in order, first one that yields an abstract of at least
 * MIN_ABSTRACT_CHARS wins:
 *   1. Crossref   (publisher-deposited JATS <jats:abstract>)
 *   2. OpenAlex   (abstract_inverted_index, rebuilt into text)
 *   3. Semantic Scholar (graph API `abstract` field)
 *   4. Europe PMC (search by DOI, `abstractText`)
 *
 * Three outcomes, never collapsed into one another:
 *   - found:     an abstract, with the source that supplied it
 *   - not_found: every source answered and none had a usable abstract
 *   - error:     no source had one AND at least one source failed (network,
 *                5xx, rate limit), so absence is not established
 * Only `found` and `not_found` are cached; an `error` is retried next time.
 */
import axios from 'axios';
import type { MetadataCredentials } from '../http/credentials.js';
import { DEFAULT_POLITE_EMAIL } from '../http/credentials.js';

/** Shortest text accepted as an abstract; shorter is usually a title echo or a stub. */
export const MIN_ABSTRACT_CHARS = 200;

export type AbstractSource = 'crossref' | 'openalex' | 'semanticscholar' | 'europepmc';
export const ABSTRACT_SOURCES: readonly AbstractSource[] = ['crossref', 'openalex', 'semanticscholar', 'europepmc'];

/** `invalid_doi` is returned only by fetchAbstracts, for an input that is not a DOI. */
export type AbstractStatus = 'found' | 'not_found' | 'error' | 'invalid_doi';

export interface AbstractAttempt {
  source: AbstractSource;
  /** found: usable abstract; absent: source has the work but no abstract (or no record); too_short: under MIN_ABSTRACT_CHARS; error: request failed */
  outcome: 'found' | 'absent' | 'too_short' | 'error';
  detail?: string;
}

export interface AbstractResult {
  doi: string;
  status: AbstractStatus;
  abstract: string | null;
  source: AbstractSource | null;
  title: string | null;
  year: number | null;
  attempts: AbstractAttempt[];
  /** The sources this lookup consulted, in order. A cached not_found is reused only by a lookup asking no more than these. */
  sourcesTried: AbstractSource[];
  /** The longest abstract text seen that was under MIN_ABSTRACT_CHARS (a brief report, a stub), or null. */
  shortAbstract: string | null;
  retrievedAt: string;
}

/** Cross-document cache, keyed by normalised DOI. The host may back it with a database. */
export interface AbstractCache {
  get(doi: string): Promise<AbstractResult | undefined>;
  set(doi: string, result: AbstractResult): Promise<void>;
}

/** Default in-process cache. */
export class MemoryAbstractCache implements AbstractCache {
  private readonly store = new Map<string, AbstractResult>();
  async get(doi: string): Promise<AbstractResult | undefined> {
    return this.store.get(doi);
  }
  async set(doi: string, result: AbstractResult): Promise<void> {
    this.store.set(doi, result);
  }
  get size(): number {
    return this.store.size;
  }
}

/** HTTP GET returning parsed JSON, or null for a 404. Throws on any other failure. Injected for tests. */
export type JsonGet = (url: string, headers: Record<string, string>) => Promise<unknown | null>;

export const axiosJsonGet: JsonGet = async (url, headers) => {
  try {
    const r = await axios.get(url, { headers, timeout: 20000 });
    return r.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
};

export interface FetchAbstractOptions {
  credentials?: MetadataCredentials;
  cache?: AbstractCache;
  /**
   * Sources to try, in order. Default: ABSTRACT_SOURCES, except that semanticscholar is
   * skipped unless credentials.semanticScholarApiKey is set (its keyless pool answers
   * HTTP 429 so often that a miss would almost always read as `error`).
   */
  sources?: readonly AbstractSource[];
  httpGet?: JsonGet;
  /** Clock for retrievedAt; injected for tests. */
  now?: () => Date;
}

export function normalizeAbstractDoi(doi: string): string | null {
  const d = (doi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  return d.startsWith('10.') && d.includes('/') ? d : null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Strip JATS/HTML markup and decode entities; drop a leading "Abstract" heading. */
export function cleanAbstractMarkup(raw: string): string {
  let s = raw.replace(/<jats:title>[^<]*<\/jats:title>/gi, ' ').replace(/<title>[^<]*<\/title>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  s = s.replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
  s = s.replace(/\s+/g, ' ').trim();
  return s.replace(/^(abstract|summary)[\s.:]+/i, '');
}

/** Rebuild text from an OpenAlex abstract_inverted_index. */
export function invertedIndexToText(index: Record<string, number[]>): string {
  const pos: string[] = [];
  for (const [word, idxs] of Object.entries(index)) {
    for (const i of idxs) pos[i] = word;
  }
  return pos.filter((w) => w !== undefined).join(' ');
}

interface Hit {
  abstract: string | null;
  title: string | null;
  year: number | null;
}

type SourceFn = (doi: string, get: JsonGet, creds?: MetadataCredentials) => Promise<Hit | null>;

const enc = (doi: string) => encodeURIComponent(doi);
const mail = (c?: MetadataCredentials) => c?.crossrefEmail || DEFAULT_POLITE_EMAIL;

const SOURCE_FNS: Record<AbstractSource, SourceFn> = {
  async crossref(doi, get, creds) {
    const d = (await get(`https://api.crossref.org/works/${enc(doi)}`, {
      'User-Agent': `referencecheck (mailto:${mail(creds)})`,
    })) as { message?: any } | null;
    if (d === null) return null;
    const m = (d as { message?: any })?.message;
    if (!m || typeof m !== 'object') throw new Error('crossref: unexpected response shape');
    const year = m.issued?.['date-parts']?.[0]?.[0] ?? null;
    return { abstract: m.abstract ? cleanAbstractMarkup(String(m.abstract)) : null,
      title: Array.isArray(m.title) ? m.title[0] ?? null : null, year: Number.isInteger(year) ? year : null };
  },
  async openalex(doi, get, creds) {
    const email = creds?.openAlexEmail || creds?.crossrefEmail || DEFAULT_POLITE_EMAIL;
    const w = (await get(`https://api.openalex.org/works/doi:${enc(doi)}?mailto=${encodeURIComponent(email)}`, {})) as any;
    if (w === null) return null;
    if (!w || typeof w !== 'object' || typeof w.id !== 'string') throw new Error('openalex: unexpected response shape');
    const inv = w.abstract_inverted_index;
    return { abstract: inv ? invertedIndexToText(inv) : null, title: w.title ?? null,
      year: Number.isInteger(w.publication_year) ? w.publication_year : null };
  },
  async semanticscholar(doi, get, creds) {
    const headers: Record<string, string> = {};
    if (creds?.semanticScholarApiKey) headers['x-api-key'] = creds.semanticScholarApiKey;
    const p = (await get(`https://api.semanticscholar.org/graph/v1/paper/DOI:${enc(doi)}?fields=title,year,abstract`, headers)) as any;
    if (p === null) return null;
    if (!p || typeof p !== 'object' || typeof p.paperId !== 'string') throw new Error('semanticscholar: unexpected response shape');
    return { abstract: p.abstract ?? null, title: p.title ?? null, year: Number.isInteger(p.year) ? p.year : null };
  },
  async europepmc(doi, get) {
    const q = encodeURIComponent(`DOI:"${doi}"`);
    const d = (await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${q}&format=json&resultType=core`, {})) as any;
    if (d === null) return null;
    const list = d?.resultList?.result;
    if (!Array.isArray(list)) throw new Error('europepmc: unexpected response shape');
    // The search is by DOI, but the hit is only accepted when it names that DOI.
    const r = list.find((x: any) => normalizeAbstractDoi(String(x?.doi ?? '')) === doi);
    if (!r) return null;
    const year = parseInt(r.pubYear, 10);
    return { abstract: r.abstractText ? cleanAbstractMarkup(String(r.abstractText)) : null,
      title: r.title ?? null, year: Number.isInteger(year) ? year : null };
  },
};

/**
 * Fetch the abstract for one DOI through the source cascade, using the cache.
 * Never throws for a source failure; the result says what happened per source.
 * Throws only for an invalid DOI (a caller bug, not a data condition).
 */
export async function fetchAbstract(doi: string, options: FetchAbstractOptions = {}): Promise<AbstractResult> {
  const key = normalizeAbstractDoi(doi);
  if (!key) throw new Error(`fetchAbstract: not a DOI: ${JSON.stringify(doi)}`);
  const sources = options.sources ?? ABSTRACT_SOURCES.filter(
    (s) => s !== 'semanticscholar' || !!options.credentials?.semanticScholarApiKey);
  const cached = await options.cache?.get(key);
  // A found abstract is reusable by anyone. A not_found only answers a lookup
  // that asks no more sources than it consulted: a crossref-only miss must not
  // stand in for a full cascade (review 2026-10-14).
  if (cached && (cached.status === 'found' || sources.every((s) => (cached.sourcesTried ?? []).includes(s)))) {
    return cached;
  }

  const get = options.httpGet ?? axiosJsonGet;
  const attempts: AbstractAttempt[] = [];
  let title: string | null = null;
  let year: number | null = null;
  let found: { abstract: string; source: AbstractSource } | null = null;
  let shortAbstract: string | null = null;
  for (const source of sources) {
    try {
      const hit = await SOURCE_FNS[source](key, get, options.credentials);
      title = title ?? hit?.title ?? null;
      year = year ?? hit?.year ?? null;
      const text = hit?.abstract?.trim() ?? '';
      if (!text) {
        attempts.push(hit === null ? { source, outcome: 'absent', detail: 'no record' } : { source, outcome: 'absent' });
      } else if (text.length < MIN_ABSTRACT_CHARS) {
        attempts.push({ source, outcome: 'too_short', detail: `${text.length} chars` });
        if (!shortAbstract || text.length > shortAbstract.length) shortAbstract = text;
      } else {
        attempts.push({ source, outcome: 'found' });
        found = { abstract: text, source };
        break;
      }
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      attempts.push({ source, outcome: 'error',
        detail: status ? `HTTP ${status}` : (err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
  const status: AbstractStatus = found ? 'found' : attempts.some((a) => a.outcome === 'error') ? 'error' : 'not_found';
  const result: AbstractResult = {
    doi: key, status, abstract: found?.abstract ?? null, source: found?.source ?? null, title, year, attempts,
    sourcesTried: [...sources], shortAbstract: found ? null : shortAbstract,
    retrievedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  if (status !== 'error') await options.cache?.set(key, result);
  return result;
}

/**
 * Fetch many DOIs sequentially (polite to free APIs); duplicates are fetched once.
 * The map is keyed by the NORMALISED DOI; an input that is not a DOI is kept
 * under its original text with status `invalid_doi`, never dropped.
 */
export async function fetchAbstracts(dois: string[], options: FetchAbstractOptions = {}): Promise<Map<string, AbstractResult>> {
  const cache = options.cache ?? new MemoryAbstractCache();
  const out = new Map<string, AbstractResult>();
  const now = options.now ?? (() => new Date());
  for (const doi of dois) {
    const key = normalizeAbstractDoi(doi);
    if (!key) {
      out.set(doi, { doi, status: 'invalid_doi', abstract: null, source: null, title: null, year: null,
        attempts: [], sourcesTried: [], shortAbstract: null, retrievedAt: now().toISOString() });
      continue;
    }
    if (out.has(key)) continue;
    out.set(key, await fetchAbstract(key, { ...options, cache }));
  }
  return out;
}
