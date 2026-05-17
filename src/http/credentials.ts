/**
 * Credentials threaded into referencecheck's HTTP clients. referencecheck
 * never reads process.env; the consuming app populates this from its own
 * environment. Every field is optional — when absent, each client falls back
 * to the same default it used before extraction (the polite-pool contact
 * email). The consuming app reads process.env at its own adapter boundary and
 * passes a populated object.
 */
export interface MetadataCredentials {
  /** Polite-pool contact email for Crossref. Was process.env.CROSSREF_EMAIL. */
  crossrefEmail?: string;
  /** Polite-pool contact email for OpenAlex. Was OPENALEX_EMAIL || CROSSREF_EMAIL. */
  openAlexEmail?: string;
}

/** The default polite-pool contact email used when none is supplied —
 *  identical to the hardcoded fallback inlined in the extracted code. */
export const DEFAULT_POLITE_EMAIL = 'collaborativeopenscience@gmail.com';
