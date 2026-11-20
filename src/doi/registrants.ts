/**
 * The one list of DOI registrants the library knows by name: preprint servers (what
 * `detectKnownPreprintFromDoi` reports) and registrants that mint one DOI per version (what
 * `doiWithoutVersion` drops before deduplication compares DOIs). Before 0.3.0 these were two
 * tables that disagreed: 10.31222 (MetaArXiv) was labelled engrXiv, engrXiv (10.31224) and
 * EarthArXiv (10.31223) were missing, and the EarthArXiv row (10.32942/osf.io/) matched no
 * real DOI (v0.3.0 review 3).
 *
 * Every row was read on 2026-11-20: the prefix owner in Crossref (`/prefixes`, `/members`),
 * a sample DOI resolved at doi.org to the server's own site, and, for `version`, Crossref
 * `is-version-of` relations (figshare: DataCite records, `.vN` beside a bare DOI for the whole
 * item). Zenodo (10.5281, DataCite) is absent on purpose: 200 of 200 sampled Zenodo DOIs carry
 * no version ending; each version has its own number. F1000/Open Research (10.12688) versions
 * end in a bare number (`.1`, `.2`) and are peer-reviewed article versions; they are not
 * merged (two listed versions is the safe error).
 *
 * `prefix` and `version` are case-insensitive: a DOI is case-insensitive.
 */
export interface DoiRegistrant {
  /** What a DOI of this registrant starts with. */
  prefix: RegExp;
  /** Preprint server name, when the registrant is one. */
  server?: string;
  /** The version ending, when the registrant mints one DOI per version. */
  version?: RegExp;
}

/**
 * Center for Open Science servers on OSF (Crossref member 15934), `10.x/osf.io/abcde_v2`:
 * [prefix code, name, osf.io/preprints/<slug>]. Names and slugs read from
 * api.osf.io/v2/preprint_providers/<slug>/ on 2026-11-20; Banglarxiv returned no record
 * there, so it has no URL slug.
 */
const OSF_SERVERS: ReadonlyArray<[string, string, string | null]> = [
  ['31219', 'OSF Preprints', 'osf'], ['31221', 'Arabixiv', 'arabixiv'], ['31222', 'MetaArXiv', 'metaarxiv'],
  ['31225', 'FocUS Archive', 'focusarchive'], ['31226', 'Frenxiv', 'frenxiv'], ['31227', 'INA-Rxiv', 'inarxiv'],
  ['31228', 'LawArXiv', 'lawarxiv'], ['31229', 'LIS Scholarship Archive', 'lissa'], ['31230', 'MarXiv', 'marxiv'],
  ['31231', 'MindRxiv', 'mindrxiv'], ['31232', 'NutriXiv', 'nutrixiv'], ['31233', 'PaleorXiv', 'paleorxiv'],
  ['31235', 'SocArXiv', 'socarxiv'], ['31236', 'SportRxiv', 'sportrxiv'], ['31730', 'AfricArXiv', 'africarxiv'],
  ['32943', 'Banglarxiv', null], ['33767', 'MediArXiv', 'mediarxiv'], ['34055', 'BodoArXiv', 'bodoarxiv'],
  ['35542', 'EdArXiv', 'edarxiv'], ['37044', 'BioHackrXiv', 'biohackrxiv'],
  // Not listed: 10.31237 Thesis Commons (theses) and 10.71240 Lifecycle Journal (a journal).
];

/** osf.io/preprints/<slug> for every OSF server above with a slug, and PsyArXiv (10.31234). */
export const OSF_PREPRINT_SLUGS: ReadonlyArray<{ slug: string; server: string }> = [
  { slug: 'psyarxiv', server: 'PsyArXiv' },
  ...OSF_SERVERS.flatMap(([, server, slug]) => (slug ? [{ slug, server }] : [])),
];

const OSF_VERSION = /_v\d+$/i;

