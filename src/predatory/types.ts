export interface BeallsList {
  lastUpdated: string;
  source: string;
  note?: string;
  publishers: string[];
  indicators: {
    rapid_publication: string[];
    guaranteed_acceptance: string[];
    excessive_marketing: string[];
    suspicious_fees: string[];
    poor_quality_signals: string[];
  };
  knownLegitimatePublishers: string[];
}

export interface DOAJResult {
  found: boolean;
  journalTitle?: string;
  publisher?: string;
  issn?: string;
  eissn?: string;
  url?: string;
}

export interface OpenAlexSource {
  id: string;
  display_name: string;
  issn_l?: string;
  issn?: string[];
  host_organization_name?: string;
  homepage_url?: string;
  type?: string;
  is_oa?: boolean;
  is_in_doaj?: boolean;
}

export interface OpenAlexResult {
  found: boolean;
  journalTitle?: string;
  publisher?: string;
  issn?: string;
  eissn?: string;
  url?: string;
  openalexId?: string;
}

export interface HeuristicsResult {
  isPredatory: boolean;
  confidence: number;
  indicators: string[];
  details: string[];
}

export interface JournalMetadata {
  journal?: string;
  issn?: string;
  publisher?: string;
}

export interface VerificationResult {
  status: 'legitimate' | 'predatory' | 'unknown';
  source: 'bealls_list' | 'doaj' | 'heuristics' | 'combined';
  confidence: number;
  isPredatory: boolean;
  reasoning: string;
  sources: string[];
  details: {
    beallsCheck?: boolean;
    doajCheck?: DOAJResult;
    heuristicsCheck?: HeuristicsResult;
  };
}

export interface PluginConfig {
  useBeallsList?: boolean;
  useDOAJ?: boolean;
  useHeuristics?: boolean;
  useOpenAlex?: boolean; // Enable OpenAlex API lookups for better journal extraction
  heuristicSensitivity?: 'low' | 'medium' | 'high';
  cacheExpiry?: number;
}