/**
 * bioRxiv/medRxiv: "v2", and the page endings a bioRxiv link adds (".full", ".full.pdf",
 * ".abstract", ".article-info", ".article-metrics", ".figures-only",
 * ".supplementary-material"): each names the same preprint.
 */
const BIORXIV_VERSION =
  /(?<=\d)(?:v\d+)?(?:\.(?:full(?:\.pdf)?|abstract|article-info|article-metrics|figures-only|supplementary-material))?$/i;

export const DOI_REGISTRANTS: ReadonlyArray<DoiRegistrant> = [
  { prefix: /^10\.2139\/ssrn\./i, server: 'SSRN' },
  { prefix: /^10\.31234\//i, server: 'PsyArXiv', version: OSF_VERSION },
  ...OSF_SERVERS.map(([code, server]) => ({ prefix: new RegExp(`^10\\.${code}\\/osf\\.io\\/`, 'i'), server, version: OSF_VERSION })),
  // Only the bioRxiv/medRxiv suffix forms (dated "2020.03.22.002386", or the older six-plus
  // digit "002386"). The 10.1101 prefix also carries Cold Spring Harbor journal articles
  // (10.1101/pdb.prot099176, 10.1101/gr.*), which Crossref types journal-article.
  // Not anchored at the end, so a version or page ending still names the server (as in
  // 0.2.x); deduplication drops the endings listed in BIORXIV_VERSION.
  { prefix: /^10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.\d+|\d{6,})/i, server: 'bioRxiv/medRxiv', version: BIORXIV_VERSION },
  // bioRxiv/medRxiv deposit new preprints under 10.64898 (openRxiv); every one of its
  // 453,106 Crossref works is posted-content (type facet, 2026-11-18).
  { prefix: /^10\.64898\//i, server: 'bioRxiv/medRxiv', version: BIORXIV_VERSION },
  { prefix: /^10\.48550\/arxiv\./i, server: 'arXiv' },
  { prefix: /^10\.20944\/preprints/i, server: 'Preprints.org', version: /\.v\d+$/i },
  { prefix: /^10\.21203\/rs\./i, server: 'Research Square', version: /\/v\d+$/i },
  // ChemRxiv writes /v2, .v2 and -v2; its bare DOI names the whole work.
  { prefix: /^10\.26434\/chemrxiv/i, server: 'ChemRxiv', version: /[./-]v\d+$/i },
  // Cambridge Open Engage: coe-2025-pzt7t-v2 is a version of coe-2025-pzt7t.
  { prefix: /^10\.33774\//i, server: 'Cambridge Open Engage', version: /-v\d+$/i },
  // Authorea (and ESSOAr, hosted there): au.172258443.36807633/v2.
  { prefix: /^10\.22541\//i, server: 'Authorea', version: /\/v\d+$/i },
  { prefix: /^10\.36227\/techrxiv/i, server: 'TechRxiv', version: /[./]v\d+$/i },
  // engrXiv (Open Engineering), EarthArXiv and EcoEvoRxiv (California Digital Library):
  // no version DOIs in Crossref.
  { prefix: /^10\.31224\//i, server: 'engrXiv' },
  { prefix: /^10\.31223\//i, server: 'EarthArXiv' },
  { prefix: /^10\.32942\//i, server: 'EcoEvoRxiv' },
  // figshare items, and figshare-hosted items under a publisher prefix that say so
  // (10.1000/x.figshare.12345.v1); a figshare instance whose DOI does not say figshare
  // (10.25384/sage.c.12345.v1) is not matched: two versions listed twice is the safe error.
  { prefix: /^10\.6084\/m9\.figshare\./i, version: /\.v\d+$/i },
  { prefix: /^10\.\d{4,9}\/(?:[^/]*\.)?figshare\.\d/i, version: /\.v\d+$/i },
];

/** The registrant a cleaned DOI belongs to, or undefined. The first matching row wins. */
export function doiRegistrant(doi: string): DoiRegistrant | undefined {
  return DOI_REGISTRANTS.find((r) => r.prefix.test(doi));
}
